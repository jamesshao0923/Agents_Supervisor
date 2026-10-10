import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Run } from '../../packages/contracts/p1.js';
import type { VerificationResult, VerificationSpec } from '../../packages/contracts/p4.js';
import type { Proposal, FrozenPlan, VerificationJob, Delivery } from '../../packages/verification/records.js';
import { captureCandidate, canonical, digest } from '../../packages/verification/candidate.js';
import { captureDefinition } from '../../packages/verification/definition.js';
import { selectInstances, evaluateVerification } from '../../packages/verification/rules.js';
import { assessDeliveryEvidence, invalidateWorkspaceObservation, unavailableDeliveryAssessment } from '../../packages/verification/delivery-status.js';
import type { DeliveryEvidenceSnapshot, DeliveryAssessmentOptions } from '../../packages/verification/delivery-status.js';

// Explicit persisted-record audit fixtures. Real SQLite, frozen candidates,
// definition capture, byte hashes and report files; approval/result metadata is
// supplied here. These tests do not claim a model review or a live P4 delivery.
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sv-delivery-history-'))), dataDir = join(root, 'data');
  const workspace = join(root, 'work'), good = join(root, 'good'), bad = join(root, 'bad'), definitions = join(root, 'definitions');
  for (const p of [dataDir, workspace, good, bad, definitions]) await mkdir(p);
  for (const p of [workspace, good]) await writeFile(join(p, 'value.txt'), 'correct\n');
  await writeFile(join(bad, 'value.txt'), 'incorrect\n');
  await writeFile(join(definitions, 'check.mjs'), '// Frozen implementation fixture, not executed or reviewed by a model\n');
  const contract = { version: 1, goal: 'Return correct value', criteria: [{ id: 'value', description: 'Value is correct', required: true }] };
  const spec: VerificationSpec = { schemaVersion: 1, contractVersion: 1, standardsVersion: 's1', obligations: [{ id: 'value', criterionId: 'value', expectation: 'Value equals correct', required: true, applicable: true }], cases: [{ id: 'value-check', revision: 1, obligationIds: ['value'], parameters: [{}], modules: ['value'], replaces: [], defectRefs: ['incorrect-value'], verifier: { kind: 'command', version: 'v1', entry: 'check.mjs', files: ['check.mjs'], timeoutMs: 1000 } }], controls: [{ id: 'good', workspace: good, expect: 'passed', mustFail: [] }, { id: 'bad', workspace: bad, expect: 'failed', mustFail: ['value'] }], moduleDependencies: {} };
  const specPath = join(definitions, 'spec.json'); await writeFile(specPath, JSON.stringify(spec));
  const proposalRoot = join(dataDir, 'verification', 'proposal'); await mkdir(proposalRoot, { recursive: true });
  const captured = await captureDefinition(specPath, proposalRoot);
  const proposalCandidate = await captureCandidate(workspace, join(proposalRoot, 'candidate'));
  const planCandidate = await captureCandidate(workspace, join(dataDir, 'verification', 'plan'));
  const environment = digest('explicit recorded environment fixture'), startedAt = '2026-10-10T00:00:00.000Z', finishedAt = '2026-10-10T00:01:00.000Z', createdAt = '2026-10-10T00:02:00.000Z';
  const proposal: Proposal = { id: 'proposal', runtimeId: 'runtime', projectId: 'project', runId: 'run', baseVersion: 0, version: 1, spec, bundle: captured.bundle, candidate: proposalCandidate, contractDigest: digest(canonical(contract)), status: 'published', createdAt: startedAt, reviewId: 'review', reviewEnvironmentDigest: environment };
  const plan: FrozenPlan = { id: 'plan', runtimeId: 'runtime', projectId: 'project', runId: 'run', proposalId: proposal.id, catalogVersion: 1, candidate: planCandidate, contractDigest: proposal.contractDigest, definitionDigest: proposal.bundle.digest, environmentDigest: environment, selection: selectInstances(spec, { mode: 'final' }), createdAt: finishedAt };
  function result(verdict: 'passed' | 'failed', proof: string): VerificationResult { return { instanceId: plan.selection.instances[0]!.id, executionStatus: 'executed', checks: [{ obligationId: 'value', verdict, reason: 'Explicit result metadata fixture for persisted proof audit' }], reason: 'Fixture is not actual model or command acceptance', proofFiles: [proof] }; }
  const common = { runtimeId: 'runtime', projectId: 'project', runId: 'run', workspace, proposalId: proposal.id, request: { purpose: 'explicit non-model repository fixture' }, status: 'finished' as const, environmentDigest: environment, config: { model: 'no-model-fixture', effort: 'low', reservation: 10, timeoutMs: 1000 }, startedAt, finishedAt, intents: [], identities: [], usage: 0, modelStarted: false, usageUnknown: false, approved: true, stopConfirmed: true, error: null, proofs: {}, sources: [] };
  const reviewProof = join(dataDir, 'verification', 'review', 'outcome.txt'), finalProof = join(dataDir, 'verification', 'final', 'outcome.txt');
  const review: VerificationJob = { ...structuredClone(common), id: 'review', kind: 'review', planId: null, attemptId: 'review', results: [], controls: [{ id: 'good', passed: true, results: [result('passed', reviewProof)] }, { id: 'bad', passed: true, results: [result('failed', reviewProof)] }], evaluation: null };
  const results = [result('passed', finalProof)];
  const verification: VerificationJob = { ...structuredClone(common), id: 'final', kind: 'verification', planId: plan.id, attemptId: 'final', results, controls: [], evaluation: evaluateVerification(spec, plan.selection, results) };
  async function recordJob(job: VerificationJob) {
    const directory = join(dataDir, 'verification', job.id); await mkdir(directory, { recursive: true });
    const outcome = join(directory, 'outcome.txt'); await writeFile(outcome, 'Explicit immutable stored result fixture\n'); job.proofs[outcome] = digest(await readFile(outcome));
    const report = join(directory, 'report.json'); await writeFile(report, JSON.stringify({ results: job.results, controls: job.controls, evaluation: job.evaluation, error: job.error })); job.proofs[report] = digest(await readFile(report));
  }
  await recordJob(review); await recordJob(verification);
  const artifactPath = join(dataDir, 'artifact.json'), artifactText = canonical(plan.candidate); await writeFile(artifactPath, artifactText);
  const artifact = { id: plan.id, path: artifactPath, digest: digest(artifactText), contractVersion: 1 };
  const delivery: Delivery = { id: 'delivery', jobId: verification.id, planId: plan.id, runtimeId: 'runtime', projectId: 'project', runId: 'run', candidateDigest: plan.candidate.digest, definitionDigest: plan.definitionDigest, createdAt, path: join(dataDir, 'verification', verification.id, 'delivery.json') }; await writeFile(delivery.path, JSON.stringify(delivery));
  const run: Run = { id: 'run', projectId: 'project', revision: 8, contract, status: 'succeeded', nodes: [{ id: 'implement', dependencies: [], required: true, status: 'succeeded' }], attempts: [review, verification].map(j => ({ id: j.attemptId, nodeId: 'implement', contractVersion: 1, status: 'succeeded', reservation: 10, purpose: 'verification', settled: true, actual: j.usage })), budget: { unit: 'token', limit: 100, spent: 0, verificationReserve: 20 }, operations: [], leases: [], artifact, evidence: [{ id: delivery.id + ':value', criterionId: 'value', contractVersion: 1, artifactDigest: artifact.digest, verdict: 'passed', verifierVersion: 'p4:' + plan.definitionDigest }] };
  const snapshot: DeliveryEvidenceSnapshot = { delivery, run, runtime: { id: 'runtime', projectId: 'project', runId: 'run', workspace }, plan, proposal, verification, review, artifact, conversation: null, round: null, head: { proposalId: proposal.id }, scopeIssues: [] };
  const options: DeliveryAssessmentOptions = { dataDir, checkedAt: '2026-10-10T00:03:00.000Z', workspaceRead: 'quiet', currentEnvironmentDigest: environment };
  const dbPath = join(dataDir, 'fixture.sqlite'); let db = new DatabaseSync(dbPath); db.exec('CREATE TABLE audit_fixture(id TEXT PRIMARY KEY,record TEXT NOT NULL)'); db.prepare('INSERT INTO audit_fixture VALUES (?,?)').run('snapshot', JSON.stringify(snapshot));
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const load = () => JSON.parse(String(db.prepare('SELECT record FROM audit_fixture WHERE id=?').get('snapshot')!.record)) as DeliveryEvidenceSnapshot;
  return { root, dataDir, workspace, definitions, snapshot, options, recordJob, load, reopen() { db.close(); db = new DatabaseSync(dbPath); }, stored() { return String(db.prepare('SELECT record FROM audit_fixture WHERE id=?').get('snapshot')!.record); } };
}

test('P6-HIST-I01 stored delivery audits exact frozen files and settled records without mutations across SQLite reopen', async t => {
  const f = await fixture(t), before = f.stored(), frozen = await readFile(f.snapshot.delivery.path), input = JSON.stringify(f.snapshot);
  const a = await assessDeliveryEvidence(f.load(), f.options);
  assert.equal(a.historicalEvidenceIntact, true, JSON.stringify(a.issues)); assert.equal(a.workspaceMatches, true); assert.equal(a.headMatches, true); assert.equal(a.environmentMatches, true); assert.equal(a.isActiveRound, null); assert.equal(a.sourceFreshness.state, 'not-applicable');
  f.reopen(); assert.deepEqual(await assessDeliveryEvidence(f.load(), f.options), a); assert.equal(f.stored(), before); assert.equal(JSON.stringify(f.snapshot), input); assert.deepEqual(await readFile(f.snapshot.delivery.path), frozen);
  assert.equal(Object.hasOwn(a, 'canDeliver'), false); assert.equal(Object.hasOwn(a, 'complete'), false);
});

test('P6-HIST-I02 child round head workspace and environment changes preserve the original historical delivery', async t => {
  const f = await fixture(t), s = f.load();
  s.conversation = { id: 'conversation', projectId: 'project', workspace: f.workspace, firstRunId: 'run', activeRunId: 'child', activeSessionId: 'child-session', authorizedLimit: 100, createdAt: s.delivery.createdAt };
  s.round = { conversationId: 'conversation', ordinal: 1, sessionId: 'session', projectId: 'project', runId: 'run', predecessorRunId: null, predecessorDeliveryId: null, createdAt: s.delivery.createdAt }; s.head = { proposalId: 'child-proposal' };
  await writeFile(join(f.workspace, 'value.txt'), 'new child development\n'); await writeFile(join(f.definitions, 'check.mjs'), '// live checker has evolved\n');
  const a = await assessDeliveryEvidence(s, { ...f.options, currentEnvironmentDigest: digest('updated environment') });
  assert.equal(a.historicalEvidenceIntact, true, JSON.stringify(a.issues)); assert.equal(a.workspaceMatches, false); assert.equal(a.headMatches, false); assert.equal(a.environmentMatches, false); assert.equal(a.isActiveRound, false); assert.equal(a.round?.ordinal, 1);
  s.conversation.activeRunId = 'run'; assert.equal((await assessDeliveryEvidence(s, { ...f.options, workspaceRead: 'busy' })).isActiveRound, true, 'Terminal inquiry alone does not create a child round');
});

test('P6-HIST-I03 actual archived proof detector candidate artifact and delivery byte changes cannot remain intact', async t => {
  const f = await fixture(t), s = f.load();
  const paths = [Object.keys(s.review.proofs)[0]!, Object.keys(s.verification.proofs)[0]!, join(s.proposal.bundle.directory, 'check.mjs'), join(s.plan.candidate.tree, 'value.txt'), s.artifact!.path, s.delivery.path];
  for (const path of paths) { const before = await readFile(path); await writeFile(path, 'tampered historical bytes'); const a = await assessDeliveryEvidence(s, f.options); assert.equal(a.historicalEvidenceIntact, false, path); assert.ok(a.issues.some(i => i.area === 'history')); await writeFile(path, before); }
  const proof = Object.keys(s.verification.proofs)[0]!; await rm(proof); assert.equal((await assessDeliveryEvidence(s, f.options)).historicalEvidenceIntact, false);
});

test('P6-HIST-I04 expired source windows differ from damaged archival bytes without any remote refresh', async t => {
  const f = await fixture(t), s = f.load(), path = join(f.dataDir, 'verification', 'final', 'source.txt'); await writeFile(path, 'Saved source document');
  const hash = digest(await readFile(path)); s.verification.proofs[path] = hash; s.verification.sources.push({ id: 'source', url: 'https://example.invalid/no-network-is-performed', digest: hash, acquiredAt: '2026-10-10T00:00:00.000Z', maxAgeMs: 180_000, path });
  const expired = await assessDeliveryEvidence(s, { ...f.options, checkedAt: '2026-10-10T00:04:00.000Z' }); assert.equal(expired.historicalEvidenceIntact, true, JSON.stringify(expired.issues)); assert.equal(expired.sourceFreshness.state, 'expired'); assert.equal(expired.sourceFreshness.remoteChecked, false);
  assert.equal((await assessDeliveryEvidence(s, f.options)).sourceFreshness.state, 'within-recorded-window');
  const rewind = await assessDeliveryEvidence(s, { ...f.options, checkedAt: '2026-10-09T23:59:00.000Z' }); assert.equal(rewind.historicalEvidenceIntact, true); assert.equal(rewind.sourceFreshness.state, 'unknown');
  await writeFile(path, 'altered stored source'); assert.equal((await assessDeliveryEvidence(s, f.options)).historicalEvidenceIntact, false);
});

test('P6-HIST-I05 identity accounting partial scope and self-declared completion cannot replace historical evidence', async t => {
  const f = await fixture(t);
  const changes: ((s: DeliveryEvidenceSnapshot) => void)[] = [s => { s.verification.runId = 'another'; }, s => { s.verification.usageUnknown = true; }, s => { s.run.attempts[0]!.settled = false; }, s => { s.plan.selection.mode = 'impact'; }, s => { s.verification.results = []; }, s => { s.run.evidence[0]!.artifactDigest = 'different'; }, s => { s.review.controls = []; }, s => { s.verification.proofs = {}; }];
  for (const change of changes) { const s = f.load(); change(s); assert.equal((await assessDeliveryEvidence(s, f.options)).historicalEvidenceIntact, false); }
  const s = f.load(), report = join(f.dataDir, 'verification', 'final', 'report.json'); await writeFile(report, '{}'); s.verification.proofs[report] = digest(await readFile(report)); assert.equal((await assessDeliveryEvidence(s, f.options)).historicalEvidenceIntact, false, 'Rehashing a different report does not match the stored actual results');
});

test('P6-HIST-I06 symlink and external proof paths fail while unsupported history remains explicitly unknown', async t => {
  const f = await fixture(t), s = f.load(), proof = Object.keys(s.verification.proofs)[0]!, bytes = await readFile(proof), outside = join(f.root, 'external-proof'); await writeFile(outside, bytes); await rm(proof); await symlink(outside, proof);
  const unsafe = await assessDeliveryEvidence(s, f.options); assert.equal(unsafe.historicalEvidenceIntact, false); assert.ok(unsafe.issues.some(i => i.code === 'history-file-unsafe'));
  await rm(proof); await writeFile(proof, bytes); s.verification.proofs[outside] = digest(bytes); assert.equal((await assessDeliveryEvidence(s, f.options)).historicalEvidenceIntact, false);
  const unsupported = f.load(); unsupported.definitionFormat = 'qualified-v2'; assert.equal((await assessDeliveryEvidence(unsupported, f.options)).historicalEvidenceIntact, null);
});

test('P6-HIST-I07 busy missing and changed read observations never erase the saved delivery or grant authority', async t => {
  const f = await fixture(t), s = f.load(); await rm(f.workspace, { recursive: true });
  const busy = await assessDeliveryEvidence(s, { ...f.options, workspaceRead: 'busy', currentEnvironmentDigest: null }); assert.equal(busy.historicalEvidenceIntact, true); assert.equal(busy.workspaceMatches, null); assert.equal(busy.environmentMatches, null); assert.ok(busy.issues.some(i => i.code === 'workspace-busy'));
  const missing = await assessDeliveryEvidence(s, f.options); assert.equal(missing.workspaceMatches, false); assert.equal(missing.historicalEvidenceIntact, true);
  const invalidated = invalidateWorkspaceObservation(missing); assert.equal(invalidated.workspaceMatches, null); assert.equal(invalidated.historicalEvidenceIntact, true); assert.equal(missing.workspaceMatches, false);
  const unavailable = unavailableDeliveryAssessment(s.delivery, f.options.checkedAt, { code: 'history-record-missing', area: 'history', message: 'Stored plan is missing' }); assert.equal(unavailable.historicalEvidenceIntact, false); assert.deepEqual(unavailable.delivery, s.delivery);
});
