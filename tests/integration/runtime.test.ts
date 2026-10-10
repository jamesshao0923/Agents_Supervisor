import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { request } from '../../apps/cli/client.js';
import type { Run, VerificationCase, VerificationCatalog, VerificationPlan } from '../../packages/contracts/p1.js';
import { codexStart, type RuntimeAction, type RuntimeRecord, type RuntimeStep } from '../../packages/contracts/p3.js';
import { ExecutionManager } from '../../packages/execution/manager.js';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { captureProcessMember, inspectProcess, spawnManagedProcess, terminateProcess } from '../../packages/process-control/index.js';
import { createOwnership, readOwnership, retireOwnership, workerAlive, writeOwnership, type WorkerOwnership } from '../../packages/runtime/worker-ownership.js';

const cli = fileURLToPath(new URL('../../apps/cli/main.js', import.meta.url));
const httpFixture = fileURLToPath(new URL('../fixtures/runtime-http.js', import.meta.url));
async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > deadline) throw new Error('Real runtime state did not reach expected condition: ' + JSON.stringify(value)); await delay(30); }
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill(signal); const fallback = setTimeout(() => child.kill('SIGKILL'), 2500);
  try { await exit; } finally { clearTimeout(fallback); }
}
async function launch(data: string): Promise<ChildProcess> {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, [cli, 'serve', '--data', data], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout!.on('data', b => { output += String(b); }); child.stderr!.on('data', b => { errors += String(b); });
  try { await waitFor(() => ({ output, errors, code: child.exitCode }), v => { if (v.code !== null) throw new Error('Service died: ' + v.errors); return v.output.includes('"event":"listening"'); }); }
  catch (error) { await stop(child, 'SIGKILL'); throw error; }
  return child;
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sv-p3-')); const data = join(root, 'data'), workspacePath = join(root, 'workspace'); await mkdir(workspacePath); await mkdir(data); const workspace = await realpath(workspacePath);
  const children = new Set<ChildProcess>(), stores = new Set<SupervisorStore>();
  t.after(async () => {
    for (const child of children) await stop(child);
    const ownership = await readOwnership(data);
    if (ownership?.worker) { try { process.kill(ownership.worker.pid, 'SIGCONT'); } catch {} }
    if (ownership?.identity) { const result = await terminateProcess(ownership.identity, { graceMs: 200, killWaitMs: 5000 }); assert.equal(result.stopped, true, JSON.stringify(result)); }
    for (const store of stores) store.close(); await rm(root, { recursive: true, force: true });
  });
  const store = new SupervisorStore(data); stores.add(store);
  return { root, data, workspace, store, children, stores,
    async service() { const child = await launch(data); children.add(child); return child; },
    async http(options: { hold: boolean; deduplicate: boolean }) {
      const path = join(root, 'effects.sqlite'); const child = spawn(process.execPath, [httpFixture, path, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.add(child);
      const messages: { event: string; port?: number; operationId?: string }[] = []; let stderr = ''; child.stderr!.on('data', b => { stderr += String(b); }); child.on('message', m => messages.push(m as typeof messages[number]));
      const ready = await waitFor(() => messages.find(m => m.event === 'ready'), v => { if (child.exitCode !== null) throw new Error(stderr); return !!v; });
      const db = new DatabaseSync(path); t.after(() => db.close());
      return { child, db, messages, url: `http://127.0.0.1:${ready!.port}/effect`, effects: () => db.prepare('SELECT * FROM effects ORDER BY seq').all(), posts: () => db.prepare("SELECT * FROM requests WHERE method='POST' ORDER BY seq").all() };
    },
  };
}
async function runtime<T>(data: string, action: RuntimeAction): Promise<T> {
  const response = await request(data, { id: randomUUID(), method: 'runtime', action }); assert.equal(response.ok, true, JSON.stringify(response)); return response.value as T;
}
async function ownership(data: string): Promise<WorkerOwnership> { return (await waitFor(() => readOwnership(data), v => !!v?.ready && !!v.worker))!; }
async function submit(data: string, workspace: string, steps: RuntimeStep[], commandId = 'bounded-runtime') {
  return runtime<RuntimeRecord>(data, { type: 'submit', commandId, workspace, goal: 'Execute only the declared steps; independent verification remains required', tokenLimit: 100, verificationReserve: 20, steps });
}
function httpStep(url: string, query = true, idempotent = true): RuntimeStep { return { id: 'effect', kind: 'http', url, body: 'bounded actual business effect', idempotent, ...(query ? { queryUrl: url } : {}), timeoutMs: 30_000 }; }

test('runtime HTTP commit before response survives Worker SIGKILL with stable key and one SQLite effect', { timeout: 45_000 }, async t => {
  const f = await fixture(t), http = await f.http({ hold: true, deduplicate: true }); await f.service();
  const r = await submit(f.data, f.workspace, [httpStep(http.url)]); await waitFor(http.effects, v => v.length === 1);
  const before = f.store.runtime.operations(r.id)[0]!; assert.equal(before.state, 'started'); const old = await ownership(f.data); assert.ok(old.worker);
  process.kill(old.worker!.pid, 'SIGKILL'); await waitFor(() => workerAlive(old), v => !v);
  await runtime(f.data, { type: 'reconcile', runtimeId: r.id, commandId: 'recover-query' });
  await waitFor(() => f.store.runtime.get(r.id), v => v.phase === 'awaiting-verification');
  const after = f.store.runtime.operations(r.id)[0]!; assert.equal(after.id, before.id); assert.equal(after.attemptId, before.attemptId); assert.equal(after.state, 'confirmed');
  assert.equal(http.effects().length, 1); assert.equal(http.posts().length, 1); assert.equal(http.effects()[0]?.operation_id, before.id);
  assert.ok(http.db.prepare("SELECT * FROM requests WHERE method='GET'").all().length >= 1);
  const inspection = f.store.runtime.inspect(r.id); assert.equal(inspection.run.attempts.length, 1); assert.equal(inspection.run.budget.spent, 0); assert.equal(inspection.run.budget.verificationReserve, 20); assert.notEqual(inspection.run.status, 'succeeded'); assert.ok(inspection.checkpoints.every(c => c.valid));
  t.diagnostic(JSON.stringify({ fault: 'SQLite committed before HTTP response and Worker report', oldWorkerPid: old.worker!.pid, newWorkerPid: (await ownership(f.data)).worker!.pid, operationId: after.id, posts: 1, effects: 1 }));
});

test('runtime idempotent HTTP recovery resends the same key after lost response and has one actual effect', { timeout: 45_000 }, async t => {
  const f = await fixture(t), http = await f.http({ hold: true, deduplicate: true }); await f.service();
  const r = await submit(f.data, f.workspace, [httpStep(http.url, false, true)]); await waitFor(http.effects, v => v.length === 1); const old = await ownership(f.data); const op = f.store.runtime.operations(r.id)[0]!;
  process.kill(old.worker!.pid, 'SIGKILL'); await waitFor(() => workerAlive(old), v => !v); http.child.send({ type: 'release' });
  await runtime(f.data, { type: 'reconcile', runtimeId: r.id, commandId: 'recover-safe-idempotency' }); await waitFor(() => f.store.runtime.get(r.id), v => v.phase === 'awaiting-verification');
  assert.equal(http.posts().length, 2); assert.deepEqual(http.posts().map(row => row.operation_id), [op.id, op.id]); assert.equal(http.effects().length, 1); assert.equal(f.store.runtime.inspect(r.id).run.attempts.length, 1);
  t.diagnostic(JSON.stringify({ stableOperationId: op.id, actualPostAttempts: 2, actualSQLiteEffects: 1 }));
});

test('runtime unknown nonidempotent HTTP effect without query is preserved and never automatically retried', { timeout: 45_000 }, async t => {
  const f = await fixture(t), http = await f.http({ hold: true, deduplicate: false }); let service = await f.service();
  const r = await submit(f.data, f.workspace, [httpStep(http.url, false, false)]); await waitFor(http.effects, v => v.length === 1); const old = await ownership(f.data);
  process.kill(old.worker!.pid, 'SIGKILL'); await waitFor(() => workerAlive(old), v => !v); await stop(service, 'SIGKILL'); service = await f.service();
  await runtime(f.data, { type: 'reconcile', runtimeId: r.id, commandId: 'query-unavailable' }); await waitFor(() => f.store.runtime.get(r.id), v => v.phase === 'blocked');
  const snapshot = f.store.runtime.inspect(r.id); assert.equal(snapshot.operations[0]?.state, 'unknown'); assert.equal(snapshot.runtime.cursor, 0); assert.equal(snapshot.run.operations[0]?.status, 'unknown');
  await delay(300); assert.equal(http.posts().length, 1); assert.equal(http.effects().length, 1); assert.equal(f.store.runtime.inspect(r.id).run.attempts.length, 1);
  assert.equal((await request(f.data, { id: 'service-recovered', method: 'health' })).ok, true); t.diagnostic(JSON.stringify({ effects: 1, requests: 1, outcome: 'unknown', servicePid: service.pid }));
});

test('runtime service restart retains an alive old Worker and original declared wait history', { timeout: 45_000 }, async t => {
  const f = await fixture(t), http = await f.http({ hold: false, deduplicate: true }); let service = await f.service();
  const r = await submit(f.data, f.workspace, [{ id: 'wait', kind: 'input', prompt: 'Durable decision' }, httpStep(http.url)]); const old = await ownership(f.data); const originalEvents = f.store.runtime.events(r.id, 0);
  await stop(service, 'SIGKILL'); assert.equal(await workerAlive(old), true); service = await f.service(); const continued = await ownership(f.data);
  assert.equal(continued.owner, old.owner); assert.equal(continued.worker!.pid, old.worker!.pid); assert.equal(f.store.runtime.get(r.id).phase, 'waiting-input'); assert.deepEqual(f.store.runtime.events(r.id, 0), originalEvents);
  await runtime(f.data, { type: 'input', runtimeId: r.id, commandId: 'answer-after-restart', stepId: 'wait', text: 'approved task data' }); await waitFor(() => f.store.runtime.get(r.id), v => v.phase === 'awaiting-verification');
  assert.equal(http.effects().length, 1); assert.equal(f.store.runtime.operations(r.id).length, 2); assert.equal(f.store.runtime.inspect(r.id).run.attempts.length, 2); assert.equal((await ownership(f.data)).owner, old.owner);
  t.diagnostic(JSON.stringify({ servicePid: service.pid, survivingWorkerPid: old.worker!.pid, domainRevision: f.store.runtime.inspect(r.id).run.revision }));
});

test('runtime Worker startup stops an actual orphan workspace writer and preserves unknown effects without model replay', { timeout: 45_000 }, async t => {
  const f = await fixture(t), execute = promisify(execFile); await execute('git', ['init', '-q'], { cwd: f.workspace }); const writes = join(f.workspace, 'writes.txt'); await writeFile(writes, 'baseline\n');
  await execute('git', ['add', 'writes.txt'], { cwd: f.workspace }); await execute('git', ['-c', 'user.name=Integration Test', '-c', 'user.email=integration@example.invalid', 'commit', '-qm', 'isolated runtime recovery fixture'], { cwd: f.workspace });
  const r = f.store.runtime.submit({ type: 'submit', commandId: 'orphan-runtime', workspace: f.workspace, workspaceKind: 'project', goal: 'Recover an actual old writer', tokenLimit: 100, verificationReserve: 20, steps: [{ id: 'write', kind: 'codex', prompt: 'No model invocation in this process recovery fixture', model: 'uninvoked-model', effort: 'low', reservation: 60, timeoutMs: 30_000 }] });
  const op = f.store.runtime.claim(r.id, 'absent-old-worker')!; f.store.runtime.markStarted(op.id, 'absent-old-worker'); const input = codexStart(r, op); const execution = f.store.executionCreate({ ...input, workspace: f.workspace, workspaceKind: 'project' }, f.store.runtime.binding(op.id, 'absent-old-worker')).record;
  const child = await spawnManagedProcess({ operationId: execution.id, command: process.execPath, args: ['-e', `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(writes)},'writer-start\\n');setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},'write\\n'),20);`], cwd: f.workspace,
    onBeforeSpawn: intent => { f.store.executionUpdate(execution.id, {}, 'process-intent', intent); }, onIdentity: identity => { f.store.executionUpdate(execution.id, { identity, pid: identity.pid, state: 'running', turnIntent: true, threadId: 'lost-observation', turnId: 'lost-turn' }, 'process-identity', identity); } });
  child.detach(); t.after(async () => { assert.equal((await child.terminate()).stopped, true); });
  await waitFor(() => readFile(writes, 'utf8'), v => v.includes('write\n')); assert.equal((await inspectProcess(child.identity)).status, 'verified');
  await f.service(); await runtime(f.data, { type: 'reconcile', runtimeId: r.id, commandId: 'recover-old-writer' }); await waitFor(() => f.store.runtime.get(r.id), v => v.phase === 'blocked');
  const stopped = f.store.executionGet(execution.id), run = f.store.runtime.inspect(r.id).run;
  assert.equal(stopped.stopConfirmed, true); assert.equal(stopped.state, 'interrupted'); assert.equal(stopped.usageStatus, 'unknown'); assert.equal(stopped.usage, null); assert.equal((await inspectProcess(child.identity)).status, 'stopped');
  assert.equal(f.store.executionList().length, 1); assert.equal(f.store.runtime.operations(r.id)[0]?.state, 'unknown'); assert.equal(run.operations[0]?.status, 'unknown'); assert.equal(run.attempts.length, 1); assert.equal(run.attempts[0]?.settled, false); assert.equal(run.attempts[0]?.reservation, 60); assert.equal(run.budget.spent, 0); assert.equal(run.leases[0]?.released, true);
  const bytes = await readFile(writes, 'utf8'); await delay(150); assert.equal(await readFile(writes, 'utf8'), bytes); assert.equal(bytes.split('writer-start\n').length - 1, 1); assert.ok(run.artifact);
  const artifact = JSON.parse(await readFile(run.artifact.path, 'utf8')) as { snapshot: { diff: string } }; assert.match(artifact.snapshot.diff, /writer-start/);
  const denied = await request(f.data, { id: 'exclude-new-runtime', method: 'runtime', action: { type: 'submit', commandId: 'blocked-new-runtime', workspace: f.workspace, goal: 'Must not overlap unresolved writer effects', tokenLimit: 100, verificationReserve: 20, steps: [{ id: 'wait', kind: 'input', prompt: 'blocked' }] } }); assert.equal(denied.ok, false); assert.match(denied.error!, /unresolved/);
  const legacyController = new ExecutionManager(f.store, f.data, 'uninvoked', { scope: 'legacy' });
  for (const type of ['cancel', 'reconcile'] as const) {
    await assert.rejects(legacyController.dispatch({ type, executionId: execution.id }), /runtime/);
    const outside = await request(f.data, { id: 'outside-' + type, method: 'execution', action: { type, executionId: execution.id } }); assert.equal(outside.ok, false); assert.match(outside.error!, /runtime/);
  }
  await legacyController.close();
  const forged = await request(f.data, { id: 'outside-domain', method: 'command', command: { type: 'act', commandId: 'outside-domain', projectId: r.projectId, runId: r.runId, expectedRevision: run.revision, action: { type: 'cancel' } } }); assert.equal(forged.ok, false); assert.match(forged.error!, /controller|runtime/);
  t.diagnostic(JSON.stringify({ actualOldWriterPid: child.identity.pid, effectStatus: 'unknown', reservedTokensRetained: 60, modelInvocations: 0 }));
});

test('runtime SIGSTOP SIGCONT process suspension preserves pause input and resumes one declared effect', { timeout: 45_000 }, async t => {
  const f = await fixture(t), http = await f.http({ hold: false, deduplicate: true }); await f.service(); const r = await submit(f.data, f.workspace, [{ id: 'wait', kind: 'input', prompt: 'Input while process suspended' }, httpStep(http.url)]); const old = await ownership(f.data);
  process.kill(old.worker!.pid, 'SIGSTOP'); assert.equal(await workerAlive(old), true); assert.equal((await inspectProcess(old.identity!)).status, 'verified');
  await runtime(f.data, { type: 'pause', runtimeId: r.id, commandId: 'pause-suspended' }); await runtime(f.data, { type: 'input', runtimeId: r.id, commandId: 'answer-suspended', stepId: 'wait', text: 'durable' });
  await delay(150); assert.equal(http.effects().length, 0); assert.equal(f.store.runtime.get(r.id).phase, 'paused');
  process.kill(old.worker!.pid, 'SIGCONT'); await delay(150); assert.equal(http.effects().length, 0);
  await runtime(f.data, { type: 'resume', runtimeId: r.id, commandId: 'resume-suspended' }); await waitFor(() => f.store.runtime.get(r.id), v => v.phase === 'awaiting-verification');
  assert.equal(http.effects().length, 1); assert.equal((await ownership(f.data)).owner, old.owner); assert.deepEqual(f.store.runtime.get(r.id).inputs, { wait: 'durable' });
  t.diagnostic('This verifies real Worker process suspension via SIGSTOP/SIGCONT; it does not assert actual macOS host sleep/wake.');
});

test('runtime cancellation reaches an in-flight real HTTP request and prevents the later declared step', { timeout: 45_000 }, async t => {
  const f = await fixture(t), http = await f.http({ hold: true, deduplicate: true }); await f.service(); const r = await submit(f.data, f.workspace, [httpStep(http.url), { id: 'later', kind: 'http', url: http.url, body: 'must not dispatch', idempotent: true, timeoutMs: 1000 }]);
  await waitFor(http.effects, v => v.length === 1); await runtime(f.data, { type: 'cancel', runtimeId: r.id, commandId: 'cancel-inflight' });
  await waitFor(() => http.posts(), v => v[0]?.aborted === 1); await waitFor(() => f.store.runtime.operations(r.id), v => v[0]?.state === 'unknown' || v[0]?.state === 'cancelled');
  http.child.send({ type: 'release' }); await delay(150); const snapshot = f.store.runtime.inspect(r.id);
  assert.equal(snapshot.runtime.phase, 'cancelled'); assert.equal(snapshot.runtime.cursor, 0); assert.equal(snapshot.operations.length, 1); assert.equal(snapshot.run.status, 'cancelled'); assert.equal(http.posts().length, 1); assert.equal(http.effects().length, 1);
  const rejection = await request(f.data, { id: 'forbid-resume', method: 'runtime', action: { type: 'resume', runtimeId: r.id, commandId: 'resume-cancelled' } }); assert.equal(rejection.ok, false);
  const start = { type: 'start' as const, commandId: 'legacy-overlap-cancelled-unknown', workspace: f.workspace, prompt: 'Must not bypass runtime uncertainty', model: 'uninvoked', effort: 'low', timeoutMs: 1000, tokenLimit: 100, reservation: 60, verificationReserve: 20 };
  assert.throws(() => f.store.executionCreate({ ...start, workspaceKind: 'project' }), /unresolved runtime/);
  const legacy = await request(f.data, { id: 'legacy-overlap', method: 'execution', action: start }); assert.equal(legacy.ok, false); assert.match(legacy.error!, /unresolved runtime/); assert.equal(f.store.executionList().length, 0);
});

async function publishCrash(data: string, command: unknown, point: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/persistence-crash.js', import.meta.url)), data, point, JSON.stringify(command)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = ''; child.stdout!.on('data', b => { output += String(b); }); child.stderr!.on('data', b => { stderr += String(b); });
  try { await waitFor(() => output, v => { if (child.exitCode !== null) throw new Error('Publication fixture died: ' + stderr); return v.includes(point); }); await stop(child, 'SIGKILL'); }
  finally { await stop(child, 'SIGKILL'); }
}

test('runtime recovery keeps original frozen plan budget failure history and product catalog publication atomic', { timeout: 45_000 }, async t => {
  const f = await fixture(t); const r = f.store.runtime.submit({ type: 'submit', commandId: 'catalog-runtime', workspace: f.workspace, workspaceKind: 'project', goal: 'Independent product plan recovery', tokenLimit: 100, verificationReserve: 20, steps: [{ id: 'one', kind: 'input', prompt: 'one' }, { id: 'two', kind: 'input', prompt: 'two' }] });
  const item: VerificationCase = { id: 'acceptance', revision: 1, criterionIds: ['independent-acceptance'], definition: 'Read actual candidate bytes', status: 'active', replaces: [], defectRefs: ['RECOVERY-PLAN'] };
  f.store.command({ type: 'proposeVerificationChange', commandId: 'initial-propose', projectId: r.projectId, change: { id: 'initial', baseVersion: 0, reason: 'Independent checks', cases: [item], status: 'proposed' } });
  f.store.command({ type: 'publishVerificationChange', commandId: 'initial-publish', projectId: r.projectId, changeId: 'initial', baseVersion: 0 });
  const published = f.store.command({ type: 'publishArtifact', commandId: 'candidate', projectId: r.projectId, runId: r.runId, expectedRevision: f.store.runtime.inspect(r.id).run.revision, artifactId: 'candidate', content: 'actual candidate bytes' }).value as Run;
  const plan: VerificationPlan = { id: 'frozen', catalogVersion: 1, contractVersion: 1, artifactDigest: published.artifact!.digest, cases: [{ id: item.id, revision: 1, parameters: { recovery: 'original' } }] };
  f.store.command({ type: 'freezeVerificationPlan', commandId: 'freeze', projectId: r.projectId, runId: r.runId, plan });
  f.store.runtime.control({ type: 'input', commandId: 'one-input', runtimeId: r.id, stepId: 'one', text: 'provided' }); const op = f.store.runtime.claim(r.id, 'manual-accounting')!;
  f.store.runtime.report(op.id, 'manual-accounting', { messageId: 'original-failure', outcome: 'unknown', result: null, error: 'Keep failure trace' });
  const frozen = f.store.runtime.checkpoint(r.id)!; assert.deepEqual(frozen.frozenPlans, [plan]); const failureEvents = f.store.runtime.events(r.id, 0); const budget = frozen.budget;
  const next = { ...item, revision: 2, definition: 'Additional actual readback' };
  f.store.command({ type: 'proposeVerificationChange', commandId: 'next-propose', projectId: r.projectId, change: { id: 'next', baseVersion: 1, reason: 'Add coverage', cases: [item, next], status: 'proposed' } });
  const command = { type: 'publishVerificationChange' as const, commandId: 'next-publish', projectId: r.projectId, changeId: 'next', baseVersion: 1 };
  await publishCrash(f.data, command, 'beforeCommit'); let reopened = new SupervisorStore(f.data); f.stores.add(reopened);
  assert.equal((reopened.query({ type: 'catalog', projectId: r.projectId }) as VerificationCatalog).version, 1);
  await publishCrash(f.data, command, 'afterCommit'); reopened.close(); f.stores.delete(reopened); reopened = new SupervisorStore(f.data); f.stores.add(reopened);
  const catalog = reopened.query({ type: 'catalog', projectId: r.projectId }) as VerificationCatalog; assert.equal(catalog.version, 2); assert.deepEqual(reopened.command(command).value, catalog);
  assert.deepEqual(reopened.query({ type: 'plans', projectId: r.projectId, runId: r.runId }), [plan]); assert.deepEqual(reopened.runtime.checkpoint(r.id)?.frozenPlans, [plan]); assert.deepEqual(reopened.runtime.checkpoint(r.id)?.budget, budget); assert.deepEqual(reopened.runtime.events(r.id, 0), failureEvents); assert.equal(reopened.runtime.operations(r.id)[0]?.state, 'unknown');
  assert.equal(await readFile(published.artifact!.path, 'utf8'), 'actual candidate bytes');
  const db = new DatabaseSync(join(f.data, 'supervisor.sqlite')); try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_coverage WHERE project_id=? AND version=2').get(r.projectId)?.n, 2); assert.equal(db.prepare('SELECT status FROM verification_changes WHERE project_id=? AND id=?').get(r.projectId, 'next')?.status, 'published'); } finally { db.close(); }
});


test('runtime startup ownership recovery stops the released process scope before receipt takeover and fences stale publishers', { timeout: 45_000 }, async t => {
  const f = await fixture(t); let old = (await createOwnership(f.data))!; assert.ok(old);
  assert.equal(await createOwnership(f.data), null); await assert.rejects(retireOwnership(f.data, old), /launcher.*preparing/); assert.deepEqual(await readOwnership(f.data), old);
  // A separate actual launcher dies while its released target has not published
  // a Worker member receipt. The guardian receipt alone does not mean stopped.
  const launcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); f.children.add(launcher);
  const launcherMember = await waitFor(() => captureProcessMember(launcher.pid!), v => v !== null); assert.ok(launcherMember); old = { ...old, launcher: launcherMember }; await writeOwnership(f.data, old);
  const writes = join(f.root, 'startup-writes.txt'); await writeFile(writes, '');
  const target = await spawnManagedProcess({ operationId: 'runtime-worker-' + old.owner, command: process.execPath, args: ['-e', `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},'startup-target-write\\n'),20);`], cwd: f.data,
    onBeforeSpawn: async intent => { old = { ...old, intent }; await writeOwnership(f.data, old); },
    onIdentity: async identity => { old = { ...old, identity }; await writeOwnership(f.data, old); },
  }); target.detach(); t.after(async () => { assert.equal((await target.terminate()).stopped, true); });
  await waitFor(() => readFile(writes, 'utf8'), bytes => bytes.includes('startup-target-write'));
  assert.equal(old.ready, false); assert.equal(old.worker, null); assert.equal(await workerAlive(old), false); assert.equal((await inspectProcess(target.identity)).status, 'verified');
  await assert.rejects(retireOwnership(f.data, old), /launcher.*preparing/); assert.deepEqual(await readOwnership(f.data), old); assert.equal((await inspectProcess(target.identity)).status, 'verified');
  const members = (await inspectProcess(target.identity)).members; const targetMember = members.find(member => member.pid !== target.identity.pid)!; assert.ok(targetMember);
  await stop(launcher, 'SIGKILL'); assert.equal(await captureProcessMember(launcherMember.pid), null);
  const published = { ...old, worker: targetMember, ready: true }; await writeOwnership(f.data, published);
  assert.equal(await workerAlive(published), true); await assert.rejects(retireOwnership(f.data, published), /worker remains active/); assert.deepEqual(await readOwnership(f.data), published);
  await writeOwnership(f.data, old); await retireOwnership(f.data, old);
  assert.equal((await inspectProcess(target.identity)).status, 'stopped'); assert.equal(await readOwnership(f.data), null);
  const stoppedBytes = await readFile(writes, 'utf8'); await delay(100); assert.equal(await readFile(writes, 'utf8'), stoppedBytes);
  const replacement = (await createOwnership(f.data))!; assert.ok(replacement); assert.notEqual(replacement.owner, old.owner);
  await assert.rejects(writeOwnership(f.data, published), /Stale runtime worker|replaced/); assert.deepEqual(await readOwnership(f.data), replacement);
  t.diagnostic(JSON.stringify({ actualDeadLauncherPid: launcherMember.pid, oldScopePid: target.identity.pid, actualTargetPid: targetMember.pid, oldReady: false, oldWorkerReceipt: null, scopeStoppedBeforeTakeover: true, stalePublisherRejected: true }));
});
