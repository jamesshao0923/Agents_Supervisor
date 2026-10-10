import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Run } from '../../packages/contracts/p1.js';
import type { VerificationSpec, VerificationResult } from '../../packages/contracts/p4.js';
import type { Candidate } from '../../packages/verification/candidate.js';
import type { Proposal, FrozenPlan, VerificationJob, Delivery } from '../../packages/verification/records.js';
import { VerificationRepository } from '../../packages/persistence/verification.js';
import { VerificationLineageRepository, lineageDigest } from '../../packages/persistence/verification-lineage.js';
import { selectInstances, evaluateVerification } from '../../packages/verification/rules.js';

/** Explicit historical DB fixture for conversation/lineage mechanism tests.
 * It runs real domain/accounting/publication transactions and writes real proof
 * bytes, but DOES NOT invoke a model or claim product acceptance. */
export function acceptedDeliveryFixture(db: DatabaseSync, root: string, input: Run, workspace: string, verificationUsage = 0): string {
  const repo = new VerificationRepository(db), lineage = new VerificationLineageRepository(db), now = new Date().toISOString();
  const proofPath = join(root, input.id + '-accepted-fixture.txt'), proofText = 'Explicit historical verification fixture; no model acceptance was executed.';
  writeFileSync(proofPath, proofText);
  // Proofs use byte SHA-256, whereas contract/candidate identities use canonical JSON.
  const proofs = { [proofPath]: byteDigest(proofText) };
  const artifact = { id: 'fixture-plan-' + input.id, path: proofPath, digest: lineageDigest({ fixture: proofText }), contractVersion: input.contract.version };
  repo.act(input.projectId, input.id, { type: 'setArtifact', artifact });
  const candidate: Candidate = { root: workspace, tree: root, files: { [input.id + '-accepted-fixture.txt']: proofs[proofPath]! }, digest: artifact.digest, excluded: [], createdAt: now };
  const spec: VerificationSpec = { schemaVersion: 1, contractVersion: input.contract.version, standardsVersion: 'explicit-db-fixture', obligations: input.contract.criteria.map(criterion => ({ id: criterion.id, criterionId: criterion.id, expectation: criterion.description, required: criterion.required, applicable: true })), cases: input.contract.criteria.map(criterion => ({ id: criterion.id, revision: 1, obligationIds: [criterion.id], parameters: [{}], modules: [criterion.id], replaces: [], defectRefs: ['fixture-defect-' + criterion.id], status: 'active' as const, verifier: { kind: 'command' as const, version: 'fixture', entry: 'never-executed.mjs', files: ['never-executed.mjs'], timeoutMs: 1000 } })), controls: [{ id: 'good', workspace: root, expect: 'passed', mustFail: [] }, { id: 'bad', workspace: root, expect: 'failed', mustFail: input.contract.criteria.map(criterion => criterion.id) }], moduleDependencies: {} };
  const base = lineage.captureBase(input.projectId, input.id);
  const proposal: Proposal = { id: 'fixture-proposal-' + input.id, projectId: input.projectId, runId: input.id, runtimeId: input.id, baseVersion: base.baseProposalId ? repo.get('proposal', base.baseProposalId).version! : 0, version: null, status: 'proposed', spec, bundle: { root, directory: root, specPath: proofPath, specDigest: lineageDigest(spec), files: {}, digest: lineageDigest({ spec }), controls: [{ id: 'good', candidate }, { id: 'bad', candidate }] }, candidate, contractDigest: lineageDigest(input.contract), createdAt: now };
  repo.insert('proposal', proposal); lineage.bindProposal({ commandId: 'fixture-bind-' + input.id, proposalId: proposal.id, base, definitionFormat: 'legacy-v1' });
  const selection = selectInstances(spec, { mode: 'final' });
  const results: VerificationResult[] = selection.instances.map(instance => ({ instanceId: instance.id, executionStatus: 'executed', checks: instance.obligationIds.map(obligationId => ({ obligationId, verdict: 'passed', reason: 'Explicit repository scenario, not observed model acceptance' })), reason: 'Stored fixture', proofFiles: [proofPath] }));
  function settledJob(kind: VerificationJob['kind'], usage: number, planId: string | null): VerificationJob {
    const id = `fixture-${kind}-` + input.id;
    repo.act(input.projectId, input.id, { type: 'startAttempt', attemptId: id, nodeId: input.nodes.at(-1)!.id, contractVersion: input.contract.version, reservation: Math.max(1, usage), purpose: 'verification', resources: [] });
    repo.act(input.projectId, input.id, { type: 'finishAttempt', attemptId: id, outcome: 'succeeded' });
    repo.act(input.projectId, input.id, { type: 'settleAttempt', attemptId: id, actual: usage });
    const job: VerificationJob = { id, runtimeId: input.id, projectId: input.projectId, runId: input.id, workspace, kind, proposalId: proposal.id, planId, request: { fixture: true }, status: 'finished', attemptId: id, environmentDigest: 'explicit-db-fixture', config: { model: 'not-called', effort: 'low', reservation: Math.max(1, usage), timeoutMs: 1000 }, startedAt: now, finishedAt: now, intents: [], identities: [], usage, modelStarted: false, usageUnknown: false, results, controls: [], evaluation: kind === 'verification' ? evaluateVerification(spec, selection, results) : null, approved: true, stopConfirmed: true, error: null, proofs, sources: [] };
    return repo.insert('job', job);
  }
  const review = settledJob('review', 0, null); proposal.reviewId = review.id; repo.publish(proposal, 'fixture-publish-' + input.id);
  const plan: FrozenPlan = { id: artifact.id, runtimeId: input.id, projectId: input.projectId, runId: input.id, proposalId: proposal.id, catalogVersion: proposal.version!, candidate, contractDigest: proposal.contractDigest, definitionDigest: proposal.bundle.digest, environmentDigest: review.environmentDigest, selection, createdAt: now };
  repo.insert('plan', plan); const job = settledJob('verification', verificationUsage, plan.id);
  for (const criterion of input.contract.criteria) repo.act(input.projectId, input.id, { type: 'recordEvidence', evidence: { id: 'fixture-evidence-' + criterion.id, criterionId: criterion.id, contractVersion: input.contract.version, artifactDigest: artifact.digest, verdict: 'passed', verifierVersion: 'repository-fixture-only' } });
  repo.act(input.projectId, input.id, { type: 'complete' });
  const delivery: Delivery = { id: 'fixture-delivery-' + input.id, jobId: job.id, planId: plan.id, runtimeId: input.id, projectId: input.projectId, runId: input.id, candidateDigest: candidate.digest, definitionDigest: proposal.bundle.digest, createdAt: now, path: proofPath };
  repo.insert('delivery', delivery); return delivery.id;
}
const byteDigest = (value: string) => createHash('sha256').update(value).digest('hex');
