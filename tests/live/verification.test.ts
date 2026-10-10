import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { LocalRuntimeAdapter } from '../../packages/runtime/index.js';
import { readOwnership } from '../../packages/runtime/worker-ownership.js';
import { VerificationController } from '../../packages/verification/controller.js';
import { digest } from '../../packages/verification/candidate.js';
import type { Delivery, FrozenPlan, Proposal, VerificationAction, VerificationJob } from '../../packages/verification/records.js';
import type { VerificationSpec } from '../../packages/contracts/p4.js';
import { inspectProcess, terminateProcess } from '../../packages/process-control/index.js';
import { p4CorrectSource, p4SourceExcerpt, p4SourceUrl, writeP4Project } from '../fixtures/p4-project.js';

type Status = { proposals: Proposal[]; plans: FrozenPlan[]; jobs: VerificationJob[]; deliveries: Delivery[]; currentDelivery: { current: boolean; reason: string } };
const goal = 'Discount calculator and source note: discountedPrice(amount, percent) returns amount*(1-percent/100); finite nonnegative amounts and finite percentages in [0,100] are required, otherwise RangeError. A readable labeled page has a Calculate price button, shows correct results and a clear invalid-input message after actual typing/clicking. The source note accurately explains RFC 9110 safe HTTP methods from the actual official source, including that safe request semantics do not prohibit incidental logging. All four obligations are necessary; independent verification is required.';

function definition(good: string, bad: string): VerificationSpec {
  return { schemaVersion: 1, contractVersion: 1, standardsVersion: 'discount-page-rfc-v1', obligations: [
    { id: 'normal', criterionId: 'independent-acceptance', required: true, applicable: true, expectation: 'discountedPrice returns amount*(1-percent/100): 200/25=>150, 80/0=>80, 30/100=>0.' },
    { id: 'invalid', criterionId: 'independent-acceptance', required: true, applicable: true, expectation: 'Negative amount, percentages below zero or over 100, Infinity or NaN in either argument raise RangeError.' },
    { id: 'ui-price', criterionId: 'independent-acceptance', required: true, applicable: true, expectation: 'Actual fill and click produce 150.00 and 80.00, invalid negative input shows Invalid discount input. Labels, button and resulting feedback are visible and readable.' },
    { id: 'source-safe', criterionId: 'independent-acceptance', required: true, applicable: true, expectation: 'The claim identifies GET, HEAD, OPTIONS and TRACE as safe and does not misrepresent DELETE or incidental logging, supported by the actually acquired RFC 9110 source.' },
  ], cases: [
    { id: 'price', revision: 1, obligationIds: ['normal', 'invalid'], parameters: [{ amount: '200', percent: '25', expected: '150' }, { amount: '80', percent: '0', expected: '80' }, { amount: '30', percent: '100', expected: '0' }], modules: ['price'], replaces: [], defectRefs: ['WRONG-DISCOUNT-FORMULA', 'ILLEGAL-INPUT-NOT-REJECTED'], verifier: { kind: 'command', version: 'price-assertions-v1', entry: 'price.mjs', files: ['price.mjs'], timeoutMs: 5000, build: {kind:'typescript',sources:['src/price.ts'],rootDir:'src',outputDir:'build',timeoutMs:15000} } },
    { id: 'ui', revision: 1, obligationIds: ['ui-price'], parameters: [{}], modules: ['ui'], replaces: [], defectRefs: ['WRONG-INTERACTIVE-RESULT', 'MISSING-ERROR-FEEDBACK'], verifier: { kind: 'ui', version: 'interactive-price-v1', entry: 'index.html', timeoutMs: 25_000, expectations: ['Amount and discount inputs have clear visible labels.', 'Calculate price is a visible enabled button and feedback is readable.', 'Actual normal and invalid interactions change the visible result as required; no exact pixel match is required.'], steps: [
      { kind: 'assertText', selector: 'h1', text: 'Discount calculator' }, { kind: 'assertVisible', selector: '#calculate' },
      { kind: 'fill', selector: '#amount', value: '200' }, { kind: 'fill', selector: '#percent', value: '25' }, { kind: 'click', selector: '#calculate' }, { kind: 'assertText', selector: '#result', text: '150.00' },
      { kind: 'fill', selector: '#amount', value: '-1' }, { kind: 'click', selector: '#calculate' }, { kind: 'assertText', selector: '#result', text: 'Invalid discount input' },
      { kind: 'fill', selector: '#amount', value: '80' }, { kind: 'fill', selector: '#percent', value: '0' }, { kind: 'click', selector: '#calculate' }, { kind: 'assertText', selector: '#result', text: '80.00' },
    ] } },
    { id: 'source', revision: 1, obligationIds: ['source-safe'], parameters: [{}], modules: ['source-note'], replaces: [], defectRefs: ['UNSUPPORTED-SAFE-METHOD-CLAIM'], verifier: { kind: 'source', version: 'rfc-primary-v1', claimFile: 'claim.txt', sources: [{ id: 'rfc9110', url: p4SourceUrl, excerpt: p4SourceExcerpt, maxAgeMs: 86_400_000 }], timeoutMs: 20_000 } },
  ], controls: [{ id: 'correct-program-page-claim', workspace: good, expect: 'passed', mustFail: [] }, { id: 'known-formula-ui-source-defects', workspace: bad, expect: 'failed', mustFail: ['normal', 'invalid', 'ui-price', 'source-safe'] }], moduleDependencies: {} };
}

test('live verification reviews real positive and negative engineering UI and primary-source controls before delivery and invalidates changed evidence', { timeout: 900_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sv-p4-live-'))), data = join(directory, 'data'), workspace = join(directory, 'project'), good = join(directory, 'good'), bad = join(directory, 'bad'), bundle = join(directory, 'definition');
  for (const path of [workspace, good, bad, bundle]) await mkdir(path);
  await writeP4Project(workspace, true); await writeP4Project(good); await writeP4Project(bad, true);
  await copyFile(fileURLToPath(new URL('../fixtures/p4-price-verifier.js', import.meta.url)), join(bundle, 'price.mjs'));
  const spec = definition(good, bad), specPath = join(bundle, 'spec.json'); await writeFile(specPath, JSON.stringify(spec, null, 2));
  const evidence = join(process.env.SUPERVISOR_EVIDENCE_DIR ?? resolve('.supervisor-dev/live'), 'artifacts', 'p4-lifecycle-' + randomUUID()); await mkdir(evidence, { recursive: true });
  let store = new SupervisorStore(data), controller = new VerificationController(store, data); const adapter = new LocalRuntimeAdapter(store, data); await controller.initialize();
  t.after(async () => {
    await controller.close(); await adapter.close(); const ownership = await readOwnership(data);
    if (ownership?.identity) assert.equal((await terminateProcess(ownership.identity)).stopped, true, 'Stop only this fixture runtime worker scope');
    store.close(); await cp(directory, join(evidence, 'runtime'), { recursive: true }); t.diagnostic(JSON.stringify({ evidence, directory }));
  });
  const runtime = await adapter.submit({ type: 'submit', commandId: randomUUID(), workspace, goal, tokenLimit: 1_000_000, verificationReserve: 800_000, steps: [{ id: 'ready', kind: 'input', prompt: 'Start actual independent verification of the prepared isolated candidate' }] });
  await adapter.sendInput({ type: 'input', commandId: randomUUID(), runtimeId: runtime.id, stepId: 'ready', text: 'Candidate files have been prepared; verify them without changing acceptance.' });
  const deadline = Date.now() + 20_000; while (store.runtime.get(runtime.id).phase !== 'awaiting-verification' && Date.now() < deadline) await delay(100);
  assert.equal(store.runtime.get(runtime.id).phase, 'awaiting-verification'); assert.equal(store.runtime.operations(runtime.id)[0]?.state, 'confirmed'); assert.notEqual(store.runtime.inspect(runtime.id).run.status, 'succeeded');
  const config = { model: process.env.SUPERVISOR_LIVE_MODEL ?? 'gpt-5.6-sol', effort: 'low', reservation: 180_000, timeoutMs: 240_000 };
  async function action<T>(value: VerificationAction): Promise<T> { return await controller.dispatch(value) as T; }
  async function finished(job: VerificationJob, timeout = 600_000): Promise<VerificationJob> {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const next = await action<VerificationJob>({ type: 'job', jobId: job.id }); if (next.status === 'finished') { await writeFile(join(evidence, next.id + '.json'), JSON.stringify(next, null, 2)); return next; } await delay(200); }
    await action({ type: 'cancel', jobId: job.id }); throw new Error('Actual verification job did not finish within live observation bound');
  }
  async function stopped(job: VerificationJob): Promise<void> {
    assert.equal(job.stopConfirmed, true, job.error ?? 'Missing actual stop receipt'); assert.equal(job.usageUnknown, false); assert.equal(job.intents.length, job.identities.length); assert.ok(job.identities.length);
    for (const identity of job.identities) assert.equal((await inspectProcess(identity)).status, 'stopped');
    const attempt = store.runtime.inspect(runtime.id).run.attempts.find(a => a.id === job.attemptId)!; assert.equal(attempt.settled, true); assert.equal(attempt.actual, job.usage);
  }
  const proposal = await action<Proposal>({ type: 'propose', commandId: randomUUID(), runtimeId: runtime.id, specPath });
  await assert.rejects(action({ type: 'publish', commandId: randomUUID(), proposalId: proposal.id, reviewId: 'absent-review' }), /Unknown verification job/);
  const review = await finished(await action<VerificationJob>({ type: 'review', commandId: randomUUID(), proposalId: proposal.id, ...config }));
  await stopped(review); assert.equal(review.approved, true, JSON.stringify({ error: review.error, controls: review.controls })); assert.ok(review.modelStarted && review.usage > 0); assert.equal(review.controls.length, 2); assert.ok(review.controls.every(c => c.passed));
  const negative = review.controls.find(c => c.id === 'known-formula-ui-source-defects')!; for (const id of spec.controls[1]!.mustFail) assert.ok(negative.results.some(r => r.executionStatus === 'executed' && r.checks.some(c => c.obligationId === id && c.verdict === 'failed')), id);
  assert.ok(negative.results.find(r => r.checks.some(c => c.obligationId === 'ui-price'))!.proofFiles!.some(p => p.endsWith('trace.json')), 'Negative control uses actual UI steps');
  const positiveUi = review.controls.find(c => c.id === 'correct-program-page-claim')!.results.find(r => r.checks.some(c => c.obligationId === 'ui-price'))!;
  const uiTrace = JSON.parse(await readFile(positiveUi.proofFiles!.find(path => path.endsWith('trace.json'))!, 'utf8')) as { steps: { step: { kind: string; value?: string }; verdict: string; observed?: { before?: { value: string }; selected?: { selectionStart: number; selectionEnd: number }; after?: { value: string } } }[] };
  assert.ok(uiTrace.steps.every(step => step.verdict === 'passed')); const fills = uiTrace.steps.filter(step => step.step.kind === 'fill'); assert.ok(fills.length);
  for (const step of fills) { assert.equal(step.observed?.selected?.selectionStart, 0); assert.equal(step.observed?.selected?.selectionEnd, step.observed?.before?.value.length); assert.equal(step.observed?.after?.value, step.step.value, 'Actual filled value replaces the complete original text'); }
  assert.ok(review.sources.length >= 2, 'Both correct and erroneous claims use actual downloaded RFC bytes');
  const published = await action<Proposal>({ type: 'publish', commandId: randomUUID(), proposalId: proposal.id, reviewId: review.id }); assert.equal(published.version, 1);
  const badPlan = await action<FrozenPlan>({ type: 'freeze', commandId: randomUUID(), runtimeId: runtime.id, mode: 'final' });
  const rejected = await finished(await action<VerificationJob>({ type: 'run', commandId: randomUUID(), planId: badPlan.id, ...config })); await stopped(rejected); assert.equal(rejected.approved, false); assert.equal(rejected.evaluation?.complete, false);
  for (const id of spec.controls[1]!.mustFail) assert.ok(rejected.results.some(r => r.executionStatus === 'executed' && r.checks.some(c => c.obligationId === id && c.verdict === 'failed')), id);
  await assert.rejects(action({ type: 'deliver', commandId: randomUUID(), jobId: rejected.id }), /complete actual verification/); assert.notEqual(store.runtime.inspect(runtime.id).run.status, 'succeeded');
  await writeP4Project(workspace);
  const impact = await action<FrozenPlan>({ type: 'freeze', commandId: randomUUID(), runtimeId: runtime.id, mode: 'impact', changedModules: ['price'] }); assert.ok(impact.selection.instances.every(i => i.caseId === 'price')); assert.equal(impact.selection.completeScope, false);
  const partial = await finished(await action<VerificationJob>({ type: 'run', commandId: randomUUID(), planId: impact.id, ...config })); await stopped(partial); assert.equal(partial.evaluation?.passed, true); assert.equal(partial.evaluation?.complete, false); assert.equal(partial.modelStarted, false);
  await assert.rejects(action({ type: 'deliver', commandId: randomUUID(), jobId: partial.id }), /complete actual verification/);
  const final = await action<FrozenPlan>({ type: 'freeze', commandId: randomUUID(), runtimeId: runtime.id, mode: 'final' }); assert.notEqual(final.candidate.digest, badPlan.candidate.digest);
  const accepted = await finished(await action<VerificationJob>({ type: 'run', commandId: randomUUID(), planId: final.id, ...config })); await stopped(accepted); assert.equal(accepted.approved, true, accepted.error ?? JSON.stringify(accepted.results)); assert.equal(accepted.evaluation?.complete, true); assert.equal(accepted.results.length, final.selection.instances.length); assert.ok(accepted.modelStarted && accepted.usage > 0);
  const storedSource = accepted.sources[0]!; assert.ok(storedSource && storedSource.url === p4SourceUrl); const sourceBytes = await readFile(storedSource.path); assert.equal(digest(sourceBytes), storedSource.digest); assert.ok(sourceBytes.toString().includes(p4SourceExcerpt));
  await writeFile(storedSource.path, 'altered primary source evidence\n'); await assert.rejects(action({ type: 'deliver', commandId: randomUUID(), jobId: accepted.id }), /evidence changed/); await writeFile(storedSource.path, sourceBytes);
  const commandId = randomUUID(), delivery = await action<Delivery>({ type: 'deliver', commandId, jobId: accepted.id }); assert.equal(store.runtime.inspect(runtime.id).run.status, 'succeeded'); assert.deepEqual(await action({ type: 'deliver', commandId, jobId: accepted.id }), delivery);
  async function status(): Promise<Status> { return await controller.status(runtime.id) as Status; }
  assert.equal((await status()).currentDelivery.current, true);
  await writeFile(join(workspace, 'src/price.ts'), p4CorrectSource + '// changed after acceptance\n'); let current = await status(); assert.equal(current.currentDelivery.current, false); assert.match(current.currentDelivery.reason, /workspace differs/); await writeFile(join(workspace, 'src/price.ts'), p4CorrectSource);
  const checkerPath = join(bundle, 'price.mjs'), checker = await readFile(checkerPath); await writeFile(checkerPath, Buffer.concat([checker, Buffer.from('\n// verifier implementation changed\n')])); current = await status(); assert.equal(current.currentDelivery.current, false); assert.match(current.currentDelivery.reason, /Verifier implementation changed/); await writeFile(checkerPath, checker);
  await writeFile(storedSource.path, 'changed source proof\n'); current = await status(); assert.equal(current.currentDelivery.current, false); assert.match(current.currentDelivery.reason, /evidence changed/); await writeFile(storedSource.path, sourceBytes); assert.equal((await status()).currentDelivery.current, true);
  await controller.close(); store.close(); store = new SupervisorStore(data); controller = new VerificationController(store, data); await controller.initialize(); current = await status(); assert.equal(current.currentDelivery.current, true); assert.equal(current.jobs.find(j => j.id === rejected.id)?.approved, false); assert.equal(current.jobs.find(j => j.id === partial.id)?.evaluation?.complete, false); assert.deepEqual(current.plans.find(p => p.id === badPlan.id), JSON.parse(JSON.stringify(badPlan)), 'All frozen JSON fields survive restart; in-memory null-prototype dictionaries serialize as JSON objects'); assert.equal(current.deliveries.length, 1);
  const run = store.runtime.inspect(runtime.id).run; assert.equal(run.budget.spent, current.jobs.reduce((sum, job) => sum + job.usage, 0)); assert.ok(run.attempts.every(a => a.settled)); assert.ok(run.leases.every(l => l.released));
  await writeFile(join(evidence, 'lifecycle.json'), JSON.stringify({ runtime: store.runtime.inspect(runtime.id), status: current, spec, source: { url: p4SourceUrl, excerpt: p4SourceExcerpt }, hostScope: 'Actual Electron interaction and process stop; no claim of macOS host sleep/wake' }, null, 2));
});
