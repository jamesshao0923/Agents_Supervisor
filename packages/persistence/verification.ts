import {persistedResearchWorkflow} from '../verification/research-mapping-proof.js';
import {dirname} from 'node:path';
import { VerificationLineageRepository } from './verification-lineage.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Run, RunAction, Artifact } from '../contracts/p1.js';
import type { Delivery, FrozenPlan, Proposal, VerificationJob } from '../verification/records.js';
import { applyAction } from '../domain/index.js';
function canonical(value: unknown): string { if(value===null||typeof value!=='object')return JSON.stringify(value); if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'; return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}'; }
type Records = { proposal: Proposal; plan: FrozenPlan; job: VerificationJob; delivery: Delivery };
export class VerificationRepository {
  constructor(private readonly db: DatabaseSync) {}
  researchProofPlanDigest(proposalId:string):string|null {return persistedResearchWorkflow(this.db,proposalId)?.proofPlan.digest??null;}
  dataDirectory():string {const row=this.db.prepare('PRAGMA database_list').all().find(r=>r.name==='main');if(!row?.file)throw new Error('Verification needs its actual database directory');return dirname(String(row.file));}
  transaction<T>(body: () => T): T { if(this.db.isTransaction)return body();this.db.exec('BEGIN IMMEDIATE'); try { const value = body(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  get<K extends keyof Records>(kind: K, id: string): Records[K] {
    const row = this.db.prepare('SELECT record FROM verification_records WHERE kind=? AND id=?').get(kind, id);
    if (!row) throw new Error('Unknown verification ' + kind); return JSON.parse(String(row.record)) as Records[K];
  }
  list<K extends keyof Records>(kind: K, runtimeId?: string): Records[K][] {
    return this.db.prepare('SELECT record FROM verification_records WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(String(row.record)) as Records[K]).filter(r => !runtimeId || r.runtimeId === runtimeId);
  }
  insert<K extends keyof Records>(kind: K, record: Records[K]): Records[K] {
    this.db.prepare('INSERT INTO verification_records(kind,id,project_id,run_id,record) VALUES (?,?,?,?,?)').run(kind, record.id, record.projectId, record.runId, canonical(record)); return record;
  }
  update<K extends 'proposal' | 'job'>(kind: K, record: Records[K]): void { this.get(kind, record.id); this.db.prepare('UPDATE verification_records SET record=? WHERE kind=? AND id=?').run(canonical(record), kind, record.id); }
  headForRun(projectId: string, runId: string): Proposal | null { const head=new VerificationLineageRepository(this.db).headForRun(projectId,runId); return head?this.get('proposal',head.proposalId):null; }
  /** Historical diagnosis only; never a dispatch/publication authority. */
  legacyProjectHead(projectId: string): Proposal | null { const row = this.db.prepare('SELECT proposal_id FROM verification_product_heads WHERE project_id=?').get(projectId); return row ? this.get('proposal', String(row.proposal_id)) : null; }
  publish(proposal: Proposal, commandId: string): void {
    const lineage=new VerificationLineageRepository(this.db),base=lineage.baseForProposal(proposal.id);
    if(!proposal.reviewId)throw new Error('Publication requires exact independent review');
    lineage.publishBound({commandId,proposalId:proposal.id,reviewId:proposal.reviewId,expectedBaseProposalId:base.baseProposalId,expectedHeadRevision:base.expectedHeadRevision});
    Object.assign(proposal,this.get('proposal',proposal.id));
  }
  receipt(commandId: string, request: unknown): unknown | undefined {
    const row = this.db.prepare('SELECT request,result FROM verification_product_receipts WHERE command_id=?').get(commandId);
    if (!row) return undefined; if (String(row.request) !== canonical(request)) throw new Error('Verification commandId conflicts with prior request'); return JSON.parse(String(row.result));
  }
  remember(commandId: string, request: unknown, result: unknown): void { this.db.prepare('INSERT INTO verification_product_receipts(command_id,request,result) VALUES (?,?,?)').run(commandId, canonical(request), canonical(result)); }
  run(projectId: string, runId: string): Run { const row = this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(projectId, runId); if (!row) throw new Error('Unknown verification Run'); return JSON.parse(String(row.snapshot)); }
  artifactRecord(projectId: string, runId: string, id: string): Artifact | null {
    const row = this.db.prepare('SELECT digest,path,contract_version FROM artifacts WHERE project_id=? AND run_id=? AND id=?').get(projectId, runId, id);
    return row ? { id, digest: String(row.digest), path: String(row.path), contractVersion: Number(row.contract_version) } : null;
  }
  act(projectId: string, runId: string, action: RunAction): Run {
    const { run, events } = applyAction(this.run(projectId, runId), action);
    this.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(canonical(run), run.revision, projectId, runId);
    for (const event of events) this.db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES (?,?,?,?,?)').run('verification:' + runId, projectId, runId, event.type, canonical(event));
    return run;
  }
  artifact(projectId: string, runId: string, value: Artifact): void {
    this.db.prepare('INSERT INTO artifacts(project_id,run_id,id,digest,path,contract_version) VALUES (?,?,?,?,?,?)').run(projectId, runId, value.id, value.digest, value.path, value.contractVersion);
    this.act(projectId, runId, { type: 'setArtifact', artifact: value });
  }
  assertNoVerificationWriter(workspace: string): void {
    if (this.list('job').some(job => (job.status === 'running' || !job.stopConfirmed) && (workspace === job.workspace || workspace.startsWith(job.workspace + '/') || job.workspace.startsWith(workspace + '/')))) throw new Error('Workspace has active independent verification');
  }
}
