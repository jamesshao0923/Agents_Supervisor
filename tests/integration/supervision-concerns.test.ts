import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { runtimeCanonical } from '../../packages/persistence/runtime.js';
import { SupervisionConcernRepository } from '../../packages/persistence/supervision-concerns.js';
import { SupervisionConcernAdapter } from '../../packages/orchestration/supervision-concern-adapter.js';
import { decideConcernBoundary } from '../../packages/orchestration/supervision-concern-policy.js';
import { spawnManagedProcess, type ManagedProcess } from '../../packages/process-control/index.js';
import type { FrozenInspectionInput, InspectionResult } from '../../packages/contracts/p6-monitor.js';
import { selectInstances } from '../../packages/verification/rules.js';
import { canonical as verificationCanonical, captureCandidate } from '../../packages/verification/candidate.js';
import type { Proposal, FrozenPlan, VerificationJob } from '../../packages/verification/records.js';
import type { VerificationSpec } from '../../packages/contracts/p4.js';

// Actual SQLite repositories, immutable files and owned Node processes. The
// model response/usage and P4 published proposal below are explicit repository
// fixtures, not a live model, independent review or product delivery claim.
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const config = { model: 'never-invoke-model-concern-mechanism', effort: 'low', reservation: 30, timeoutMs: 1000 };
async function fixture(t: TestContext, structured = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sv-concern-'))), data = join(root, 'data'), workspace = join(root, 'workspace'); await mkdir(workspace);
  const store = new SupervisorStore(data); let db = new DatabaseSync(join(data, 'supervisor.sqlite')); db.exec('PRAGMA foreign_keys=ON');
  let repository = new SupervisionConcernRepository(db, data); let adapter = new SupervisionConcernAdapter(repository);
  const children: ManagedProcess[] = [];
  t.after(async () => { for (const child of children) { await child.terminate(); await child.completion; } db.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  let runtime: import('../../packages/contracts/p3.js').RuntimeRecord;
  if (structured) {
    const started = store.goals.start({ type: 'start', commandId: 'goal', goal: 'Retain original complete acceptance', tokenLimit: 1000, verificationReserve: 100, ...config }, workspace, 'project');
    const ready = store.goals.finish(started.session.id, started.session.jobs[0]!.id, job => { job.usage = 0; job.stopConfirmed = true; job.proposal = { decision: 'ready', summary: 'Repository admission fixture, no model', questions: [], facts: [{ text: started.session.goal, origin: 'explicit', sourceId: started.session.messages[0]!.id }], constraints: [], style: [], criteria: [{ id: 'original', description: 'Retain original complete acceptance', kind: 'command', target: 'artifact.mjs', checks: ['Verify the original requirement'] }], steps: [{ id: 'work', description: 'Implement', dependencies: [], acceptanceIds: ['original'] }] }; });
    const admitted = store.goals.control({ type: 'admit', commandId: 'admit', sessionId: started.session.id, expectedRevision: ready.session.revision }); runtime = store.runtime.get(admitted.session.runtimeId!);
  } else runtime = store.runtime.submit({ type: 'submit', commandId: 'runtime', workspace, workspaceKind: 'project', goal: 'Retain original complete acceptance', tokenLimit: 1000, verificationReserve: 100, steps: [{ id: 'work', kind: 'codex', prompt: 'Real Node process fixture, no Codex', ...config }] });
  const loop = store.supervision.attach({ commandId: 'loop', runtimeId: runtime.id, config, limits: { maxRepairs: 1, maxReasoningCalls: 8, maxDurationMs: 2_000_000, maxContextChars: 200000 } });
  // A saved epoch exercises repository mechanics; no claim of a real 300s wait.
  loop.createdAt = new Date(Date.now() - 300100).toISOString(); db.prepare('UPDATE supervision_loops SET record=? WHERE id=?').run(runtimeCanonical(loop), loop.id);
  store.supervisionMonitor.initialize({ commandId: 'baseline', loopId: loop.id, expectedRevision: loop.revision, startedAtMs: Date.parse(loop.createdAt), evidenceCursor: store.supervisionMonitor.cursor(loop.id) });
  const operation = store.runtime.claim(runtime.id, 'owner')!, binding = store.runtime.binding(operation.id, 'owner');
  const execution = store.executionCreate({ type: 'start', commandId: operation.id, workspace, workspaceKind: 'project', prompt: 'Owned Node mechanism writer', ...config, tokenLimit: 1000, verificationReserve: 100 }, binding).record;
  const writer = await spawnManagedProcess({ operationId: execution.id, command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: workspace, timeoutMs: 30000, onBeforeSpawn: intent => { store.executionUpdate(execution.id, {}, 'mechanism-intent', intent); }, onIdentity: identity => { store.executionUpdate(execution.id, { identity, state: 'running', pid: identity.pid }, 'mechanism-process', {}); } }); children.push(writer); store.runtime.markStarted(operation.id, 'owner');
  store.executionUpdate(execution.id, {}, 'codex-event', { kind: 'diff', diff: 'Fixture change with a review concern' });
  const event = store.executionEvents(execution.id, 0).at(-1)!, refs = [{ kind: 'execution-event' as const, executionId: execution.id, seq: event.seq }];
  const actual = store.supervision.get(loop.id);
  store.supervisionMonitor.observe({ commandId: 'window', loopId: loop.id, expectedRevision: actual.revision, input: { nowMs: Date.now(), lifecycle: 'active', evidenceCursor: store.supervisionMonitor.cursor(loop.id, refs) }, evidenceRefs: refs });
  const job = store.supervisionMonitor.beginInspection({ commandId: 'inspection', loopId: loop.id, expectedRevision: store.supervision.get(loop.id).revision, prompt: 'Explicit persisted response fixture, never a model invocation', evidenceRefs: refs });
  const path = join(data, 'supervision-inspection', 'logs', sha(job.id)); await mkdir(path, { recursive: true });
  const inspector = await spawnManagedProcess({ operationId: job.id + '-fixture', command: globalThis.process.execPath, args: ['-e', 'console.log("actual-node-only")'], cwd: path, timeoutMs: 3000, onBeforeSpawn: intent => { store.supervision.observeJob(job.id, { intents: [intent] }); }, onIdentity: identity => { store.supervision.observeJob(job.id, { identities: [identity], modelStarted: true, observedUsage: 3 }); } }); children.push(inspector);
  const result = await inspector.completion, saved = store.supervision.job(job.id), processPath = join(path, 'fixture.process.json');
  const evidenceId = (job.input as FrozenInspectionInput).context.snapshot.evidence[0]!.id;
  const observation: InspectionResult = { summary: 'Review the implementation against the original complete standard', assessment: 'concern', observations: [{ evidenceId, text: 'A recorded change may need checking' }], concerns: [{ evidenceIds: [evidenceId], description: 'Confirm this change under full acceptance; not an authorized repair' }], recommendation: 'request-diagnosis-at-safe-boundary' };
  const proofText = JSON.stringify({ intent: saved.intents[0], identity: saved.identities[0], result }); await writeFile(processPath, proofText);
  function finishInspection(unknown = false) {
    store.supervision.finishJob(job.id, { usage: unknown ? null : 3, stopConfirmed: true, error: unknown ? 'Explicit unknown usage fixture' : null, result: unknown ? null : observation, proofs: { [processPath]: sha(proofText) }, threadId: 'mechanism-metadata-only' });
    return store.supervisionMonitor.completeInspection({ commandId: 'disposition', jobId: job.id });
  }
  async function finishWriter(physical = true) {
    if (physical) { await writer.terminate(); await writer.completion; }
    store.executionUpdate(execution.id, { state: 'completed', stopConfirmed: true, usageStatus: 'reported', usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } }, 'mechanism-complete', {}, [{ type: 'finishAttempt', attemptId: execution.id, outcome: 'succeeded' }, { type: 'settleAttempt', attemptId: execution.id, actual: 0 }, { type: 'releaseLease', attemptId: execution.id, resource: 'workspace:' + workspace }, { type: 'setOperation', operationId: execution.id, attemptId: execution.id, status: 'confirmed' }]);
    store.runtime.report(operation.id, 'owner', { messageId: randomUUID(), outcome: 'confirmed', result: 'Actual writer fixture accounted' });
  }
  async function verification(consumedAt: string) {
    const run = store.runtime.inspect(runtime.id).run, digest = sha(verificationCanonical(run.contract)), now = new Date(Math.max(Date.now(), Date.parse(consumedAt))).toISOString();
    const spec: VerificationSpec = { schemaVersion: 1, contractVersion: run.contract.version, standardsVersion: 'original-fixture', obligations: [{ id: 'o', criterionId: run.contract.criteria[0]!.id, expectation: run.contract.criteria[0]!.description, required: true, applicable: true }], cases: [{ id: 'case', revision: 1, obligationIds: ['o'], parameters: [{}], modules: ['module'], replaces: [], defectRefs: [], verifier: { kind: 'command', version: '1', entry: 'check.mjs', files: ['check.mjs'], timeoutMs: 1000 } }], controls: [{ id: 'positive', workspace: join(root, 'positive'), expect: 'passed', mustFail: [] }, { id: 'negative', workspace: join(root, 'negative'), expect: 'failed', mustFail: ['o'] }], moduleDependencies: {} };
    await writeFile(join(workspace, 'artifact.mjs'), 'export const fixture = true;\n');
    const candidate = await captureCandidate(workspace, join(root, 'frozen-candidate'));
    const proposal: Proposal = { id: 'p4-proposal-fixture', runtimeId: runtime.id, projectId: run.projectId, runId: run.id, baseVersion: 0, version: 1, spec, bundle: { root: workspace, directory: workspace, specPath: join(workspace, 'spec.json'), specDigest: sha('spec'), files: {}, digest: sha('definition'), controls: [] }, candidate, contractDigest: digest, status: 'published', createdAt: now };
    const plan: FrozenPlan = { id: 'p4-plan-fixture', runtimeId: runtime.id, projectId: run.projectId, runId: run.id, proposalId: proposal.id, catalogVersion: 1, candidate, contractDigest: digest, definitionDigest: proposal.bundle.digest, environmentDigest: sha('environment'), selection: selectInstances(spec, { mode: 'final' }), createdAt: now };
    const request = { type: 'run', commandId: 'verify-command', planId: plan.id, ...config };
    const verification: VerificationJob = { id: 'verify-fixture', runtimeId: runtime.id, projectId: run.projectId, runId: run.id, workspace, kind: 'verification', proposalId: proposal.id, planId: plan.id, request, status: 'running', attemptId: 'verify-fixture', environmentDigest: plan.environmentDigest, config, startedAt: now, finishedAt: null, intents: [], identities: [], usage: 0, usageUnknown: false, modelStarted: false, results: [], controls: [], evaluation: null, approved: false, stopConfirmed: false, error: null, proofs: {}, sources: [] };
    store.verification.transaction(() => { store.verification.insert('proposal', proposal); store.verification.insert('plan', plan); store.verification.artifact(run.projectId, run.id, { id: plan.id, ...store.managedSnapshot(verificationCanonical(candidate)), contractVersion: run.contract.version }); store.verification.act(run.projectId, run.id, { type: 'startAttempt', attemptId: verification.id, nodeId: 'work', purpose: 'verification', contractVersion: run.contract.version, reservation: config.reservation, resources: ['verification:' + workspace] }); store.verification.insert('job', verification); store.verification.remember(request.commandId, request, verification); });
    return { proposal, plan, verification };
  }
  return { root, data, workspace, store, runtime, loop, job, writer, processPath, proofText, event, execution, finishInspection, finishWriter, verification, get db() { return db; }, get repository() { return repository; }, get adapter() { return adapter; }, reopen() { db.close(); db = new DatabaseSync(join(data, 'supervisor.sqlite')); db.exec('PRAGMA foreign_keys=ON'); repository = new SupervisionConcernRepository(db, data); adapter = new SupervisionConcernAdapter(repository); } };
}

test('P6-CONC-I01 consumes one applied concern only after actual writer stop and resumes the same durable requirement without a model', async t => {
  const f = await fixture(t); f.finishInspection(); assert.equal((await f.adapter.prepare(f.loop.id)).action, 'wait'); assert.equal(f.repository.list(f.loop.id).length, 0);
  await f.finishWriter(); const ledger = f.store.runtime.inspect(f.runtime.id), jobs = f.store.supervision.jobs(f.loop.id), first = await f.adapter.prepare(f.loop.id);
  assert.equal(first.action, 'require-full-acceptance'); assert.equal(first.records.length, 1); assert.deepEqual(f.store.runtime.inspect(f.runtime.id), ledger); assert.deepEqual(f.store.supervision.jobs(f.loop.id), jobs);
  f.store.executionUpdate(f.execution.id, {}, 'codex-event', { kind: 'token-usage', totalTokens: 100 });
  f.store.executionUpdate(f.execution.id, {}, 'codex-event', { kind: 'diff', diff: 'Fixture change with a review concern' });
  f.reopen(); assert.deepEqual(await f.adapter.prepare(f.loop.id), first); assert.deepEqual(f.repository.candidates(f.loop.id), []); assert.equal(f.store.supervision.get(f.loop.id).reasoningCount, 1);
  const record = first.records[0]!.consumption; await assert.rejects(f.repository.consume({ commandId: record.commandId, jobId: 'different' }), /Conflicting/); await assert.rejects(f.repository.consume({ commandId: 'second', jobId: f.job.id }), /already consumed/);
  assert.throws(() => f.db.prepare('DELETE FROM supervision_concerns').run(), /Immutable/);
});

test('P6-CONC-I02 unknown inspection accounting retains its reservation and never becomes a consumable request', async t => {
  const f = await fixture(t); assert.equal(f.finishInspection(true).disposition, 'unknown'); await f.finishWriter();
  const before = f.store.runtime.inspect(f.runtime.id); await assert.rejects(f.repository.consume({ commandId: 'consume', jobId: f.job.id }), /accounting/); assert.equal((await f.adapter.prepare(f.loop.id)).action, 'wait');
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id), before); assert.equal(before.run.attempts.find(a => a.id === f.job.id)!.settled, false); assert.equal(f.repository.list(f.loop.id).length, 0);
});

test('P6-CONC-I03 original proof bytes and actual event binding are required after disposition was applied', async t => {
  const f = await fixture(t); f.finishInspection(); await f.finishWriter();
  await writeFile(f.processPath, f.proofText + ' '); await assert.rejects(f.adapter.prepare(f.loop.id), /proof digest/); await writeFile(f.processPath, f.proofText);
  f.db.prepare('UPDATE execution_events SET payload=? WHERE execution_id=? AND seq=?').run(JSON.stringify({ kind: 'diff', diff: 'tampered' }), f.execution.id, f.event.seq);
  await assert.rejects(f.adapter.prepare(f.loop.id), /original durable event/); assert.equal(f.repository.list(f.loop.id).length, 0);
});

test('P6-CONC-I04 a forged stopped ledger cannot consume while the original owned Node writer is alive', async t => {
  const f = await fixture(t); f.finishInspection(); await f.finishWriter(false);
  const result = await f.adapter.prepare(f.loop.id); assert.equal(result.action, 'wait'); if (result.action === 'wait') assert.match(result.reason, /actual stopped/);
  assert.equal(f.repository.list(f.loop.id).length, 0); await f.writer.terminate(); await f.writer.completion; assert.equal((await f.adapter.prepare(f.loop.id)).action, 'require-full-acceptance');
});

test('P6-CONC-I05 pause cancellation contract replacement and clock rollback never dispatch a new concern effect', async t => {
  const f = await fixture(t); f.finishInspection(); await f.finishWriter(); let loop = f.store.supervision.get(f.loop.id); f.store.supervision.update(loop.id, loop.revision, { paused: true });
  assert.equal((await f.adapter.prepare(loop.id)).action, 'wait'); loop = f.store.supervision.get(loop.id); f.store.supervision.update(loop.id, loop.revision, { paused: false });
  const first = await f.adapter.prepare(loop.id), id = first.records[0]!.consumption.id;
  loop = f.store.supervision.get(loop.id); f.store.supervision.update(loop.id, loop.revision, { stopped: true }); assert.equal(f.repository.reconcile(id).invalidation!.reason, 'cancelled');
  assert.equal((await f.adapter.prepare(loop.id)).action, 'none'); assert.deepEqual(f.adapter.bindVerification(loop.id, 'cancelled-effect-ack-not-a-new-dispatch'), []); assert.equal(f.store.supervision.jobs(loop.id).length, 1);
  const facts = f.repository.facts(loop.id, loop.contractDigest, true); assert.deepEqual(decideConcernBoundary({ ...facts, sameContract: false }), { action: 'invalidate', reason: 'contract-changed' });
  assert.deepEqual(decideConcernBoundary({ ...facts, cancelled: false, clockBehind: true }), { action: 'wait', reason: 'Concern clock moved backwards' });
  assert.deepEqual(decideConcernBoundary({ ...facts, cancelled: false, pendingFollowup: true }), { action: 'wait', reason: 'Pending user follow-up' });
});

test('P6-CONC-I06 exact full-scope P4 request receipt is bound atomically without claiming verification success', async t => {
  const f = await fixture(t); f.finishInspection(); await f.finishWriter(); const first = await f.adapter.prepare(f.loop.id), record = first.records[0]!.consumption;
  const { plan, verification } = await f.verification(record.preparedAt);
  assert.throws(() => f.repository.transaction(() => { f.repository.bindVerification(record.id, verification.id); throw new Error('parent rollback'); }), /parent rollback/); assert.equal(f.repository.get(record.id).binding, null);
  f.db.prepare('UPDATE verification_records SET record=? WHERE kind=? AND id=?').run(runtimeCanonical({ ...plan, selection: { ...plan.selection, mode: 'impact' } }), 'plan', plan.id);
  assert.throws(() => f.repository.bindVerification(record.id, verification.id), /full verification scope/); f.db.prepare('UPDATE verification_records SET record=? WHERE kind=? AND id=?').run(runtimeCanonical(plan), 'plan', plan.id);
  f.db.prepare('DELETE FROM verification_product_receipts WHERE command_id=?').run('verify-command'); assert.throws(() => f.repository.bindVerification(record.id, verification.id), /dispatch receipt/);
  f.store.verification.remember('verify-command', verification.request, verification); const bound = f.repository.bindVerification(record.id, verification.id); assert.equal(bound.binding!.verificationJobId, verification.id);
  f.reopen(); assert.deepEqual(f.repository.bindVerification(record.id, verification.id), bound); assert.equal((await f.adapter.prepare(f.loop.id)).action, 'none'); assert.equal(f.store.verification.get('job', verification.id).approved, false); assert.notEqual(f.store.runtime.inspect(f.runtime.id).run.status, 'succeeded');
});


test('P6-CONC-I07 real conversation fence and persisted clock rollback block consumption without reserving new budget', async t => {
  const f = await fixture(t, true); f.finishInspection(); await f.finishWriter();
  const conversation = f.store.conversations.forRun(f.runtime.projectId, f.runtime.runId)!;
  const message = f.store.conversations.receive({ commandId: 'change', conversationId: conversation.id, source: 'user', kind: 'change', text: 'Preserve this queued requirement before any further acceptance' });
  const before = f.store.runtime.inspect(f.runtime.id); const fenced = await f.adapter.prepare(f.loop.id); assert.equal(fenced.action, 'wait'); if (fenced.action === 'wait') assert.match(fenced.reason, /follow-up/);
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id), before); assert.equal(f.repository.list(f.loop.id).length, 0); assert.equal(f.store.conversations.message(message.id).state, 'received');
  const loop = f.store.supervision.get(f.loop.id), monitor = f.store.supervisionMonitor.envelope(loop.id)!; monitor.state.lastObservedAtMs = Date.now() + 100000; f.store.supervision.update(loop.id, loop.revision, { monitor });
  const clock = await f.adapter.prepare(loop.id); assert.equal(clock.action, 'wait'); if (clock.action === 'wait') assert.match(clock.reason, /clock moved backwards/);
});

test('P6-CONC-I08 an applied old-contract concern is durably invalidated without consuming or altering the original inspection', async t => {
  const f = await fixture(t); f.finishInspection(); await f.finishWriter(); const original = f.store.supervision.job(f.job.id), run = f.store.runtime.inspect(f.runtime.id).run;
  // Actual domain contract replacement, not a caller supplied stale boolean.
  f.store.verification.act(run.projectId, run.id, { type: 'replaceContract', contract: { ...run.contract, version: run.contract.version + 1 } });
  const first = await f.adapter.prepare(f.loop.id); assert.equal(first.action, 'none'); assert.equal(f.repository.list(f.loop.id).length, 0);
  const discard = f.repository.discards(f.loop.id); assert.equal(discard.length, 1); assert.equal(discard[0]!.reason, 'contract-changed');
  f.reopen(); assert.equal((await f.adapter.prepare(f.loop.id)).action, 'none'); assert.deepEqual(f.repository.discards(f.loop.id), discard); assert.deepEqual(f.store.supervision.job(f.job.id), original);
});
