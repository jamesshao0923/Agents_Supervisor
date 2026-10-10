import test from 'node:test';
import assert from 'node:assert/strict';
import type { Run, RunAction } from '../../packages/contracts/p1.js';
import { parseRunAction } from '../../packages/contracts/validation.js';
import { applyAction, createDraftRun, createRun, futureVerificationFloor, readiness } from '../../packages/domain/index.js';

const act = (run: Run, action: RunAction): Run => applyAction(run, action).run;
function fresh(): Run {
  return createRun({ id: 'run', projectId: 'project', contract: { version: 1, goal: 'Preserve the original behavior', criteria: [{ id: 'correct', description: 'Original exact necessary check', required: true }] }, nodes: [{ id: 'implement', required: true, dependencies: [] }, { id: 'next', required: false, dependencies: ['implement'] }], budget: { unit: 'token', limit: 100, verificationReserve: 20 } });
}
const execution = (reservation = 40): Extract<RunAction, { type: 'startAttempt' }> => ({ type: 'startAttempt', attemptId: 'worker', nodeId: 'implement', contractVersion: 1, purpose: 'execution', reservation, resources: ['workspace:project'] });
const inspection = (reservation = 10): Extract<RunAction, { type: 'startAttempt' }> => ({ type: 'startAttempt', attemptId: 'inspection', nodeId: '@inspection', contractVersion: 1, purpose: 'inspection', reservation, resources: [] });
function executing(run = fresh(), reservation = 40): Run {
  run = act(run, execution(reservation)); return act(run, { type: 'setOperation', operationId: 'worker-op', attemptId: 'worker', status: 'pending' });
}
function inspecting(run = executing()): Run { run = act(run, inspection()); return act(run, { type: 'setOperation', operationId: 'inspection-op', attemptId: 'inspection', status: 'pending' }); }
function finishWorker(run: Run): Run {
  run = act(run, { type: 'finishAttempt', attemptId: 'worker', outcome: 'succeeded' }); run = act(run, { type: 'settleAttempt', attemptId: 'worker', actual: 8 });
  run = act(run, { type: 'setOperation', operationId: 'worker-op', attemptId: 'worker', status: 'confirmed' }); return act(run, { type: 'releaseLease', resource: 'workspace:project', attemptId: 'worker' });
}
function finishInspection(run: Run, outcome: 'succeeded' | 'failed' | 'cancelled' = 'succeeded', actual = 3): Run {
  run = act(run, { type: 'finishAttempt', attemptId: 'inspection', outcome }); run = act(run, { type: 'settleAttempt', attemptId: 'inspection', actual }); return act(run, { type: 'setOperation', operationId: 'inspection-op', attemptId: 'inspection', status: 'confirmed' });
}

test('P6-INSP-U01 inspection parser accepts the distinct purpose and rejects unsafe or extra fields', () => {
  assert.deepEqual(parseRunAction(inspection()), inspection());
  for (const reservation of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseRunAction({ ...inspection(), reservation }));
  for (const extra of [{ readonly: true }, { approved: true }, { currentExecutionIds: ['worker'] }]) assert.throws(() => parseRunAction({ ...inspection(), ...extra }), /unknown/i);
});

test('P6-INSP-U02 current running execution can overlap read-only inspection without task or writer mutations', () => {
  const before = executing(), original = structuredClone(before), result = applyAction(before, inspection());
  assert.deepEqual(before, original); assert.deepEqual(result.run.contract, before.contract); assert.deepEqual(result.run.nodes, before.nodes); assert.deepEqual(result.run.leases, before.leases); assert.deepEqual(result.run.operations, before.operations); assert.equal(result.run.artifact, before.artifact); assert.deepEqual(result.run.evidence, before.evidence);
  assert.deepEqual(result.run.attempts[0], before.attempts[0]); assert.equal(result.run.attempts[1]?.purpose, 'inspection'); assert.equal(result.run.attempts[1]?.nodeId, '@inspection'); assert.equal(result.run.attempts[1]?.reservation, 10); assert.equal(result.events[0]?.type, 'startAttempt'); assert.equal(result.events[0]?.details.purpose, 'inspection'); assert.equal(readiness(result.run).state, 'active');
});

test('P6-INSP-U03 synthetic inspection node positive reservation and empty resources cannot be bypassed', () => {
  for (const action of [{ ...inspection(), nodeId: 'implement' }, { ...inspection(), resources: ['workspace:project'] }, { ...inspection(), resources: ['inspector-private-writer'] }, inspection(0), { ...inspection(), futureVerificationAllocationId: 'final' }]) assert.throws(() => act(executing(), action), /read-only node/);
  const collision = fresh(); collision.nodes.push({ id: '@inspection', required: false, dependencies: [], status: 'pending' }); assert.throws(() => act(executing(collision), inspection()), /collides/);
});

test('P6-INSP-U04 draft paused cancelled succeeded stale or quiet runs cannot begin inspection', () => {
  const draft = createDraftRun({ id: 'draft', projectId: 'project', goal: 'Unadmitted', budget: { limit: 100, verificationReserve: 20 } }); assert.throws(() => act(draft, inspection()), /requirements/);
  assert.throws(() => act(act(executing(), { type: 'pause' }), inspection()), /run state/); assert.throws(() => act(act(executing(), { type: 'cancel' }), inspection()), /cancelled/);
  assert.throws(() => act({ ...fresh(), status: 'succeeded' }, inspection()), /terminal/); assert.throws(() => act(executing(), { ...inspection(), contractVersion: 2 }), /stale contract/); assert.throws(() => act(fresh(), inspection()), /current execution/);
});

test('P6-INSP-U05 ordinary reasoning retains its settled boundary during active execution and inspection', () => {
  const reasoning: RunAction = { ...inspection(), attemptId: 'author', nodeId: '@supervisor', purpose: 'reasoning' };
  assert.throws(() => act(executing(), reasoning), /unsettled attempts/); assert.throws(() => act(inspecting(), reasoning), /unsettled inspection|unsettled attempts/);
  assert.throws(() => act(finishWorker(inspecting()), reasoning), /unsettled inspection|unsettled attempts/);
});

test('P6-INSP-U06 unknown current effect orphan pending or absent current pending blocks inspection', () => {
  const unknown = act(executing(), { type: 'setOperation', operationId: 'worker-op', attemptId: 'worker', status: 'unknown' }); assert.throws(() => act(unknown, inspection()), /unknown or unrelated/);
  const absent = act(fresh(), execution()); assert.throws(() => act(absent, inspection()), /unknown or unrelated/);
  const settled: RunAction[] = [{ type: 'finishAttempt', attemptId: 'worker', outcome: 'failed' }, { type: 'settleAttempt', attemptId: 'worker', actual: 0 }, { type: 'setOperation', operationId: 'worker-op', attemptId: 'worker', status: 'confirmed' }, { type: 'releaseLease', resource: 'workspace:project', attemptId: 'worker' }];
  let run = executing(); for (const action of settled) run = act(run, action);
  run = act(run, { ...execution(), attemptId: 'new-worker' }); run = act(run, { type: 'setOperation', operationId: 'new-op', attemptId: 'new-worker', status: 'pending' }); run = act(run, { type: 'setOperation', operationId: 'orphan-old-op', attemptId: 'worker', status: 'pending' });
  assert.throws(() => act(run, inspection()), /unknown or unrelated/);
});

test('P6-INSP-U07 terminal unknown usage and historical running corruption cannot be treated as live execution', () => {
  const failed = act(executing(), { type: 'finishAttempt', attemptId: 'worker', outcome: 'failed' }); assert.throws(() => act(failed, inspection()), /current running execution/);
  const old = executing(); old.attempts[0]!.contractVersion = 0; assert.throws(() => act(old, inspection()), /current running execution/);
  const node = executing(); node.nodes[0]!.status = 'pending'; assert.throws(() => act(node, inspection()), /node is not current/);
  const hidden = executing(); hidden.attempts.push({ id: 'old', nodeId: '@supervisor', contractVersion: 1, purpose: 'reasoning', status: 'failed', actual: null, reservation: 5, settled: false }); assert.throws(() => act(hidden, inspection()), /unsettled reasoning|unresolved history/);
  const malformed = executing(); malformed.attempts.push({ id: 'corrupt', nodeId: 'next', contractVersion: 1, purpose: 'execution', status: 'running', actual: 0, reservation: 5, settled: true }); assert.throws(() => act(malformed, inspection()), /historical attempts/);
});

test('P6-INSP-U08 unrelated unreleased writer lease and multiple active executions are refused', () => {
  const lease = executing(); lease.leases.push({ resource: 'foreign-workspace', attemptId: 'historical-owner', released: false }); assert.throws(() => act(lease, inspection()), /unrelated writer leases/);
  const parallel = fresh(); parallel.nodes[1]!.dependencies = []; let run = act(parallel, { ...execution(), resources: [] }); run = act(run, { ...execution(10), attemptId: 'other-worker', nodeId: 'next', resources: [] }); run = act(run, { type: 'setOperation', operationId: 'worker-op', attemptId: 'worker', status: 'pending' }); run = act(run, { type: 'setOperation', operationId: 'other-op', attemptId: 'other-worker', status: 'pending' }); assert.throws(() => act(run, inspection()), /exactly one/);
});

test('P6-INSP-U09 a second concurrent inspection is rejected and first reservation is retained', () => {
  const run = inspecting(), before = structuredClone(run); assert.throws(() => act(run, { ...inspection(), attemptId: 'second-inspection' }), /unresolved history/); assert.deepEqual(run, before); assert.equal(run.attempts.find(a => a.id === 'inspection')?.settled, false);
});

test('P6-INSP-U10 original budget includes worker and inspector reservations while overlapping future floor only once', () => {
  const allocated = act(fresh(), { type: 'setFutureVerification', contractVersion: 1, allocationId: 'final', amount: 50, reason: 'Preserve required final verification' }), run = executing(allocated);
  assert.equal(futureVerificationFloor(run), 50); const admitted = act(run, inspection(10)); assert.equal(admitted.budget.spent, 0); assert.equal(admitted.attempts.filter(a => !a.settled).reduce((n, a) => n + a.reservation, 0), 50); assert.equal(futureVerificationFloor(admitted), 50);
  assert.throws(() => act(run, inspection(11)), /insufficient budget/); assert.deepEqual(run.budget.futureVerification, allocated.budget.futureVerification);
});

test('P6-INSP-U11 larger original verification reserve remains protected and no inspection consumes allocation', () => {
  const allocated = act(fresh(), { type: 'setFutureVerification', contractVersion: 1, allocationId: 'final', amount: 10, reason: 'Protected final reservation' }), run = executing(allocated, 60);
  assert.equal(act(run, inspection(20)).attempts.at(-1)?.reservation, 20); assert.throws(() => act(run, inspection(21)), /insufficient budget/); assert.throws(() => act(run, { ...inspection(10), futureVerificationAllocationId: 'final' }), /read-only node/); assert.equal(futureVerificationFloor(run), 10);
});

test('P6-INSP-U12 inspection finish settlement and confirmation preserve ongoing node lease artifact and evidence', () => {
  let run = inspecting(); run = act(run, { type: 'setArtifact', artifact: { id: 'previous', digest: 'original-digest', path: '/fixture', contractVersion: 1 } }); run = act(run, { type: 'recordEvidence', evidence: { id: 'original-evidence', criterionId: 'correct', contractVersion: 1, artifactDigest: 'original-digest', verdict: 'failed', verifierVersion: 'independent-fixture' } });
  const before = structuredClone(run), done = finishInspection(run); assert.deepEqual(done.nodes, before.nodes); assert.deepEqual(done.leases, before.leases); assert.deepEqual(done.artifact, before.artifact); assert.deepEqual(done.evidence, before.evidence); assert.deepEqual(done.contract, before.contract); assert.equal(done.attempts[0]?.status, 'running'); assert.equal(done.status, 'running'); assert.equal(done.budget.spent, 3); assert.equal(done.operations.find(o => o.id === 'worker-op')?.status, 'pending'); assert.notEqual(readiness(done).state, 'complete');
  const duplicate = applyAction(done, { type: 'settleAttempt', attemptId: 'inspection', actual: 3 }); assert.equal(duplicate.run.revision, done.revision); assert.equal(duplicate.run.budget.spent, 3); assert.deepEqual(duplicate.events, []); assert.throws(() => act(done, { type: 'settleAttempt', attemptId: 'inspection', actual: 4 }), /conflicting settlement/);
});

test('P6-INSP-U13 finished inspection with unknown usage blocks ordinary execution reasoning and verification', () => {
  let run = finishWorker(inspecting()); run = act(run, { type: 'finishAttempt', attemptId: 'inspection', outcome: 'failed' }); run = act(run, { type: 'setOperation', operationId: 'inspection-op', attemptId: 'inspection', status: 'confirmed' }); run = act(run, { type: 'setArtifact', artifact: { id: 'candidate', digest: 'digest', path: '/candidate', contractVersion: 1 } });
  for (const action of [{ ...execution(1), attemptId: 'next-worker', nodeId: 'next', resources: [] }, { ...inspection(1), attemptId: 'reasoning', nodeId: '@supervisor', purpose: 'reasoning' as const }, { ...inspection(1), attemptId: 'verification', nodeId: 'implement', purpose: 'verification' as const }]) assert.throws(() => act(run, action), /unsettled inspection/);
  assert.equal(run.attempts.find(a => a.id === 'inspection')?.reservation, 10); assert.equal(run.attempts.find(a => a.id === 'inspection')?.settled, false); assert.equal(readiness(run).state, 'blocked');
});

test('P6-INSP-U14 known settled usage with unknown inspection effect still blocks the next dispatch', () => {
  let run = finishWorker(inspecting()); run = act(run, { type: 'finishAttempt', attemptId: 'inspection', outcome: 'failed' }); run = act(run, { type: 'settleAttempt', attemptId: 'inspection', actual: 3 }); run = act(run, { type: 'setOperation', operationId: 'inspection-op', attemptId: 'inspection', status: 'unknown' });
  assert.throws(() => act(run, { ...execution(1), attemptId: 'next-worker', nodeId: 'next', resources: [] }), /unresolved operation/); assert.equal(readiness(run).state, 'blocked'); assert.equal(run.budget.spent, 11);
});

test('P6-INSP-U15 pause and cancellation permit real accounting without reviving task nodes or release of worker lease', () => {
  const original = inspecting(), paused = act(original, { type: 'pause' }), pausedDone = finishInspection(paused); assert.equal(pausedDone.status, 'paused'); assert.deepEqual(pausedDone.nodes, paused.nodes); assert.deepEqual(pausedDone.leases, paused.leases); assert.equal(pausedDone.budget.spent, 3);
  const cancelled = act(original, { type: 'cancel' }), late = applyAction(cancelled, { type: 'finishAttempt', attemptId: 'inspection', outcome: 'succeeded' }); assert.equal(late.events[0]?.details.ignored, 'late result after cancellation'); assert.equal(late.run.status, 'cancelled'); assert.deepEqual(late.run.nodes, cancelled.nodes); assert.equal(late.run.attempts.find(a => a.id === 'inspection')?.status, 'cancelled');
  const settled = act(late.run, { type: 'settleAttempt', attemptId: 'inspection', actual: 3 }); assert.equal(settled.status, 'cancelled'); assert.equal(settled.budget.spent, 3); assert.deepEqual(settled.leases, cancelled.leases); assert.equal(settled.leases[0]?.released, false);
});

test('P6-INSP-U16 inspection alone cannot complete required nodes or authorize independent acceptance', () => {
  const done = finishInspection(finishWorker(inspecting())); assert.equal(done.nodes[0]?.status, 'succeeded'); assert.equal(done.artifact, null); assert.deepEqual(done.evidence, []); assert.equal(readiness(done).state, 'ready', 'Optional next node remains dispatchable; inspection cannot mark the Run complete'); assert.throws(() => act(done, { type: 'complete' }), /artifact missing|lacks current passed evidence/);
  const next = act(done, { ...execution(1), attemptId: 'next-worker', nodeId: 'next', resources: [] }); assert.equal(next.attempts.at(-1)?.purpose, 'execution'); assert.equal(next.nodes[1]?.status, 'running');
});

test('P6-INSP-U17 inspection overrun is charged as actual cost and prevents new inspection or execution', () => {
  const overrun = finishInspection(inspecting(), 'failed', 101); assert.equal(overrun.budget.spent, 101); assert.equal(overrun.status, 'blocked'); assert.equal(overrun.nodes[0]?.status, 'running'); assert.throws(() => act(overrun, { ...inspection(), attemptId: 'second' }), /insufficient budget/); const quiet = finishWorker(overrun); assert.throws(() => act(quiet, { ...execution(1), attemptId: 'next-worker', nodeId: 'next', resources: [] }), /insufficient budget/);
});

test('P6-INSP-U18 revision cannot cross unsettled inspection and old cancelled accounting cannot satisfy new standards', () => {
  const run = inspecting(), revision: RunAction = { type: 'revisePlan', contract: { ...run.contract, version: 2 }, nodes: [{ id: 'implement', dependencies: [], required: true }], reason: 'Authorized later contract fixture' }; assert.throws(() => act(run, revision), /settled attempts/);
  const replaced = act(run, { type: 'replaceContract', contract: { ...run.contract, version: 2 } }), late = act(replaced, { type: 'finishAttempt', attemptId: 'inspection', outcome: 'succeeded' }), settled = act(late, { type: 'settleAttempt', attemptId: 'inspection', actual: 3 }); assert.equal(settled.contract.version, 2); assert.equal(settled.nodes[0]?.status, 'pending'); assert.equal(settled.attempts.find(a => a.id === 'inspection')?.status, 'cancelled'); assert.deepEqual(settled.evidence, []); assert.equal(settled.artifact, null); assert.notEqual(readiness(settled).state, 'complete'); assert.throws(() => act(settled, { ...inspection(), contractVersion: 2, attemptId: 'new' }), /current running execution|current execution|unresolved history/);
});
