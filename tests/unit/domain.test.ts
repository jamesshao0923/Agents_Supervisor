import assert from 'node:assert/strict';
import test from 'node:test';
import type { CreateRunInput, Run, RunAction, VerificationCase, VerificationCatalog, VerificationChange, VerificationPlan } from '../../packages/contracts/p1.js';
import { parseCommand, parseQuery } from '../../packages/contracts/validation.js';
import { applyAction, createRun, readiness, validateVerificationChange, validateVerificationPlan } from '../../packages/domain/index.js';

function input(): CreateRunInput { return { id: 'run', projectId: 'project', contract: { version: 1, goal: 'produce artifact', criteria: [{ id: 'correct', description: 'artifact correct', required: true }] }, nodes: [{ id: 'build', dependencies: [], required: true }, { id: 'child', dependencies: ['build'], required: false }], budget: { limit: 10, verificationReserve: 2 } }; }
function fresh(): Run { return createRun(input()); }
function start(attemptId = 'attempt', nodeId = 'build', reservation = 3, resources = ['workspace']): RunAction { return { type: 'startAttempt', attemptId, nodeId, reservation, contractVersion: 1, purpose: 'execution', resources }; }
function act(run: Run, action: RunAction): Run { return applyAction(run, action).run; }
function built(): Run {
  let run = act(fresh(), start()); run = act(run, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'succeeded' }); run = act(run, { type: 'settleAttempt', attemptId: 'attempt', actual: 2 }); run = act(run, { type: 'releaseLease', resource: 'workspace', attemptId: 'attempt' });
  return act(run, { type: 'setArtifact', artifact: { id: 'artifact', digest: 'digest', path: 'artifact.txt', contractVersion: 1 } });
}
function passed(run = built()): Run { return act(run, { type: 'recordEvidence', evidence: { id: 'evidence', criterionId: 'correct', contractVersion: 1, artifactDigest: 'digest', verdict: 'passed', verifierVersion: 'p1-structure' } }); }
function verificationCase(): VerificationCase { return { id: 'case', revision: 1, criterionIds: ['correct'], definition: 'check artifact', status: 'active', replaces: [], defectRefs: ['defect-1'] }; }
function catalog(): VerificationCatalog { return { version: 1, cases: [verificationCase()], snapshotPath: 'catalog.json', digest: 'catalog-digest' }; }
function change(): VerificationChange { return { id: 'change', baseVersion: 1, reason: 'preserve regression in a replacement', status: 'proposed', cases: [verificationCase(), { ...verificationCase(), revision: 2, status: 'retired' }, { ...verificationCase(), id: 'replacement', replaces: ['case'] }] }; }
function plan(): VerificationPlan { return { id: 'plan', catalogVersion: 1, contractVersion: 1, artifactDigest: 'digest', cases: [{ id: 'case', revision: 1, parameters: { platform: 'mac' } }] }; }

test('run creation validates acyclic known dependencies and copies contract inputs', () => {
  const value = input(); const run = createRun(value); value.contract.criteria[0]!.description = 'mutated'; assert.equal(run.contract.criteria[0]!.description, 'artifact correct'); assert.equal(run.revision, 0); assert.equal(readiness(run).state, 'ready');
  const missing = input(); missing.nodes[0]!.dependencies = ['absent']; assert.throws(() => createRun(missing), /unknown dependency/);
  const cyclic = input(); cyclic.nodes[0]!.dependencies = ['child']; assert.throws(() => createRun(cyclic), /cyclic/);
});
test('run creation rejects duplicate nodes criteria dependencies and empty contracts', () => {
  const nodes = input(); nodes.nodes.push(nodes.nodes[0]!); assert.throws(() => createRun(nodes), /duplicate node/);
  const criteria = input(); criteria.contract.criteria.push(criteria.contract.criteria[0]!); assert.throws(() => createRun(criteria), /duplicate criterion/);
  const dependencies = input(); dependencies.nodes[1]!.dependencies = ['build', 'build']; assert.throws(() => createRun(dependencies), /duplicate dependency/);
  const empty = input(); empty.contract.criteria = []; assert.throws(() => createRun(empty), /needs criteria/);
});
test('dispatch enforces contract version dependencies and unique attempt ownership', () => {
  const run = fresh(); assert.throws(() => act(run, start('attempt', 'child')), /dependencies/);
  assert.throws(() => act(run, { ...start(), contractVersion: 2 } as RunAction), /stale contract/);
  const running = act(run, start()); assert.equal(running.nodes[0]!.status, 'running'); assert.equal(run.nodes[0]!.status, 'pending'); assert.equal(running.revision, 1);
  assert.throws(() => act(running, start()), /attempt id/); assert.throws(() => act(running, start('other')), /active attempt/);
});
test('reservations conflict across parallel nodes and preserve verification allowance', () => {
  const value = input(); value.nodes[1]!.dependencies = []; const run = createRun(value);
  assert.throws(() => act(run, start('a', 'build', 9)), /budget/);
  const running = act(run, start('a', 'build', 6)); assert.throws(() => act(running, start('b', 'child', 3, [])), /budget/);
  assert.equal(act(running, start('b', 'child', 2, [])).attempts.length, 2);
});
test('budget rejects negative nonfinite and malformed reservations without mutation', () => {
  for (const reservation of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => act(fresh(), { ...start(), reservation } as RunAction), /finite/);
  for (const limit of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createRun({ ...input(), budget: { limit, verificationReserve: 0 } }), /finite/);
  assert.throws(() => createRun({ ...input(), budget: { limit: 1, verificationReserve: 2 } }), /reserve/);
});
test('actual overspend is recorded and prevents new dispatch', () => {
  let run = act(fresh(), start()); run = act(run, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'succeeded' }); run = act(run, { type: 'settleAttempt', attemptId: 'attempt', actual: 12 });
  assert.equal(run.budget.spent, 12); assert.equal(run.attempts[0]!.actual, 12); assert.equal(run.attempts[0]!.settled, true); assert.equal(readiness(run).state, 'blocked');
  assert.throws(() => act(run, start('other', 'child', 0, [])), /budget/);
});
test('settlement releases reservation exactly once and rejects conflicting totals', () => {
  let run = act(fresh(), start()); assert.throws(() => act(run, { type: 'settleAttempt', attemptId: 'attempt', actual: 1 }), /active/);
  run = act(run, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'failed' }); run = act(run, { type: 'settleAttempt', attemptId: 'attempt', actual: 1 });
  const duplicate = applyAction(run, { type: 'settleAttempt', attemptId: 'attempt', actual: 1 }); assert.equal(duplicate.run.budget.spent, 1); assert.equal(duplicate.run.revision, run.revision); assert.deepEqual(duplicate.events, []);
  assert.throws(() => act(run, { type: 'settleAttempt', attemptId: 'attempt', actual: 2 }), /conflicting settlement/);
  assert.throws(() => act(run, { type: 'settleAttempt', attemptId: 'unknown', actual: 2 }), /unknown attempt/);
  for (const actual of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => act(run, { type: 'settleAttempt', attemptId: 'attempt', actual }), /finite/);
});
test('lease ownership persists after finish until explicit release', () => {
  let run = act(fresh(), start()); assert.throws(() => act(run, { type: 'releaseLease', resource: 'workspace', attemptId: 'attempt' }), /active owner/);
  run = act(run, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'succeeded' }); run = act(run, { type: 'settleAttempt', attemptId: 'attempt', actual: 1 });
  assert.throws(() => act(run, start('child-attempt', 'child')), /still leased/);
  assert.throws(() => act(run, { type: 'releaseLease', resource: 'workspace', attemptId: 'other' }), /unknown lease/);
  run = act(run, { type: 'releaseLease', resource: 'workspace', attemptId: 'attempt' }); assert.equal(act(run, start('child-attempt', 'child')).attempts.length, 2);
});
test('cancelled attempts accept late settlement but late success never revives nodes', () => {
  let run = act(fresh(), start()); run = act(run, { type: 'cancel' }); const late = applyAction(run, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'succeeded' });
  assert.equal(late.run.status, 'cancelled'); assert.equal(late.run.nodes[0]!.status, 'failed'); assert.equal(late.run.attempts[0]!.status, 'cancelled'); assert.equal(late.events[0]!.details.ignored, 'late result after cancellation');
  run = act(late.run, { type: 'settleAttempt', attemptId: 'attempt', actual: 4 }); assert.equal(run.budget.spent, 4); assert.equal(run.leases[0]!.released, false);
  assert.throws(() => act(run, start('new')), /cancelled/); assert.throws(() => act(run, { type: 'resume' }), /cancelled/);
});
test('duplicate finishes are idempotent and conflicting terminal results reject', () => {
  let run = act(fresh(), start()); run = act(run, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'failed' });
  assert.deepEqual(applyAction(run, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'failed' }).events, []);
  assert.throws(() => act(run, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'succeeded' }), /conflicting terminal/);
});
test('pause gates new dispatch while allowing in-flight finish and explicit resume', () => {
  let run = act(fresh(), start()); run = act(run, { type: 'pause' }); assert.equal(readiness(run).state, 'paused'); assert.throws(() => act(run, start('new', 'child')), /run state/);
  run = act(run, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'succeeded' }); assert.equal(run.status, 'paused'); assert.equal(act(run, { type: 'resume' }).status, 'ready');
  assert.throws(() => act(fresh(), { type: 'resume' }), /only paused/);
});
test('completion requires nodes artifact and all required passed evidence', () => {
  assert.throws(() => act(fresh(), { type: 'complete' }), /required nodes unfinished/);
  const run = built(); assert.throws(() => act(run, { type: 'complete' }), /lacks current passed evidence/);
  const failure = act(run, { type: 'recordEvidence', evidence: { id: 'failed', criterionId: 'correct', contractVersion: 1, artifactDigest: 'digest', verdict: 'failed', verifierVersion: 'v' } }); assert.throws(() => act(failure, { type: 'complete' }), /lacks current passed evidence/);
  assert.equal(act(passed(), { type: 'complete' }).status, 'succeeded');
});
test('completion rejects active optional attempts unsettled usage and unreleased leases', () => {
  const verified = passed(); const active = act(verified, start('optional', 'child', 1, ['other'])); assert.throws(() => act(active, { type: 'complete' }), /active attempts/);
  const finished = act(active, { type: 'finishAttempt', attemptId: 'optional', outcome: 'failed' }); assert.throws(() => act(finished, { type: 'complete' }), /unsettled/);
  const settled = act(finished, { type: 'settleAttempt', attemptId: 'optional', actual: 1 }); assert.throws(() => act(settled, { type: 'complete' }), /unreleased/);
  assert.equal(act(act(settled, { type: 'releaseLease', resource: 'other', attemptId: 'optional' }), { type: 'complete' }).status, 'succeeded');
});
test('unresolved operations block completion and dispatch until explicit confirmation', () => {
  let run = act(passed(), { type: 'setOperation', operationId: 'op', attemptId: 'attempt', status: 'unknown' }); assert.equal(readiness(run).state, 'blocked');
  assert.throws(() => act(run, { type: 'complete' }), /unresolved/); assert.throws(() => act(run, start('optional', 'child', 1, [])), /unresolved/);
  run = act(run, { type: 'setOperation', operationId: 'op', attemptId: 'attempt', status: 'confirmed' }); assert.equal(act(run, { type: 'complete' }).status, 'succeeded');
  assert.throws(() => act(run, { type: 'setOperation', operationId: 'op', attemptId: 'attempt', status: 'pending' }), /immutable/);
});
test('artifact changes invalidate evidence and returning to an old digest cannot revive it', () => {
  const run = passed(); const changed = applyAction(run, { type: 'setArtifact', artifact: { ...run.artifact!, digest: 'new' } }); assert.deepEqual(changed.run.evidence, []); assert.equal((changed.events[0]!.details.invalidatedEvidence as unknown[]).length, 1);
  const restored = act(changed.run, { type: 'setArtifact', artifact: run.artifact! }); assert.throws(() => act(restored, { type: 'complete' }), /lacks current passed evidence/);
  assert.throws(() => act(changed.run, { type: 'recordEvidence', evidence: run.evidence[0]! }), /stale evidence artifact/);
});
test('contract replacement cancels old writers preserves budget and invalidates old candidate', () => {
  const running = act(passed(), start('optional', 'child', 1, ['other'])); const nextContract = { ...running.contract, version: 2 };
  const run = act(running, { type: 'replaceContract', contract: nextContract }); assert.equal(run.budget.spent, 2); assert.equal(run.artifact, null); assert.deepEqual(run.evidence, []); assert.equal(run.attempts.at(-1)!.status, 'cancelled'); assert.equal(run.leases.at(-1)!.released, false);
  assert.throws(() => act(run, { type: 'replaceContract', contract: nextContract }), /increment/); assert.throws(() => act(run, { type: 'setArtifact', artifact: running.artifact! }), /stale artifact/);
  assert.equal(act(run, { type: 'finishAttempt', attemptId: 'optional', outcome: 'succeeded' }).nodes[1]!.status, 'pending');
});
test('evidence ids are immutable and a newer failed verdict supersedes an earlier pass', () => {
  const run = passed(); assert.deepEqual(applyAction(run, { type: 'recordEvidence', evidence: run.evidence[0]! }).events, []);
  assert.throws(() => act(run, { type: 'recordEvidence', evidence: { ...run.evidence[0]!, verdict: 'failed' } }), /immutable/);
  const failed = act(run, { type: 'recordEvidence', evidence: { ...run.evidence[0]!, id: 'new-evidence', verdict: 'unknown' } }); assert.throws(() => act(failed, { type: 'complete' }), /lacks current/);
  assert.throws(() => act(run, { type: 'recordEvidence', evidence: { ...run.evidence[0]!, id: 'other', criterionId: 'missing' } }), /unknown evidence criterion/);
});
test('readiness distinguishes active paused cancelled blocked verification and complete', () => {
  assert.equal(readiness(act(fresh(), start())).state, 'active'); assert.equal(readiness(act(fresh(), { type: 'pause' })).state, 'paused'); assert.equal(readiness(act(fresh(), { type: 'cancel' })).state, 'cancelled');
  const blocked = fresh(); blocked.nodes[0]!.status = 'blocked'; assert.equal(readiness(blocked).state, 'blocked');
  const verification = built(); verification.nodes[1]!.status = 'succeeded'; assert.equal(readiness(verification).state, 'verification');
  assert.equal(readiness(act(passed(), { type: 'complete' })).state, 'complete');
});
test('verification attempts can consume protected allowance without rewriting execution success', () => {
  const run = built(); const action = { ...start('verify', 'build', 2, []), purpose: 'verification' } as RunAction;
  assert.throws(() => act(fresh(), action), /verification needs/); const verifying = act(run, action); assert.equal(verifying.nodes[0]!.status, 'succeeded');
  const finished = act(verifying, { type: 'finishAttempt', attemptId: 'verify', outcome: 'failed' }); assert.equal(finished.nodes[0]!.status, 'succeeded');
  assert.equal(act(finished, { type: 'settleAttempt', attemptId: 'verify', actual: 2 }).budget.spent, 4);
});
test('completed runs are terminal and duplicate completion preserves revision', () => {
  const complete = act(passed(), { type: 'complete' }); assert.deepEqual(applyAction(complete, { type: 'complete' }).events, []); assert.throws(() => act(complete, { type: 'pause' }), /terminal/); assert.throws(() => act(complete, { type: 'setArtifact', artifact: complete.artifact! }), /terminal/);
});
test('verification catalog publication retains immutable revisions and rejects stale bases', () => {
  validateVerificationChange(catalog(), change()); validateVerificationChange(null, { ...change(), baseVersion: 0, cases: [verificationCase()] });
  assert.throws(() => validateVerificationChange(catalog(), { ...change(), baseVersion: 0 }), /stale catalog/);
  const overwritten = change(); overwritten.cases[0]!.definition = 'weaker'; assert.throws(() => validateVerificationChange(catalog(), overwritten), /overwritten/);
  assert.throws(() => validateVerificationChange(catalog(), { ...change(), cases: change().cases.slice(1) }), /removed/);
  assert.throws(() => validateVerificationChange(catalog(), { ...change(), status: 'published' }), /proposed/);
});
test('verification replacement and retirement preserve defects and required coverage', () => {
  const defect = change(); defect.cases[2]!.defectRefs = []; assert.throws(() => validateVerificationChange(catalog(), defect), /drops defect/);
  const coverage = change(); coverage.cases[2]!.criterionIds = ['different']; assert.throws(() => validateVerificationChange(catalog(), coverage), /drops criterion/);
  const retirement = change(); retirement.cases.pop(); assert.throws(() => validateVerificationChange(catalog(), retirement), /explicit replacement/);
  const revision = change(); revision.cases[1]!.defectRefs = []; assert.throws(() => validateVerificationChange(catalog(), revision), /revision drops defect/);
});
test('verification catalog rejects skipped revisions duplicate definitions and unknown replacements', () => {
  const skipped = change(); skipped.cases[1]!.revision = 3; assert.throws(() => validateVerificationChange(catalog(), skipped), /increment/);
  const duplicate = change(); duplicate.cases.push(duplicate.cases[0]!); assert.throws(() => validateVerificationChange(catalog(), duplicate), /duplicate case/);
  const unknown = change(); unknown.cases[2]!.replaces = ['missing']; assert.throws(() => validateVerificationChange(catalog(), unknown), /unknown case/);
});
test('frozen verification plan binds current catalog contract candidate and active revisions', () => {
  const run = built(); validateVerificationPlan(run, catalog(), plan());
  for (const override of [{ catalogVersion: 2 }, { contractVersion: 2 }, { artifactDigest: 'old' }]) assert.throws(() => validateVerificationPlan(run, catalog(), { ...plan(), ...override }), /mismatch/);
  assert.throws(() => validateVerificationPlan(run, catalog(), { ...plan(), cases: [{ ...plan().cases[0]!, revision: 2 }] }), /active current/);
  const retiredCatalog = catalog(); retiredCatalog.cases.push({ ...verificationCase(), revision: 2, status: 'retired' }); assert.throws(() => validateVerificationPlan(run, retiredCatalog, plan()), /active current/);
  const foreignCriterion = catalog(); foreignCriterion.cases[0]!.criterionIds.push('other-run-criterion'); assert.throws(() => validateVerificationPlan(run, foreignCriterion, plan()), /outside run contract/);
});
test('frozen verification plan rejects missing necessary criteria and duplicate parameter instances', () => {
  assert.throws(() => validateVerificationPlan(built(), catalog(), { ...plan(), cases: [] }), /lacks required/);
  const duplicate = plan(); duplicate.cases.push({ ...duplicate.cases[0]!, parameters: { platform: 'mac' } }); assert.throws(() => validateVerificationPlan(built(), catalog(), duplicate), /duplicate verification/);
  const order = plan(); order.cases[0]!.parameters = { platform: 'mac', input: 'bad' }; order.cases.push({ ...order.cases[0]!, parameters: { input: 'bad', platform: 'mac' } }); assert.throws(() => validateVerificationPlan(built(), catalog(), order), /duplicate verification/);
});
test('frozen verification plan preserves distinct platform and fault parameter coverage', () => {
  const value = plan(); value.cases.push({ ...value.cases[0]!, parameters: { platform: 'linux' } }, { ...value.cases[0]!, parameters: { platform: 'mac', fault: 'bad-input' } }); validateVerificationPlan(built(), catalog(), value); assert.equal(value.cases.length, 3);
});
test('command parser validates every command family and returns independent nested copies', () => {
  const commands = [ { commandId: 'c', type: 'createProject', project: { id: 'p', name: 'Project' } }, { commandId: 'c', type: 'createRun', input: input() }, { commandId: 'c', type: 'act', projectId: 'p', runId: 'r', expectedRevision: 0, action: start() }, { commandId: 'c', type: 'publishArtifact', projectId: 'p', runId: 'r', expectedRevision: 0, artifactId: 'a', content: '' }, { commandId: 'c', type: 'proposeVerificationChange', projectId: 'p', change: change() }, { commandId: 'c', type: 'publishVerificationChange', projectId: 'p', changeId: 'x', baseVersion: 0 }, { commandId: 'c', type: 'freezeVerificationPlan', projectId: 'p', runId: 'r', plan: plan() } ];
  for (const command of commands) { const parsed = parseCommand(command); assert.deepEqual(parsed, command); assert.notEqual(parsed, command); }
  const original = commands[1]!; const parsed = parseCommand(original); assert.equal(parsed.type, 'createRun'); if (parsed.type === 'createRun') { parsed.input.contract.goal = 'changed'; assert.equal(original.input!.contract.goal, 'produce artifact'); }
  const refs = [{ runId: 'prior-run', artifactId: 'prior-artifact' }];
  for (const command of [{ commandId: 'refs-change', type: 'proposeVerificationChange', projectId: 'p', change: { ...change(), evidenceRefs: refs } }, { commandId: 'refs-plan', type: 'freezeVerificationPlan', projectId: 'p', runId: 'r', plan: { ...plan(), evidenceRefs: refs } }]) {
    assert.deepEqual(parseCommand(command), command);
    const member = command.type === 'proposeVerificationChange' ? 'change' : 'plan';
    const payload = command[member as keyof typeof command];
    for (const evidenceRefs of [undefined, null, {}, [{ runId: '', artifactId: 'a' }], [{ runId: 'r', artifactId: 1 }], [{ runId: 'r', artifactId: 'a', extra: true }], [refs[0], refs[0]]]) {
      assert.throws(() => parseCommand({ ...command, [member]: { ...(payload as object), evidenceRefs } }));
    }
  }
});
test('command parser rejects extra missing inherited accessor and unknown action fields', () => {
  const command = { commandId: 'c', type: 'act', projectId: 'p', runId: 'r', expectedRevision: 0, action: start() };
  for (const value of [null, [], JSON.stringify(command), { ...command, surprise: 1 }, { ...command, action: { ...start(), surprise: 1 } }, { ...command, action: { type: 'skipBudget' } }, { ...command, commandId: undefined }, Object.create(command)]) assert.throws(() => parseCommand(value));
  assert.throws(() => parseCommand({ ...command, get expectedRevision() { throw new Error('must not run getter'); } }), /accessors/);
  const hidden = { ...command }; Object.defineProperty(hidden, 'commandId', { value: 'hidden', enumerable: false }); assert.throws(() => parseCommand(hidden), /nonenumerable/);
});
test('command parser rejects unsafe numeric revisions nonbooleans and sparse arrays', () => {
  for (const expectedRevision of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '0']) assert.throws(() => parseCommand({ commandId: 'c', type: 'act', projectId: 'p', runId: 'r', expectedRevision, action: start() }), /number/);
  const value = input(); (value.nodes[0] as unknown as Record<string, unknown>).required = 'true'; assert.throws(() => parseCommand({ commandId: 'c', type: 'createRun', input: value }), /boolean/);
  const sparse = input(); sparse.nodes = new Array(1); assert.throws(() => createRun(sparse), /sparse/);
});
test('query parser validates all query families and rejects malformed cursors and fields', () => {
  for (const query of [{ type: 'projects' }, { type: 'runs', projectId: 'p' }, { type: 'run', projectId: 'p', runId: 'r' }, { type: 'events', after: 0, projectId: 'p' }, { type: 'catalog', projectId: 'p' }, { type: 'changes', projectId: 'p' }, { type: 'plans', projectId: 'p', runId: 'r' }]) { assert.deepEqual(parseQuery(query), query); assert.notEqual(parseQuery(query), query); }
  for (const after of [-1, NaN, Infinity, 0.5, '0']) assert.throws(() => parseQuery({ type: 'events', projectId: 'p', after }), /number/);
  assert.throws(() => parseQuery({ type: 'projects', projectId: 'p' }), /unknown field/); assert.throws(() => parseQuery({ type: 'run', projectId: 'p' }), /required field/);
});

test('active verification revisions cannot shrink inherited criterion coverage', () => {
  const previous = catalog(); previous.cases[0]!.criterionIds = ['correct', 'failure-path'];
  const proposal: VerificationChange = { id: 'shrink', baseVersion: 1, reason: 'attempt to drop failure path', status: 'proposed', cases: [...previous.cases, { ...previous.cases[0]!, revision: 2, criterionIds: ['correct'] }] };
  assert.throws(() => validateVerificationChange(previous, proposal), /revision drops criterion coverage/);
  proposal.cases[1]!.criterionIds = ['correct', 'failure-path', 'added-regression']; validateVerificationChange(previous, proposal);
});

test('later verification publications retain replacement lineage and historical coverage', () => {
  validateVerificationChange(catalog(), change());
  const previous: VerificationCatalog = { ...catalog(), version: 2, cases: change().cases };
  const replacement = previous.cases.find((c) => c.id === 'replacement')!;
  const proposal: VerificationChange = { id: 'later', baseVersion: 2, reason: 'attempt to forget replacement', status: 'proposed', cases: [...previous.cases, { ...replacement, revision: 2, replaces: [] }] };
  assert.throws(() => validateVerificationChange(previous, proposal), /drops replacement lineage/);
  proposal.cases.at(-1)!.replaces = ['case']; proposal.cases.at(-1)!.criterionIds = ['unrelated'];
  assert.throws(() => validateVerificationChange(previous, proposal), /drops criterion coverage/);
  proposal.cases = [...previous.cases, { ...replacement, revision: 2, status: 'retired' }];
  assert.throws(() => validateVerificationChange(previous, proposal), /explicit replacement coverage/);
});

test('transitive verification replacement preserves all retired ancestors and defects', () => {
  const previous: VerificationCatalog = { ...catalog(), version: 2, cases: change().cases };
  const replacement = previous.cases.find((c) => c.id === 'replacement')!;
  const proposal: VerificationChange = { id: 'chain', baseVersion: 2, reason: 'equivalent successor', status: 'proposed', cases: [...previous.cases, { ...replacement, revision: 2, status: 'retired' }, { ...replacement, id: 'successor', revision: 1, replaces: ['replacement'] }] };
  validateVerificationChange(previous, proposal);
  proposal.cases.at(-1)!.criterionIds = ['unrelated']; assert.throws(() => validateVerificationChange(previous, proposal), /drops criterion coverage/);
  proposal.cases.at(-1)!.criterionIds = ['correct']; proposal.cases.at(-1)!.defectRefs = []; assert.throws(() => validateVerificationChange(previous, proposal), /drops defect reference/);
});

test('verification publication rejects retired id revival and cyclic replacement ancestry', () => {
  const previous: VerificationCatalog = { ...catalog(), version: 2, cases: change().cases };
  const retired = previous.cases.find((c) => c.id === 'case' && c.revision === 2)!;
  assert.throws(() => validateVerificationChange(previous, { id: 'revival', baseVersion: 2, reason: 'revive stable id', status: 'proposed', cases: [...previous.cases, { ...retired, revision: 3, status: 'active' }] }), /cannot be revived/);
  const cyclicBase: VerificationCatalog = { ...catalog(), cases: [verificationCase(), { ...verificationCase(), id: 'second' }] };
  const cycle: VerificationChange = { id: 'cycle', baseVersion: 1, reason: 'invalid mutual replacement', status: 'proposed', cases: [...cyclicBase.cases, { ...verificationCase(), revision: 2, status: 'retired', replaces: ['second'] }, { ...verificationCase(), id: 'second', revision: 2, status: 'retired', replaces: ['case'] }] };
  assert.throws(() => validateVerificationChange(cyclicBase, cycle), /cyclic replacement lineage/);
});

test('overspent verified runs report completion without dispatching optional work', () => {
  let run = act(fresh(), start()); run = act(run, { type: 'finishAttempt', attemptId: 'attempt', outcome: 'succeeded' }); run = act(run, { type: 'settleAttempt', attemptId: 'attempt', actual: 11 });
  run = act(run, { type: 'releaseLease', resource: 'workspace', attemptId: 'attempt' }); run = act(run, { type: 'setArtifact', artifact: { id: 'artifact', digest: 'digest', path: 'artifact.txt', contractVersion: 1 } });
  assert.equal(readiness(run).state, 'blocked'); run = passed(run); assert.equal(run.status, 'blocked'); assert.equal(run.budget.spent, 11); assert.equal(run.nodes[1]!.status, 'pending'); assert.equal(readiness(run).state, 'complete');
  assert.throws(() => act(run, start('optional', 'child', 0, [])), /budget/); assert.equal(act(run, { type: 'complete' }).status, 'succeeded');
  assert.equal(readiness(act(run, { type: 'pause' })).state, 'paused'); assert.equal(readiness(act(run, { type: 'cancel' })).state, 'cancelled');
});

test('readiness completion remains gated by active writers accounting leases and operations', () => {
  const run = passed(); const active = act(run, start('writer', 'child', 1, ['other'])); assert.equal(readiness(active).state, 'active');
  const finished = act(active, { type: 'finishAttempt', attemptId: 'writer', outcome: 'succeeded' }); assert.equal(readiness(finished).state, 'blocked');
  const settled = act(finished, { type: 'settleAttempt', attemptId: 'writer', actual: 1 }); assert.equal(readiness(settled).state, 'blocked');
  const released = act(settled, { type: 'releaseLease', resource: 'other', attemptId: 'writer' }); assert.equal(readiness(released).state, 'complete');
  const unresolved = act(released, { type: 'setOperation', operationId: 'op', attemptId: 'writer', status: 'unknown' }); assert.equal(readiness(unresolved).state, 'blocked');
});

test('domain immutable equality accepts reordered persisted object keys', () => {
  const previous = catalog(); previous.cases = previous.cases.map((c) => Object.fromEntries(Object.entries(c).reverse()) as unknown as VerificationCase);
  validateVerificationChange(previous, change());
  const run = passed(); const evidence = Object.fromEntries(Object.entries(run.evidence[0]!).reverse()) as unknown as NonNullable<Run['evidence'][number]>;
  assert.deepEqual(applyAction(run, { type: 'recordEvidence', evidence }).events, []);
});
