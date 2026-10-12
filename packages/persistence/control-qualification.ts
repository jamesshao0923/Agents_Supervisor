import { captureQualificationCausalEvidence } from '../verification/qualification-causal-evidence.js';
import {decodeQualificationReviewPrompt} from '../verification/qualification-review-wire.js';
import {expandedAuthorInput} from '../orchestration/indexed-history-presentation.js';
import {assertIndexedAuthorArchive} from '../runtime/indexed-research-consumer.js';
import {SupervisionRepository} from './supervision.js';
import {authorWireReceipt,assertAuthorWireProof} from '../orchestration/author-presentation-proofs.js';
import {captureSourceRefreshControlContext,sourceRefreshReviewEvidence} from '../verification/source-refresh-controls.js';
import {ControlMaintenanceRepository} from './control-maintenance.js';
import {FrozenReader} from '../verification/frozen-reader.js';
import {persistedResearchWorkflow,researchQualificationReviewContext} from '../verification/research-mapping-proof.js';
import {materialProjectionReviewEvidence} from '../verification/material.js';
import {verificationDirectory} from '../verification/scoped-environment.js';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AcceptanceBundle } from '../orchestration/acceptance-authoring.js';
import type { Run, TaskContract } from '../contracts/p1.js';
import type { SupervisionJob } from '../contracts/p6-supervision.js';
import type { ControlBootstrapHistory, FrozenControlDraft, BootstrapEvidence, AssembledControlQualification } from '../contracts/p4-control-draft.js';
import type { ControlQualificationEvidence, ControlReviewStage, ControlReviewStageName, ControlReviewStagePayloads, StoredControlDraft } from '../contracts/p4-qualification.js';
import type { FailureWitness, SpecimenRevision } from '../contracts/p4-controls.js';
import { parseSpecimenRevision, safeControlJSON } from '../contracts/p4-controls.js';
import type { Candidate } from '../verification/candidate.js';
import { canonical, digest, exclusions } from '../verification/candidate.js';
import type { Proposal, VerificationJob, DefinitionBundle } from '../verification/records.js';
import { controlDigest, evaluateControlQualification } from '../verification/control-rules.js';
import { assertControlDraftStructure, reconstructQualification } from '../verification/control-bootstrap.js';
import { bindControlDefinition, specimenDiff, validateControlImplementationHistory } from '../verification/control-definition.js';
import { evaluateVerification, selectInstances } from '../verification/rules.js';
import { VerificationLineageRepository } from './verification-lineage.js';
import { runtimeCanonical } from './runtime.js';

export const CONTROL_QUALIFICATION_MIGRATION_SQL = `
CREATE TABLE verification_control_drafts(proposal_id TEXT PRIMARY KEY REFERENCES verification_proposal_bindings(proposal_id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE verification_control_stages(review_id TEXT NOT NULL,job_kind TEXT NOT NULL DEFAULT 'job' CHECK(job_kind='job'),proposal_id TEXT NOT NULL REFERENCES verification_control_drafts(proposal_id),stage TEXT NOT NULL CHECK(stage IN ('bootstrap','matrix-frozen','qualification','independent-review')),sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 4),record TEXT NOT NULL CHECK(json_valid(record)),PRIMARY KEY(review_id,stage),UNIQUE(review_id,sequence),FOREIGN KEY(job_kind,review_id) REFERENCES verification_records(kind,id));
CREATE TABLE verification_control_qualifications(review_id TEXT PRIMARY KEY,job_kind TEXT NOT NULL DEFAULT 'job' CHECK(job_kind='job'),proposal_id TEXT NOT NULL REFERENCES verification_control_drafts(proposal_id),record TEXT NOT NULL CHECK(json_valid(record)),FOREIGN KEY(job_kind,review_id) REFERENCES verification_records(kind,id));
CREATE TABLE verification_control_receipts(command_id TEXT PRIMARY KEY,request TEXT NOT NULL CHECK(json_valid(request)),result TEXT NOT NULL CHECK(json_valid(result)));
${['verification_control_drafts','verification_control_stages','verification_control_qualifications','verification_control_receipts'].map(table => `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Control qualification records are immutable');END;
CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Control qualification records are immutable');END;`).join('\n')}
`;
const stages: ControlReviewStageName[] = ['bootstrap', 'matrix-frozen', 'qualification', 'independent-review'];
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function text(value: string) { ensure(typeof value === 'string' && value.trim() && value.length <= 4096 && !value.includes('\0'), 'Invalid control persistence identifier'); }
function encoded(value: unknown): string { safeControlJSON(value); const result = canonical(value); ensure(Buffer.byteLength(result) <= 32 * 1024 * 1024, 'Complete control record exceeds capacity'); return result; }
export function controlQualificationDigest(value: Omit<ControlQualificationEvidence, 'digest'>): string { return controlDigest(value); }
/** Synchronous complete evidence checks participate in the publication transaction. */

/** Append-only sidecars; never changes Proposal, Run, model costs, or publication head. */
export class ControlQualificationRepository {
  constructor(private readonly db: DatabaseSync, private readonly dataDir?: string) {}
  sourceRefreshContext(base:import('../contracts/p4-lineage.js').ProposalBase,spec:import('../contracts/p4.js').VerificationSpec|import('../contracts/p4-material.js').MaterialVerifierBinding,history:ControlBootstrapHistory,actualProposalId?:string){if(!base.transitionIds.some(id=>new VerificationLineageRepository(this.db).transition(id).sourceRefresh))return null;const database=this.db.prepare('PRAGMA database_list').all().find(r=>r.name==='main');ensure(this.dataDir||database?.file,'Refresh authority requires real host data root');return captureSourceRefreshControlContext(this.db,this.dataDir??dirname(String(database!.file)),base,spec,history,actualProposalId);}
  transaction<T>(body: () => T): T { const own = !this.db.isTransaction; if (own) this.db.exec('BEGIN IMMEDIATE'); try { const result = body(); ensure(!result
      || typeof (result as { then?: unknown }).then !== 'function', 'Asynchronous control transaction prohibited'); if (own) this.db.exec('COMMIT'); return result; } catch (error) { if (own) this.db.exec('ROLLBACK'); throw error; } }
  private command<T>(commandId: string, request: unknown, body: () => T): T { return this.transaction(() => { text(commandId); const row = this.db.prepare('SELECT request,result FROM verification_control_receipts WHERE command_id=?').get(commandId); if (row) { ensure(row.request === encoded(request), 'Conflicting control qualification commandId'); return JSON.parse(String(row.result)) as T; } const result = body(); this.db.prepare('INSERT INTO verification_control_receipts(command_id,request,result) VALUES (?,?,?)').run(commandId, encoded(request), encoded(result)); return result; }); }
  private record<T>(kind: string, id: string): T { const row = this.db.prepare('SELECT record FROM verification_records WHERE kind=? AND id=?').get(kind, id); ensure(row, 'Missing actual control ' + kind); return JSON.parse(String(row.record)) as T; }
  private run(projectId: string, runId: string): Run { const row = this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(projectId, runId); ensure(row, 'Missing control Run'); return JSON.parse(String(row.snapshot)) as Run; }
  private binding(proposalId: string) { return new VerificationLineageRepository(this.db).bindingForProposal(proposalId); }
  private job(proposal: Proposal, reviewId: string, finished: boolean): VerificationJob {
    const job = this.record<VerificationJob>('job', reviewId), run = this.run(proposal.projectId, proposal.runId), attempt = run.attempts.find(a => a.id === job.attemptId);
    ensure(job.kind === 'review'
        && job.planId === null
        && job.proposalId === proposal.id
        && job.projectId === proposal.projectId
        && job.runId === proposal.runId
        && job.runtimeId === proposal.runtimeId
        && job.workspace === proposal.candidate.root, 'Control sidecar belongs to another review or proposal');
    ensure(Number.isSafeInteger(job.usage)
        && job.usage >= 0
        && job.usage <= job.config.reservation
        && !job.usageUnknown
        && attempt?.purpose === 'verification'
        && attempt.reservation === job.config.reservation, 'Control review accounting is unknown or outside reservation');
    if (finished) ensure(job.status === 'finished'
        && job.approved
        && !job.error
        && job.stopConfirmed
        && attempt.status === 'succeeded'
        && attempt.settled
        && attempt.actual === job.usage, 'Control qualification needs actual approved settled review');
    else ensure(job.status === 'running' && attempt.status === 'running' && !attempt.settled, 'Control stage needs its actual running review');
    return job;
  }
  private recordedStops(job: Pick<VerificationJob, 'intents' | 'identities' | 'proofs'>, requiredProofs?: string[]): void {
    const reader = new FrozenReader(this.dataDir), paths = requiredProofs ?? Object.keys(job.proofs);
    const processRecords = paths.filter(p => /(?:^|\/)(?:[^/]+\.)?process\.json$/.test(p)).map(p => ({ path: p, record: JSON.parse(reader.read(p).toString()) }));
    ensure(job.identities.length > 0
        && job.intents.length === job.identities.length
        && new Set(job.identities.map(i => i.operationId)).size === job.identities.length, 'Actual control process identity inventory is incomplete');
    for (const identity of job.identities) {
      const intent = job.intents.find(i => i.operationId === identity.operationId && i.ownerToken === identity.ownerToken); ensure(intent, 'Actual control process intent missing');
      const match = processRecords.find(({ record }) => same(record.identity, identity)); ensure(match, 'Actual control process stop proof is missing');
      const outcome = match.record.result ?? match.record;
      ensure(outcome.stopped === true
          && (outcome.stop?.status === 'stopped'
          || outcome.status === 'stopped')
          && (outcome.stop?.members ?? outcome.members)?.length === 0, 'Actual control process stop is unresolved');
      if (match.record.result) ensure(same(match.record.intent, intent), 'Actual model stop proof belongs to another intent');
      else { const dir = dirname(match.path), intentPath = join(dir, 'intent.json'), identityPath = join(dir, 'identity.json'); ensure(job.proofs[intentPath]
          && job.proofs[identityPath]
          && same(JSON.parse(reader.read(intentPath).toString()), intent)
          && same(JSON.parse(reader.read(identityPath).toString()), identity), 'Actual command ownership proof differs'); }
    }
  }
  private author(draft: FrozenControlDraft): SupervisionJob {
    const row = this.db.prepare('SELECT record FROM supervision_jobs WHERE id=?').get(draft.authorBinding.jobId); ensure(row, 'Control draft lacks actual author job'); const job = JSON.parse(String(row.record)) as SupervisionJob;
    // Parse the persisted version even when its value is falsy or malformed.
    const wireReceipt = authorWireReceipt(job);
    const run = this.run(job.projectId, job.runId), attempt = run.attempts.find(a => a.id === job.attemptId);
    ensure(job.purpose === 'acceptance-authoring'
        && job.projectId === draft.base.target.projectId
        && job.runId === draft.base.target.runId
        && job.contractDigest === draft.base.target.contractDigest
        && job.status === 'finished'
        && job.modelStarted
        && job.threadId
        && job.stopConfirmed
        && !job.error
        && Number.isSafeInteger(job.usage)
        && job.usage! > 0
        && job.usage! <= job.config.reservation
        && attempt?.purpose === 'reasoning'
        && attempt.status === 'succeeded'
        && attempt.reservation === job.config.reservation
        && attempt.settled
        && attempt.actual === job.usage, 'Control author is not the actual settled model author');
    ensure(job.inputDigest === draft.authorBinding.inputDigest && controlDigest(job.result) === draft.authorBinding.resultDigest, 'Control author input or result digest differs');
    const input = expandedAuthorInput(job.input) as { context?: { acceptance?: unknown; evolution?: { current?: unknown; base?: unknown; history?: unknown; transitions?: unknown } } }, result = job.result as { plan?: unknown; assets?: AcceptanceBundle };
    ensure(input.context?.evolution
        && same(input.context.evolution.current, input.context.acceptance)
        && same(input.context.evolution.base, draft.base)
        && same(input.context.evolution.history, draft.history)
        && same(input.context.evolution.transitions, draft.transitions)
        && same(result.plan, draft.authoredPlan), 'Draft differs from actual frozen author history or plan');
    ensure(digest(runtimeCanonical(job.input)) === job.inputDigest
        && digest(runtimeCanonical({ usage: job.usage, stopConfirmed: job.stopConfirmed, error: job.error, proofs: job.proofs, threadId: job.threadId, result: job.result })) === job.completionDigest, 'Author input or completion record changed');
    const reader = new FrozenReader(this.dataDir); reader.proofs(job.proofs); this.recordedStops(job);
    if (wireReceipt !== null) {
      const database = this.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main');
      ensure(this.dataDir || database?.file, 'Presented author requires its actual host data root');
      assertAuthorWireProof(job, join(this.dataDir ?? dirname(String(database!.file)), 'supervision-reasoning', digest(job.id)));
    }
    const authorRefresh=(input.context?.evolution as {sourceRefresh?:import('../contracts/p4-source-refresh.js').SourceRefreshControlContext})?.sourceRefresh;
    const indexedHistory=wireReceipt?.kind==='indexed-history-author-wire';
    ensure(indexedHistory||authorRefresh===undefined,'Historical view inventory requires explicit indexed-history presentation');
    if(indexedHistory)ensure((authorRefresh!==undefined)===(draft.sourceRefresh!==undefined)&&same(authorRefresh??null,draft.sourceRefresh??null),'Author frozen refresh inventory differs from actual draft');
    const indexedMaterials=(input.context?.acceptance as {materials?:{evidence?:{indexed?:unknown}}[]})?.materials;
    if(indexedMaterials?.some(m=>m.evidence?.indexed)){
      const database=this.db.prepare('PRAGMA database_list').all().find(row=>row.name==='main'),root=this.dataDir??dirname(String(database!.file));
      const bindingPath=join(root,'supervision-reasoning',digest(job.id),'indexed-reader','binding.json');
      ensure(job.proofs[bindingPath],'Actual indexed control author archive missing');
      assertIndexedAuthorArchive({supervision:new SupervisionRepository(this.db),verificationLineage:new VerificationLineageRepository(this.db)},job.id,bindingPath);
    }
    ensure((input.context?.acceptance as { previousSpec?: unknown })?.previousSpec === null, 'V2 author must use separate exact historical context');
    const assets = result.assets; ensure(assets && Array.isArray(assets.verifierFiles) && Array.isArray(assets.controls), 'Actual author assets missing');
    const symbolic = structuredClone(draft.target.definition.spec); for (const control of symbolic.controls) control.workspace = control.id;
    ensure(same(symbolic, assets.spec), 'Proposed standards differ from actual author output');
    ensure(new Set(assets.verifierFiles.map(f => f.path)).size === assets.verifierFiles.length
        && Object.keys(draft.target.bundle.files).every(name => assets.verifierFiles.some(f => f.path === name
        && digest(f.content) === draft.target.bundle.files[name]
        && reader.read(join(draft.target.bundle.directory, name)).equals(Buffer.from(f.content)))), 'Proposed verifier differs from actual authored bytes');
    ensure(assets.controls.length === draft.target.bundle.controls.length
        && new Set(assets.controls.map(c => c.id)).size === assets.controls.length, 'Author control inventory differs');
    for (const control of draft.target.bundle.controls) { const authored = assets.controls.find(c => c.id === control.id); ensure(authored
        && same(authored.files.map(f => f.path).sort(), Object.keys(control.candidate.files).sort()), 'Proposed control file inventory differs from author'); for (const file of authored.files) ensure(reader.read(join(control.candidate.tree, file.path)).equals(Buffer.from(file.content)), 'Proposed control differs from authored bytes'); }
    return job;
  }
  private checkDraft(record: StoredControlDraft, current = false): { proposal: Proposal; author: SupervisionJob } {
    const proposal = this.record<Proposal>('proposal', record.proposalId), binding = this.binding(record.proposalId), draft = record.draft;
    assertControlDraftStructure(draft);
    const { digest: stored, ...content } = draft;
    ensure(record.schemaVersion === 1
        && draft.schemaVersion === 1
        && draft.proposalId === proposal.id
        && record.draftDigest === draft.digest
        && controlDigest(content) === stored
        && record.proposalDigest === binding.proposalDigest
        && binding.definitionFormat === 'qualified-v2', 'Frozen control draft or proposal binding changed');
    ensure((proposal as Proposal & { controlDraftDigest?: string }).controlDraftDigest === draft.digest
        && same(binding.base, draft.base), 'Proposal does not freeze this exact control draft');
    ensure(same(proposal.spec, draft.target.definition.spec)
        && same(proposal.bundle, draft.target.bundle)
        && proposal.contractDigest === controlDigest(draft.target.definition.contract)
        && draft.target.definition.definitionDigest === proposal.bundle.digest, 'Control target differs from actual proposed definition');
    const lineage = new VerificationLineageRepository(this.db);
    if (current) ensure(same(lineage.captureBase(proposal.projectId, proposal.runId), draft.base), 'Control proposal base changed');
    ensure(same(draft.transitions, draft.base.transitionIds.map(id => lineage.transition(id))), 'Control draft transition is not actual applied authority');
    const history = draft.base.baseProposalId ? this.loadHistory(draft.base.baseProposalId) : { definitions: [], specimens: [], manifest: null, transitions: [] };
    ensure(same(history, draft.history), 'Control draft historical state differs from its exact published predecessor');
    ensure(same(this.sourceRefreshContext(draft.base,draft.target.definition.spec,history,proposal.id),draft.sourceRefresh??null),'Refresh control context differs from actual acquisition/history authority');
    const author = this.author(draft), reader = new FrozenReader(this.dataDir);
    reader.definition(proposal.spec, proposal.bundle); reader.candidate(proposal.candidate);
    ensure(draft.manifest.lineageId === draft.base.lineageId
        && draft.manifest.targetDefinitionDigest === draft.target.definition.definitionDigest
        && same(draft.manifest.transitionIds, draft.base.transitionIds), 'Control draft manifest binding differs');
    ensure(draft.descriptors.length === proposal.spec.controls.length
        && new Set(draft.descriptors.map(d => d.controlId)).size === draft.descriptors.length, 'Draft descriptors omit or duplicate current controls');
    for (const descriptor of draft.descriptors) {
      const actual = proposal.bundle.controls.find(c => c.id === descriptor.controlId), control = proposal.spec.controls.find(c => c.id === descriptor.controlId);
      ensure(actual
          && control
          && same(descriptor.candidate, actual.candidate)
          && descriptor.ref.candidateDigest === actual.candidate.digest
          && descriptor.introducedDefinitionDigest === proposal.bundle.digest
          && (descriptor.kind === 'positive-full' ? control.expect === 'passed' : control.expect === 'failed'), 'Descriptor does not bind actual frozen control bytes');
      ensure(same(descriptor.scope, proposal.spec.obligations.map(o => ({ obligationId: o.id, expectationDigest: controlDigest(o) }))), 'Draft descriptor scope is not the full current definition');
    }
    return { proposal, author };
  }
  insertDraft(input: { commandId: string; proposalId: string; draft: FrozenControlDraft }): StoredControlDraft {
    return this.command(input.commandId, { method: 'insert-draft', ...input }, () => {
      const binding = this.binding(input.proposalId), value: StoredControlDraft = { schemaVersion: 1, proposalId: input.proposalId, proposalDigest: binding.proposalDigest, draftDigest: input.draft.digest, draft: structuredClone(input.draft) };
      const checked = this.checkDraft(value, true); ensure(checked.proposal.status === 'proposed'
          && checked.proposal.version === null, 'Control draft must be frozen before publication');
      const old = this.db.prepare('SELECT record FROM verification_control_drafts WHERE proposal_id=?').get(input.proposalId);
      if (old) { ensure(old.record === encoded(value), 'Conflicting immutable control draft'); return JSON.parse(String(old.record)) as StoredControlDraft; }
      this.db.prepare('INSERT INTO verification_control_drafts(proposal_id,record) VALUES (?,?)').run(input.proposalId, encoded(value)); return value;
    });
  }
  draftForProposal(proposalId: string): StoredControlDraft {
    const row = this.db.prepare('SELECT record FROM verification_control_drafts WHERE proposal_id=?').get(proposalId); ensure(row, 'Missing immutable control draft'); const value = JSON.parse(String(row.record)) as StoredControlDraft; this.checkDraft(value); return value;
  }
  stagesForReview(reviewId: string): ControlReviewStage[] {
    return this.db.prepare('SELECT record FROM verification_control_stages WHERE review_id=? ORDER BY sequence').all(reviewId).map(row => { const stage = JSON.parse(String(row.record)) as ControlReviewStage; ensure(stage.payloadDigest === controlDigest(stage.payload), 'Control stage payload changed'); return stage; });
  }
  appendReviewStage<K extends ControlReviewStageName>(input: { commandId: string; reviewId: string; stage: K; payload: ControlReviewStagePayloads[K] }): ControlReviewStage {
    return this.command(input.commandId, { method: 'append-stage', ...input }, () => {
      ensure(stages.includes(input.stage), 'Unknown control review stage'); const actual = this.record<VerificationJob>('job', input.reviewId), draft = this.draftForProposal(actual.proposalId), proposal = this.record<Proposal>('proposal', actual.proposalId); this.job(proposal, actual.id, false);
      const previous = this.stagesForReview(actual.id), index = stages.indexOf(input.stage), existing = previous.find(s => s.stage === input.stage);
      if (existing) { ensure(same(existing.payload, input.payload), 'Conflicting immutable control stage'); return existing; }
      ensure(previous.length === index && previous.every((s, i) => s.stage === stages[i] && s.sequence === i + 1), 'Control review stage sequence gap');
      if (input.stage === 'bootstrap') ensure(same(input.payload, { draftDigest: draft.draftDigest }), 'Bootstrap stage draft differs');
      const value: ControlReviewStage = { reviewJobId: actual.id, proposalId: proposal.id, stage: input.stage, sequence: index + 1, payload: structuredClone(input.payload), payloadDigest: controlDigest(input.payload), createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO verification_control_stages(review_id,proposal_id,stage,sequence,record) VALUES (?,?,?,?,?)').run(actual.id, proposal.id, input.stage, value.sequence, encoded(value)); return value;
    });
  }
  assertMaintenanceDelivery(projectId: string, runId: string, contractDigest: string): void {
    new ControlMaintenanceRepository(this.db, this.dataDir).assertDelivery(projectId, runId, contractDigest);
}
  maintenanceCandidatesForReview(reviewId: string): import('../verification/candidate.js').Candidate[] {
    const repo = new ControlMaintenanceRepository(this.db, this.dataDir), stage = repo.replayForReview(reviewId);
    if (!stage)
        return [];
    repo.validateReplay(stage, false);
    return stage.replays.flatMap(pair => [pair.source.candidate, pair.passingCandidate]);
}
  maintenanceForReview(reviewId: string): import('../contracts/p6-control-maintenance.js').MaintenanceReviewPayload | null {
    const repo = new ControlMaintenanceRepository(this.db, this.dataDir), stage = repo.replayForReview(reviewId);
    if (!stage)
        return null;
    repo.validateReplay(stage, true);
    const job = this.record<VerificationJob>('job', reviewId), root = this.jobRoot(job), reader = new FrozenReader(this.dataDir);
    const eventsPath = join(root, 'definition-review', 'events.jsonl');
    ensure(Object.hasOwn(job.proofs, eventsPath), 'Maintenance review lacks frozen input proof');
    const bytes = reader.read(eventsPath, root);
    ensure(digest(bytes) === job.proofs[eventsPath], 'Maintenance review input proof changed');
    const inputs = bytes.toString().trim().split('\n').map(line => JSON.parse(line)).filter(e => e.kind === 'review-input');
    ensure(inputs.length === 1 && typeof inputs[0].value?.prompt === 'string', 'Maintenance review lacks unique input');
    const decoded = decodeQualificationReviewPrompt(inputs[0].value.prompt);
    return repo.reviewPayload(stage.proposalId, reviewId, decoded.presentation === 'complete-v3' ? 'causal-v2' : decoded.compact ? 'causal-v1' : undefined) as import('../contracts/p6-control-maintenance.js').MaintenanceReviewPayload;
}
  private jobRoot(job: VerificationJob): string {
    if (this.dataDir) return verificationDirectory(this.dataDir,job);
    const reports = Object.keys(job.proofs).filter(p => basename(p) === 'report.json'
        && basename(dirname(p)) === job.id); ensure(reports.length === 1, 'Cannot resolve exact actual verification job root'); return dirname(reports[0]!);
  }
  private verifyModel(job: VerificationJob, evidence: ControlQualificationEvidence, author: SupervisionJob): void {
    const model = evidence.independentReview, reader = new FrozenReader(this.dataDir), root = this.jobRoot(job);
    ensure(model.verdict === 'passed'
        && model.reason.trim()
        && model.modelStarted
        && model.stopConfirmed
        && Number.isSafeInteger(model.usage)
        && model.usage! > 0
        && model.usage! <= job.usage
        && model.threadId
        && model.turnId
        && model.threadId !== author.threadId, 'Qualification lacks a fresh independent actual model result');
    ensure(model.proofFiles.length > 0 && model.proofFiles.every(path => Object.hasOwn(job.proofs, path)), 'Independent review proofs differ from actual job');
    const resultPaths = model.proofFiles.filter(p => basename(p) === 'result.json'); ensure(resultPaths.length === 1, 'Independent review has no unique raw result');
    const modelRoot = dirname(resultPaths[0]!);
    const processPaths = model.proofFiles.filter(p => p.endsWith('.process.json')); ensure(processPaths.length > 0, 'Independent model lacks actual process proofs');
    const ids = processPaths.map(p => JSON.parse(reader.read(p, root).toString()).identity); ensure(ids.every(id => job.identities.some(actual => same(actual, id))), 'Independent model process is absent from actual job');
    this.recordedStops({ intents: job.intents.filter(i => ids.some(id => id.operationId === i.operationId)), identities: ids, proofs: job.proofs }, model.proofFiles);
    ensure(same(JSON.parse(reader.read(resultPaths[0]!, root).toString()), model), 'Independent review differs from its actual raw result');
    const outputPath = join(modelRoot, 'output.txt'), eventsPath = join(modelRoot, 'events.jsonl');
    ensure(model.proofFiles.includes(outputPath) && model.proofFiles.includes(eventsPath), 'Independent review lacks raw output and event proof');
    ensure(same(JSON.parse(reader.read(outputPath, root).toString()), { verdict: model.verdict, reason: model.reason, observations: model.observations }), 'Independent verdict differs from its raw structured output');
    const events = reader.read(eventsPath, root).toString().trim().split('\n').map(line => JSON.parse(line) as { kind: string; value: any });
    const inputs = events.filter(e => e.kind === 'review-input'); ensure(inputs.length === 1
        && typeof inputs[0]!.value.prompt === 'string'
        && digest(inputs[0]!.value.prompt) === evidence.reviewPromptDigest, 'Independent model prompt differs from frozen review context');
    const prompt = inputs[0]!.value.prompt as string, newline = prompt.indexOf('\n'); ensure(newline > 0, 'Independent review lacks complete qualification context');
    const {payload, compact, presentation} = decodeQualificationReviewPrompt(prompt), assembled = evidence.assembled;
    const implementations: Record<string, Record<string, string>> = {}, specimenImplementations: Record<string, Record<string, string>> = {};
    for (const definition of assembled.definitions) implementations[definition.definition.definitionDigest] = Object.fromEntries(Object.keys(definition.bundle.files).map(name => [name, new TextDecoder('utf-8', { fatal: true }).decode(reader.read(join(definition.bundle.directory, name)))]));
    for (const specimen of assembled.specimens) specimenImplementations[specimen.revision.ref.id + ':' + specimen.revision.ref.revision] = Object.fromEntries(Object.keys(specimen.candidate.files).map(name => [name, new TextDecoder('utf-8', { fatal: true }).decode(reader.read(join(specimen.candidate.tree, name)))]));
    const diffs = assembled.specimens.filter(s => s.revision.predecessor).map(s => { const before = assembled.specimens.find(p => same(p.revision.ref, s.revision.predecessor)); ensure(before, 'Review specimen predecessor missing'); return { specimen: s.revision.ref, diff: specimenDiff(before, s) }; });
    const proposal=this.record<Proposal>('proposal',evidence.proposalId);
    const native=persistedResearchWorkflow(this.db,proposal.id);
    const researchWorkflow=native?researchQualificationReviewContext(this.db,proposal,this.run(proposal.projectId,proposal.runId).contract):undefined;
    const sourceRefreshEvidence=sourceRefreshReviewEvidence({matrix:assembled.matrix,pairs:evidence.execution.pairs,observations:job.materials??[]});
    const materialProjections=materialProjectionReviewEvidence(evidence.execution.pairs,job.materials??[],assembled);
    ensure(same(payload, { ...(presentation==='complete-v3'?{qualificationCausalEvidence:captureQualificationCausalEvidence({job,matrix:assembled.matrix,pairs:evidence.execution.pairs,executionProofs:evidence.execution.proofs,dataDir:this.dataDir??dirname(String(this.db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file??''))})}:{}),...(sourceRefreshEvidence?{sourceRefreshEvidence}:{}),...(researchWorkflow?{researchWorkflow}:{}),...(materialProjections.length?{materialProjections}:{}),rules: assembled.rules, matrix: assembled.matrix, pairs: evidence.execution.pairs, deterministicQualification: evaluateControlQualification(assembled.matrix, evidence.execution.pairs), implementations, specimenImplementations, diffs, ...(()=>{const value=new ControlMaintenanceRepository(this.db,this.dataDir).reviewPayload(job.proposalId,job.id,presentation==='complete-v3'?'causal-v2':compact?'causal-v1':undefined);return value?{maintenance:value}:{};})() }), 'Independent model did not review the complete actual qualification context');
    const completed = events.filter(e => e.kind === 'codex-event' && e.value?.method === 'turn/completed').map(e => e.value.raw?.params);
    ensure(completed.some(p => p?.threadId === model.threadId
        && p?.turn?.id === model.turnId
        && p?.turn?.status === 'completed'), 'Independent review lacks its actual authoritative completed turn');
  }
  private validateQualification(evidence: ControlQualificationEvidence, published = false): void {
    const { digest: stored, ...content } = evidence;
    ensure(evidence.schemaVersion === 1
        && evidence.id === 'qualification:' + evidence.reviewJobId
        && stored === controlQualificationDigest(content), 'Qualification evidence digest changed');
    const draftRow = this.db.prepare('SELECT record FROM verification_control_drafts WHERE proposal_id=?').get(evidence.proposalId); ensure(draftRow, 'Missing immutable control draft');
    const record = JSON.parse(String(draftRow.record)) as StoredControlDraft, { proposal, author } = this.checkDraft(record), job = this.job(proposal, evidence.reviewJobId, true);
    ensure(evidence.proposalDigest === record.proposalDigest
        && evidence.controlDraftDigest === record.draftDigest
        && evidence.environmentDigest === job.environmentDigest
        && same(evidence.proofs, job.proofs), 'Qualification sidecar differs from actual proposal or review');
    if (published) ensure(proposal.status === 'published'
        && proposal.reviewId === job.id
        && proposal.reviewEnvironmentDigest === job.environmentDigest, 'History is not the exact published qualification review');
    const reader = new FrozenReader(this.dataDir); reader.proofs(job.proofs, this.jobRoot(job));
    ensure(job.modelStarted
        && job.intents.length > 0
        && job.intents.length === job.identities.length
        && job.identities.every(identity => job.intents.some(intent => intent.operationId === identity.operationId
        && intent.ownerToken === identity.ownerToken)), 'Qualified model review lacks complete actual process ownership');
    const expected = reconstructQualification({ draft: record.draft, evidence: evidence.bootstrap, reviewJob: job }, 'finished');
    ensure(same(expected, evidence.assembled), 'Qualification assembly differs from exact actual bootstrap results');
    validateControlImplementationHistory(expected.definitions);
    for (const d of expected.definitions) reader.definition(d.definition.spec, d.bundle);
    for (const s of expected.specimens) { reader.candidate(s.candidate); for (const witness of s.revision.witnesses) reader.proofs(witness.proofs); }
    const execution = evidence.execution, evaluation = evaluateControlQualification(expected.matrix, execution.pairs);
    ensure(execution.matrixDigest === expected.matrix.digest
        && execution.stopConfirmed
        && evaluation.qualified
        && same(evaluation, execution.evaluation), 'Actual qualification does not satisfy every frozen detector pair');
    reader.proofs(execution.proofs, this.jobRoot(job));
    for (const pair of execution.pairs) {
      const rows = job.controls.filter(c => c.id === 'qualification:' + pair.rowId);
      ensure(rows.length === 1 && rows[0]!.passed && same(rows[0]!.results, pair.results), 'Qualification pair differs from the actual persisted job control');
      for (const result of pair.results) ensure(result.proofFiles?.length
          && result.proofFiles.every(path => job.proofs[path]
          && job.proofs[path] === execution.proofs[path]), 'Qualification pair lacks actual job proof binding');
    }
    const proofUnion = [...new Set(execution.pairs.flatMap(p => p.results.flatMap(r => r.proofFiles ?? [])))].sort();
    ensure(same(Object.keys(execution.proofs).sort(), proofUnion), 'Qualification proof inventory differs from actual pair reports');
    for (const entry of expected.rules.manifest.entries.filter(e => e.disposition === 'current')) {
      const specimen = expected.specimens.find(s => same(s.revision.ref, entry.specimen))!;
      if (specimen.revision.kind === 'positive-full') { const rows = expected.matrix.rows.filter(r => r.role === 'current'
          && same(r.specimen, entry.specimen)); const results = rows.flatMap(row => execution.pairs.find(p => p.rowId === row.id)!.results); ensure(evaluateVerification(expected.rules.target.spec, selectInstances(expected.rules.target.spec, { mode: 'final' }), results).complete, 'New complete positive lacks full final qualification'); }
    }
    const report = join(this.jobRoot(job), 'report.json'); ensure(Object.hasOwn(job.proofs, report)
        && same(JSON.parse(reader.read(report).toString()), { results: job.results, controls: job.controls, evaluation: job.evaluation, error: job.error }), 'Actual finished job report differs from persisted qualification results');
    sourceRefreshReviewEvidence({matrix:expected.matrix,pairs:execution.pairs,observations:job.materials??[]});
    for(const observation of job.materials??[])if(observation.historical)ensure(execution.pairs.some(pair=>pair.results.some(r=>r.proofFiles?.includes(observation.proofPath))),'Historical observation cannot exempt bootstrap or untracked material evidence');
    this.recordedStops(job); this.verifyModel(job, evidence, author);
    const persisted = this.stagesForReview(job.id), payloads: ControlReviewStagePayloads[ControlReviewStageName][] = [{ draftDigest: record.draftDigest }, { bootstrap: evidence.bootstrap, assembled: evidence.assembled }, { execution }, { review: evidence.independentReview, promptDigest: evidence.reviewPromptDigest }];
    ensure(persisted.length === 4
        && persisted.every((stage, index) => stage.stage === stages[index]
        && stage.sequence === index + 1
        && stage.proposalId === proposal.id
        && same(stage.payload, payloads[index])), 'Final qualification differs from immutable review stages');
  }
  recordQualification(input: { commandId: string; reviewId: string; evidence: ControlQualificationEvidence }): ControlQualificationEvidence {
    return this.command(input.commandId, { method: 'record-qualification', ...input }, () => {
      ensure(input.reviewId === input.evidence.reviewJobId, 'Qualification review identity differs'); this.validateQualification(input.evidence);
      const old = this.db.prepare('SELECT record FROM verification_control_qualifications WHERE review_id=?').get(input.reviewId);
      if (old) { ensure(old.record === encoded(input.evidence), 'Conflicting immutable qualification'); return JSON.parse(String(old.record)) as ControlQualificationEvidence; }
      this.db.prepare('INSERT INTO verification_control_qualifications(review_id,proposal_id,record) VALUES (?,?,?)').run(input.reviewId, input.evidence.proposalId, encoded(input.evidence)); return structuredClone(input.evidence);
    });
  }
  qualificationForReview(reviewId: string): ControlQualificationEvidence {
    const row = this.db.prepare('SELECT record FROM verification_control_qualifications WHERE review_id=?').get(reviewId); ensure(row, 'Review lacks finalized immutable qualification evidence'); const value = JSON.parse(String(row.record)) as ControlQualificationEvidence; this.validateQualification(value); return value;
  }
  assertPublicationBinding(input: { proposalId: string; reviewId: string }): ControlQualificationEvidence {
    const evidence = this.qualificationForReview(input.reviewId); ensure(evidence.proposalId === input.proposalId, 'Publication qualification belongs to another proposal'); return evidence;
  }
  private readonly readingHistory = new Set<string>();
  /** Loads only the exact published review; unresolved legacy provenance blocks. */
  loadHistory(proposalId: string): ControlBootstrapHistory {
    ensure(!this.readingHistory.has(proposalId) && this.readingHistory.size < 128, 'Control ancestry is cyclic or exceeds complete capacity');
    this.readingHistory.add(proposalId);
    try {
      const proposal = this.record<Proposal>('proposal', proposalId), binding = this.binding(proposalId);
      ensure(proposal.status === 'published' && proposal.reviewId && proposal.reviewEnvironmentDigest, 'Control history requires an exact published reviewed proposal');
      const lineage = new VerificationLineageRepository(this.db);
      if (binding.definitionFormat === 'qualified-v2') {
        const evidence = this.qualificationForReview(proposal.reviewId); ensure(evidence.proposalId === proposal.id
            && evidence.environmentDigest === proposal.reviewEnvironmentDigest, 'History differs from exact published review');
        const stored = this.db.prepare('SELECT record FROM verification_control_drafts WHERE proposal_id=?').get(proposalId)!;
        const draft = (JSON.parse(String(stored.record)) as StoredControlDraft).draft;
        const transitions = [...new Map([...draft.history.transitions, ...draft.transitions].map(t => [t.id, lineage.transition(t.id)])).values()];
        return structuredClone({ definitions: evidence.assembled.definitions, specimens: evidence.assembled.specimens, manifest: evidence.assembled.rules.manifest, transitions });
      }
      const job = this.job(proposal, proposal.reviewId, true), reader = new FrozenReader(this.dataDir), root = this.jobRoot(job);
      ensure(job.environmentDigest === proposal.reviewEnvironmentDigest
          && job.modelStarted
          && job.usage > 0
          && job.intents.length > 0
          && job.intents.length === job.identities.length
          && job.identities.every(i => job.intents.some(n => n.operationId === i.operationId
          && n.ownerToken === i.ownerToken)), 'Legacy control review lacks original known model execution');
      reader.proofs(job.proofs, root); this.recordedStops(job); reader.definition(proposal.spec, proposal.bundle);
      const report = join(root, 'report.json'); ensure(job.proofs[report]
          && same(JSON.parse(reader.read(report).toString()), { results: job.results, controls: job.controls, evaluation: job.evaluation, error: job.error }), 'Legacy actual report differs from stored control observations');
      const modelPath = join(root, 'definition-review', 'result.json');
      ensure(job.proofs[modelPath], 'Legacy definition review lacks its actual model result');
      const model = JSON.parse(reader.read(modelPath).toString()) as ControlQualificationEvidence['independentReview'];
      ensure(model.verdict === 'passed'
          && model.stopConfirmed
          && model.modelStarted
          && model.threadId
          && model.turnId
          && Number.isSafeInteger(model.usage)
          && model.usage! > 0
          && model.usage! <= job.usage
          && model.proofFiles.length > 0
          && model.proofFiles.every(p => job.proofs[p]), 'Legacy model result is incomplete or unbound');
      const output = join(dirname(modelPath), 'output.txt'), eventsPath = join(dirname(modelPath), 'events.jsonl');
      ensure(model.proofFiles.includes(output)
          && model.proofFiles.includes(eventsPath)
          && same(JSON.parse(reader.read(output).toString()), { verdict: model.verdict, reason: model.reason, observations: model.observations }), 'Legacy review raw structured output differs');
      const events = reader.read(eventsPath).toString().trim().split('\n').map(l => JSON.parse(l));
      ensure(events.some(e => e.kind === 'codex-event'
          && e.value?.threadId === model.threadId
          && e.value?.turnId === model.turnId
          && e.value?.method === 'turn/completed'
          && e.value.raw.params?.turn?.status === 'completed'), 'Legacy review lacks actual completed turn proof');
      let contract: TaskContract | null = null;
      const run = this.run(proposal.projectId, proposal.runId); if (controlDigest(run.contract) === proposal.contractDigest) contract = run.contract;
      for (const row of this.db.prepare('SELECT id FROM verification_contract_transitions WHERE lineage_id=?').all(binding.base.lineageId)) {
        const transition = lineage.transition(String(row.id));
        for (const [ref, candidate] of [[transition.from, transition.fromContract], [transition.to, transition.toContract]] as const) if (ref.projectId === proposal.projectId
            && ref.runId === proposal.runId
            && ref.contractDigest === proposal.contractDigest) { ensure(contract === null
            || same(contract, candidate), 'Ambiguous legacy contract'); contract = candidate; }
      }
      ensure(contract, 'Legacy exact historical contract is unavailable; migration cannot infer it');
      const prior = binding.base.baseProposalId ? this.loadHistory(binding.base.baseProposalId) : { definitions: [], specimens: [], manifest: null, transitions: [] };
      ensure(prior.manifest === null || prior.manifest.targetDefinitionDigest === binding.base.baseDefinitionDigest, 'Legacy history base differs');
      const definition = { spec: proposal.spec, contract, definitionDigest: proposal.bundle.digest }, selection = selectInstances(proposal.spec, { mode: 'final' });
      ensure(job.controls.length === proposal.spec.controls.length
          && new Set(job.controls.map(c => c.id)).size === job.controls.length, 'Legacy actual control inventory is incomplete');
      const specimens = structuredClone(prior.specimens), entries = structuredClone(prior.manifest?.entries ?? []);
      for (const control of proposal.spec.controls) {
        const observed = job.controls.find(c => c.id === control.id), candidate = proposal.bundle.controls.find(c => c.id === control.id)?.candidate;
        ensure(observed?.passed
            && candidate
            && observed.results.length === selection.instances.length
            && new Set(observed.results.map(r => r.instanceId)).size === selection.instances.length, 'Legacy actual control has incomplete detector results');
        for (const result of observed.results) {
          const instance = selection.instances.find(i => i.id === result.instanceId); ensure(instance
              && result.executionStatus === 'executed'
              && result.proofFiles?.length
              && result.proofFiles.every(p => job.proofs[p]
              && p.startsWith(join(root, 'control-' + digest(control.id), instance.id) + sep)), 'Legacy witness lacks exact executed instance proof');
          ensure(result.checks.length === instance.obligationIds.length
              && new Set(result.checks.map(c => c.obligationId)).size === result.checks.length
              && result.checks.every(c => instance.obligationIds.includes(c.obligationId)), 'Legacy result check scope differs from original detector');
        }
        if (control.expect === 'passed') ensure(evaluateVerification(proposal.spec, selection, observed.results).complete, 'Legacy positive did not pass the full final selection');
        else ensure(control.mustFail.every(id => observed.results.some(r => r.checks.some(c => c.obligationId === id
            && c.verdict === 'failed'))), 'Legacy negative lacks actual required fault detection');
        const oldEntry = entries.find(e => e.disposition === 'current'
            && prior.specimens.find(s => same(s.revision.ref, e.specimen))?.revision.controlId === control.id), old = oldEntry ? prior.specimens.find(s => same(s.revision.ref, oldEntry.specimen))! : null;
        const kind = control.expect === 'passed' ? 'positive-full' as const : 'negative' as const;
        ensure(!old || old.revision.kind === kind && old.candidate.digest === candidate.digest, 'Legacy control evolved without explicit qualified provenance');
        const scope = proposal.spec.obligations.map(o => ({ obligationId: o.id, expectationDigest: controlDigest(o) }));
        ensure(!old || old.revision.scope.every(s => scope.some(n => same(s, n))), 'Legacy control drops historical scope without applied retirement');
        const ref = { id: old?.revision.ref.id ?? 'legacy-specimen-' + controlDigest({ lineageId: binding.base.lineageId, proposalId, controlId: control.id }), revision: (old?.revision.ref.revision ?? 0) + 1, candidateDigest: candidate.digest };
        const witnesses: FailureWitness[] = structuredClone(old?.revision.witnesses ?? []);
        if (kind === 'negative') for (const result of observed.results) for (const check of result.checks.filter(c => c.verdict === 'failed')) {
          const obligation = proposal.spec.obligations.find(o => o.id === check.obligationId)!;
          witnesses.push({ id: 'legacy-witness-' + controlDigest({ reviewId: job.id, controlId: control.id, instanceId: result.instanceId, obligationId: check.obligationId }), obligationId: check.obligationId, expectationDigest: controlDigest(obligation), candidateDigest: candidate.digest, definitionDigest: proposal.bundle.digest, instance: selection.instances.find(i => i.id === result.instanceId)!, result, proofs: Object.fromEntries(result.proofFiles!.map(p => [p, job.proofs[p]!])) });
        }
        const revision = parseSpecimenRevision({ ref, controlId: control.id, kind, introducedDefinitionDigest: proposal.bundle.digest, predecessor: old?.revision.ref ?? null, scope, witnesses });
        specimens.push({ revision, candidate }); if (oldEntry) { oldEntry.disposition = 'historical'; oldEntry.successor = ref; } entries.push({ specimen: ref, disposition: 'current', successor: null, retiredScopes: [] });
      }
      ensure(entries.filter(e => e.disposition === 'current').every(e => specimens.find(s => same(s.revision.ref, e.specimen))?.revision.introducedDefinitionDigest === proposal.bundle.digest), 'Legacy published proposal omitted a historical control');
      const definitions = [...new Map([...prior.definitions, { definition, bundle: proposal.bundle }].map(d => [d.definition.definitionDigest, d])).values()]; validateControlImplementationHistory(definitions);
      const transitions = [...new Map([...prior.transitions, ...binding.base.transitionIds.map(id => lineage.transition(id))].map(t => [t.id, t])).values()];
      return { definitions, specimens, manifest: { schemaVersion: 1, lineageId: binding.base.lineageId, baseDefinitionDigest: binding.base.baseDefinitionDigest, targetDefinitionDigest: proposal.bundle.digest, transitionIds: binding.base.transitionIds, entries }, transitions };
    } finally { this.readingHistory.delete(proposalId); }
  }
}
/** Transaction-joining guard for direct publication as well as controller calls. */
export function assertControlQualificationPublication(db: DatabaseSync, input: { proposalId: string; reviewId: string }, dataDir?: string): ControlQualificationEvidence {
  return new ControlQualificationRepository(db, dataDir).assertPublicationBinding(input);
}
