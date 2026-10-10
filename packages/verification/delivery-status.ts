import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Artifact, Run } from '../contracts/p1.js';
import type { RuntimeRecord } from '../contracts/p3.js';
import type { Conversation, ConversationRound } from '../contracts/p6.js';
import type { DeliveryAssessment, DeliveryIssue, DeliveryIssueCode } from '../contracts/p4-delivery-status.js';
import type { Delivery, FrozenPlan, Proposal, SourceObservation, VerificationJob } from './records.js';
import { assertCandidate, canonical, digest, scanCandidate } from './candidate.js';
import { assertDefinition } from './definition.js';
import { evaluateVerification, selectInstances, validateSpecChange } from './rules.js';

export interface DeliveryEvidenceSnapshot {
  delivery: Delivery;
  run: Run;
  runtime: Pick<RuntimeRecord, 'id' | 'projectId' | 'runId' | 'workspace'>;
  plan: FrozenPlan;
  proposal: Proposal;
  verification: VerificationJob;
  review: VerificationJob;
  artifact: Artifact | null;
  conversation: Conversation | null;
  round: ConversationRound | null;
  head: { proposalId: string } | null;
  scopeIssues: DeliveryIssue[];
  /** Legacy records without an envelope remain V1. V2 needs a separate receipt reader. */
  definitionFormat?: 'legacy-v1' | 'qualified-v2';
}
export interface DeliveryAssessmentOptions {
  dataDir: string;
  checkedAt: string;
  workspaceRead: 'quiet' | 'busy' | 'unknown';
  currentEnvironmentDigest: string | null;
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
class InvalidEvidence extends Error {
  constructor(readonly code: DeliveryIssueCode, message: string) { super(message); }
}
function ensure(value: unknown, code: DeliveryIssueCode, message: string): asserts value {
  if (!value) throw new InvalidEvidence(code, message);
}
function base(delivery: Delivery, checkedAt: string): DeliveryAssessment {
  return { delivery: structuredClone(delivery), checkedAt, historicalEvidenceIntact: null,
    workspaceMatches: null, isActiveRound: null, round: null, headMatches: null,
    environmentMatches: null, sourceFreshness: { state: 'unknown', earliestExpiresAt: null, remoteChecked: false }, issues: [] };
}
export function unavailableDeliveryAssessment(delivery: Delivery, checkedAt: string, issue: DeliveryIssue): DeliveryAssessment {
  const result = base(delivery, checkedAt);
  result.historicalEvidenceIntact = issue.code === 'history-record-missing' ? false : null;
  result.issues.push(structuredClone(issue));
  return result;
}
/** Called after async filesystem reads if the controller's writer/revision token changed. */
export function invalidateWorkspaceObservation(value: DeliveryAssessment): DeliveryAssessment {
  const result = structuredClone(value); result.workspaceMatches = null;
  result.issues.push({ code: 'workspace-observation-changed', area: 'workspace', message: 'Workspace writer or runtime state changed during the read-only observation' });
  return result;
}
function binding(s: DeliveryEvidenceSnapshot): void {
  const { delivery: d, run, runtime, plan, proposal: p, verification: job, review, artifact } = s;
  const bad = 'history-binding-invalid';
  ensure(d.projectId === run.projectId && d.runId === run.id && d.runtimeId === runtime.id && runtime.projectId === run.projectId && runtime.runId === run.id, bad, 'Delivery and original Run/runtime identity differ');
  for (const item of [plan, p, job, review]) ensure(item.projectId === d.projectId && item.runId === d.runId && item.runtimeId === d.runtimeId, bad, 'Historical verification chain crosses a Run or runtime');
  ensure(d.planId === plan.id && d.jobId === job.id && job.planId === plan.id && plan.proposalId === p.id && job.proposalId === p.id && review.proposalId === p.id && p.reviewId === review.id, bad, 'Delivery plan, verification or reviewed proposal binding differs');
  ensure(job.kind === 'verification' && review.kind === 'review' && review.planId === null && p.status === 'published' && p.version === plan.catalogVersion, bad, 'Historical verification kind or published catalog differs');
  ensure(runtime.workspace === plan.candidate.root && job.workspace === runtime.workspace && review.workspace === runtime.workspace, bad, 'Historical workspace identity differs');
  ensure(d.candidateDigest === plan.candidate.digest && d.definitionDigest === plan.definitionDigest && plan.definitionDigest === p.bundle.digest, bad, 'Delivery frozen candidate or definition digest differs');
  ensure(digest(canonical(run.contract)) === plan.contractDigest && plan.contractDigest === p.contractDigest, bad, 'Original contract differs from the reviewed frozen contract');
  ensure(plan.environmentDigest === job.environmentDigest && p.reviewEnvironmentDigest === review.environmentDigest && review.environmentDigest === plan.environmentDigest, bad, 'Historical review, plan and execution environments differ');
  ensure(run.status === 'succeeded' && run.nodes.filter(n => n.required).every(n => n.status === 'succeeded'), bad, 'Original Run has no completed delivery domain state');
  ensure(artifact && equal(artifact, run.artifact) && artifact.id === plan.id && artifact.contractVersion === run.contract.version, bad, 'Delivery artifact index or original Run artifact differs');
  ensure(run.attempts.every(a => a.status !== 'running' && a.settled) && run.operations.every(o => o.status === 'confirmed') && run.leases.every(l => l.released), 'history-accounting-invalid', 'Original Run has unsettled attempts, effects or leases');
  for (const j of [review, job]) {
    const a = run.attempts.find(a => a.id === j.attemptId);
    ensure(j.status === 'finished' && j.approved && !j.error && j.stopConfirmed && !j.usageUnknown && Number.isSafeInteger(j.usage) && j.usage >= 0 && j.finishedAt && j.intents.length === j.identities.length, 'history-accounting-invalid', 'Historical job lacks completed approval, recorded stop or known usage');
    ensure(a?.purpose === 'verification' && a.status === 'succeeded' && a.settled && a.actual === j.usage && a.contractVersion === run.contract.version, 'history-accounting-invalid', 'Historical job actual usage does not match its settled attempt');
    const intentIds = j.intents.map(i => i.operationId), identityIds = j.identities.map(i => i.operationId);
    ensure(new Set(intentIds).size === intentIds.length && equal([...intentIds].sort(), [...identityIds].sort()), 'history-evidence-invalid', 'Historical process intents lack exact identity correspondence');
    for (const identity of j.identities) ensure(identity.version === 1 && Number.isSafeInteger(identity.pid) && identity.pid > 0 && Number.isSafeInteger(identity.pgid) && identity.pgid > 0 && identity.startIdentity.length > 0 && j.intents.some(intent => intent.operationId === identity.operationId && intent.ownerToken === identity.ownerToken), 'history-evidence-invalid', 'Historical process birth or owner binding is incomplete');
    const start = Date.parse(j.startedAt), finish = Date.parse(j.finishedAt), delivered = Date.parse(d.createdAt);
    ensure(Number.isFinite(start) && Number.isFinite(finish) && Number.isFinite(delivered) && start <= finish && finish <= delivered, bad, 'Historical job and delivery timestamps are inconsistent');
  }
  for (const criterion of run.contract.criteria.filter(c => c.required)) {
    const e = run.evidence.filter(e => e.id === d.id + ':' + criterion.id);
    ensure(e.length === 1 && e[0]!.criterionId === criterion.id && e[0]!.contractVersion === run.contract.version && e[0]!.artifactDigest === artifact.digest && e[0]!.verdict === 'passed' && e[0]!.verifierVersion === 'p4:' + plan.definitionDigest, 'history-evidence-invalid', 'Original required criterion delivery evidence differs');
  }
  validateSpecChange(null, p.spec, run.contract);
  const selection = selectInstances(p.spec, { mode: 'final' });
  ensure(plan.selection.mode === 'final' && plan.selection.completeScope && equal(plan.selection, selection), 'history-selection-invalid', 'Historical plan is not the exact complete final selection');
  const evaluated = evaluateVerification(p.spec, plan.selection, job.results);
  ensure(evaluated.complete && equal(evaluated, job.evaluation), 'history-selection-invalid', 'Historical results do not reproduce the recorded complete evaluation');
  ensure(review.controls.length === p.spec.controls.length && new Set(review.controls.map(c => c.id)).size === review.controls.length, 'history-evidence-invalid', 'Historical review controls are incomplete');
  for (const control of p.spec.controls) {
    const result = review.controls.find(c => c.id === control.id);
    ensure(result?.passed && (control.expect === 'passed' ? evaluateVerification(p.spec, selection, result.results).complete : result.results.length === selection.instances.length && result.results.every(r => r.executionStatus === 'executed') && control.mustFail.every(id => result.results.some(r => r.checks.some(c => c.obligationId === id && c.verdict === 'failed')))), 'history-evidence-invalid', 'Historical review control outcomes do not satisfy original control expectations');
  }
}
/** Confined, bounded file reader. Refuses symlinks at every component, not just the leaf. */
function reader(dataDir: string) {
  let total = 0, count = 0;
  return async (path: string, allowedRoot = dataDir): Promise<Buffer> => {
    ensure(isAbsolute(dataDir) && isAbsolute(path) && isAbsolute(allowedRoot), 'history-file-unsafe', 'Historical evidence needs absolute managed paths');
    const root = await realpath(dataDir), allowed = resolve(allowedRoot), absolute = resolve(path), inside = (a: string, b: string) => a === b || a.startsWith(b + sep);
    // dataDir may be reached through /tmp -> /private/tmp; normalize its real root once.
    const normalizedAllowed = join(root, relative(resolve(dataDir), allowed));
    const normalized = join(root, relative(resolve(dataDir), absolute));
    ensure(inside(allowed, resolve(dataDir)) && inside(absolute, allowed) && inside(normalized, normalizedAllowed), 'history-file-unsafe', 'Historical evidence escaped its managed root');
    const local = relative(root, normalized); let current = root;
    for (const part of local.split(sep)) { current = join(current, part); ensure(!(await lstat(current)).isSymbolicLink(), 'history-file-unsafe', 'Historical evidence contains a symlink'); }
    const info = await lstat(normalized);
    ensure(info.isFile(), 'history-file-unsafe', 'Historical evidence is not a regular file');
    total += info.size; count++;
    ensure(count <= 30_000 && total <= 512 * 1024 * 1024, 'history-capacity-exceeded', 'Complete historical proof inspection exceeds bounded capacity');
    const bytes = await readFile(normalized);
    ensure(bytes.length === info.size, 'history-file-changed', 'Historical evidence changed while reading');
    return bytes;
  };
}
async function files(s: DeliveryEvidenceSnapshot, options: DeliveryAssessmentOptions): Promise<void> {
  const read = reader(options.dataDir), { plan, proposal, review, verification: job, delivery, artifact } = s;
  // Check manifest paths before the existing frozen-only scanners follow them.
  for (const candidate of [plan.candidate, proposal.candidate, ...proposal.bundle.controls.map(c => c.candidate)]) {
    for (const name of Object.keys(candidate.files)) await read(join(candidate.tree, name));
    await assertCandidate(candidate, false);
  }
  for (const name of Object.keys(proposal.bundle.files)) await read(join(proposal.bundle.directory, name));
  await assertDefinition(proposal.spec, proposal.bundle, false);
  for (const j of [review, job]) {
    const root = join(options.dataDir, 'verification', j.id);
    ensure(Object.keys(j.proofs).length > 0, 'history-evidence-invalid', 'Historical verification proof manifest is empty');
    for (const [path, hash] of Object.entries(j.proofs)) ensure(digest(await read(path, root)) === hash, 'history-file-changed', 'Historical verification proof bytes changed: ' + path);
    for (const result of [...j.results, ...j.controls.flatMap(c => c.results)]) {
      ensure(result.proofFiles?.length && result.proofFiles.every(path => Object.hasOwn(j.proofs, path)), 'history-evidence-invalid', 'Actual result lacks exact proof manifest references');
    }
    const reportPath = join(root, 'report.json');
    ensure(Object.hasOwn(j.proofs, reportPath), 'history-evidence-invalid', 'Historical job report is not bound in its proof manifest');
    const report: unknown = JSON.parse((await read(reportPath, root)).toString('utf8'));
    ensure(equal(report, { results: j.results, controls: j.controls, evaluation: j.evaluation, error: j.error }), 'history-evidence-invalid', 'Historical job report differs from its stored result');
    for (const source of j.sources) {
      ensure(Object.hasOwn(j.proofs, source.path) && j.proofs[source.path] === source.digest && digest(await read(source.path, root)) === source.digest, 'history-file-changed', 'Historical source bytes differ from their actual job proof');
      const acquired = Date.parse(source.acquiredAt), delivered = Date.parse(delivery.createdAt);
      ensure(Number.isFinite(acquired) && Number.isSafeInteger(source.maxAgeMs) && source.maxAgeMs > 0 && acquired <= delivered && delivered - acquired <= source.maxAgeMs, 'history-evidence-invalid', 'Historical source acquisition or original delivery window is invalid');
    }
  }
  ensure(artifact, 'history-binding-invalid', 'Historical artifact is missing');
  const artifactBytes = await read(artifact.path);
  ensure(digest(artifactBytes) === artifact.digest && equal(JSON.parse(artifactBytes.toString('utf8')), plan.candidate), 'history-file-changed', 'Historical artifact snapshot differs from the frozen candidate manifest');
  ensure(resolve(delivery.path) === resolve(options.dataDir, 'verification', job.id, 'delivery.json'), 'history-file-unsafe', 'Delivery record file has a different managed location');
  ensure(equal(JSON.parse((await read(delivery.path)).toString('utf8')), delivery), 'history-file-changed', 'Historical delivery record file differs from SQLite');
}
function freshness(sources: SourceObservation[], checkedAt: string): DeliveryAssessment['sourceFreshness'] {
  if (!sources.length) return { state: 'not-applicable', earliestExpiresAt: null, remoteChecked: false };
  const now = Date.parse(checkedAt), times = sources.map(s => ({ acquired: Date.parse(s.acquiredAt), age: s.maxAgeMs }));
  if (!Number.isFinite(now) || times.some(s => !Number.isFinite(s.acquired) || !Number.isSafeInteger(s.age) || s.age <= 0 || now < s.acquired || !Number.isFinite(s.acquired + s.age) || s.acquired + s.age > 8.64e15)) return { state: 'unknown', earliestExpiresAt: null, remoteChecked: false };
  const expiry = Math.min(...times.map(s => s.acquired + s.age));
  return { state: now > expiry ? 'expired' : 'within-recorded-window', earliestExpiresAt: new Date(expiry).toISOString(), remoteChecked: false };
}
/** Read-only local audit. Never use this result instead of current()/deliver authorization. */
export async function assessDeliveryEvidence(snapshot: DeliveryEvidenceSnapshot, options: DeliveryAssessmentOptions): Promise<DeliveryAssessment> {
  const s = structuredClone(snapshot), result = base(s.delivery, options.checkedAt);
  result.issues.push(...structuredClone(s.scopeIssues));
  const add = (code: DeliveryIssueCode, area: DeliveryIssue['area'], message: string) => result.issues.push({ code, area, message });
  try {
    ensure(s.definitionFormat !== 'qualified-v2', 'history-format-unsupported', 'Qualified V2 history requires its immutable qualification receipt adapter');
    binding(s); await files(s, options); result.historicalEvidenceIntact = true;
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    const code = error instanceof InvalidEvidence ? error.code : errno === 'ENOENT' ? 'history-file-missing' : errno === 'EACCES' || errno === 'EPERM' ? 'history-unavailable' : /bounded.*capacity|exceeds.*capacity/i.test(String(error)) ? 'history-capacity-exceeded' : 'history-evidence-invalid';
    result.historicalEvidenceIntact = ['history-unavailable', 'history-capacity-exceeded', 'history-format-unsupported'].includes(code) ? null : false;
    add(code, 'history', String(error));
  }
  const { conversation: conversation, round } = s;
  if (conversation || round) {
    if (conversation && round && round.projectId === s.run.projectId && round.runId === s.run.id && round.conversationId === conversation.id && conversation.projectId === s.run.projectId && Number.isSafeInteger(round.ordinal) && round.ordinal > 0) {
      result.round = { conversationId: conversation.id, ordinal: round.ordinal, activeRunId: conversation.activeRunId };
      result.isActiveRound = conversation.activeRunId === s.run.id;
      if (!result.isActiveRound) add('historical-round', 'scope', 'This accepted delivery belongs to an earlier conversation round');
    } else add('scope-unresolved', 'scope', 'Conversation round identity is inconsistent');
  }
  if (!s.scopeIssues.length && s.head) { result.headMatches = s.head.proposalId === s.plan.proposalId; if (!result.headMatches) add('head-changed', 'scope', 'The current scoped verification catalog differs from this historical delivery'); }
  else add('scope-unresolved', 'scope', 'No unambiguous current scoped verification head is available');
  result.environmentMatches = options.currentEnvironmentDigest === null ? null : [s.plan.environmentDigest, s.review.environmentDigest, s.verification.environmentDigest].every(d => d === options.currentEnvironmentDigest);
  if (result.environmentMatches !== true) add(result.environmentMatches === null ? 'environment-unknown' : 'environment-changed', 'environment', 'Current verifier environment is ' + (result.environmentMatches === null ? 'unavailable' : 'different from the historical environment'));
  result.sourceFreshness = freshness([...s.review.sources, ...s.verification.sources], options.checkedAt);
  if (result.sourceFreshness.state === 'expired') add('sources-expired', 'sources', 'Stored source evidence is outside its recorded validity window; remote content was not fetched');
  if (result.sourceFreshness.state === 'unknown') add('sources-time-unknown', 'sources', 'Source timing cannot establish current freshness; remote content was not fetched');
  if (options.workspaceRead !== 'quiet') add(options.workspaceRead === 'busy' ? 'workspace-busy' : 'workspace-unknown', 'workspace', 'Live workspace was not scanned because writer state is ' + options.workspaceRead);
  else try {
    const first = await scanCandidate(s.plan.candidate.root), second = await scanCandidate(s.plan.candidate.root);
    if (!equal(first, second)) add('workspace-observation-changed', 'workspace', 'Live workspace changed between read-only scans');
    else { result.workspaceMatches = equal(first, s.plan.candidate.files) && digest(canonical(first)) === s.delivery.candidateDigest; if (!result.workspaceMatches) add('workspace-differs', 'workspace', 'Current files differ from the accepted frozen candidate'); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { result.workspaceMatches = false; add('workspace-missing', 'workspace', 'Accepted workspace or one of its observed files is missing'); }
    else add('workspace-unknown', 'workspace', String(error));
  }
  return result;
}
