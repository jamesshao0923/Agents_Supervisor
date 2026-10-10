import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Run } from '../../packages/contracts/p1.js';
import { parseRuntimeAction, type RuntimeSubmit } from '../../packages/contracts/p3.js';
import { applyAction } from '../../packages/domain/index.js';
import { migrate } from '../../packages/persistence/migrations.js';
import { RuntimeRepository, runtimeCanonical } from '../../packages/persistence/runtime.js';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'); migrate(db); t.after(() => db.close());
  const repo = new RuntimeRepository(db);
  function submit(steps: RuntimeSubmit['steps'] = [{ id: 'effect', kind: 'http', url: 'http://127.0.0.1:1/effect', body: 'task', idempotent: true, timeoutMs: 1000 }]) {
    return { type: 'submit' as const, commandId: 'submit', workspace: '/isolated/project', workspaceKind: 'project' as const, goal: 'Bounded declared steps', tokenLimit: 100, verificationReserve: 20, steps };
  }
  return { db, repo, submit };
}

test('runtime contract rejects unbounded undeclared malformed and unsafe requests', () => {
  const input: RuntimeSubmit = { type: 'submit', commandId: 'c', goal: 'goal', tokenLimit: 100, verificationReserve: 20, steps: [{ id: 'a', kind: 'input', prompt: 'Need input' }] };
  assert.deepEqual(parseRuntimeAction(input), input);
  for (const steps of [[], Array.from({ length: 33 }, (_, n) => ({ id: String(n), kind: 'input', prompt: 'wait' })), [input.steps[0], input.steps[0]]]) assert.throws(() => parseRuntimeAction({ ...input, steps }));
  assert.throws(() => parseRuntimeAction({ ...input, autonomous: true }), /Unknown runtime field/);
  assert.throws(() => parseRuntimeAction({ ...input, steps: [{ id: 'a', kind: 'http', url: 'file:///secret', body: '', idempotent: true, timeoutMs: 1000 }] }), /HTTP/);
  assert.throws(() => parseRuntimeAction({ ...input, steps: [{ id: 'a', kind: 'codex', prompt: 'p', model: 'm', effort: 'low', reservation: 81, timeoutMs: 1000 }] }), /budget/);
  assert.throws(() => parseRuntimeAction({ type: 'events', runtimeId: 'r', after: -1 }));
});

test('runtime submission canonical receipt prevents duplicate runs effects and changed commands', t => {
  const { repo, submit } = fixture(t); const input = submit(); const first = repo.submit(input);
  const before = repo.inspect(first.id); const events = repo.events(first.id, 0);
  assert.equal(repo.submit(Object.fromEntries(Object.entries(input).reverse()) as typeof input).id, first.id);
  assert.throws(() => repo.submit({ ...input, goal: 'Changed work' }), /conflicts/);
  assert.equal(repo.list().length, 1); assert.equal(repo.operations(first.id).length, 1);
  assert.deepEqual(repo.inspect(first.id), before); assert.deepEqual(repo.events(first.id, 0), events);
  assert.deepEqual(repo.events(first.id, events.at(-1)!.seq), []);
  assert.equal(before.checkpoints[0]?.valid, true);
});

test('runtime input receipt accepts only the declared current wait and never overwrites data', t => {
  const { repo, submit } = fixture(t); const r = repo.submit(submit([{ id: 'wait', kind: 'input', prompt: 'approve declared step' }, { id: 'next', kind: 'input', prompt: 'later' }]));
  assert.equal(repo.claim(r.id, 'worker'), null);
  assert.throws(() => repo.control({ type: 'input', commandId: 'future', runtimeId: r.id, stepId: 'next', text: 'early' }), /current wait/);
  const input = { type: 'input' as const, commandId: 'answer', runtimeId: r.id, stepId: 'wait', text: 'approved' };
  const answered = repo.control(input); assert.deepEqual(repo.control(input), answered);
  assert.throws(() => repo.control({ ...input, text: 'changed' }), /conflicts/);
  assert.throws(() => repo.control({ ...input, commandId: 'overwrite' }), /already supplied/);
  const op = repo.claim(r.id, 'worker')!; assert.ok(op);
  const advanced = repo.report(op.id, 'worker', { messageId: 'wait-done', outcome: 'confirmed', result: { input: 'approved' } });
  assert.equal(advanced.cursor, 1); assert.equal(advanced.phase, 'waiting-input'); assert.deepEqual(advanced.inputs, { wait: 'approved' });
  assert.throws(() => repo.control({ ...input, commandId: 'late' }), /current wait/);
});

test('runtime inbox deduplicates exact reports and rejects conflicting deliveries while unknown stays blocked', t => {
  const { repo, submit } = fixture(t); const r = repo.submit(submit()); const op = repo.claim(r.id, 'worker')!; repo.markStarted(op.id, 'worker');
  const message = { messageId: 'report', outcome: 'unknown' as const, result: null, error: 'receipt lost' }; const first = repo.report(op.id, 'worker', message);
  const before = repo.inspect(r.id); assert.deepEqual(repo.report(op.id, 'worker', message), first);
  assert.throws(() => repo.report(op.id, 'worker', { ...message, outcome: 'confirmed' }), /Conflicting inbox/);
  assert.deepEqual(repo.inspect(r.id), before); assert.equal(first.cursor, 0); assert.equal(first.phase, 'blocked'); assert.equal(repo.claim(r.id, 'new-worker'), null);
  repo.adopt(op.id, 'new-worker'); const reconciled = repo.report(op.id, 'new-worker', { messageId: 'queried-confirmed', outcome: 'confirmed', result: { receipt: 'existing effect' } });
  assert.equal(reconciled.phase, 'awaiting-verification'); const terminal = repo.inspect(r.id); assert.deepEqual(repo.report(op.id, 'new-worker', { messageId: 'queried-confirmed', outcome: 'confirmed', result: { receipt: 'existing effect' } }), reconciled); assert.deepEqual(repo.inspect(r.id), terminal); assert.throws(() => repo.report(op.id, 'new-worker', { messageId: 'different-terminal-message', outcome: 'confirmed', result: null }), /already terminal/); assert.notEqual(repo.inspect(r.id).run.status, 'succeeded'); assert.equal(repo.operations(r.id).length, 1);
});

test('runtime pause prevents claims and dispatch while completed current work preserves the pause', t => {
  const { repo, submit } = fixture(t); const r = repo.submit(submit([{ id: 'one', kind: 'input', prompt: 'one' }, { id: 'two', kind: 'input', prompt: 'two' }]));
  repo.control({ type: 'input', commandId: 'input', runtimeId: r.id, stepId: 'one', text: 'answer' });
  repo.control({ type: 'pause', commandId: 'pause', runtimeId: r.id }); assert.equal(repo.claim(r.id, 'worker'), null);
  repo.control({ type: 'resume', commandId: 'resume', runtimeId: r.id }); const op = repo.claim(r.id, 'worker')!;
  repo.control({ type: 'pause', commandId: 'pause-again', runtimeId: r.id }); assert.throws(() => repo.eligible(op.id, 'worker'), /paused/);
  const current = repo.report(op.id, 'worker', { messageId: 'current-complete', outcome: 'confirmed', result: 'answer' });
  assert.equal(current.cursor, 1); assert.equal(current.phase, 'paused'); assert.equal(repo.claim(r.id, 'worker'), null);
  assert.equal(repo.control({ type: 'resume', commandId: 'resume-again', runtimeId: r.id }).phase, 'waiting-input');
});

test('runtime owner transfer fences stale qualification start binding and reports', t => {
  const { db, repo, submit } = fixture(t); const r = repo.submit(submit()); const op = repo.claim(r.id, 'old')!; repo.adopt(op.id, 'new');
  for (const stale of [() => repo.eligible(op.id, 'old'), () => repo.markStarted(op.id, 'old'), () => repo.binding(op.id, 'old'), () => repo.report(op.id, 'old', { messageId: 'stale', outcome: 'confirmed', result: null })]) assert.throws(stale, /Stale worker/);
  assert.equal(repo.operations(r.id)[0]?.owner, 'new'); repo.eligible(op.id, 'new');
  const current = repo.operations(r.id)[0]!; db.prepare('UPDATE runtime_outbox SET record=? WHERE id=?').run(runtimeCanonical({ ...current, contractVersion: 2 }), op.id); assert.throws(() => repo.eligible(op.id, 'new'), /Stale attempt/); assert.throws(() => repo.binding(op.id, 'new'), /Stale attempt/);
});

test('runtime cancellation rejects recovery dispatch and late confirmation cannot advance workflow', t => {
  const { repo, submit } = fixture(t); const r = repo.submit(submit([{ id: 'one', kind: 'http', url: 'http://127.0.0.1:1', body: '', idempotent: true, timeoutMs: 1000 }, { id: 'two', kind: 'input', prompt: 'must not start' }])); const op = repo.claim(r.id, 'worker')!; repo.markStarted(op.id, 'worker');
  repo.control({ type: 'cancel', commandId: 'cancel', runtimeId: r.id });
  assert.equal(repo.claim(r.id, 'worker'), null); assert.throws(() => repo.eligible(op.id, 'worker'), /cancelled/);
  assert.throws(() => repo.control({ type: 'resume', commandId: 'resume', runtimeId: r.id }), /Cancelled/);
  const late = repo.report(op.id, 'worker', { messageId: 'late-confirmation', outcome: 'confirmed', result: { receipt: 'already happened' } });
  assert.equal(late.phase, 'cancelled'); assert.equal(late.cursor, 0); assert.equal(repo.operations(r.id).length, 1);
  assert.equal(repo.inspect(r.id).run.status, 'cancelled'); assert.equal(repo.inspect(r.id).run.attempts[0]?.status, 'cancelled');
});

test('runtime workflow checkpoint digest schema and contract mismatch fail closed before dispatch', t => {
  const { db, repo, submit } = fixture(t); const r = repo.submit(submit()); const row = db.prepare('SELECT record,digest FROM runtime_checkpoints WHERE id=?').get(r.checkpointId!)!;
  for (const changed of [{ schemaVersion: 2 }, { workflowVersion: 2 }, { contractVersion: 2 }, { cursor: 9 }]) {
    const content = runtimeCanonical({ ...JSON.parse(String(row.record)), ...changed }); db.prepare('UPDATE runtime_checkpoints SET record=?,digest=? WHERE id=?').run(content, createHash('sha256').update(content).digest('hex'), r.checkpointId!);
    assert.throws(() => repo.claim(r.id, 'worker'), /version|position/); assert.equal(repo.operations(r.id)[0]?.state, 'queued'); assert.equal(repo.inspect(r.id).run.attempts.length, 0);
  }
  db.prepare('UPDATE runtime_checkpoints SET record=?,digest=? WHERE id=?').run(String(row.record), '0'.repeat(64), r.checkpointId!); assert.throws(() => repo.claim(r.id, 'worker'), /digest/);
  db.prepare('UPDATE runtime_checkpoints SET record=?,digest=? WHERE id=?').run(String(row.record), String(row.digest), r.checkpointId!);
  db.prepare('UPDATE runtime_runs SET record=? WHERE id=?').run(runtimeCanonical({ ...r, workflowVersion: 2 }), r.id); assert.throws(() => repo.claim(r.id, 'worker'), /workflow version/);
});

test('runtime cumulative domain spending survives checkpoints and rejects a step exceeding the remaining budget', t => {
  const { db, repo, submit } = fixture(t); const r = repo.submit(submit([{ id: 'spent', kind: 'input', prompt: 'settled work' }, { id: 'codex', kind: 'codex', prompt: 'never invoked', model: 'uninvoked', effort: 'low', reservation: 50, timeoutMs: 1000 }]));
  repo.control({ type: 'input', commandId: 'input', runtimeId: r.id, stepId: 'spent', text: 'input' }); const op = repo.claim(r.id, 'worker')!;
  // Exercise the real domain ledger with a explicit accounting value. No model result is fabricated.
  let run = repo.inspect(r.id).run; run = applyAction(run, { type: 'finishAttempt', attemptId: op.attemptId, outcome: 'succeeded' }).run; run = applyAction(run, { type: 'settleAttempt', attemptId: op.attemptId, actual: 35 }).run;
  db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(runtimeCanonical(run), run.revision, r.projectId, r.runId);
  repo.report(op.id, 'worker', { messageId: 'accounted', outcome: 'confirmed', result: 'input' });
  assert.equal(repo.checkpoint(r.id)?.budget.spent, 35); assert.equal(repo.checkpoint(r.id)?.budget.verificationReserve, 20);
  assert.throws(() => repo.claim(r.id, 'next-worker'), /insufficient budget/); assert.equal(repo.inspect(r.id).run.budget.spent, 35); assert.equal(repo.inspect(r.id).run.attempts.length, 1);
});

test('runtime in-flight reservation survives owner recovery without settlement or duplicate attempt', t => {
  const { db, repo, submit } = fixture(t); const r = repo.submit(submit([{ id: 'codex', kind: 'codex', prompt: 'Not invoked in this ledger unit test', model: 'uninvoked', effort: 'low', reservation: 60, timeoutMs: 1000 }]));
  const op = repo.claim(r.id, 'old')!; const before = repo.inspect(r.id).run; assert.equal(before.attempts[0]?.settled, false); assert.equal(before.attempts[0]?.reservation, 60); assert.equal(before.budget.spent, 0);
  const reopened = new RuntimeRepository(db); reopened.adopt(op.id, 'new'); assert.equal(reopened.claim(r.id, 'new'), null); reopened.eligible(op.id, 'new');
  assert.deepEqual(reopened.inspect(r.id).run, before); assert.equal(reopened.operations(r.id).length, 1); assert.equal(reopened.checkpoint(r.id)?.budget.limit, 100); assert.equal(reopened.checkpoint(r.id)?.budget.verificationReserve, 20);
  assert.throws(() => reopened.report(op.id, 'new', { messageId: 'forged-success', outcome: 'confirmed', result: 'not a real Codex result' }), /durable execution receipt/);
  assert.deepEqual(reopened.inspect(r.id).run, before);
});
