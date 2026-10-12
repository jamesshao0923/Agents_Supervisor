import { captureQualificationCausalEvidence } from './qualification-causal-evidence.js';
import {decodeQualificationReviewPrompt} from './qualification-review-wire.js';
import type {MaintenanceReviewPayload} from '../contracts/p6-control-maintenance.js';
import {assertMaintenanceContext,assertRegressionContext} from './control-maintenance-replay.js';
import {assertMaintenanceReplay,maintenanceInstance,maintenanceDigest} from './control-maintenance-rules.js';
import {verificationDirectory,parseEnvironmentScope} from './scoped-environment.js';
import {assertFullstackJob} from './fullstack-proof.js';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Artifact, Run } from '../contracts/p1.js';
import type { RuntimeRecord } from '../contracts/p3.js';
import type { Conversation, ConversationRound } from '../contracts/p6.js';
import type { ControlQualificationEvidence, StoredControlDraft } from '../contracts/p4-qualification.js';
import { safeControlJSON } from '../contracts/p4-controls.js';
import { reconstructQualification } from './control-bootstrap.js';
import { specimenDiff } from './control-definition.js';
import { controlDigest, evaluateControlQualification } from './control-rules.js';
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
  /** Legacy records without an envelope remain V1; V2 is read through the actual immutable receipt repository. */
  definitionFormat?: 'legacy-v1' | 'qualified-v2';
}
/** Supply the actual read-only store.controlQualification repository. The assessor
 * loads by the historical IDs, never accepts a caller-provided validity boolean. */
export interface DeliveryQualificationReader {
  qualificationForReview(reviewId: string): ControlQualificationEvidence;
  draftForProposal(proposalId: string): StoredControlDraft;
  maintenanceForReview?(reviewId:string):MaintenanceReviewPayload|null;
}
export interface DeliveryAssessmentOptions {
  dataDir: string;
  checkedAt: string;
  workspaceRead: 'quiet' | 'busy' | 'unknown';
  currentEnvironmentDigest: string | null;
  qualificationReader?: DeliveryQualificationReader;
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
  for(const record of [p,plan,job,review])if(record.environmentScope)parseEnvironmentScope(record.environmentScope,{projectId:run.projectId,runId:run.id,workspace:runtime.workspace});
  ensure([p,plan,review].every(record=>equal(record.environmentScope??null,job.environmentScope??null)),'history-binding-invalid','Historical environment scopes differ');
  const bad = 'history-binding-invalid';
  ensure(d.projectId === run.projectId
      && d.runId === run.id
      && d.runtimeId === runtime.id
      && runtime.projectId === run.projectId
      && runtime.runId === run.id, bad, 'Delivery and original Run/runtime identity differ');
  for (const item of [plan, p, job, review]) ensure(item.projectId === d.projectId
      && item.runId === d.runId
      && item.runtimeId === d.runtimeId, bad, 'Historical verification chain crosses a Run or runtime');
  ensure(d.planId === plan.id
      && d.jobId === job.id
      && job.planId === plan.id
      && plan.proposalId === p.id
      && job.proposalId === p.id
      && review.proposalId === p.id
      && p.reviewId === review.id, bad, 'Delivery plan, verification or reviewed proposal binding differs');
  ensure(job.kind === 'verification'
      && review.kind === 'review'
      && review.planId === null
      && p.status === 'published'
      && p.version === plan.catalogVersion, bad, 'Historical verification kind or published catalog differs');
  ensure(runtime.workspace === plan.candidate.root && job.workspace === runtime.workspace && review.workspace === runtime.workspace, bad, 'Historical workspace identity differs');
  ensure(d.candidateDigest === plan.candidate.digest
      && d.definitionDigest === plan.definitionDigest
      && plan.definitionDigest === p.bundle.digest, bad, 'Delivery frozen candidate or definition digest differs');
  ensure(digest(canonical(run.contract)) === plan.contractDigest && plan.contractDigest === p.contractDigest, bad, 'Original contract differs from the reviewed frozen contract');
  ensure(plan.environmentDigest === job.environmentDigest
      && p.reviewEnvironmentDigest === review.environmentDigest
      && review.environmentDigest === plan.environmentDigest, bad, 'Historical review, plan and execution environments differ');
  ensure(run.status === 'succeeded' && run.nodes.filter(n => n.required).every(n => n.status === 'succeeded'), bad, 'Original Run has no completed delivery domain state');
  ensure(artifact
      && equal(artifact, run.artifact)
      && artifact.id === plan.id
      && artifact.contractVersion === run.contract.version, bad, 'Delivery artifact index or original Run artifact differs');
  ensure(run.attempts.every(a => a.status !== 'running'
      && a.settled)
      && run.operations.every(o => o.status === 'confirmed')
      && run.leases.every(l => l.released), 'history-accounting-invalid', 'Original Run has unsettled attempts, effects or leases');
  for (const j of [review, job]) {
    const a = run.attempts.find(a => a.id === j.attemptId);
    ensure(j.status === 'finished'
        && j.approved
        && !j.error
        && j.stopConfirmed
        && !j.usageUnknown
        && Number.isSafeInteger(j.usage)
        && j.usage >= 0
        && j.finishedAt
        && j.intents.length === j.identities.length, 'history-accounting-invalid', 'Historical job lacks completed approval, recorded stop or known usage');
    ensure(a?.purpose === 'verification'
        && a.status === 'succeeded'
        && a.settled
        && a.actual === j.usage
        && a.contractVersion === run.contract.version, 'history-accounting-invalid', 'Historical job actual usage does not match its settled attempt');
    const intentIds = j.intents.map(i => i.operationId), identityIds = j.identities.map(i => i.operationId);
    ensure(new Set(intentIds).size === intentIds.length
        && equal([...intentIds].sort(), [...identityIds].sort()), 'history-evidence-invalid', 'Historical process intents lack exact identity correspondence');
    for (const identity of j.identities) ensure(identity.version === 1
        && Number.isSafeInteger(identity.pid)
        && identity.pid > 0
        && Number.isSafeInteger(identity.pgid)
        && identity.pgid > 0
        && identity.startIdentity.length > 0
        && j.intents.some(intent => intent.operationId === identity.operationId
        && intent.ownerToken === identity.ownerToken), 'history-evidence-invalid', 'Historical process birth or owner binding is incomplete');
    const start = Date.parse(j.startedAt), finish = Date.parse(j.finishedAt), delivered = Date.parse(d.createdAt);
    ensure(Number.isFinite(start)
        && Number.isFinite(finish)
        && Number.isFinite(delivered)
        && start <= finish
        && finish <= delivered, bad, 'Historical job and delivery timestamps are inconsistent');
  }
  for (const criterion of run.contract.criteria.filter(c => c.required)) {
    const e = run.evidence.filter(e => e.id === d.id + ':' + criterion.id);
    ensure(e.length === 1
        && e[0]!.criterionId === criterion.id
        && e[0]!.contractVersion === run.contract.version
        && e[0]!.artifactDigest === artifact.digest
        && e[0]!.verdict === 'passed'
        && e[0]!.verifierVersion === 'p4:' + plan.definitionDigest, 'history-evidence-invalid', 'Original required criterion delivery evidence differs');
  }
  validateSpecChange(null, p.spec, run.contract);
  const selection = selectInstances(p.spec, { mode: 'final' });
  ensure(plan.selection.mode === 'final'
      && plan.selection.completeScope
      && equal(plan.selection, selection), 'history-selection-invalid', 'Historical plan is not the exact complete final selection');
  const evaluated = evaluateVerification(p.spec, plan.selection, job.results);
  ensure(evaluated.complete && equal(evaluated, job.evaluation), 'history-selection-invalid', 'Historical results do not reproduce the recorded complete evaluation');
  if (s.definitionFormat === 'qualified-v2') return;
  ensure(review.controls.length === p.spec.controls.length
      && new Set(review.controls.map(c => c.id)).size === review.controls.length, 'history-evidence-invalid', 'Historical review controls are incomplete');
  for (const control of p.spec.controls) {
    const result = review.controls.find(c => c.id === control.id);
    ensure(result?.passed
        && (control.expect === 'passed' ? evaluateVerification(p.spec, selection, result.results).complete : result.results.length === selection.instances.length
        && result.results.every(r => r.executionStatus === 'executed')
        && control.mustFail.every(id => result.results.some(r => r.checks.some(c => c.obligationId === id
        && c.verdict === 'failed')))), 'history-evidence-invalid', 'Historical review control outcomes do not satisfy original control expectations');
  }
}
interface QualifiedHistory { receipt: ControlQualificationEvidence; draft: StoredControlDraft; maintenance:MaintenanceReviewPayload|null }
function qualifiedHistory(s: DeliveryEvidenceSnapshot, options: DeliveryAssessmentOptions): QualifiedHistory {
    const provider = options.qualificationReader;
    ensure(provider, 'history-unavailable', 'Qualified V2 immutable qualification repository is unavailable');
    const receipt = provider.qualificationForReview(s.review.id), draft = provider.draftForProposal(s.proposal.id);
    safeControlJSON({ receipt, draft });
    const { digest: receiptDigest, ...receiptBody } = receipt;
    const { status: _status, version: _version, reviewId: _review, reviewEnvironmentDigest: _environment, ...proposalBody } = s.proposal;
    ensure(receipt.schemaVersion === 1
        && receipt.id === 'qualification:' + s.review.id
        && receipt.digest === controlDigest(receiptBody)
        && receipt.reviewJobId === s.review.id
        && receipt.proposalId === s.proposal.id, 'history-binding-invalid', 'Historical qualification receipt identity or digest differs');
    ensure(draft.schemaVersion === 1
        && draft.proposalId === s.proposal.id
        && draft.proposalDigest === controlDigest(proposalBody)
        && receipt.proposalDigest === draft.proposalDigest
        && receipt.controlDraftDigest === draft.draftDigest
        && draft.draftDigest === draft.draft.digest
        && s.proposal.controlDraftDigest === draft.draftDigest, 'history-binding-invalid', 'Historical qualification does not bind the exact immutable proposal and draft');
    ensure(receipt.environmentDigest === s.review.environmentDigest
        && equal(receipt.proofs, s.review.proofs)
        && draft.draft.base.target.projectId === s.run.projectId
        && draft.draft.base.target.runId === s.run.id
        && draft.draft.base.target.contractDigest === s.proposal.contractDigest, 'history-binding-invalid', 'Historical qualification differs from the original review or Run');
    ensure(equal(draft.draft.target.definition.spec, s.proposal.spec)
        && equal(draft.draft.target.bundle, s.proposal.bundle)
        && equal(draft.draft.target.definition.contract, s.run.contract), 'history-binding-invalid', 'Historical qualification target differs from the delivered standard');
    const reconstructed = reconstructQualification({ draft: draft.draft, evidence: receipt.bootstrap, reviewJob: s.review }, 'finished', s.run.budget.limit);
    ensure(equal(reconstructed, receipt.assembled), 'history-evidence-invalid', 'Historical qualification assembly differs from original persisted observations');
    const execution = receipt.execution, evaluation = evaluateControlQualification(reconstructed.matrix, execution.pairs);
    ensure(execution.stopConfirmed
        && execution.matrixDigest === reconstructed.matrix.digest
        && evaluation.qualified
        && equal(evaluation, execution.evaluation), 'history-evidence-invalid', 'Historical qualification pairs do not satisfy the complete frozen matrix');
    const maintenance = s.proposal.regressionDigest ? provider.maintenanceForReview?.(s.review.id) : null;
    if (s.proposal.regressionDigest) {
        ensure(maintenance, 'history-unavailable', 'Historical regression receipt is missing');
        const { context, plan, replay } = maintenance, basis = 'basis' in context ? context.basis : context;
        ensure(equal(Object.keys(maintenance.passingSourceText).sort(), Object.keys(basis.passingCandidate.files).sort()),
            'history-binding-invalid', 'Historical complete good source inventory differs');
        for (const [name, file] of Object.entries(maintenance.passingSourceText)) {
            ensure(Number.isInteger(file.executable)
                && (file.executable & 0o111) === file.executable
                && digest(Buffer.concat([Buffer.from(file.content), Buffer.from('\0executable:' + file.executable)])) === basis.passingCandidate.files[name],
                'history-binding-invalid', 'Historical complete good source bytes or mode differ');
        }
        ensure(maintenanceDigest(basis) === s.proposal.regressionDigest, 'history-binding-invalid', 'Historical regression context differs');
        if ('basis' in context)
            assertMaintenanceContext(context);
        else
            assertRegressionContext(context);
        const { digest: replayDigest, ...body } = replay;
        ensure(replayDigest === maintenanceDigest(body)
            && replay.reviewId === s.review.id
            && replay.proposalId === s.proposal.id
            && equal(replay.replays.map(r => r.defectRef).sort(), basis.sources.map(r => r.defectRef).sort())
            && equal(plan.regressions.map(m => m.defectRef).sort(), basis.sources.map(r => r.defectRef).sort()), 'history-binding-invalid', 'Historical regression inventory differs');
        for (const pair of replay.replays) {
            const source = basis.sources.find(source => source.defectRef === pair.defectRef)!;
            ensure(equal(pair.source, source)
                && equal(pair.passingCandidate, basis.passingCandidate)
                && equal(pair.instance, maintenanceInstance(s.proposal.spec, plan.regressions.find(m => m.defectRef === pair.defectRef)!, source)), 'history-binding-invalid', 'Historical regression binding differs');
            assertMaintenanceReplay(pair);
            for (const side of ['bad', 'good'] as const) {
                const actual = s.review.controls.filter(c => c.id === 'maintenance:' + pair.id + ':' + side);
                ensure(actual.length === 1
                    && actual[0]!.passed
                    && equal(actual[0]!.results, pair[side]), 'history-evidence-invalid', 'Historical regression differs from actual review observation');
            }
        }
    }
    const expectedIds = [...draft.draft.bootstrapPlan.map(p => 'bootstrap:' + p.id), ...reconstructed.matrix.rows.map(r => 'qualification:' + r.id), ...(maintenance?.replay.replays.flatMap(r => ['maintenance:' + r.id + ':bad', 'maintenance:' + r.id + ':good']) ?? [])].sort();
    ensure(equal(s.review.controls.map(c => c.id).sort(), expectedIds), 'history-evidence-invalid', 'Historical V2 review has missing, duplicate or unrelated bootstrap/qualification observations');
    for (const pair of execution.pairs) {
        const actual = s.review.controls.find(c => c.id === 'qualification:' + pair.rowId);
        ensure(actual?.passed && equal(actual.results, pair.results), 'history-evidence-invalid', 'Historical qualification pair differs from its actual stored review result');
    }
    for (const entry of reconstructed.rules.manifest.entries.filter(e => e.disposition === 'current')) {
        const specimen = reconstructed.specimens.find(s => equal(s.revision.ref, entry.specimen))!;
        if (specimen.revision.kind === 'positive-full') {
            const rows = reconstructed.matrix.rows.filter(r => r.role === 'current' && equal(r.specimen, entry.specimen));
            const results = rows.flatMap(r => execution.pairs.find(p => p.rowId === r.id)!.results);
            ensure(evaluateVerification(s.proposal.spec, selectInstances(s.proposal.spec, { mode: 'final' }), results).complete, 'history-evidence-invalid', 'Historical positive did not satisfy the full final standard');
        }
    }
    const model = receipt.independentReview;
    ensure(model.verdict === 'passed'
        && model.stopConfirmed
        && model.modelStarted
        && model.threadId
        && model.turnId
        && Number.isSafeInteger(model.usage)
        && model.usage! > 0
        && model.usage! <= s.review.usage
        && model.proofFiles.length > 0
        && model.proofFiles.every(p => receipt.proofs[p]), 'history-evidence-invalid', 'Historical qualification lacks its completed independent review');
    return structuredClone({ receipt, draft, maintenance: maintenance ?? null });
}
async function qualifiedFiles(history: QualifiedHistory, options: DeliveryAssessmentOptions, review:VerificationJob): Promise<void> {
  const read = reader(options.dataDir), { receipt } = history;
  for (const definition of receipt.assembled.definitions) {
    for (const name of Object.keys(definition.bundle.files)) await read(join(definition.bundle.directory, name));
    for (const control of definition.bundle.controls) { for (const name of Object.keys(control.candidate.files)) await read(join(control.candidate.tree, name)); await assertCandidate(control.candidate, false); }
    await assertDefinition(definition.definition.spec, definition.bundle, false);
  }
  for (const specimen of receipt.assembled.specimens) {
    for (const name of Object.keys(specimen.candidate.files)) await read(join(specimen.candidate.tree, name)); await assertCandidate(specimen.candidate, false);
    for (const witness of specimen.revision.witnesses) for (const [path, hash] of Object.entries(witness.proofs)) ensure(digest(await read(path)) === hash, 'history-file-changed', 'Historical negative witness proof bytes changed');
  }
  for (const proof of [receipt.bootstrap.proofs, receipt.execution.proofs]) for (const [path, hash] of Object.entries(proof)) ensure(receipt.proofs[path] === hash
      && digest(await read(path, verificationDirectory(options.dataDir,review))) === hash, 'history-file-changed', 'Historical qualification execution proof differs');
  const actualProofs = [...new Set(receipt.execution.pairs.flatMap(p => p.results.flatMap(r => r.proofFiles ?? [])))].sort();
  ensure(equal(Object.keys(receipt.execution.proofs).sort(), actualProofs), 'history-evidence-invalid', 'Historical qualification proof inventory differs from actual pair results');
  for(const replay of history.maintenance?.replay.replays??[])for(const candidate of [replay.source.candidate,replay.passingCandidate]){for(const name of Object.keys(candidate.files))await read(join(candidate.tree,name));await assertCandidate(candidate,false);}
  const model = receipt.independentReview, root = verificationDirectory(options.dataDir,review), resultPaths = model.proofFiles.filter(p => p.endsWith('/result.json'));
  ensure(resultPaths.length === 1, 'history-evidence-invalid', 'Historical independent review lacks a unique actual result');
  const modelRoot = resultPaths[0]!.slice(0, -'/result.json'.length), output = join(modelRoot, 'output.txt'), eventsPath = join(modelRoot, 'events.jsonl');
  ensure(equal(JSON.parse((await read(resultPaths[0]!, root)).toString()), model), 'history-evidence-invalid', 'Historical independent review differs from its raw persisted result');
  ensure(model.proofFiles.includes(output)
      && model.proofFiles.includes(eventsPath)
      && equal(JSON.parse((await read(output, root)).toString()), { verdict: model.verdict, reason: model.reason, observations: model.observations }), 'history-evidence-invalid', 'Historical review raw output differs');
  const events = (await read(eventsPath, root)).toString().trim().split('\n').map(line => JSON.parse(line) as { kind: string; value: any });
  const inputs = events.filter(e => e.kind === 'review-input');
  ensure(inputs.length === 1
      && typeof inputs[0]!.value.prompt === 'string'
      && digest(inputs[0]!.value.prompt) === receipt.reviewPromptDigest, 'history-evidence-invalid', 'Historical review prompt differs from its recorded digest');
  const prompt = inputs[0]!.value.prompt as string, newline = prompt.indexOf('\n'); ensure(newline > 0, 'history-evidence-invalid', 'Historical review context is absent');
  const {payload, presentation} = decodeQualificationReviewPrompt(prompt), implementationText: Record<string, Record<string, string>> = {}, specimenText: Record<string, Record<string, string>> = {};
  for (const definition of receipt.assembled.definitions) { const files: Record<string, string> = {}; for (const name of Object.keys(definition.bundle.files)) files[name] = new TextDecoder('utf-8', { fatal: true }).decode(await read(join(definition.bundle.directory, name))); implementationText[definition.definition.definitionDigest] = files; }
  for (const specimen of receipt.assembled.specimens) { const files: Record<string, string> = {}; for (const name of Object.keys(specimen.candidate.files)) files[name] = new TextDecoder('utf-8', { fatal: true }).decode(await read(join(specimen.candidate.tree, name))); specimenText[specimen.revision.ref.id + ':' + specimen.revision.ref.revision] = files; }
  const diffs = receipt.assembled.specimens.filter(s => s.revision.predecessor).map(s => { const before = receipt.assembled.specimens.find(p => equal(p.revision.ref, s.revision.predecessor)); ensure(before, 'history-binding-invalid', 'Historical review lacks an original specimen'); return { specimen: s.revision.ref, diff: specimenDiff(before, s) }; });
  ensure(equal(payload, { ...(presentation==='complete-v3'?{qualificationCausalEvidence:captureQualificationCausalEvidence({job:review,matrix:receipt.assembled.matrix,pairs:receipt.execution.pairs,executionProofs:receipt.execution.proofs,dataDir:options.dataDir})}:{}),rules: receipt.assembled.rules, matrix: receipt.assembled.matrix, pairs: receipt.execution.pairs, deterministicQualification: receipt.execution.evaluation, implementations: implementationText, specimenImplementations: specimenText, diffs,...(history.maintenance?{maintenance:history.maintenance}:{}) }), 'history-evidence-invalid', 'Historical model prompt did not contain the complete frozen qualification');
  ensure(events.some(e => e.kind === 'codex-event'
      && e.value?.method === 'turn/completed'
      && e.value?.raw?.params?.threadId === model.threadId
      && e.value.raw.params?.turn?.id === model.turnId
      && e.value.raw.params.turn.status === 'completed'), 'history-evidence-invalid', 'Historical independent review lacks its authoritative completed turn');

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
    ensure(inside(allowed, resolve(dataDir))
        && inside(absolute, allowed)
        && inside(normalized, normalizedAllowed), 'history-file-unsafe', 'Historical evidence escaped its managed root');
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
async function files(s: DeliveryEvidenceSnapshot, options: DeliveryAssessmentOptions, qualification:QualifiedHistory|null): Promise<void> {
  const read = reader(options.dataDir), { plan, proposal, review, verification: job, delivery, artifact } = s;
  // Check manifest paths before the existing frozen-only scanners follow them.
  for (const candidate of [plan.candidate, proposal.candidate, ...proposal.bundle.controls.map(c => c.candidate)]) {
    for (const name of Object.keys(candidate.files)) await read(join(candidate.tree, name));
    await assertCandidate(candidate, false);
  }
  for (const name of Object.keys(proposal.bundle.files)) await read(join(proposal.bundle.directory, name));
  await assertDefinition(proposal.spec, proposal.bundle, false);
  for (const j of [review, job]) {
    const root = verificationDirectory(options.dataDir,j);
    ensure(Object.keys(j.proofs).length > 0, 'history-evidence-invalid', 'Historical verification proof manifest is empty');
    for (const [path, hash] of Object.entries(j.proofs)) ensure(digest(await read(path, root)) === hash, 'history-file-changed', 'Historical verification proof bytes changed: ' + path);
    for (const result of [...j.results, ...j.controls.flatMap(c => c.results)]) {
      ensure(result.proofFiles?.length
          && result.proofFiles.every(path => Object.hasOwn(j.proofs, path)), 'history-evidence-invalid', 'Actual result lacks exact proof manifest references');
    }
    await assertFullstackJob(j,proposal.spec,(j.kind==='verification'?[plan.candidate]:[...proposal.bundle.controls.map(c=>c.candidate),...(qualification?.maintenance?.replay.replays.flatMap(r=>[r.source.candidate,r.passingCandidate])??[])]));
    const reportPath = join(root, 'report.json');
    ensure(Object.hasOwn(j.proofs, reportPath), 'history-evidence-invalid', 'Historical job report is not bound in its proof manifest');
    const report: unknown = JSON.parse((await read(reportPath, root)).toString('utf8'));
    ensure(equal(report, { results: j.results, controls: j.controls, evaluation: j.evaluation, error: j.error }), 'history-evidence-invalid', 'Historical job report differs from its stored result');
    for(const material of j.materials??[]){ensure(Object.hasOwn(j.proofs,material.proofPath)
        &&j.proofs[material.proofPath]===material.proofDigest,'history-evidence-invalid','Historical material evidence is not bound in job proofs');const raw=JSON.parse((await read(material.proofPath,root)).toString('utf8')) as {binding:unknown;context:{index:{acquiredAt:string;completeness:string;disposition:string};requirements:{maxSourceAgeMs:number}[]}};ensure(equal(raw.binding,material.binding)
        &&raw.context.index.acquiredAt===material.sourceAcquiredAt
        &&Math.min(...raw.context.requirements.map(r=>r.maxSourceAgeMs))===material.maxAgeMs
        &&equal(material.coverage,{completeness:raw.context.index.completeness,disposition:raw.context.index.disposition}),'history-evidence-invalid','Historical material provenance/timing/coverage differs from actual proof');const acquired=Date.parse(material.sourceAcquiredAt),delivered=Date.parse(delivery.createdAt);ensure(Number.isFinite(acquired)
        &&Number.isSafeInteger(material.maxAgeMs)
        &&material.maxAgeMs>0
        &&acquired<=delivered
        &&delivered-acquired<=material.maxAgeMs,'history-evidence-invalid','Historical material evidence was not current at delivery');}
    for (const source of j.sources) {
      ensure(Object.hasOwn(j.proofs, source.path)
          && j.proofs[source.path] === source.digest
          && digest(await read(source.path, root)) === source.digest, 'history-file-changed', 'Historical source bytes differ from their actual job proof');
      const acquired = Date.parse(source.acquiredAt), delivered = Date.parse(delivery.createdAt);
      ensure(Number.isFinite(acquired)
          && Number.isSafeInteger(source.maxAgeMs)
          && source.maxAgeMs > 0
          && acquired <= delivered
          && delivered - acquired <= source.maxAgeMs, 'history-evidence-invalid', 'Historical source acquisition or original delivery window is invalid');
    }
  }
  ensure(artifact, 'history-binding-invalid', 'Historical artifact is missing');
  const artifactBytes = await read(artifact.path);
  ensure(digest(artifactBytes) === artifact.digest
      && equal(JSON.parse(artifactBytes.toString('utf8')), plan.candidate), 'history-file-changed', 'Historical artifact snapshot differs from the frozen candidate manifest');
  ensure(resolve(delivery.path) === join(verificationDirectory(options.dataDir,job),'delivery.json'), 'history-file-unsafe', 'Delivery record file has a different managed location');
  ensure(equal(JSON.parse((await read(delivery.path)).toString('utf8')), delivery), 'history-file-changed', 'Historical delivery record file differs from SQLite');
}
function freshness(sources: Pick<SourceObservation,'acquiredAt'|'maxAgeMs'>[], checkedAt: string): DeliveryAssessment['sourceFreshness'] {
  if (!sources.length) return { state: 'not-applicable', earliestExpiresAt: null, remoteChecked: false };
  const now = Date.parse(checkedAt), times = sources.map(s => ({ acquired: Date.parse(s.acquiredAt), age: s.maxAgeMs }));
  if (!Number.isFinite(now)
      || times.some(s => !Number.isFinite(s.acquired)
      || !Number.isSafeInteger(s.age)
      || s.age <= 0
      || now < s.acquired
      || !Number.isFinite(s.acquired + s.age)
      || s.acquired + s.age > 8.64e15)) return { state: 'unknown', earliestExpiresAt: null, remoteChecked: false };
  const expiry = Math.min(...times.map(s => s.acquired + s.age));
  return { state: now > expiry ? 'expired' : 'within-recorded-window', earliestExpiresAt: new Date(expiry).toISOString(), remoteChecked: false };
}
/** Read-only local audit. Never use this result instead of current()/deliver authorization. */
export async function assessDeliveryEvidence(snapshot: DeliveryEvidenceSnapshot, options: DeliveryAssessmentOptions): Promise<DeliveryAssessment> {
  const s = structuredClone(snapshot), result = base(s.delivery, options.checkedAt);
  result.issues.push(...structuredClone(s.scopeIssues));
  const add = (code: DeliveryIssueCode, area: DeliveryIssue['area'], message: string) => result.issues.push({ code, area, message });
  try {
    binding(s);
    const qualification = s.definitionFormat === 'qualified-v2' ? qualifiedHistory(s, options) : null;
    await files(s, options, qualification);
    if (qualification) { await qualifiedFiles(qualification, options,s.review); ensure(equal(qualification, qualifiedHistory(s, options)), 'history-evidence-invalid', 'Immutable historical qualification changed during the read-only audit'); }
    result.historicalEvidenceIntact = true;
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    const code = error instanceof InvalidEvidence ? error.code : errno === 'ENOENT' ? 'history-file-missing' : errno === 'EACCES'
        || errno === 'EPERM' ? 'history-unavailable' : /bounded.*capacity|exceeds.*capacity/i.test(String(error)) ? 'history-capacity-exceeded' : 'history-evidence-invalid';
    result.historicalEvidenceIntact = ['history-unavailable', 'history-capacity-exceeded', 'history-format-unsupported'].includes(code) ? null : false;
    add(code, 'history', String(error));
  }
  const { conversation: conversation, round } = s;
  if (conversation || round) {
    if (conversation
        && round
        && round.projectId === s.run.projectId
        && round.runId === s.run.id
        && round.conversationId === conversation.id
        && conversation.projectId === s.run.projectId
        && Number.isSafeInteger(round.ordinal)
        && round.ordinal > 0) {
      result.round = { conversationId: conversation.id, ordinal: round.ordinal, activeRunId: conversation.activeRunId };
      result.isActiveRound = conversation.activeRunId === s.run.id;
      if (!result.isActiveRound) add('historical-round', 'scope', 'This accepted delivery belongs to an earlier conversation round');
    } else add('scope-unresolved', 'scope', 'Conversation round identity is inconsistent');
  }
  if (!s.scopeIssues.length
      && s.head) { result.headMatches = s.head.proposalId === s.plan.proposalId; if (!result.headMatches) add('head-changed', 'scope', 'The current scoped verification catalog differs from this historical delivery'); }
  else add('scope-unresolved', 'scope', 'No unambiguous current scoped verification head is available');
  result.environmentMatches = options.currentEnvironmentDigest === null ? null : [s.plan.environmentDigest, s.review.environmentDigest, s.verification.environmentDigest].every(d => d === options.currentEnvironmentDigest);
  if (result.environmentMatches !== true) add(result.environmentMatches === null ? 'environment-unknown' : 'environment-changed', 'environment', 'Current verifier environment is ' + (result.environmentMatches === null ? 'unavailable' : 'different from the historical environment'));
  result.sourceFreshness = freshness([...s.review.sources, ...s.verification.sources,...[...(s.review.materials??[]),...(s.verification.materials??[])].map(m=>({acquiredAt:m.sourceAcquiredAt,maxAgeMs:m.maxAgeMs}))], options.checkedAt);
  if (result.sourceFreshness.state === 'expired') add('sources-expired', 'sources', 'Stored source evidence is outside its recorded validity window; remote content was not fetched');
  if (result.sourceFreshness.state === 'unknown') add('sources-time-unknown', 'sources', 'Source timing cannot establish current freshness; remote content was not fetched');
  if (options.workspaceRead !== 'quiet') add(options.workspaceRead === 'busy' ? 'workspace-busy' : 'workspace-unknown', 'workspace', 'Live workspace was not scanned because writer state is ' + options.workspaceRead);
  else try {
    const first = await scanCandidate(s.plan.candidate.root), second = await scanCandidate(s.plan.candidate.root);
    if (!equal(first, second)) add('workspace-observation-changed', 'workspace', 'Live workspace changed between read-only scans');
    else { result.workspaceMatches = equal(first, s.plan.candidate.files)
        && digest(canonical(first)) === s.delivery.candidateDigest; if (!result.workspaceMatches) add('workspace-differs', 'workspace', 'Current files differ from the accepted frozen candidate'); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { result.workspaceMatches = false; add('workspace-missing', 'workspace', 'Accepted workspace or one of its observed files is missing'); }
    else add('workspace-unknown', 'workspace', String(error));
  }
  return result;
}
