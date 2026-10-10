import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Command, Run, RunAction, StoredEvent, VerificationCase, VerificationCatalog, VerificationChange, VerificationPlan } from '../../packages/contracts/p1.js';
import { SupervisorStore } from '../../packages/persistence/store.js';

function fixture(t: TestContext): { root: string; open: (fault?: (point: string) => void) => SupervisorStore; close: (store: SupervisorStore) => void } {
  const root = mkdtempSync(join(tmpdir(), 'supervisor-p1-persistence-'));
  const opened = new Set<SupervisorStore>();
  t.after(() => { for (const store of opened) store.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    root,
    open(fault) { const store = new SupervisorStore(root, fault ? { fault } : {}); opened.add(store); return store; },
    close(store) { store.close(); opened.delete(store); },
  };
}

function seed(store: SupervisorStore, projectId = 'project', runId = 'run'): Run {
  store.command({ commandId: `project-${projectId}`, type: 'createProject', project: { id: projectId, name: 'Real project' } });
  return store.command({ commandId: `run-${projectId}-${runId}`, type: 'createRun', input: {
    id: runId, projectId, contract: { version: 1, goal: 'Produce verified artifact', criteria: [{ id: 'criterion', description: 'Artifact correct', required: true }] },
    nodes: [{ id: 'one', dependencies: [], required: true }, { id: 'two', dependencies: [], required: false }], budget: { limit: 10, verificationReserve: 2 },
  } }).value as Run;
}
function getRun(store: SupervisorStore, projectId = 'project', runId = 'run'): Run {
  return store.query({ type: 'run', projectId, runId }) as Run;
}
function act(store: SupervisorStore, action: RunAction, commandId: string): Run {
  return store.command({ type: 'act', commandId, projectId: 'project', runId: 'run', expectedRevision: getRun(store).revision, action }).value as Run;
}
function publishArtifact(store: SupervisorStore, content = 'actual bytes', artifactId = 'artifact'): Run {
  return store.command({ type: 'publishArtifact', commandId: `publish-${artifactId}`, projectId: 'project', runId: 'run',
    expectedRevision: getRun(store).revision, content, artifactId }).value as Run;
}
const originalCase: VerificationCase = { id: 'old', revision: 1, criterionIds: ['criterion'], definition: 'Reject broken artifacts', status: 'active', replaces: [], defectRefs: ['DEFECT-7'] };
function propose(store: SupervisorStore, change: VerificationChange, projectId = 'project'): void {
  store.command({ type: 'proposeVerificationChange', commandId: `propose-${projectId}-${change.id}`, projectId, change });
}
function publish(store: SupervisorStore, changeId: string, baseVersion: number, projectId = 'project'): VerificationCatalog {
  return store.command({ type: 'publishVerificationChange', commandId: `catalog-${projectId}-${changeId}`, projectId, changeId, baseVersion }).value as VerificationCatalog;
}
function firstCatalog(store: SupervisorStore): VerificationCatalog {
  propose(store, { id: 'initial', baseVersion: 0, reason: 'Register required checks', cases: [originalCase], status: 'proposed' });
  return publish(store, 'initial', 0);
}

async function child(root: string, command: Command, point: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const path = fileURLToPath(new URL('../fixtures/persistence-crash.js', import.meta.url));
  const processChild = spawn(process.execPath, [path, root, point, JSON.stringify(command)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let killed = false;
  const timeout = setTimeout(() => processChild.kill('SIGKILL'), 10_000);
  processChild.stdout.on('data', data => {
    stdout += String(data);
    if (!killed && stdout.includes(`"point":"${point}"`)) { killed = true; processChild.kill('SIGKILL'); }
  });
  processChild.stderr.on('data', data => { stderr += String(data); });
  return await new Promise((resolve, reject) => {
    processChild.once('error', error => { clearTimeout(timeout); reject(error); });
    processChild.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}

test('persistence migrates real disk database and reopens state events budgets and receipts', (t) => {
  const f = fixture(t); let store = f.open(); seed(store);
  act(store, { type: 'startAttempt', attemptId: 'attempt', nodeId: 'one', contractVersion: 1, reservation: 5, purpose: 'execution', resources: ['workspace'] }, 'start');
  act(store, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'succeeded' }, 'finish');
  act(store, { type: 'settleAttempt', attemptId: 'attempt', actual: 3 }, 'settle');
  const before = getRun(store); const events = store.query({ type: 'events', projectId: 'project', after: 0 });
  f.close(store);
  // A real v1 fixture retains all core records while lacking the additive v2 entities.
  const old = new DatabaseSync(join(f.root, 'supervisor.sqlite'));
  old.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE execution_events; DROP TABLE executions;
    DROP TABLE verification_plans; DROP TABLE verification_replacements; DROP TABLE verification_coverage;
    DROP TABLE verification_catalog_cases; DROP TABLE verification_cases; DROP TABLE verification_catalog_heads;
    DROP TABLE verification_catalogs; DROP TABLE verification_changes;
    DELETE FROM schema_migrations WHERE version>1; PRAGMA user_version=1;`);
  old.close();
  store = f.open();
  assert.deepEqual(getRun(store), before); assert.deepEqual(store.query({ type: 'events', projectId: 'project', after: 0 }), events);
  assert.equal(getRun(store).budget.spent, 3); assert.equal(getRun(store).attempts[0]?.settled, true);
  assert.deepEqual(store.query({ type: 'catalog', projectId: 'project' }), null);
  const raw = new DatabaseSync(join(f.root, 'supervisor.sqlite'));
  assert.equal(raw.prepare('PRAGMA user_version').get()?.['user_version'], 3);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.['n'], 3);
  assert.equal(raw.prepare('PRAGMA journal_mode').get()?.['journal_mode'], 'wal'); raw.close();
  const repeated = store.command({ type: 'act', commandId: 'settle', projectId: 'project', runId: 'run', expectedRevision: 2, action: { type: 'settleAttempt', attemptId: 'attempt', actual: 3 } });
  assert.deepEqual(repeated.value, before);
});

test('persistence refuses future schema without overwriting existing database data', (t) => {
  const f = fixture(t); const store = f.open(); seed(store); f.close(store);
  const raw = new DatabaseSync(join(f.root, 'supervisor.sqlite')); raw.exec('PRAGMA user_version=99'); raw.close();
  assert.throws(() => f.open(), /Unsupported database schema version 99/);
  const check = new DatabaseSync(join(f.root, 'supervisor.sqlite'));
  assert.equal(check.prepare('PRAGMA user_version').get()?.['user_version'], 99);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM runs').get()?.['n'], 1); check.close();
});

test('persistence rolls back staged state event reservation and command receipt together', (t) => {
  const f = fixture(t); let store = f.open(); seed(store); const before = getRun(store);
  const initialEvents = store.query({ type: 'events', projectId: 'project', after: 0 }); f.close(store);
  store = f.open(point => { if (point === 'beforeCommit') throw new Error('controlled transaction failure'); });
  const command: Command = { type: 'act', commandId: 'retryable', projectId: 'project', runId: 'run', expectedRevision: before.revision,
    action: { type: 'startAttempt', attemptId: 'attempt', nodeId: 'one', contractVersion: 1, reservation: 8, purpose: 'execution', resources: ['workspace'] } };
  assert.throws(() => store.command(command), /controlled transaction failure/); f.close(store); store = f.open();
  assert.deepEqual(getRun(store), before); assert.deepEqual(store.query({ type: 'events', projectId: 'project', after: 0 }), initialEvents);
  const raw = new DatabaseSync(join(f.root, 'supervisor.sqlite'));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE command_id=?').get('retryable')?.['n'], 0); raw.close();
  assert.equal((store.command(command).value as Run).attempts[0]?.reservation, 8);
});

test('persistence canonical command receipts reject changed payloads and isolate project cursors', (t) => {
  const f = fixture(t); const store = f.open(); seed(store); seed(store, 'other');
  const command: Command = { type: 'act', commandId: 'cancel', projectId: 'project', runId: 'run', expectedRevision: 0, action: { type: 'cancel' } };
  const result = store.command(command);
  const reordered = { action: { type: 'cancel' }, expectedRevision: 0, runId: 'run', projectId: 'project', commandId: 'cancel', type: 'act' } as Command;
  assert.deepEqual(store.command(reordered), result);
  assert.throws(() => store.command({ ...command, expectedRevision: 1 }), /different request/);
  assert.throws(() => store.command({ ...command, commandId: 'stale', action: { type: 'pause' } }), /revision conflict/);
  const other = store.query({ type: 'events', projectId: 'other', after: 0 }) as StoredEvent[];
  assert.ok(other.every(event => event.projectId === 'other'));
  assert.deepEqual(store.query({ type: 'events', projectId: 'project', after: result.eventSeq }), []);
  assert.equal(getRun(store, 'other').status, 'ready');
  assert.throws(() => store.query({ type: 'run', projectId: 'other', runId: 'absent' }), /Run not found in project/);
  assert.throws(() => store.command({ type: 'act', commandId: 'unknown', projectId: 'absent', runId: 'run', expectedRevision: 0, action: { type: 'cancel' } }), /Project not found/);
});

test('persistence simultaneous real writers cannot oversubscribe budget reservations', async (t) => {
  const f = fixture(t); const store = f.open(); seed(store); f.close(store);
  const command = (name: string, nodeId: string): Command => ({ type: 'act', commandId: name, projectId: 'project', runId: 'run', expectedRevision: 0,
    action: { type: 'startAttempt', attemptId: name, nodeId, contractVersion: 1, reservation: 6, purpose: 'execution', resources: [] } });
  const results = await Promise.all([child(f.root, command('writer-one', 'one'), 'never'), child(f.root, command('writer-two', 'two'), 'never')]);
  assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
  assert.match(results.find(result => result.code === 1)!.stderr, /revision conflict/);
  const reopened = f.open(); const run = getRun(reopened);
  assert.equal(run.attempts.length, 1); assert.equal(run.attempts[0]?.reservation, 6);
  const remaining = run.nodes.find(node => node.status === 'pending')!;
  assert.throws(() => act(reopened, { type: 'startAttempt', attemptId: 'too-much', nodeId: remaining.id, contractVersion: 1, reservation: 6, purpose: 'execution', resources: [] }, 'too-much'), /insufficient budget/);
});

test('persistence global resource keys reject cross run leases until terminal owner releases', (t) => {
  const f = fixture(t); const store = f.open(); seed(store); seed(store, 'other');
  act(store, { type: 'startAttempt', attemptId: 'owner', nodeId: 'one', contractVersion: 1, reservation: 1, purpose: 'execution', resources: ['shared-resource'] }, 'owner');
  const competitor: Command = { type: 'act', commandId: 'competitor', projectId: 'other', runId: 'run', expectedRevision: 0,
    action: { type: 'startAttempt', attemptId: 'other-owner', nodeId: 'one', contractVersion: 1, reservation: 1, purpose: 'execution', resources: ['shared-resource'] } };
  assert.throws(() => store.command(competitor), /already leased/);
  act(store, { type: 'finishAttempt', attemptId: 'owner', outcome: 'succeeded' }, 'finish-owner');
  assert.throws(() => store.command(competitor), /already leased/);
  act(store, { type: 'releaseLease', resource: 'shared-resource', attemptId: 'owner' }, 'release-owner');
  assert.equal((store.command(competitor).value as Run).leases[0]?.resource, 'shared-resource');
});

test('persistence SIGKILL before commit preserves no partial state event budget or receipt', async (t) => {
  const f = fixture(t); const store = f.open(); const before = seed(store); const events = store.query({ type: 'events', projectId: 'project', after: 0 }); f.close(store);
  const command: Command = { type: 'act', commandId: 'killed-before', projectId: 'project', runId: 'run', expectedRevision: 0,
    action: { type: 'startAttempt', attemptId: 'attempt', nodeId: 'one', contractVersion: 1, reservation: 6, purpose: 'execution', resources: ['workspace'] } };
  const result = await child(f.root, command, 'beforeCommit'); assert.equal(result.signal, 'SIGKILL'); assert.match(result.stdout, /beforeCommit/);
  const reopened = f.open(); assert.deepEqual(getRun(reopened), before); assert.deepEqual(reopened.query({ type: 'events', projectId: 'project', after: 0 }), events);
  assert.equal((reopened.command(command).value as Run).attempts.length, 1);
});

test('persistence SIGKILL after commit retains state event budget and idempotent receipt', async (t) => {
  const f = fixture(t); const store = f.open(); seed(store); f.close(store);
  const command: Command = { type: 'act', commandId: 'killed-after', projectId: 'project', runId: 'run', expectedRevision: 0,
    action: { type: 'startAttempt', attemptId: 'attempt', nodeId: 'one', contractVersion: 1, reservation: 6, purpose: 'execution', resources: ['workspace'] } };
  const result = await child(f.root, command, 'afterCommit'); assert.equal(result.signal, 'SIGKILL'); assert.match(result.stdout, /afterCommit/);
  const reopened = f.open(); const run = getRun(reopened); assert.equal(run.attempts.length, 1); assert.equal(run.attempts[0]?.reservation, 6);
  const events = reopened.query({ type: 'events', projectId: 'project', after: 0 }) as StoredEvent[];
  const receipt = reopened.command(command); assert.deepEqual(receipt.value, run); assert.equal(receipt.eventSeq, events.at(-1)?.seq);
  assert.deepEqual(reopened.query({ type: 'events', projectId: 'project', after: 0 }), events);
});

test('persistence durable artifact orphan remains invisible after real process termination', async (t) => {
  const f = fixture(t); const store = f.open(); seed(store); f.close(store);
  const command: Command = { type: 'publishArtifact', commandId: 'orphan', projectId: 'project', runId: 'run', expectedRevision: 0, artifactId: 'candidate', content: 'Durable but unpublished bytes' };
  const result = await child(f.root, command, 'afterSnapshot'); assert.equal(result.signal, 'SIGKILL'); assert.match(result.stdout, /afterSnapshot/);
  const files = readdirSync(join(f.root, 'objects')); assert.equal(files.length, 1); assert.match(files[0]!, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(f.root, 'objects', files[0]!), 'utf8'), command.content);
  const reopened = f.open(); assert.equal(getRun(reopened).artifact, null);
  const raw = new DatabaseSync(join(f.root, 'supervisor.sqlite')); assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM artifacts').get()?.['n'], 0); raw.close();
  assert.equal((reopened.command(command).value as Run).artifact?.id, 'candidate');
});

test('persistence published artifact digest checks reject tampering missing bytes and arbitrary paths', (t) => {
  const f = fixture(t); const store = f.open(); seed(store);
  const run = publishArtifact(store); const artifact = run.artifact!;
  assert.equal(readFileSync(artifact.path, 'utf8'), 'actual bytes');
  assert.throws(() => act(store, { type: 'setArtifact', artifact: { ...artifact, path: join(f.root, 'external') } }, 'external'), /must be published/);
  assert.throws(() => store.command({ type: 'publishArtifact', commandId: 'overwrite', projectId: 'project', runId: 'run', expectedRevision: run.revision, artifactId: artifact.id, content: 'replacement' }), /immutable/);
  writeFileSync(artifact.path, 'external edit');
  assert.throws(() => getRun(store), /digest mismatch/);
  assert.throws(() => store.command({ type: 'act', commandId: 'complete-tampered', projectId: 'project', runId: 'run', expectedRevision: run.revision, action: { type: 'complete' } }), /digest mismatch/);
  rmSync(artifact.path); assert.throws(() => getRun(store), /ENOENT/);
});

test('persistence rejects symlink object directories and records actual permission failure without publication', (t) => {
  const f = fixture(t); const store = f.open(); seed(store); const before = getRun(store);
  const objects = join(f.root, 'objects'); chmodSync(objects, 0o500);
  try {
    assert.throws(() => store.command({ type: 'publishArtifact', commandId: 'unwritable', projectId: 'project', runId: 'run', expectedRevision: 0, artifactId: 'denied', content: 'cannot write' }), /EACCES|EPERM/);
    assert.deepEqual(getRun(store), before);
  } finally { chmodSync(objects, 0o700); }
  f.close(store); rmSync(objects, { recursive: true });
  // Point at an existing directory without granting the writer a different managed root.
  symlinkSync(f.root, objects, 'dir');
  assert.throws(() => f.open(), /Object directory cannot be a symbolic link/);
  assert.equal(readdirSync(f.root).includes('outside'), false);
});

test('persistence unwritable real database refuses writes and preserves previous committed data', (t) => {
  const f = fixture(t); const store = f.open(); const before = seed(store); f.close(store);
  const database = join(f.root, 'supervisor.sqlite'); chmodSync(database, 0o400); chmodSync(f.root, 0o500);
  try { assert.throws(() => f.open(), /unable to open database|readonly|EACCES|EPERM/); }
  finally { chmodSync(f.root, 0o700); chmodSync(database, 0o600); }
  const reopened = f.open(); assert.deepEqual(getRun(reopened), before);
  assert.equal((reopened.query({ type: 'events', projectId: 'project', after: 0 }) as StoredEvent[]).length, 2);
});

test('persistence project verification catalogs retain immutable revisions coverage and defect inheritance', (t) => {
  const f = fixture(t); const store = f.open(); seed(store); seed(store, 'other'); const first = firstCatalog(store);
  assert.deepEqual(store.query({ type: 'catalog', projectId: 'other' }), null);
  assert.throws(() => store.command({ type: 'publishVerificationChange', commandId: 'foreign', projectId: 'other', changeId: 'initial', baseVersion: 0 }), /not found in project/);
  assert.throws(() => propose(store, { id: 'overwrite', baseVersion: 1, reason: 'Overwrite', status: 'proposed', cases: [{ ...originalCase, definition: 'different assertions' }] }), /cannot be overwritten/);
  const retired = { ...originalCase, revision: 2, status: 'retired' as const };
  const replacement: VerificationCase = { ...originalCase, id: 'new', replaces: ['old'], defectRefs: [] };
  assert.throws(() => propose(store, { id: 'lost-defect', baseVersion: 1, reason: 'Bad replacement', status: 'proposed', cases: [originalCase, retired, replacement] }), /drops defect reference/);
  replacement.defectRefs = ['DEFECT-7'];
  propose(store, { id: 'replacement', baseVersion: 1, reason: 'Preserve actual fault coverage', status: 'proposed', cases: [originalCase, retired, replacement] });
  const second = publish(store, 'replacement', 1); assert.equal(second.version, 2); assert.deepEqual(second.cases, [originalCase, retired, replacement]);
  const raw = new DatabaseSync(join(f.root, 'supervisor.sqlite'));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM verification_cases').get()?.['n'], 3);
  assert.equal(raw.prepare('SELECT replaced_id FROM verification_replacements WHERE version=2').get()?.['replaced_id'], 'old');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM verification_coverage WHERE version=2').get()?.['n'], 3); raw.close();
  assert.equal(JSON.parse(readFileSync(first.snapshotPath, 'utf8')).version, 1);
  assert.equal((store.query({ type: 'changes', projectId: 'project' }) as VerificationChange[]).find(change => change.id === 'replacement')?.status, 'published');
});

test('persistence stale verification proposal cannot publish over a newer catalog pointer', (t) => {
  const f = fixture(t); const store = f.open(); seed(store); firstCatalog(store);
  const next = { ...originalCase, revision: 2, definition: 'Extended assertions' };
  for (const id of ['first', 'second']) propose(store, { id, baseVersion: 1, reason: 'Extend check', cases: [originalCase, next], status: 'proposed' });
  publish(store, 'first', 1);
  assert.throws(() => publish(store, 'second', 1), /base version conflict/);
  assert.equal((store.query({ type: 'catalog', projectId: 'project' }) as VerificationCatalog).version, 2);
  assert.equal((store.query({ type: 'changes', projectId: 'project' }) as VerificationChange[]).find(change => change.id === 'second')?.status, 'proposed');
});

test('persistence killed catalog snapshot publishes neither pointer coverage nor proposal status', async (t) => {
  const f = fixture(t); const store = f.open(); seed(store);
  propose(store, { id: 'initial', baseVersion: 0, reason: 'Register checks', cases: [originalCase], status: 'proposed' }); f.close(store);
  const command: Command = { type: 'publishVerificationChange', commandId: 'publish-killed', projectId: 'project', changeId: 'initial', baseVersion: 0 };
  const result = await child(f.root, command, 'afterSnapshot'); assert.equal(result.signal, 'SIGKILL'); assert.match(result.stdout, /afterSnapshot/);
  let reopened = f.open(); assert.equal(reopened.query({ type: 'catalog', projectId: 'project' }), null);
  assert.equal((reopened.query({ type: 'changes', projectId: 'project' }) as VerificationChange[])[0]?.status, 'proposed');
  const raw = new DatabaseSync(join(f.root, 'supervisor.sqlite'));
  for (const table of ['verification_catalog_heads', 'verification_catalogs', 'verification_cases', 'verification_coverage', 'verification_replacements']) {
    assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n'], 0, table);
  } raw.close();
  f.close(reopened);
  const staged = await child(f.root, command, 'beforeCommit'); assert.equal(staged.signal, 'SIGKILL'); assert.match(staged.stdout, /beforeCommit/);
  reopened = f.open(); assert.equal(reopened.query({ type: 'catalog', projectId: 'project' }), null);
  assert.equal((reopened.query({ type: 'changes', projectId: 'project' }) as VerificationChange[])[0]?.status, 'proposed');
  const stagedCheck = new DatabaseSync(join(f.root, 'supervisor.sqlite'));
  for (const table of ['verification_catalog_heads', 'verification_catalogs', 'verification_cases', 'verification_coverage', 'verification_replacements']) {
    assert.equal(stagedCheck.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n'], 0, table);
  } stagedCheck.close(); f.close(reopened);
  const committed = await child(f.root, command, 'afterCommit'); assert.equal(committed.signal, 'SIGKILL'); assert.match(committed.stdout, /afterCommit/);
  reopened = f.open(); const catalog = reopened.query({ type: 'catalog', projectId: 'project' }) as VerificationCatalog;
  assert.equal(catalog.version, 1); assert.deepEqual(reopened.command(command).value, catalog);
  assert.equal((reopened.query({ type: 'changes', projectId: 'project' }) as VerificationChange[])[0]?.status, 'published');
});

test('persistence frozen plans retain original catalog and reject changed revisions candidates and projects', (t) => {
  const f = fixture(t); let store = f.open(); seed(store); seed(store, 'other'); publishArtifact(store); firstCatalog(store);
  const plan: VerificationPlan = { id: 'frozen', catalogVersion: 1, contractVersion: 1, artifactDigest: getRun(store).artifact!.digest,
    cases: [{ id: 'old', revision: 1, parameters: { environment: 'real-disk' } }] };
  store.command({ type: 'freezeVerificationPlan', commandId: 'freeze', projectId: 'project', runId: 'run', plan });
  assert.throws(() => store.command({ type: 'freezeVerificationPlan', commandId: 'change-frozen', projectId: 'project', runId: 'run', plan: { ...plan, cases: [{ id: 'old', revision: 1, parameters: { environment: 'changed' } }] } }), /UNIQUE/);
  assert.throws(() => store.command({ type: 'freezeVerificationPlan', commandId: 'bad-candidate', projectId: 'project', runId: 'run', plan: { ...plan, id: 'wrong', artifactDigest: '0'.repeat(64) } }), /candidate mismatch/);
  assert.throws(() => store.command({ type: 'freezeVerificationPlan', commandId: 'foreign-freeze', projectId: 'other', runId: 'run', plan }), /Catalog version not found in project/);
  const next = { ...originalCase, revision: 2, definition: 'New checks' };
  propose(store, { id: 'update', baseVersion: 1, reason: 'Check extra edge', cases: [originalCase, next], status: 'proposed' }); publish(store, 'update', 1);
  assert.deepEqual(store.query({ type: 'plans', projectId: 'project', runId: 'run' }), [plan]);
  assert.throws(() => store.command({ type: 'freezeVerificationPlan', commandId: 'old-catalog', projectId: 'project', runId: 'run', plan: { ...plan, id: 'new-plan' } }), /current published catalog/);
  assert.throws(() => store.command({ type: 'freezeVerificationPlan', commandId: 'old-case', projectId: 'project', runId: 'run', plan: { ...plan, id: 'new-plan', catalogVersion: 2 } }), /active current case revision/);
  f.close(store); store = f.open(); assert.deepEqual(store.query({ type: 'plans', projectId: 'project', runId: 'run' }), [plan]);
});

test('persistence catalog file edits invalidate reads plans and subsequent publication', (t) => {
  const f = fixture(t); const store = f.open(); seed(store); const catalog = firstCatalog(store);
  writeFileSync(catalog.snapshotPath, 'hand edited definition');
  assert.throws(() => store.query({ type: 'catalog', projectId: 'project' }), /digest mismatch/);
  assert.throws(() => propose(store, { id: 'next', baseVersion: 1, reason: 'Next', cases: [originalCase], status: 'proposed' }), /digest mismatch/);
});

test('persistence damaged artifacts block verification while stopping accounting and reconciliation remain writable', (t) => {
  const f = fixture(t); const store = f.open(); seed(store);
  act(store, { type: 'startAttempt', attemptId: 'active', nodeId: 'one', contractVersion: 1, reservation: 4, purpose: 'execution', resources: ['resource'] }, 'damage-start');
  let run = publishArtifact(store);
  const evidence = { id: 'verified-before-edit', criterionId: 'criterion', contractVersion: 1, artifactDigest: run.artifact!.digest, verdict: 'passed' as const, verifierVersion: 'real-p1-reference' };
  run = act(store, { type: 'recordEvidence', evidence }, 'before-edit-evidence');
  run = act(store, { type: 'setOperation', attemptId: 'active', operationId: 'operation', status: 'unknown' }, 'before-edit-operation');
  writeFileSync(run.artifact!.path, 'damaged actual candidate bytes');
  const mutate = (action: RunAction, commandId: string): Run => {
    run = store.command({ type: 'act', commandId, projectId: 'project', runId: 'run', expectedRevision: run.revision, action }).value as Run;
    return run;
  };
  for (const action of [{ type: 'complete' }, { type: 'recordEvidence', evidence: { ...evidence, id: 'after-edit' } },
    { type: 'startAttempt', attemptId: 'verification', nodeId: 'one', contractVersion: 1, reservation: 1, purpose: 'verification', resources: [] }] as RunAction[]) {
    assert.throws(() => mutate(action, `blocked-${action.type}`), /digest mismatch/);
  }
  assert.equal(mutate({ type: 'pause' }, 'safe-pause').status, 'paused'); assert.deepEqual(run.evidence, []);
  assert.equal(mutate({ type: 'finishAttempt', attemptId: 'active', outcome: 'succeeded' }, 'safe-finish').attempts[0]?.status, 'succeeded');
  assert.equal(mutate({ type: 'cancel' }, 'safe-cancel').status, 'cancelled');
  assert.equal(mutate({ type: 'settleAttempt', attemptId: 'active', actual: 3 }, 'safe-settle').budget.spent, 3);
  assert.equal(mutate({ type: 'releaseLease', resource: 'resource', attemptId: 'active' }, 'safe-release').leases[0]?.released, true);
  assert.equal(mutate({ type: 'setOperation', attemptId: 'active', operationId: 'operation', status: 'confirmed' }, 'safe-reconcile').operations[0]?.status, 'confirmed');
  assert.throws(() => mutate({ type: 'complete' }, 'blocked-after-stop'), /digest mismatch/);
  assert.throws(() => getRun(store), /digest mismatch/);
  const events = store.query({ type: 'events', projectId: 'project', after: 0 }) as StoredEvent[];
  const invalidation = events.find(event => event.commandId === 'safe-pause' && event.type === 'artifactInvalidated')!;
  const details = (invalidation.payload as { details: { invalidatedEvidence: unknown[]; reason: string; status: string } }).details;
  assert.deepEqual(details.invalidatedEvidence, [evidence]); assert.match(details.reason, /digest mismatch/); assert.equal(details.status, 'paused');
  assert.ok(events.some(event => event.commandId === 'safe-cancel' && event.type === 'cancel'));
  assert.ok(events.some(event => event.commandId === 'safe-settle' && event.type === 'settleAttempt'));
  const raw = new DatabaseSync(join(f.root, 'supervisor.sqlite'));
  const saved = JSON.parse(String(raw.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get('project', 'run')?.['snapshot'])) as Run;
  assert.equal(saved.status, 'cancelled'); assert.equal(saved.budget.spent, 3); assert.deepEqual(saved.evidence, []); raw.close();
});

test('persistence verification evidence references roundtrip and reject foreign missing or altered artifacts', (t) => {
  const f = fixture(t); let store = f.open(); seed(store); seed(store, 'other', 'foreign-run'); publishArtifact(store);
  store.command({ type: 'publishArtifact', commandId: 'foreign-artifact', projectId: 'other', runId: 'foreign-run', expectedRevision: 0, artifactId: 'foreign', content: 'actual foreign evidence' });
  const ref = { runId: 'run', artifactId: 'artifact' };
  const change: VerificationChange = { id: 'evidence-change', baseVersion: 0, reason: 'Register actual evidence', cases: [originalCase], status: 'proposed', evidenceRefs: [ref] };
  for (const [id, invalid] of [['missing', { runId: 'run', artifactId: 'missing' }], ['foreign', { runId: 'foreign-run', artifactId: 'foreign' }]] as const) {
    assert.throws(() => propose(store, { ...change, id, evidenceRefs: [invalid] }), /Evidence reference artifact not found in project/);
  }
  propose(store, change); publish(store, change.id, 0);
  const plan: VerificationPlan = { id: 'evidence-plan', catalogVersion: 1, contractVersion: 1, artifactDigest: getRun(store).artifact!.digest,
    cases: [{ id: 'old', revision: 1, parameters: {} }], evidenceRefs: [ref] };
  for (const [id, invalid] of [['missing-plan', { runId: 'run', artifactId: 'missing' }], ['foreign-plan', { runId: 'foreign-run', artifactId: 'foreign' }]] as const) {
    assert.throws(() => store.command({ type: 'freezeVerificationPlan', commandId: id, projectId: 'project', runId: 'run', plan: { ...plan, id, evidenceRefs: [invalid] } }), /Evidence reference artifact not found in project/);
  }
  store.command({ type: 'freezeVerificationPlan', commandId: 'evidence-freeze', projectId: 'project', runId: 'run', plan });
  f.close(store); store = f.open();
  assert.deepEqual((store.query({ type: 'changes', projectId: 'project' }) as VerificationChange[])[0]?.evidenceRefs, [ref]);
  assert.deepEqual((store.query({ type: 'plans', projectId: 'project', runId: 'run' }) as VerificationPlan[])[0]?.evidenceRefs, [ref]);
  const next: VerificationChange = { ...change, id: 'pending-evidence-change', baseVersion: 1 };
  propose(store, next); const artifact = getRun(store).artifact!; writeFileSync(artifact.path, 'edited reference bytes');
  assert.throws(() => publish(store, next.id, 1), /digest mismatch/);
  assert.throws(() => propose(store, { ...next, id: 'tampered-reference' }), /digest mismatch/);
  assert.equal((store.query({ type: 'changes', projectId: 'project' }) as VerificationChange[]).find(change => change.id === next.id)?.status, 'proposed');
  assert.equal((store.query({ type: 'catalog', projectId: 'project' }) as VerificationCatalog).version, 1);
});
