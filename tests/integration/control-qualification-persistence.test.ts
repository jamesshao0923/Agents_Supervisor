import { captureQualificationCausalEvidence } from '../../packages/verification/qualification-causal-evidence.js';
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
import type { Proposal, VerificationJob } from '../../packages/verification/records.js';
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
  async function complete(presentation?:'compact-v2'|'complete-v3') {
    repo.insertDraft({ commandId: 'draft', proposalId: proposal.id, draft }); repo.appendReviewStage({ commandId: 's1', reviewId: 'review', stage: 'bootstrap', payload: { draftDigest: draft.digest } });
    const bootstrap = await executeControlBootstrap(ctx, draft), assembled = await assembleQualification({ draft, evidence: bootstrap, reviewJob: ctx.job });
    repo.appendReviewStage({ commandId: 's2', reviewId: 'review', stage: 'matrix-frozen', payload: { bootstrap, assembled } });
    const execution = await executeQualification(ctx, { ...assembled, matrix: assembled.matrix });
    repo.appendReviewStage({ commandId: 's3', reviewId: 'review', stage: 'qualification', payload: { execution } });
    Object.assign(ctx.job.proofs,execution.proofs);ctx.save();
    const qualificationCausalEvidence=presentation==='complete-v3'?captureQualificationCausalEvidence({job:ctx.job,matrix:assembled.matrix,pairs:execution.pairs,executionProofs:execution.proofs,dataDir:f.root}):undefined;
    const prompt = await controlQualificationReviewPrompt({ ...assembled, pairs: execution.pairs,...(qualificationCausalEvidence?{qualificationCausalEvidence}:{}) },1_000_000,presentation), review = await model(prompt); ctx.save();
    repo.appendReviewStage({ commandId: 's4', reviewId: 'review', stage: 'independent-review', payload: { review, promptDigest: digest(prompt) } });
    await writeFile(join(ctx.output, 'report.json'), JSON.stringify({ results: ctx.job.results, controls: ctx.job.controls, evaluation: ctx.job.evaluation, error: ctx.job.error })); ctx.job.proofs = await proofs(); finish();
    const content = { schemaVersion: 1 as const, id: 'qualification:review', proposalId: proposal.id, proposalDigest: lineage.bindingForProposal(proposal.id).proposalDigest, controlDraftDigest: draft.digest, reviewJobId: 'review', environmentDigest: ctx.job.environmentDigest, bootstrap, assembled, execution, independentReview: review, reviewPromptDigest: digest(prompt), proofs: ctx.job.proofs };
    return structuredClone({ ...content, digest: controlQualificationDigest(content) });
  }
  return { ...f, get db() { return db; }, get repo() { return repo; }, get lineage() { return lineage; }, draft, proposal, ctx, run, record, saveRun, author, finish, proofs, model, complete, reopen() { db.close(); db = new DatabaseSync(dbPath); repo = new ControlQualificationRepository(db, f.root); lineage = new VerificationLineageRepository(db); } };
}

test('P6-QUAL-I01 immutable draft full-payload idempotency survives real SQLite reopen and preserves proposal', async t => {
  const f = await fixture(t), before = f.db.prepare("SELECT record FROM verification_records WHERE kind='proposal'").get()!.record, input = { commandId: 'draft', proposalId: 'proposal', draft: f.draft };
  const saved = f.repo.insertDraft(input); f.reopen(); assert.deepEqual(f.repo.insertDraft(input), saved); assert.deepEqual(f.repo.draftForProposal('proposal'), saved);
  assert.throws(() => f.repo.insertDraft({ ...input, proposalId: 'foreign' }), /Conflicting/); assert.throws(() => f.db.exec('UPDATE verification_control_drafts SET record=record'), /immutable/); assert.throws(() => f.db.exec('DELETE FROM verification_control_receipts'), /immutable/);
  assert.equal(f.db.prepare("SELECT record FROM verification_records WHERE kind='proposal'").get()!.record, before);
});

test('P6-QUAL-I02 staged review enforces exact running ownership sequence and parent rollback without committing parent', async t => {
  const f = await fixture(t); f.repo.insertDraft({ commandId: 'draft', proposalId: 'proposal', draft: f.draft });
  assert.throws(() => f.repo.appendReviewStage({ commandId: 'gap', reviewId: 'review', stage: 'qualification', payload: { execution: {} as never } }), /sequence gap/);
  assert.throws(() => f.repo.transaction(() => { f.repo.appendReviewStage({ commandId: 's1', reviewId: 'review', stage: 'bootstrap', payload: { draftDigest: f.draft.digest } }); assert.equal(f.db.isTransaction, true); throw new Error('parent rollback'); }), /parent rollback/);
  assert.equal(f.repo.stagesForReview('review').length, 0); assert.equal(f.db.prepare("SELECT count(*) n FROM verification_control_receipts WHERE command_id='s1'").get()!.n, 0);
  const saved = f.repo.appendReviewStage({ commandId: 's1', reviewId: 'review', stage: 'bootstrap', payload: { draftDigest: f.draft.digest } }); assert.deepEqual(f.repo.appendReviewStage({ commandId: 's1', reviewId: 'review', stage: 'bootstrap', payload: { draftDigest: f.draft.digest } }), saved);
  assert.throws(() => f.repo.appendReviewStage({ commandId: 'conflict', reviewId: 'review', stage: 'bootstrap', payload: { draftDigest: digest('wrong') } }), /Conflicting/);
  f.ctx.job.usageUnknown = true; f.ctx.save(); assert.throws(() => f.repo.appendReviewStage({ commandId: 'unknown', reviewId: 'review', stage: 'matrix-frozen', payload: {} as never }), /accounting/);
});

test('P6-QUAL-I03 caller rehashed draft or altered frozen author bytes cannot enter immutable persistence', async t => {
  const f = await fixture(t), altered = structuredClone(f.draft); altered.bootstrapPlan = []; const { digest: _, ...body } = altered; altered.digest = controlDigest(body);
  assert.throws(() => f.repo.insertDraft({ commandId: 'forged', proposalId: 'proposal', draft: altered }), /draft changed|binding changed|freeze/i);
  // Stored-record integrity negatives only: no fake semantic success or model request.
  // The reader must parse explicit versions before any truthiness branch.
  const originalAuthor = String(f.db.prepare('SELECT record FROM supervision_jobs WHERE id=?').get(f.author.id)!.record);
  for (const version of [false, 0, null]) {
    const corrupted = structuredClone(f.author);
    (corrupted.input as {context:Record<string,unknown>}).context.authorPresentation = version;
    f.db.prepare('UPDATE supervision_jobs SET record=? WHERE id=?').run(canonical(corrupted), f.author.id);
    assert.throws(() => f.repo.insertDraft({commandId:'malformed-version-'+String(version),proposalId:'proposal',draft:f.draft}), /Unknown author presentation version/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM verification_control_drafts').get()!.n, 0);
    f.db.prepare('UPDATE supervision_jobs SET record=? WHERE id=?').run(originalAuthor, f.author.id);
  }
  await writeFile(Object.keys(f.author.proofs)[0]!, 'tamper'); assert.throws(() => f.repo.insertDraft({ commandId: 'tamper', proposalId: 'proposal', draft: f.draft }), /proof bytes changed/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM verification_control_drafts').get()!.n, 0);
});

test('P6-QUAL-I04 actual command qualification is atomically bound to final job and scoped publication then reloads exact history', async t => {
  const f = await fixture(t), evidence = await f.complete('complete-v3'), request = { commandId: 'publish', proposalId: 'proposal', reviewId: 'review', expectedBaseProposalId: null, expectedHeadRevision: 0 };
  assert.throws(() => f.lineage.publishBound(request), /finalized/);
  assert.throws(() => f.repo.transaction(() => { f.repo.recordQualification({ commandId: 'final', reviewId: 'review', evidence }); f.lineage.publishBound(request); assert.equal(f.db.isTransaction, true); throw new Error('atomic rollback'); }), /atomic rollback/);
  assert.equal(f.lineage.headForRun('project', 'run'), null); assert.equal(f.db.prepare('SELECT count(*) n FROM verification_control_qualifications').get()!.n, 0);
  f.repo.recordQualification({ commandId: 'final', reviewId: 'review', evidence }); f.lineage.publishBound(request); f.reopen(); assert.deepEqual(f.repo.qualificationForReview('review'), evidence); const history = f.repo.loadHistory('proposal'); assert.deepEqual(history.specimens, evidence.assembled.specimens); assert.deepEqual(history.manifest, evidence.assembled.rules.manifest); assert.equal(history.transitions.length, 0);
  assert.ok(f.ctx.job.identities.length >= 4, 'actual bootstrap and complete matrix processes, no live model');
});

test('P6-QUAL-I05 actual DB row tamper unsettled costs raw review and proof mutations all reject final qualification', async t => {
  const f = await fixture(t), evidence = await f.complete();
  const valid = structuredClone(f.ctx.job); f.ctx.job.controls.find(c => c.id.startsWith('qualification:'))!.results[0]!.checks[0]!.verdict = 'unknown'; f.ctx.save(); assert.throws(() => f.repo.recordQualification({ commandId: 'forged', reviewId: 'review', evidence }), /actual persisted/); Object.assign(f.ctx.job, structuredClone(valid)); f.ctx.save();
  f.run.attempts.at(-1)!.settled = false; f.saveRun(); assert.throws(() => f.repo.recordQualification({ commandId: 'unsettled', reviewId: 'review', evidence }), /settled/); f.run.attempts.at(-1)!.settled = true; f.saveRun();
  const altered = structuredClone(evidence); altered.independentReview.threadId = f.author.threadId; const { digest: _, ...body } = altered; altered.digest = controlQualificationDigest(body); assert.throws(() => f.repo.recordQualification({ commandId: 'same-thread', reviewId: 'review', evidence: altered }), /fresh independent/);
  const proof = evidence.independentReview.proofFiles[0]!; await writeFile(proof, '{}'); assert.throws(() => f.repo.recordQualification({ commandId: 'proof', reviewId: 'review', evidence }), /proof bytes changed/); assert.equal(f.db.prepare('SELECT count(*) n FROM verification_control_qualifications').get()!.n, 0);
});

test('P6-QUAL-I06 trusted V1 history uses actual original controls and refuses missing exact detector proof', async t => {
  const f = await fixture(t);
  // Replace the not-yet-persisted V2 binding only by constructing an independent
  // legacy proposal on the same legitimate root; original immutable row stays.
  const p: Proposal = { ...f.proposal, id: 'legacy' }; delete p.controlDraftDigest; f.record('proposal', p); f.lineage.bindProposal({ commandId: 'legacy-bind', proposalId: p.id, base: f.input.base, definitionFormat: 'legacy-v1' }); f.ctx.job.proposalId = p.id;
  const selection = selectInstances(p.spec, { mode: 'final' }); for (const control of p.spec.controls) { const candidate = p.bundle.controls.find(c => c.id === control.id)!.candidate; const results = await executeInstances(f.ctx, p.spec, p.bundle, candidate, selection.instances, 'control-' + digest(control.id)); f.ctx.job.controls.push({ id: control.id, passed: true, results }); }
  await f.model('Explicit original V1 metadata fixture', 'definition-review'); await writeFile(join(f.ctx.output, 'report.json'), JSON.stringify({ results: [], controls: f.ctx.job.controls, evaluation: null, error: null })); f.ctx.job.proofs = await f.proofs(); f.finish();
  f.lineage.publishBound({ commandId: 'legacy-publish', proposalId: p.id, reviewId: 'review', expectedBaseProposalId: null, expectedHeadRevision: 0 });
  const history = f.repo.loadHistory(p.id), negative = history.specimens.find(s => s.revision.kind === 'negative')!; assert.equal(negative.revision.witnesses.length, 1); assert.deepEqual(negative.revision.witnesses[0]!.instance, selection.instances[0]); assert.deepEqual(negative.revision.witnesses[0]!.result, f.ctx.job.controls.find(c => c.id === 'bad')!.results[0]);
  const prior = structuredClone(history), successor: Proposal = { ...p, id: 'legacy-next', baseVersion: 1 }; f.record('proposal', successor); f.lineage.bindProposal({ commandId: 'legacy-next-bind', proposalId: successor.id, base: f.lineage.captureBase('project', 'run'), definitionFormat: 'legacy-v1' });
  Object.assign(f.ctx.job, { id: 'review-next', attemptId: 'review-next', proposalId: successor.id, status: 'running', finishedAt: null, approved: false, stopConfirmed: false, modelStarted: false, usage: 0, controls: [], proofs: {}, intents: [], identities: [] }); f.ctx.output = join(f.root, 'verification', 'review-next'); await mkdir(f.ctx.output); f.ctx.save();
  f.run.attempts.push({ id: 'review-next', nodeId: 'implement', contractVersion: 1, status: 'running', purpose: 'verification', reservation: 100, actual: null, settled: false }); f.saveRun();
  for (const control of successor.spec.controls) { const candidate = successor.bundle.controls.find(c => c.id === control.id)!.candidate; const results = await executeInstances(f.ctx, successor.spec, successor.bundle, candidate, selection.instances, 'control-' + digest(control.id)); f.ctx.job.controls.push({ id: control.id, passed: true, results }); }
  await f.model('Explicit successor V1 metadata fixture', 'definition-review'); await writeFile(join(f.ctx.output, 'report.json'), JSON.stringify({ results: [], controls: f.ctx.job.controls, evaluation: null, error: null })); f.ctx.job.proofs = await f.proofs(); f.finish();
  f.lineage.publishBound({ commandId: 'legacy-next-publish', proposalId: successor.id, reviewId: 'review-next', expectedBaseProposalId: p.id, expectedHeadRevision: 1 });
  const inherited = f.repo.loadHistory(successor.id); assert.deepEqual(inherited.specimens.slice(0, prior.specimens.length), prior.specimens); const revised = inherited.specimens.find(s => s.revision.kind === 'negative' && s.revision.ref.revision === 2)!; assert.deepEqual(revised.revision.witnesses[0], negative.revision.witnesses[0]); assert.equal(revised.revision.witnesses.length, 2, 'All actual old and new failures retained');
  const proof = Object.keys(negative.revision.witnesses[0]!.proofs)[0]!; await writeFile(proof, 'not original evidence'); assert.throws(() => f.repo.loadHistory(successor.id), /proof bytes changed/);
});
