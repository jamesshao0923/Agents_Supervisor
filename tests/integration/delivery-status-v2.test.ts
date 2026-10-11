import { assessDeliveryEvidence } from '../../packages/verification/delivery-status.js';
import type { DeliveryEvidenceSnapshot, DeliveryAssessmentOptions } from '../../packages/verification/delivery-status.js';
import { evaluateVerification } from '../../packages/verification/rules.js';
import test from 'node:test';
import { spawnManagedProcess } from '../../packages/process-control/index.js';
import type { ProcessIdentity, ProcessIntent } from '../../packages/process-control/index.js';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapFixture } from '../helpers/control-bootstrap-fixture.js';
import { migrate } from '../../packages/persistence/migrations.js';
import { VerificationLineageRepository } from '../../packages/persistence/verification-lineage.js';
import { ControlQualificationRepository, controlQualificationDigest } from '../../packages/persistence/control-qualification.js';
import { runtimeCanonical } from '../../packages/persistence/runtime.js';
import { prepareControlDraft, executeControlBootstrap, assembleQualification } from '../../packages/verification/control-bootstrap.js';
import { executeQualification } from '../../packages/verification/control-engine.js';
import { controlQualificationReviewPrompt } from '../../packages/verification/control-review.js';
import { captureCandidate, canonical, digest } from '../../packages/verification/candidate.js';
import { controlDigest } from '../../packages/verification/control-rules.js';
import { executeInstances } from '../../packages/verification/engine.js';
import { selectInstances } from '../../packages/verification/rules.js';
import type { Run } from '../../packages/contracts/p1.js';
import type { Proposal, VerificationJob, FrozenPlan, Delivery } from '../../packages/verification/records.js';
import type { SupervisionJob } from '../../packages/contracts/p6-supervision.js';
import type { ControlQualificationEvidence } from '../../packages/contracts/p4-qualification.js';
import type { ModelReviewResult } from '../../packages/verification/model.js';

// Repository fixtures: real SQLite, complete frozen FS and actual managed Node
// detector execution. Author/model-review metadata is explicitly seeded; no
// Codex request, independent model approval or live product delivery is claimed.
async function fixture(t: TestContext) {
  const f = await bootstrapFixture(t), dbPath = join(f.root, 'ledger.sqlite'); let db = new DatabaseSync(dbPath); migrate(db);
  let repo = new ControlQualificationRepository(db, f.root), lineage = new VerificationLineageRepository(db);
  db.prepare('INSERT INTO projects VALUES (?,?)').run('project', 'Explicit repository fixture');
  const run: Run = { admission: 'admitted', id: 'run', projectId: 'project', revision: 0, contract: f.input.target.definition.contract, status: 'running', nodes: [{ id: 'implement', required: true, dependencies: [], status: 'succeeded' }], attempts: [], operations: [], leases: [], budget: { unit: 'token', limit: 1000, spent: 2, verificationReserve: 100 }, evidence: [], artifact: null };
  const saveRun = () => db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(canonical(run), run.revision, 'project', 'run');
  db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('project', 'run', 0, canonical(run));
  db.prepare('INSERT INTO runtime_runs VALUES (?,?,?,?)').run('runtime', 'project', 'run', '{}');
  db.prepare('INSERT INTO supervision_loops VALUES (?,?,?)').run('loop', 'runtime', '{}');
  lineage.bindRoot({ commandId: 'root', projectId: 'project', runId: 'run' }); f.input.base = lineage.captureBase('project', 'run');
  const symbolic = structuredClone(f.input.target.definition.spec); for (const control of symbolic.controls) control.workspace = control.id;
  const assets = { contextDigest: digest('fixture'), spec: symbolic, verifierFiles: [{ path: 'check.mjs', content: await readFile(join(f.root, 'defs', 'check.mjs'), 'utf8') }], controls: await Promise.all(['good', 'bad'].map(async id => ({ id, files: [{ path: 'data.json', content: await readFile(join(f.root, id, 'data.json'), 'utf8') }] }))), coverageExplanation: [] };
  async function processProof(path: string) { let intent!: ProcessIntent, identity!: ProcessIdentity; const child = await spawnManagedProcess({ operationId: 'fixture-' + path, command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: f.root, timeoutMs: 5000, onBeforeSpawn(i) { intent = i; }, onIdentity(i) { identity = i; } }); const result = await child.completion; assert.equal(result.stopped, true); await writeFile(path, JSON.stringify({ intent, identity, result })); return { intent, identity }; }
  const authorInput = { prompt: 'Explicit stored author fixture', outputSchema: {}, context: { acceptance: { previousSpec: null }, evolution: { current: { previousSpec: null }, base: f.input.base, history: f.input.history, transitions: [] } } }, authorResult = { contextDigest: digest('fixture'), assets, plan: f.input.authoredPlan };
  const proof = join(f.root, 'author.process.json'), authorProcess = await processProof(proof);
  const author: SupervisionJob = { id: 'author', loopId: 'loop', runtimeId: 'runtime', projectId: 'project', runId: 'run', contractVersion: 1, contractDigest: f.input.base.target.contractDigest, purpose: 'acceptance-authoring', status: 'finished', attemptId: 'author', config: { model: 'non-live-fixture', effort: 'low', reservation: 10, timeoutMs: 1000 }, input: authorInput, inputDigest: digest(runtimeCanonical(authorInput)), startedAt: 'fixture', finishedAt: 'fixture', intents: [authorProcess.intent], identities: [authorProcess.identity], modelStarted: true, observedUsage: 2, usage: 2, stopConfirmed: true, error: null, proofs: { [proof]: digest(await readFile(proof)) }, threadId: 'author-thread', result: authorResult };
  author.completionDigest = digest(runtimeCanonical({ usage: author.usage, stopConfirmed: author.stopConfirmed, error: author.error, proofs: author.proofs, threadId: author.threadId, result: author.result }));
  db.prepare('INSERT INTO supervision_jobs VALUES (?,?,?)').run(author.id, 'loop', canonical(author));
  run.attempts.push({ id: 'author', nodeId: 'implement', contractVersion: 1, status: 'succeeded', purpose: 'reasoning', reservation: 10, actual: 2, settled: true }); saveRun();
  f.input.authorBinding = { jobId: author.id, inputDigest: author.inputDigest, resultDigest: controlDigest(author.result) };
  const draft = await prepareControlDraft(f.input), candidate = await captureCandidate(join(f.root, 'good'), join(f.root, 'proposal-candidate'));
  const proposal: Proposal = { id: 'proposal', runtimeId: 'runtime', projectId: 'project', runId: 'run', baseVersion: 0, version: null, spec: f.input.target.definition.spec, bundle: f.input.target.bundle, candidate, contractDigest: f.input.base.target.contractDigest, status: 'proposed', createdAt: 'fixture', controlDraftDigest: draft.digest };
  function record(kind: string, value: { id: string }) { db.prepare('INSERT INTO verification_records(kind,id,project_id,run_id,record) VALUES (?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET record=excluded.record').run(kind, value.id, 'project', 'run', canonical(value)); }
  record('proposal', proposal); lineage.bindProposal({ commandId: 'binding', proposalId: proposal.id, base: f.input.base, definitionFormat: 'qualified-v2' });
  const ctx = f.context('fixture'); ctx.job.id = 'review'; ctx.job.attemptId = 'review'; ctx.output = join(f.root, 'verification', 'review'); await mkdir(ctx.output, { recursive: true }); ctx.save = () => record('job', ctx.job); ctx.save();
  run.attempts.push({ id: 'review', nodeId: 'implement', contractVersion: 1, status: 'running', purpose: 'verification', reservation: ctx.job.config.reservation, settled: false, actual: null }); saveRun();
  t.after(() => db.close());
  function finish() { ctx.job.status = 'finished'; ctx.job.approved = true; ctx.job.stopConfirmed = true; ctx.job.finishedAt = new Date().toISOString(); ctx.save(); const attempt = run.attempts.at(-1)!; attempt.status = 'succeeded'; attempt.actual = ctx.job.usage; attempt.settled = true; run.budget.spent = 2 + ctx.job.usage; saveRun(); }
  async function proofs() { const result: Record<string, string> = {}; async function walk(path: string) { for (const item of await readdir(path, { withFileTypes: true })) { const file = join(path, item.name); if (item.isDirectory()) await walk(file); else result[file] = digest(await readFile(file)); } } await walk(ctx.output); return result; }
  async function model(prompt: string, directory = 'qualification-review'): Promise<ModelReviewResult> {
    const root = join(ctx.output, directory); await mkdir(root); const resultPath = join(root, 'result.json'), output = join(root, 'output.txt'), events = join(root, 'events.jsonl');
    const processPath = join(root, 'app-server.process.json'), managed = await processProof(processPath); ctx.job.intents.push(managed.intent); ctx.job.identities.push(managed.identity);
    const result: ModelReviewResult = { verdict: 'passed', reason: 'Explicit persisted review metadata fixture; no model called', observations: [], usage: 3, threadId: 'independent-thread', turnId: 'turn', proofFiles: [resultPath, output, events, processPath], stopConfirmed: true, modelStarted: true };
    await writeFile(output, JSON.stringify({ verdict: result.verdict, reason: result.reason, observations: result.observations }));
    await writeFile(events, [ { kind: 'review-input', value: { prompt } }, { kind: 'codex-event', value: { method: 'turn/completed', threadId: result.threadId, turnId: result.turnId, raw: { method: 'turn/completed', params: { threadId: result.threadId, turn: { id: result.turnId, status: 'completed' } } } } } ].map(x => JSON.stringify(x)).join('\n') + '\n');
    await writeFile(resultPath, JSON.stringify(result)); ctx.job.modelStarted = true; ctx.job.usage = 3; return result;
  }
  async function complete(presentation?:'compact-v2') {
    repo.insertDraft({ commandId: 'draft', proposalId: proposal.id, draft }); repo.appendReviewStage({ commandId: 's1', reviewId: 'review', stage: 'bootstrap', payload: { draftDigest: draft.digest } });
    const bootstrap = await executeControlBootstrap(ctx, draft), assembled = await assembleQualification({ draft, evidence: bootstrap, reviewJob: ctx.job });
    repo.appendReviewStage({ commandId: 's2', reviewId: 'review', stage: 'matrix-frozen', payload: { bootstrap, assembled } });
    const execution = await executeQualification(ctx, { ...assembled, matrix: assembled.matrix });
    repo.appendReviewStage({ commandId: 's3', reviewId: 'review', stage: 'qualification', payload: { execution } });
    const prompt = await controlQualificationReviewPrompt({ ...assembled, pairs: execution.pairs },1_000_000,presentation), review = await model(prompt); ctx.save();
    repo.appendReviewStage({ commandId: 's4', reviewId: 'review', stage: 'independent-review', payload: { review, promptDigest: digest(prompt) } });
    await writeFile(join(ctx.output, 'report.json'), JSON.stringify({ results: ctx.job.results, controls: ctx.job.controls, evaluation: ctx.job.evaluation, error: ctx.job.error })); ctx.job.proofs = await proofs(); finish();
    const content = { schemaVersion: 1 as const, id: 'qualification:review', proposalId: proposal.id, proposalDigest: lineage.bindingForProposal(proposal.id).proposalDigest, controlDraftDigest: draft.digest, reviewJobId: 'review', environmentDigest: ctx.job.environmentDigest, bootstrap, assembled, execution, independentReview: review, reviewPromptDigest: digest(prompt), proofs: ctx.job.proofs };
    return structuredClone({ ...content, digest: controlQualificationDigest(content) });
  }
  return { ...f, get db() { return db; }, get repo() { return repo; }, get lineage() { return lineage; }, draft, proposal, ctx, run, record, saveRun, author, finish, proofs, model, complete, reopen() { db.close(); db = new DatabaseSync(dbPath); repo = new ControlQualificationRepository(db, f.root); lineage = new VerificationLineageRepository(db); } };
}

async function deliveredFixture(t: TestContext,presentation?:'compact-v2') {
  const f = await fixture(t), evidence = await f.complete(presentation); f.repo.recordQualification({ commandId: 'final-receipt', reviewId: 'review', evidence }); f.lineage.publishBound({ commandId: 'publish', proposalId: 'proposal', reviewId: 'review', expectedBaseProposalId: null, expectedHeadRevision: 0 });
  const proposal = JSON.parse(String(f.db.prepare("SELECT record FROM verification_records WHERE kind='proposal' AND id='proposal'").get()!.record)) as Proposal;
  const candidate = await captureCandidate(join(f.root, 'good'), join(f.root, 'final-candidate'));
  const plan: FrozenPlan = { id: 'plan', runtimeId: 'runtime', projectId: 'project', runId: 'run', proposalId: proposal.id, catalogVersion: proposal.version!, candidate, contractDigest: proposal.contractDigest, definitionDigest: proposal.bundle.digest, environmentDigest: f.ctx.job.environmentDigest, selection: selectInstances(proposal.spec, { mode: 'final' }), createdAt: new Date().toISOString() };
  f.record('plan', plan);
  const final = f.context('final'); final.job.id = 'final'; final.job.kind = 'verification'; final.job.planId = plan.id; final.job.attemptId = 'final'; final.output = join(f.root, 'verification', 'final'); await mkdir(final.output); final.save = () => f.record('job', final.job); final.save();
  final.job.results = await executeInstances(final, proposal.spec, proposal.bundle, candidate, plan.selection.instances, 'candidate'); final.job.evaluation = evaluateVerification(proposal.spec, plan.selection, final.job.results); assert.equal(final.job.evaluation.complete, true);
  final.job.approved = true; final.job.stopConfirmed = true; final.job.status = 'finished'; final.job.finishedAt = new Date().toISOString();
  const source = join(final.output, 'source-fixture.txt'); await writeFile(source, 'Explicit archived source timing fixture; no source was fetched'); final.job.sources = [{ id: 'archived-source-fixture', url: 'https://example.invalid/fixture', path: source, digest: digest(await readFile(source)), acquiredAt: final.job.finishedAt, maxAgeMs: 60_000 }];
  await writeFile(join(final.output, 'report.json'), JSON.stringify({ results: final.job.results, controls: final.job.controls, evaluation: final.job.evaluation, error: final.job.error }));
  const proofs: Record<string, string> = {}; async function walk(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) { const p = join(path, entry.name); if (entry.isDirectory()) await walk(p); else proofs[p] = digest(await readFile(p)); } } await walk(final.output); final.job.proofs = proofs; final.save();
  const artifactPath = join(f.root, 'artifact.json'), bytes = canonical(candidate); await writeFile(artifactPath, bytes); const artifact = { id: plan.id, path: artifactPath, digest: digest(bytes), contractVersion: 1 };
  const delivery: Delivery = { id: 'delivery', jobId: final.job.id, planId: plan.id, runtimeId: 'runtime', projectId: 'project', runId: 'run', candidateDigest: candidate.digest, definitionDigest: proposal.bundle.digest, createdAt: new Date().toISOString(), path: join(final.output, 'delivery.json') }; await writeFile(delivery.path, JSON.stringify(delivery)); f.record('delivery', delivery);
  f.run.status = 'succeeded'; f.run.artifact = artifact; f.run.attempts.push({ id: 'final', nodeId: 'implement', contractVersion: 1, purpose: 'verification', reservation: 100, status: 'succeeded', actual: 0, settled: true }); f.run.evidence = [{ id: 'delivery:math', criterionId: 'math', contractVersion: 1, artifactDigest: artifact.digest, verdict: 'passed', verifierVersion: 'p4:' + proposal.bundle.digest }]; f.saveRun();
  const snapshot: DeliveryEvidenceSnapshot = { delivery, run: structuredClone(f.run), runtime: { id: 'runtime', projectId: 'project', runId: 'run', workspace: candidate.root }, plan, proposal, verification: structuredClone(final.job), review: structuredClone(f.ctx.job), artifact, conversation: null, round: null, head: { proposalId: proposal.id }, scopeIssues: [], definitionFormat: 'qualified-v2' };
  // Snapshot comes from real SQLite, preserving normal serializable status data.
  f.db.exec('CREATE TABLE history_fixture(record TEXT NOT NULL)'); f.db.prepare('INSERT INTO history_fixture VALUES (?)').run(JSON.stringify(snapshot));
  const load = () => JSON.parse(String(f.db.prepare('SELECT record FROM history_fixture').get()!.record)) as DeliveryEvidenceSnapshot;
  const options = (): DeliveryAssessmentOptions => ({ dataDir: f.root, checkedAt: delivery.createdAt, workspaceRead: 'quiet', currentEnvironmentDigest: plan.environmentDigest, qualificationReader: f.repo });
  return { f, snapshot, load, options, evidence, final };
}

test('P6-HISTV2-I01 actual SQLite qualification receipt and full final command preserve historical acceptance across reopen', async t => {
  const { f, load, options, evidence } = await deliveredFixture(t,'compact-v2'); const before = f.db.prepare('SELECT record FROM verification_records ORDER BY kind,id').all();
  assert.notEqual(load().review.controls.length, load().proposal.spec.controls.length, 'V2 bootstrap/matrix inventory must not be checked as V1 controls');
  const assessed = await assessDeliveryEvidence(load(), options()); assert.equal(assessed.historicalEvidenceIntact, true, JSON.stringify(assessed.issues)); assert.equal(assessed.workspaceMatches, true); assert.equal(assessed.environmentMatches, true);
  f.reopen(); assert.deepEqual(await assessDeliveryEvidence(load(), options()), assessed); assert.deepEqual(f.repo.qualificationForReview('review'), evidence); assert.deepEqual(f.db.prepare('SELECT record FROM verification_records ORDER BY kind,id').all(), before); assert.equal(Object.hasOwn(assessed, 'canDeliver'), false);
});

test('P6-HISTV2-I02 changed current environment head child workspace and source TTL do not erase authentic V2 history', async t => {
  const { f, load, options } = await deliveredFixture(t), snapshot = load();
  snapshot.head = { proposalId: 'later-proposal' }; snapshot.conversation = { id: 'conversation', projectId: 'project', workspace: snapshot.runtime.workspace, firstRunId: 'run', activeRunId: 'child', activeSessionId: 'child', authorizedLimit: 1000, createdAt: snapshot.delivery.createdAt }; snapshot.round = { conversationId: 'conversation', ordinal: 1, sessionId: 'run', projectId: 'project', runId: 'run', predecessorRunId: null, predecessorDeliveryId: null, createdAt: snapshot.delivery.createdAt };
  await writeFile(join(snapshot.runtime.workspace, 'data.json'), '{"sum":100}');
  const assessed = await assessDeliveryEvidence(snapshot, { ...options(), currentEnvironmentDigest: digest('new-environment'), checkedAt: new Date(Date.parse(snapshot.delivery.createdAt) + 120_000).toISOString() });
  assert.equal(assessed.historicalEvidenceIntact, true, JSON.stringify(assessed.issues)); assert.equal(assessed.environmentMatches, false); assert.equal(assessed.headMatches, false); assert.equal(assessed.workspaceMatches, false); assert.equal(assessed.isActiveRound, false); assert.equal(assessed.sourceFreshness.state, 'expired'); assert.equal(assessed.sourceFreshness.remoteChecked, false); assert.ok(!assessed.issues.some(i => i.area === 'history'));
  const busy = await assessDeliveryEvidence(snapshot, { ...options(), workspaceRead: 'busy', currentEnvironmentDigest: null }); assert.equal(busy.historicalEvidenceIntact, true); assert.equal(busy.workspaceMatches, null); assert.equal(busy.environmentMatches, null);
});

test('P6-HISTV2-I03 unavailable reader missing persisted receipt and snapshot substitution cannot claim intact history', async t => {
  const { f, load, options } = await deliveredFixture(t), { qualificationReader: _, ...withoutReader } = options();
  const unavailable = await assessDeliveryEvidence(load(), withoutReader); assert.equal(unavailable.historicalEvidenceIntact, null); assert.ok(unavailable.issues.some(i => i.code === 'history-unavailable'));
  const changed = load(); changed.review.controls[0]!.results[0]!.checks[0]!.verdict = 'passed'; assert.equal((await assessDeliveryEvidence(changed, options())).historicalEvidenceIntact, false);
  const wrong = load(); wrong.proposal.controlDraftDigest = digest('other-draft'); assert.equal((await assessDeliveryEvidence(wrong, options())).historicalEvidenceIntact, false);
  // Explicit corruption experiment in the disposable database, never migration.
  f.db.exec('DROP TRIGGER verification_control_qualifications_immutable_delete'); f.db.exec('DELETE FROM verification_control_qualifications'); const absent = await assessDeliveryEvidence(load(), options()); assert.equal(absent.historicalEvidenceIntact, false); assert.ok(absent.issues.some(i => i.area === 'history'));
});

test('P6-HISTV2-I04 mutated qualification archive and self-rehashed SQLite receipt are rejected as history damage', async t => {
  const { f, load, options, evidence } = await deliveredFixture(t), proof = Object.keys(evidence.bootstrap.proofs)[0]!, original = await readFile(proof); await writeFile(proof, 'changed archived qualification proof');
  assert.equal((await assessDeliveryEvidence(load(), options())).historicalEvidenceIntact, false); await writeFile(proof, original);
  const tampered = structuredClone(evidence); tampered.execution.pairs[0]!.results[0]!.checks[0]!.verdict = 'unknown'; const { digest: _, ...body } = tampered; tampered.digest = controlQualificationDigest(body);
  f.db.exec('DROP TRIGGER verification_control_qualifications_immutable_update'); f.db.prepare('UPDATE verification_control_qualifications SET record=? WHERE review_id=?').run(canonical(tampered), 'review');
  const damaged = await assessDeliveryEvidence(load(), options()); assert.equal(damaged.historicalEvidenceIntact, false); assert.equal(damaged.environmentMatches, true); assert.equal(damaged.workspaceMatches, true);
});
