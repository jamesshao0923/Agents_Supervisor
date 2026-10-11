import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnManagedProcess} from '../../packages/process-control/index.js';
import {ExecutionManager} from '../../packages/execution/manager.js';
import type {ExecutionState} from '../../packages/contracts/p2.js';
import {ResearchRuntimeActivity} from '../../packages/runtime/research-activity.js';
import type {DatabaseSync} from 'node:sqlite';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {goalProposalSchema} from '../../packages/contracts/p5.js';
import {validateProposal} from '../../packages/orchestration/admission.js';
import {parseReasonerOutput} from '../../packages/orchestration/reasoner-schema.js';
import {LocalRuntimeWorker} from '../../packages/runtime/worker.js';
import {fixture, proposal} from '../helpers/research-group-admission-fixture.js';
function db(store: SupervisorStore): DatabaseSync {return (store as unknown as {db: DatabaseSync}).db;}
function admitAction(session: {id: string; revision: number}, commandId = 'admit') {
  return {type: 'admit' as const, commandId, sessionId: session.id, expectedRevision: session.revision};
}
test('P8-GADMIT-I01 actual P5 admission registers 1 2plus4 3 5 groups before real worker installation while preserving the original complete analysis and shared budget', async t => {
  const f = await fixture(t), ended = f.ready(), before = structuredClone(ended.run.budget);
  f.store.goals.validateAdmission(admitAction(ended.session));
  const admitted = f.admit(ended.session.revision), runtimeId = admitted.session.runtimeId!;
  assert.equal(admitted.session.researchGrouping!.mode, 'grouped');
  const registration = f.store.researchGroups.byRuntime(runtimeId)!;
  assert.deepEqual(registration.groups.map(group => group.materialIds), [['m1'], ['m2', 'm4'], ['m3'], ['m5']]);
  assert.equal(registration.maxActive, 2); assert.equal(registration.state, 'waiting-materials');
  assert.ok(registration.groups.every(group => group.reservation === 100 && group.criterionIds.includes('trace')));
  assert.deepEqual(admitted.run.budget, before); assert.equal(admitted.run.budget.spent, 7);
  assert.equal(f.store.executionList().length, 0); assert.equal(f.store.scheduler.list().length, 0);
  const definition = f.store.runtime.get(runtimeId).definition;
  assert.deepEqual(definition.steps.map(step => step.kind), ['materials', 'codex']);
  assert.equal(definition.steps[1]!.kind, 'codex');
  if (definition.steps[1]!.kind === 'codex') {
    assert.equal(definition.steps[1]!.reservation, 100);
    assert.deepEqual(definition.steps[1]!.research!.requirements[0]!.requiredMaterialIds, ['m1', 'm2', 'm3', 'm4', 'm5']);
  }
  const worker = new LocalRuntimeWorker(f.store, f.data, 'explicit-local-worker');
  try {
    const tick = (worker as unknown as {tick(id: string): Promise<void>}).tick.bind(worker);
    await tick(runtimeId); await tick(runtimeId);
    const installed = f.store.researchGroups.byRuntime(runtimeId)!;
    assert.equal(installed.state, 'installed');
    const scheduler = f.store.scheduler.get(installed.schedulerId!);
    assert.equal(scheduler.plan.tasks.length, 4); assert.equal(scheduler.plan.limits.maxActive, 2);
    assert.ok(scheduler.plan.tasks.every(task => task.step.model === ended.session.config.model &&
      task.step.effort === ended.session.config.effort && task.step.timeoutMs === ended.session.config.timeoutMs));
    const full = f.store.runtime.inspect(runtimeId);
    assert.equal(full.run.budget.spent, 7); assert.equal(full.run.budget.limit, 1000);
    assert.equal(full.run.budget.verificationReserve, 300); assert.equal(full.run.budget.futureExecution!.amount, 100);
    assert.equal(full.run.nodes.find(node => node.id === 'analyze')!.dependencies.length, 5);
    assert.equal(f.store.runtime.claim(runtimeId, 'other-owner'), null, 'Final analysis remains fenced until all actual submitted group results');
    assert.equal(f.store.executionList().length, 0, 'This test only executes actual material acquisition and graph installation, no provider call');
    assert.equal(full.run.contract.criteria.length, 1); assert.equal(full.run.status, 'ready');
  } finally {await worker.close();}
});
test('P8-GADMIT-I02 actual invalid scope and SQLite registration failure roll back admitted contract runtime results and receipts without silent single fallback', async t => {
  for (const kind of ['missing', 'duplicate', 'foreign', 'sqlite'] as const) {
    const f = await fixture(t), p = proposal();
    if (kind === 'missing') p.researchGroups!.groups.pop();
    if (kind === 'duplicate') p.researchGroups!.groups[0]!.materialIds.push('m2');
    if (kind === 'foreign') p.researchGroups!.groups[0]!.criterionIds = ['foreign'];
    const ready = f.ready(p), before = f.store.goals.inspect(ready.session.id);
    if (kind === 'sqlite') db(f.store).exec("CREATE TRIGGER reject_group_registration BEFORE INSERT ON research_group_registrations BEGIN SELECT RAISE(ABORT,'explicit host transaction fault'); END;");
    assert.throws(() => f.admit(ready.session.revision), /Research grouping|explicit host transaction fault/);
    assert.deepEqual(f.store.goals.inspect(ready.session.id), before);
    assert.equal(f.store.runtime.list().length, 0); assert.equal(f.store.scheduler.list().length, 0);
    assert.equal(db(f.store).prepare('SELECT COUNT(*) n FROM research_group_registrations').get()!['n'], 0);
    assert.equal(db(f.store).prepare('SELECT COUNT(*) n FROM task_result_ledgers').get()!['n'], 0);
    assert.equal(db(f.store).prepare("SELECT COUNT(*) n FROM goal_receipts WHERE command_id='admit'").get()!['n'], 0);
    assert.equal(f.store.executionList().length, 0);
  }
});
test('P8-GADMIT-I03 actual single fallback is durable visible and budget bounded while absent nullable grouping and ordinary engineering retain the old path', async t => {
  const f = await fixture(t, 700), ended = f.ready(), admitted = f.admit(ended.session.revision);
  assert.equal(admitted.session.researchGrouping!.mode, 'single');
  assert.match(admitted.session.researchGrouping!.reason, /cannot fund every proposed group/);
  assert.equal(admitted.session.researchGrouping!.registrationId, null);
  assert.equal(f.store.researchGroups.byRuntime(admitted.session.runtimeId!), null);
  assert.deepEqual(admitted.run.budget, ended.run.budget); assert.equal(f.store.runtime.get(admitted.session.runtimeId!).definition.steps.length, 2);
  const reopened = new SupervisorStore(f.data);
  try {assert.deepEqual(reopened.goals.inspect(ended.session.id), admitted);} finally {reopened.close();}
  assert.deepEqual(f.admit(ended.session.revision), admitted);
  for (const nullable of [undefined, null] as const) {
    const g = await fixture(t), p = proposal(); if (nullable === undefined) delete p.researchGroups; else p.researchGroups = null;
    const ready = g.ready(p), result = g.admit(ready.session.revision);
    assert.equal(result.session.researchGrouping!.mode, 'single'); assert.equal(g.store.researchGroups.byRuntime(result.session.runtimeId!), null);
    assert.equal(g.store.runtime.get(result.session.runtimeId!).definition.steps.length, 2);
  }
  const weak = await fixture(t, 400), ready = weak.ready();
  assert.throws(() => weak.admit(ready.session.revision), /Insufficient execution budget|original full analysis/);
  assert.deepEqual(weak.store.goals.inspect(ready.session.id), ready); assert.equal(weak.store.runtime.list().length, 0);
  const ordinary = await fixture(t), nonresearch = ordinary.started.session;
  // A separate actual old-path goal carries no configured research and no group field.
  const started = ordinary.store.goals.start({type: 'start', commandId: 'engineering', workspace: ordinary.workspace,
    goal: 'Implement an actual engineering plan', tokenLimit: 1000, verificationReserve: 300,
    ...nonresearch.config}, ordinary.workspace, 'project');
  const p = proposal(); delete p.researchGroups; p.criteria[0]!.kind = 'command'; p.criteria[0]!.target = 'check.mjs';
  const finished = ordinary.store.goals.finish(started.session.id, started.session.jobs[0]!.id, job => {job.usage = 7; job.stopConfirmed = true; job.proposal = p;});
  const engineering = ordinary.store.goals.control(admitAction(finished.session, 'engineering-admit'));
  assert.equal(engineering.session.researchGrouping, undefined);
  assert.deepEqual(ordinary.store.runtime.get(engineering.session.runtimeId!).definition.steps.map(step => step.kind), ['codex']);
});
test('P8-GADMIT-I04 actual parent rollback unknown planning cost cancellation and reopen preserve original reservations and never authorize group work', async t => {
  const f = await fixture(t), ended = f.ready(), before = f.store.goals.inspect(ended.session.id);
  db(f.store).exec('BEGIN IMMEDIATE'); const inside = f.admit(ended.session.revision);
  assert.equal(inside.session.researchGrouping!.mode, 'grouped');
  db(f.store).exec('ROLLBACK'); assert.deepEqual(f.store.goals.inspect(ended.session.id), before);
  assert.equal(f.store.runtime.list().length, 0); assert.equal(db(f.store).prepare('SELECT COUNT(*) n FROM research_group_registrations').get()!['n'], 0);
  const valid = f.admit(ended.session.revision); assert.equal(valid.session.researchGrouping!.mode, 'grouped');
  assert.deepEqual(f.admit(ended.session.revision), valid); assert.equal(db(f.store).prepare('SELECT COUNT(*) n FROM research_group_registrations').get()!['n'], 1);
  // Restoration reanalyses context; it must not copy old execution decomposition
  // into the new output schema or pretend to register/run another generation.
  const frozenRegistration = f.store.researchGroups.byRuntime(valid.session.runtimeId!)!;
  f.store.runtime.control({type: 'pause', commandId: 'restore-quiet', runtimeId: valid.session.runtimeId!});
  const restoring = f.store.goals.control({type: 'restore', commandId: 'restore-grouped',
    sessionId: valid.session.id, expectedRevision: valid.session.revision});
  const restoration = {...proposal(), decomposition: null, iteration: null, exploration: []};
  delete restoration.researchGroups;
  parseReasonerOutput(JSON.stringify(restoration), goalProposalSchema(restoring.session.messages.map(message => message.id), 'graph-exploration-v1'));
  validateProposal(restoration, restoring.session);
  const restored = f.store.goals.finish(valid.session.id, restoring.session.jobs.at(-1)!.id, job => {
    job.usage = 3; job.stopConfirmed = true; job.proposal = restoration;
  });
  assert.deepEqual(restored.session.proposal, valid.session.proposal, 'Restore keeps the original actual admitted grouping, never substitutes the context summary');
  assert.deepEqual(restored.session.researchGrouping, valid.session.researchGrouping);
  assert.deepEqual(f.store.researchGroups.byRuntime(valid.session.runtimeId!), frozenRegistration);
  assert.equal(restored.run.budget.spent, 10); assert.equal(f.store.executionList().length, 0);

  const unknown = await fixture(t), refused = unknown.ready(proposal(), null);
  assert.throws(() => unknown.admit(refused.session.revision), /not ready|Unresolved/);
  const reopened = new SupervisorStore(unknown.data);
  try {
    const actual = reopened.goals.inspect(refused.session.id);
    assert.equal(actual.run.attempts[0]!.reservation, 100); assert.equal(actual.run.attempts[0]!.settled, false);
    assert.equal(actual.run.budget.spent, 0); assert.equal(reopened.runtime.list().length, 0);
  } finally {reopened.close();}
  const cancelled = await fixture(t), finished = cancelled.ready();
  cancelled.store.goals.control({type: 'cancel', commandId: 'cancel-before-admit', sessionId: finished.session.id});
  assert.throws(() => cancelled.admit(cancelled.store.goals.get(finished.session.id).revision), /cancelled/);
  assert.equal(cancelled.store.runtime.list().length, 0); assert.equal(cancelled.store.executionList().length, 0);
});


test('P8-GADMIT-I05 actual authorized same Run revision atomically retires old waiting or installed groups and reacquires all sources for a complete single analysis', async t => {
  for (const installed of [false, true]) {
    const f = await fixture(t), admitted = f.admit(f.ready().session.revision);
    const runtimeId = admitted.session.runtimeId!, owner = 'revision-fixture-owner';
    const activity = new ResearchRuntimeActivity(f.store, f.data);
    if (installed) {
      const worker = new LocalRuntimeWorker(f.store, f.data, owner);
      try {
        const tick = (worker as unknown as {tick(id: string): Promise<void>}).tick.bind(worker);
        await tick(runtimeId); await tick(runtimeId);
      } finally {await worker.close();}
    }
    const registration = f.store.researchGroups.byRuntime(runtimeId)!;
    assert.equal(registration.state, installed ? 'installed' : 'waiting-materials');
    const conversation = f.store.conversations.forRun(admitted.run.projectId, admitted.run.id)!;
    const message = f.store.conversations.receive({commandId: 'clarify-report', conversationId: conversation.id,
      kind: 'change', source: 'user', text: 'Keep all original source and acceptance requirements; make the narrative clearer.'});
    const begun = f.store.goals.beginFollowup(admitted.session.id, message.id), jobId = begun.session.jobs.at(-1)!.id;
    const p = proposal(); delete p.researchGroups;
    const proof = join(f.root, 'explicit-synthetic-followup-proof.json'), bytes = JSON.stringify({notProvider: true, proposal: p});
    await writeFile(proof, bytes);
    const finished = f.store.goals.finish(admitted.session.id, jobId, job => {
      // SQLite/FS lifecycle checks use an explicit synthetic planning result and
      // known 3-token accounting; this is not provider semantic approval.
      job.usage = 3; job.stopConfirmed = true;
      job.proofs = {[proof]: createHash('sha256').update(bytes).digest('hex')};
      job.followupResult = {decision: 'revise', response: 'Preserve every original requirement.',
        proposal: p, retiredCriterionIds: [], retirementSources: []};
    });
    const beforeRuntime = f.store.runtime.inspect(runtimeId), beforeEvents = db(f.store)
      .prepare('SELECT kind,record FROM research_group_events WHERE registration_id=? ORDER BY rowid').all(registration.id);
    db(f.store).exec("CREATE TRIGGER reject_group_revision_ack BEFORE UPDATE ON conversation_messages WHEN json_extract(NEW.record,'$.state')='applied' BEGIN SELECT RAISE(ABORT,'explicit late acknowledgement fault'); END;");
    assert.throws(() => f.store.goals.applyFollowup(admitted.session.id, jobId), /explicit late acknowledgement fault/);
    assert.deepEqual(f.store.goals.inspect(admitted.session.id), finished);
    assert.deepEqual(f.store.runtime.inspect(runtimeId), beforeRuntime);
    assert.deepEqual(f.store.researchGroups.get(registration.id), registration);
    assert.deepEqual(db(f.store).prepare('SELECT kind,record FROM research_group_events WHERE registration_id=? ORDER BY rowid').all(registration.id), beforeEvents);
    assert.equal(f.store.conversations.message(message.id).state, 'processing');
    db(f.store).exec('DROP TRIGGER reject_group_revision_ack');
    const applied = f.store.goals.applyFollowup(admitted.session.id, jobId);
    assert.equal(applied.run.contract.version, admitted.run.contract.version + 1);
    assert.deepEqual(applied.run.contract.criteria, admitted.run.contract.criteria);
    assert.equal(applied.run.budget.spent, 10); assert.equal(applied.run.budget.limit, 1000);
    assert.equal(applied.session.researchGrouping!.mode, 'single');
    assert.match(applied.session.researchGrouping!.reason, /Prior group configuration, costs and evidence remain historical/);
    const retired = f.store.researchGroups.get(registration.id);
    assert.equal(retired.state, 'retired'); assert.equal(retired.configurationDigest, registration.configurationDigest);
    assert.deepEqual(retired.groups, registration.groups); assert.deepEqual(retired.prepared, registration.prepared);
    assert.equal(retired.retirement!.previousContractVersion, registration.contractVersion);
    assert.equal(retired.retirement!.contractVersion, applied.run.contract.version);
    assert.equal(f.store.researchGroups.byRuntime(runtimeId), null);
    assert.equal(f.store.researchGroups.aggregate(runtimeId), null);
    if (installed) {
      const scheduler = f.store.scheduler.get(registration.schedulerId!);
      assert.equal(scheduler.state, 'cancelled'); assert.equal(scheduler.fence, 'released');
    }
    const reopened = new SupervisorStore(f.data);
    try {
      assert.deepEqual(reopened.researchGroups.get(registration.id), retired);
      assert.deepEqual(reopened.goals.applyFollowup(admitted.session.id, jobId), applied);
      assert.equal(reopened.executionList().length, 0);
    } finally {reopened.close();}
    const acquire = f.store.runtime.claim(runtimeId, owner)!; assert.equal(acquire.step.kind, 'materials');
    assert.equal(acquire.contractVersion, applied.run.contract.version);
    await activity.acquire(acquire, owner);
    assert.equal(f.store.runtime.getOperation(acquire.id).state, 'confirmed');
    const analysis = f.store.runtime.claim(runtimeId, owner)!;
    assert.equal(analysis.step.id, 'analyze'); assert.equal(analysis.contractVersion, applied.run.contract.version);
    await activity.prepare(analysis.id, owner);
    const input = f.store.runtime.researchInput(analysis.id)!;
    assert.equal(input.package.groups, undefined);
    assert.equal(input.package.context.index.entries.length, 5);
    assert.deepEqual(input.package.context.requirements[0]!.requiredMaterialIds, ['m1', 'm2', 'm3', 'm4', 'm5']);
    for (let i = 1; i <= 5; i++) assert.ok(input.package.prompt.includes('Actual frozen material ' + i));
    assert.equal(f.store.runtime.executionInput(analysis.id, owner).prompt, input.package.prompt);
    assert.equal(f.store.executionList().length, 0, 'Exact single-analysis dispatch eligibility is checked without a provider call');
    assert.equal(await readFile(proof, 'utf8'), bytes);
    assert.equal(f.store.runtime.inspect(runtimeId).run.budget.spent, 10);
  }
});


test('P8-GADMIT-I06 actual stopped failed or cancelled branches may retire without submitted success while unknown costs retain the old group fence and reservation', async t => {
  for (const outcome of ['failed', 'cancelled', 'unknown'] as const) {
    const f = await fixture(t), admitted = f.admit(f.ready().session.revision), runtimeId = admitted.session.runtimeId!;
    const owner = 'actual-failure-fixture', worker = new LocalRuntimeWorker(f.store, f.data, owner);
    try {
      const tick = (worker as unknown as {tick(id: string): Promise<void>}).tick.bind(worker);
      await tick(runtimeId); await tick(runtimeId);
    } finally {await worker.close();}
    const registration = f.store.researchGroups.byRuntime(runtimeId)!, schedulerId = registration.schedulerId!;
    const response = f.store.scheduler.claim({commandId: 'actual-failing-branch', id: schedulerId,
      expected: f.store.scheduler.expected(schedulerId), owner});
    assert.equal(response.kind, 'claimed'); if (response.kind !== 'claimed') throw Error('Actual claim missing');
    const claim = response.claim; f.store.scheduler.prepareInputs(claim.id, owner);
    const binding = f.store.scheduler.binding(claim.id, owner); f.store.scheduler.markStarted(binding);
    const record = f.store.executionCreate({...f.store.scheduler.executionInput(claim.id), workspace: claim.workspace, workspaceKind: claim.workspaceKind}, binding).record;
    // Real managed Node failure and physical stop. Provider turn/7-token values
    // below are explicit synthetic accounting fixtures, never model evidence.
    const child = await spawnManagedProcess({operationId: record.id, command: process.execPath,
      args: ['-e', 'process.exit(3)'], cwd: record.workspace, timeoutMs: 5000,
      onBeforeSpawn: intent => {f.store.executionUpdate(record.id, {}, 'process-intent', intent);},
      onIdentity: identity => {f.store.executionUpdate(record.id, {identity, pid: identity.pid}, 'process-identity', identity);}});
    const completion = await child.completion; assert.equal(completion.exitCode, 3);
    const stop = await child.terminate(); assert.equal(stop.stopped, true);
    f.store.executionUpdate(record.id, {threadId: 'synthetic-failed-thread', turnId: 'synthetic-failed-turn',
      turnIntent: true, terminalStatus: outcome === 'cancelled' ? 'interrupted' : 'failed',
      usageStatus: outcome === 'unknown' ? 'unknown' : 'reported',
      usage: outcome === 'unknown' ? null : {inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 7},
      error: 'Explicit actual failing Node fixture'}, 'explicit-synthetic-failed-accounting', {notProvider: true});
    const manager = new ExecutionManager(f.store, f.data, 'no-provider-used', {scope: 'scheduled'});
    try {
      await (manager as unknown as {finalize(id: string, state: ExecutionState, stopped: boolean, evidence: unknown,
        launched: boolean, authoritative: boolean): Promise<void>}).finalize(record.id,
        outcome === 'cancelled' ? 'cancelled' : 'failed', true, stop, true, true);
    } finally {await manager.close({cancel: false});}
    await f.store.scheduler.reconcileExecution({commandId: 'actual-failure-settlement', claimId: claim.id, executionId: record.id});
    const actual = f.store.runtime.inspect(runtimeId).run, attempt = actual.attempts.find(a => a.id === claim.attemptId)!;
    assert.equal(f.store.executionGet(record.id).stopConfirmed, true);
    assert.equal(f.store.taskResults.inspect({projectId: actual.projectId, runId: actual.id}).versions.length, 0);
    const contract = {...actual.contract, version: actual.contract.version + 1}, runtime = f.store.runtime.get(runtimeId);
    const revise = () => f.store.runtime.revise({commandId: 'actual-authorized-host-revision', runtimeId,
      expectedContractVersion: actual.contract.version, contract,
      nodes: runtime.definition.steps.map((step, i, steps) => ({id: step.id, required: true, dependencies: i ? [steps[i - 1]!.id] : []})),
      steps: runtime.definition.steps, reason: 'Actual host fixture revision preserving every original criterion'});
    if (outcome === 'unknown') {
      assert.equal(attempt.settled, false); assert.equal(attempt.reservation, 100);
      const before = f.store.runtime.inspect(runtimeId);
      assert.throws(revise, /Unresolved|unknown|settled|unsettled/i);
      assert.deepEqual(f.store.runtime.inspect(runtimeId), before);
      assert.deepEqual(f.store.researchGroups.byRuntime(runtimeId), registration);
      assert.equal(f.store.scheduler.get(schedulerId).fence, 'held');
      assert.equal(actual.budget.spent, 7);
    } else {
      assert.equal(attempt.settled, true); assert.equal(attempt.actual, 7);
      assert.equal(actual.budget.spent, 14); revise();
      assert.equal(f.store.researchGroups.get(registration.id).state, 'retired');
      assert.equal(f.store.researchGroups.byRuntime(runtimeId), null);
      assert.equal(f.store.scheduler.get(schedulerId).fence, 'released');
      assert.equal(f.store.runtime.inspect(runtimeId).run.budget.spent, 14);
      assert.deepEqual(f.store.runtime.inspect(runtimeId).run.contract.criteria, actual.contract.criteria);
    }
  }
});
