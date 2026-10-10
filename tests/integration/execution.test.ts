import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { request } from '../../apps/cli/client.js';
import { startService } from '../../apps/supervisor/server.js';
import type { Run } from '../../packages/contracts/p1.js';
import type { ExecutionRecord, ExecutionStart, ResolvedExecutionStart } from '../../packages/contracts/p2.js';
import { ExecutionManager } from '../../packages/execution/manager.js';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { inspectProcess, spawnManagedProcess } from '../../packages/process-control/index.js';

const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sv-p2-ex-'));
  const data = join(root, 'data'); const workspace = join(root, 'workspace');
  await mkdir(workspace); await mkdir(data);
  const stores = new Set<SupervisorStore>(); const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const cleanup of [...cleanups].reverse()) await cleanup();
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, data, workspace: await realpath(workspace), cleanups,
    open() { const store = new SupervisorStore(data); stores.add(store); return store; },
    close(store: SupervisorStore) { store.close(); stores.delete(store); },
  };
}
function start(workspace: string, commandId = 'integration-command'): ExecutionStart & { workspace: string } {
  return { type: 'start', commandId, workspace, prompt: 'Bounded integration task; no model invocation', model: 'uninvoked-model', effort: 'low', timeoutMs: 10_000, tokenLimit: 100, reservation: 60, verificationReserve: 20 };
}
function resolvedStart(workspace: string, commandId = 'integration-command'): ResolvedExecutionStart {
  return { ...start(workspace, commandId), workspaceKind: 'project' };
}
function automatic(commandId: string): ExecutionStart {
  const { workspace: _workspace, ...input } = start('/', commandId);
  return input;
}
function run(store: SupervisorStore, record: ExecutionRecord): Run {
  return store.query({ type: 'run', projectId: record.projectId, runId: record.runId }) as Run;
}
async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (performance.now() >= deadline) throw new Error('Actual integration state did not reach its expected condition');
    await delay(20);
  }
}
async function fileWhenPresent(path: string): Promise<string> {
  return waitFor(async () => {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }, value => value.length > 0);
}
async function failingExecutable(root: string, source: string): Promise<string> {
  const path = join(root, 'actual-failing-tool');
  await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return path;
}

test('execution SQLite persists canonical start receipt reservation lease and event cursor across reopen', async t => {
  const f = await fixture(t); let store = f.open();
  const input = resolvedStart(f.workspace);
  const first = store.executionCreate(input); assert.equal(first.created, true);
  const before = run(store, first.record); const events = store.executionEvents(first.record.id, 0);
  assert.equal(before.budget.unit, 'token'); assert.equal(before.budget.spent, 0); assert.equal(before.budget.verificationReserve, 20);
  assert.deepEqual(before.attempts.map(a => ({ reservation: a.reservation, settled: a.settled, actual: a.actual })), [{ reservation: 60, settled: false, actual: null }]);
  assert.deepEqual(before.leases, [{ resource: 'workspace:' + f.workspace, attemptId: first.record.id, released: false }]);
  assert.equal(before.operations[0]?.status, 'pending'); assert.equal(events.length, 1); assert.equal(events[0]?.kind, 'execution-intent');
  const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as ResolvedExecutionStart;
  assert.deepEqual(store.executionCreate({ ...reordered, images: [] }), { record: first.record, created: false });
  assert.throws(() => store.executionCreate({ ...input, prompt: 'Different authorized task' }), /different execution/);
  assert.equal(store.executionList().length, 1); assert.deepEqual(run(store, first.record), before);
  f.close(store); store = f.open();
  assert.deepEqual(store.executionGet(first.record.id), first.record); assert.deepEqual(run(store, first.record), before);
  assert.deepEqual(store.executionEvents(first.record.id, 0), events);
  assert.deepEqual(store.executionEvents(first.record.id, events.at(-1)!.seq), []);
  assert.deepEqual(store.executionCreate(reordered), { record: first.record, created: false });
});

test('execution store excludes overlapping workspaces and rolls back rejected admission', async t => {
  const f = await fixture(t); const store = f.open();
  const nested = join(f.workspace, 'nested'); const sibling = join(f.root, 'workspace-sibling'); await mkdir(nested); await mkdir(sibling);
  const first = store.executionCreate(resolvedStart(f.workspace)).record;
  const before = run(store, first); const events = store.executionEvents(first.id, 0);
  for (const workspace of [f.workspace, nested, await realpath(f.root)]) {
    assert.throws(() => store.executionCreate(resolvedStart(workspace, randomUUID())), /active or unverified writer/);
  }
  assert.equal(store.executionList().length, 1); assert.deepEqual(run(store, first), before); assert.deepEqual(store.executionEvents(first.id, 0), events);
  const separate = store.executionCreate(resolvedStart(sibling, 'nonoverlapping')).record; assert.notEqual(separate.id, first.id);
  assert.equal(store.executionList().length, 2);
  // Marking an outcome unknown does not release writer exclusion.
  store.executionUpdate(first.id, { state: 'unknown' }, 'lost-observation', { reason: 'Unknown process outcome' });
  assert.throws(() => store.executionCreate(resolvedStart(nested, 'still-excluded')), /active or unverified writer/);
  // Stop observation is the controller's admission prerequisite; the domain lease is released separately.
  store.executionUpdate(first.id, { stopConfirmed: true }, 'no-process-released', { identity: null }, [{ type: 'finishAttempt', attemptId: first.id, outcome: 'failed' }, { type: 'releaseLease', resource: 'workspace:' + f.workspace, attemptId: first.id }]);
  assert.equal(store.executionCreate(resolvedStart(nested, 'after-stop')).created, true);
});

test('execution manager refuses insufficient reserve before invoking a real executable', async t => {
  const f = await fixture(t); const store = f.open(); const marker = join(f.root, 'invoked');
  const executable = await failingExecutable(f.root, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected launch'); process.exit(23);`);
  const manager = new ExecutionManager(store, f.data, executable); f.cleanups.push(() => manager.close());
  const input = start(f.workspace);
  await assert.rejects(manager.dispatch({ ...input, tokenLimit: 79 }), /Budget cannot cover/);
  await assert.rejects(manager.dispatch({ ...input, reservation: 0 }), /Budget cannot cover/);
  assert.deepEqual(store.executionList(), []); assert.deepEqual(store.query({ type: 'projects' }), []);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('execution automatic workspace persists isolated files and command receipt across close and reopen', async t => {
  const f = await fixture(t); let store = f.open();
  const managedRoot = join(f.root, 'managed');
  const executable = await failingExecutable(f.root, 'process.exit(23);');
  const manager = new ExecutionManager(store, f.data, executable, { managedWorkspaceRoot: managedRoot });
  const input = automatic('../../outside/command');
  const first = await manager.dispatch(input) as ExecutionRecord;
  assert.equal(first.workspaceKind, 'managed');
  assert.equal(first.workspace, join(await realpath(managedRoot), createHash('sha256').update(input.commandId).digest('hex')));
  assert.equal((await stat(first.workspace)).isDirectory(), true);
  assert.equal((await stat(first.workspace)).mode & 0o777, 0o700);
  await writeFile(join(first.workspace, 'result.txt'), 'durable task output');
  const retry = await manager.dispatch({ ...input, workspace: ' \n\t ' }) as ExecutionRecord;
  assert.equal(retry.id, first.id); assert.equal(retry.workspace, first.workspace);
  const second = await manager.dispatch(automatic('separate-command')) as ExecutionRecord;
  assert.notEqual(second.workspace, first.workspace); assert.notEqual(second.projectId, first.projectId);
  assert.deepEqual((await readdir(managedRoot)).sort(), [first.workspace.split('/').at(-1)!, second.workspace.split('/').at(-1)!].sort());
  await assert.rejects(manager.dispatch({ ...input, prompt: 'Changed request' }), /different execution/);
  const explicitRetry = await manager.dispatch({ ...input, workspace: first.workspace }) as ExecutionRecord;
  assert.equal(explicitRetry.id, first.id); assert.equal(explicitRetry.workspaceKind, 'managed');
  await waitFor(() => store.executionGet(first.id), record => record.stopConfirmed);
  const followup = await manager.dispatch(start(first.workspace, 'explicit-managed-followup')) as ExecutionRecord;
  assert.equal(followup.workspaceKind, 'managed'); assert.equal(followup.projectId, first.projectId);
  await manager.close();
  assert.equal(await readFile(join(first.workspace, 'result.txt'), 'utf8'), 'durable task output');
  const stopped = store.executionGet(first.id); const events = store.executionEvents(first.id, 0);
  f.close(store); store = f.open();
  const changedRoot = join(f.root, 'changed-managed-root');
  const reopened = new ExecutionManager(store, f.data, executable, { managedWorkspaceRoot: changedRoot });
  f.cleanups.push(() => reopened.close());
  await reopened.initialize();
  assert.deepEqual(await reopened.dispatch(input), stopped);
  assert.deepEqual(store.executionEvents(first.id, 0), events);
  assert.equal(await readFile(join(first.workspace, 'result.txt'), 'utf8'), 'durable task output');
  await assert.rejects(stat(changedRoot), { code: 'ENOENT' });
  // A receipt retry must not silently replace a directory removed by its owner.
  await rm(first.workspace, { recursive: true });
  assert.deepEqual(await reopened.dispatch(input), stopped);
  await assert.rejects(stat(first.workspace), { code: 'ENOENT' });
});

test('execution automatic workspace validates input before filesystem creation and rejects redirected directories', async t => {
  const f = await fixture(t); const store = f.open(); const managedRoot = join(f.root, 'managed');
  const marker = join(f.root, 'invoked');
  const executable = await failingExecutable(f.root, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected launch'); process.exit(23);`);
  const manager = new ExecutionManager(store, f.data, executable, { managedWorkspaceRoot: managedRoot });
  f.cleanups.push(() => manager.close());
  const input = automatic('invalid-request');
  await assert.rejects(manager.dispatch({ ...input, tokenLimit: 79 }), /Budget cannot cover/);
  await assert.rejects(manager.dispatch({ ...input, images: ['relative.png'] }), /Image paths must be absolute/);
  await assert.rejects(manager.dispatch({ ...input, images: [join(f.root, 'missing.png')] }), { code: 'ENOENT' });
  await assert.rejects(manager.dispatch({ ...input, workspaceKind: 'managed' }), /Unknown execution field workspaceKind/);
  await assert.rejects(stat(managedRoot), { code: 'ENOENT' });
  await mkdir(managedRoot);
  const target = join(f.workspace, 'preserved.txt'); await writeFile(target, 'existing project content');
  const commandId = '../redirected';
  await symlink(f.workspace, join(managedRoot, createHash('sha256').update(commandId).digest('hex')));
  await assert.rejects(manager.dispatch(automatic(commandId)), /symbolic link/);
  assert.equal(await readFile(target, 'utf8'), 'existing project content');
  assert.deepEqual(store.executionList(), []); assert.deepEqual(store.query({ type: 'projects' }), []);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('execution explicit symlink workspace preserves canonical project grouping and writer exclusion', async t => {
  const f = await fixture(t); const store = f.open(); const alias = join(f.root, 'workspace-alias');
  await symlink(f.workspace, alias);
  const release = join(f.root, 'release');
  const executable = await failingExecutable(f.root, `const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(23); } }, 20);`);
  const manager = new ExecutionManager(store, f.data, executable, { managedWorkspaceRoot: join(f.root, 'unused') });
  f.cleanups.push(async () => { await writeFile(release, 'release for cleanup'); await manager.close(); });
  const first = await manager.dispatch(start(alias, 'explicit-alias')) as ExecutionRecord;
  assert.equal(first.workspace, f.workspace); assert.equal(first.workspaceKind, 'project');
  const retry = await manager.dispatch(start(f.workspace, 'explicit-alias')) as ExecutionRecord;
  assert.equal(retry.id, first.id); assert.equal(retry.projectId, first.projectId);
  await assert.rejects(manager.dispatch(start(f.workspace, 'overlap-alias')), /active or unverified writer/);
  await writeFile(release, 'release the real bounded probe');
  await waitFor(() => store.executionGet(first.id), record => record.stopConfirmed);
  const next = await manager.dispatch(start(f.workspace, 'next-explicit')) as ExecutionRecord;
  assert.equal(next.projectId, first.projectId); assert.equal(next.workspaceKind, 'project');
  assert.equal((store.query({ type: 'projects' }) as unknown[]).length, 1);
  await assert.rejects(stat(join(f.root, 'unused')), { code: 'ENOENT' });
});

test('execution legacy workspace receipts default to project without rewriting persisted records', async t => {
  const f = await fixture(t); let store = f.open(); const input = resolvedStart(f.workspace);
  const created = store.executionCreate(input).record; f.close(store);
  const database = join(f.data, 'supervisor.sqlite');
  const db = new DatabaseSync(database);
  try {
    const row = db.prepare('SELECT request,record FROM executions WHERE id=?').get(created.id)!;
    const request = JSON.parse(String(row.request)) as Record<string, unknown>;
    const record = JSON.parse(String(row.record)) as Record<string, unknown>;
    delete request.workspaceKind; delete record.workspaceKind;
    db.prepare('UPDATE executions SET request=?,record=? WHERE id=?').run(JSON.stringify(request), JSON.stringify(record), created.id);
  } finally { db.close(); }
  store = f.open();
  assert.deepEqual(store.executionGet(created.id), created); assert.deepEqual(store.executionList(), [created]);
  assert.deepEqual(store.executionCreate(input), { record: created, created: false });
  f.close(store);
  const check = new DatabaseSync(database);
  try {
    const row = check.prepare('SELECT request,record FROM executions WHERE id=?').get(created.id)!;
    assert.equal(Object.hasOwn(JSON.parse(String(row.record)), 'workspaceKind'), false);
    assert.equal(Object.hasOwn(JSON.parse(String(row.request)), 'workspaceKind'), false);
  } finally { check.close(); }
});

test('execution startup reconciles actual managed writer without replay or settling unknown usage', { timeout: 20_000 }, async t => {
  const f = await fixture(t); let store = f.open();
  await execute('git', ['init', '-q'], { cwd: f.workspace });
  const writes = join(f.workspace, 'writes.txt'); await writeFile(writes, 'baseline\n');
  await execute('git', ['add', 'writes.txt'], { cwd: f.workspace });
  await execute('git', ['-c', 'user.name=Integration Test', '-c', 'user.email=integration@example.invalid', 'commit', '-qm', 'isolated fixture'], { cwd: f.workspace });
  const record = store.executionCreate(resolvedStart(f.workspace)).record;
  const source = `process.on('SIGTERM', () => process.exit(0)); const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(writes)}, 'writer-start\\n'); setInterval(() => fs.appendFileSync(${JSON.stringify(writes)}, 'write\\n'), 20);`;
  const child = await spawnManagedProcess({ operationId: record.id, command: process.execPath, args: ['-e', source], cwd: f.workspace,
    onBeforeSpawn: intent => { store.executionUpdate(record.id, {}, 'process-intent', intent); },
    onIdentity: identity => { store.executionUpdate(record.id, { identity, pid: identity.pid }, 'process-identity', identity); } });
  f.cleanups.push(async () => { assert.equal((await child.terminate()).stopped, true); });
  await waitFor(() => readFile(writes, 'utf8'), bytes => bytes.includes('write\n'));
  assert.equal((await inspectProcess(child.identity)).status, 'verified');
  // This is a durable lost-turn observation scenario, not claimed vendor-live evidence.
  store.executionUpdate(record.id, { state: 'running', threadId: 'lost-observation-thread', turnId: 'lost-observation-turn' }, 'turn-observation-lost', { usage: 'unknown' });
  f.close(store); store = f.open();
  const replayMarker = join(f.root, 'would-replay');
  const executable = await failingExecutable(f.root, `require('node:fs').writeFileSync(${JSON.stringify(replayMarker)}, 'replay attempted'); process.exit(24);`);
  const manager = new ExecutionManager(store, f.data, executable); f.cleanups.push(() => manager.close());
  await manager.initialize();
  const recovered = store.executionGet(record.id); const ledger = run(store, recovered);
  assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.stopConfirmed, true); assert.equal(recovered.usageStatus, 'unknown'); assert.equal(recovered.usage, null);
  assert.equal((await inspectProcess(child.identity)).status, 'stopped');
  assert.equal(ledger.attempts[0]?.settled, false); assert.equal(ledger.attempts[0]?.actual, null); assert.equal(ledger.budget.spent, 0);
  assert.equal(ledger.operations[0]?.status, 'confirmed'); assert.equal(ledger.leases[0]?.released, true); assert.notEqual(ledger.status, 'succeeded');
  const stoppedBytes = await readFile(writes, 'utf8'); await delay(100); assert.equal(await readFile(writes, 'utf8'), stoppedBytes);
  assert.equal(stoppedBytes.split('writer-start\n').length - 1, 1); await assert.rejects(readFile(replayMarker), { code: 'ENOENT' });
  assert.ok(ledger.artifact); const artifact = JSON.parse(await readFile(ledger.artifact.path, 'utf8')) as { state: string; snapshot: { diff: string; diffDigest: string } };
  assert.equal(artifact.state, 'interrupted'); assert.ok(artifact.snapshot.diff.includes('+writer-start')); assert.equal(artifact.snapshot.diffDigest.length, 64);
  const events = store.executionEvents(record.id, 0);
  assert.ok(events.some(event => event.kind === 'process-stop-observed')); assert.ok(events.some(event => event.kind === 'workspace-captured'));
  const previousEvents = events.length; await manager.reconcile(record.id); assert.equal(store.executionEvents(record.id, 0).length, previousEvents);
  t.diagnostic(JSON.stringify({ actualManagedPid: child.identity.pid, stopConfirmed: recovered.stopConfirmed, usageSettled: ledger.attempts[0]?.settled, artifact: ledger.artifact.digest }));
});

test('execution IPC rejects direct P1 mutations of managed runs and remains queryable after restart', async t => {
  const f = await fixture(t); const store = f.open(); const seed = store.executionCreate(resolvedStart(f.workspace)).record; f.close(store);
  let service = await startService(f.data); f.cleanups.push(() => service.close());
  const inspected = await request(f.data, { id: 'inspect', method: 'execution', action: { type: 'inspect', executionId: seed.id } });
  assert.equal(inspected.ok, true);
  const record = inspected.value as ExecutionRecord;
  const queried = await request(f.data, { id: 'run', method: 'query', query: { type: 'run', projectId: record.projectId, runId: record.runId } });
  assert.equal(queried.ok, true); const ledger = queried.value as Run;
  for (const action of [{ type: 'complete' as const }, { type: 'settleAttempt' as const, attemptId: record.attemptId, actual: 0 }, { type: 'cancel' as const }]) {
    const rejected = await request(f.data, { id: randomUUID(), method: 'command', command: { type: 'act', commandId: randomUUID(), projectId: record.projectId, runId: record.runId, expectedRevision: ledger.revision, action } });
    assert.equal(rejected.ok, false); if (!rejected.ok) assert.match(rejected.error, /execution controller/);
  }
  const forged = await request(f.data, { id: 'forged-publish', method: 'command', command: { type: 'publishArtifact', commandId: 'forged-publish', projectId: record.projectId, runId: record.runId, expectedRevision: ledger.revision, artifactId: 'forged', content: 'forged evidence' } });
  assert.equal(forged.ok, false); if (!forged.ok) assert.match(forged.error, /execution controller/);
  const events = await request(f.data, { id: 'events', method: 'execution', action: { type: 'events', executionId: record.id, after: 0 } }); assert.equal(events.ok, true);
  await service.close(); service = await startService(f.data);
  assert.deepEqual(await request(f.data, { id: 'inspect', method: 'execution', action: { type: 'inspect', executionId: record.id } }), inspected);
  assert.deepEqual(await request(f.data, { id: 'events', method: 'execution', action: { type: 'events', executionId: record.id, after: 0 } }), events);
  assert.deepEqual(await request(f.data, { id: 'run', method: 'query', query: { type: 'run', projectId: record.projectId, runId: record.runId } }), queried);
});

test('execution cancellation fences an actual pending capability probe until launch resolves', { timeout: 20_000 }, async t => {
  const f = await fixture(t); const store = f.open();
  const started = join(f.root, 'probe-started'); const release = join(f.root, 'probe-release'); const targetMarker = join(f.root, 'unexpected-target');
  const executable = await failingExecutable(f.root, `const fs = require('node:fs'); if (process.argv[2] === '--version') { fs.writeFileSync(${JSON.stringify(started)}, 'real probe started'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(23); } }, 20); } else { fs.writeFileSync(${JSON.stringify(targetMarker)}, 'unexpected target invocation'); process.exit(24); }`);
  const manager = new ExecutionManager(store, f.data, executable);
  f.cleanups.push(async () => { await writeFile(release, 'release for cleanup'); await manager.close(); });
  const record = await manager.dispatch(start(f.workspace)) as ExecutionRecord;
  await fileWhenPresent(started);
  const cancelled = await manager.cancel(record.id); assert.equal(cancelled.cancelRequested, true); assert.equal(cancelled.stopConfirmed, false);
  const reconciled = await manager.reconcile(record.id); assert.equal(reconciled.stopConfirmed, false);
  await assert.rejects(manager.dispatch(start(f.workspace, 'overlapping-while-launching')), /active or unverified writer/);
  const pending = run(store, reconciled); assert.equal(pending.leases[0]?.released, false); assert.equal(pending.attempts[0]?.settled, false);
  await writeFile(release, 'release real failing probe');
  const finished = await waitFor(() => store.executionGet(record.id), value => value.stopConfirmed);
  assert.equal(finished.state, 'cancelled'); assert.equal(finished.identity, null); assert.equal(finished.threadId, null); assert.equal(finished.turnId, null);
  assert.equal(run(store, finished).attempts[0]?.settled, true); assert.equal(run(store, finished).attempts[0]?.actual, 0); assert.equal(run(store, finished).leases[0]?.released, true);
  await assert.rejects(readFile(targetMarker), { code: 'ENOENT' });
  const kinds = store.executionEvents(record.id, 0).map(event => event.kind);
  assert.equal(kinds.filter(kind => kind === 'cancel-requested').length, 1); assert.ok(!kinds.includes('process-identity')); assert.ok(!kinds.includes('turn-intent'));
});
