import type {SourceRefreshAuthorization} from '../contracts/p8-source-refresh.js';
import type {GoalResearchConfiguration} from '../contracts/p8-research-runtime.js';
import {assertSourceRefreshIntent,sourceRefreshDigest,assertSourceRefreshConfiguration} from '../verification/source-refresh-intent.js';
import {assertResearchMappingApproval,persistedResearchWorkflow} from '../verification/research-mapping-proof.js';
import {dirname} from 'node:path';
import {assertLegacyControlReviewEvidence} from '../verification/legacy-review-evidence.js';
import {ControlMaintenanceRepository} from './control-maintenance.js';
import { createHash } from 'node:crypto';
import { assertControlQualificationPublication } from './control-qualification.js';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Run, TaskContract } from '../contracts/p1.js';
import type { GoalSession } from '../contracts/p5.js';
import type { ConversationRound } from '../contracts/p6.js';
import type { AcceptanceLineage, AppliedContractTransition, BoundHead, ContractRef, LegacyLineageMigration, LineageBindingIssue, ProposalAcceptanceBinding, ProposalBase, RunAcceptanceBinding } from '../contracts/p4-lineage.js';
import type { Delivery, FrozenPlan, Proposal, VerificationJob } from '../verification/records.js';
import { verificationCanonical as canonical } from '../verification/rules.js';
import { ConversationRepository } from './conversations.js';

export const VERIFICATION_LINEAGE_MIGRATION_SQL = `
CREATE TABLE verification_lineages(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,root_run_id TEXT NOT NULL,conversation_id TEXT,record TEXT NOT NULL CHECK(json_valid(record)),UNIQUE(project_id,root_run_id),FOREIGN KEY(project_id,root_run_id) REFERENCES runs(project_id,id));
CREATE TABLE verification_run_bindings(project_id TEXT NOT NULL,run_id TEXT NOT NULL,lineage_id TEXT NOT NULL REFERENCES verification_lineages(id),record TEXT NOT NULL CHECK(json_valid(record)),PRIMARY KEY(project_id,run_id),FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));
CREATE TABLE verification_contract_transitions(id TEXT PRIMARY KEY,lineage_id TEXT NOT NULL REFERENCES verification_lineages(id),project_id TEXT NOT NULL,run_id TEXT NOT NULL,to_contract_digest TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)),UNIQUE(project_id,run_id,to_contract_digest),FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));
CREATE TABLE verification_proposal_bindings(proposal_id TEXT PRIMARY KEY,proposal_kind TEXT NOT NULL DEFAULT 'proposal' CHECK(proposal_kind='proposal'),lineage_id TEXT NOT NULL REFERENCES verification_lineages(id),record TEXT NOT NULL CHECK(json_valid(record)),FOREIGN KEY(proposal_kind,proposal_id) REFERENCES verification_records(kind,id));
CREATE TABLE verification_lineage_heads(lineage_id TEXT PRIMARY KEY REFERENCES verification_lineages(id),proposal_id TEXT NOT NULL REFERENCES verification_proposal_bindings(proposal_id),revision INTEGER NOT NULL CHECK(revision>0),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE verification_binding_issues(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),run_id TEXT,proposal_id TEXT,record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE verification_lineage_receipts(command_id TEXT PRIMARY KEY,request TEXT NOT NULL CHECK(json_valid(request)),result TEXT NOT NULL CHECK(json_valid(result)));
${['verification_lineages','verification_run_bindings','verification_contract_transitions','verification_proposal_bindings','verification_binding_issues','verification_lineage_receipts'].map(table=>`CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Lineage records are immutable');END;
CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Lineage records are immutable');END;`).join('\n')}
`;
export const lineageDigest=(value:unknown):string=>createHash('sha256').update(canonical(value)).digest('hex');
function ensure(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(message);}
function text(value:unknown):asserts value is string {ensure(typeof value==='string'&&value.trim()&&value.length<=4096&&!value.includes('\0'),'Invalid lineage identifier');}
function json(value:unknown):string {const result=canonical(value);ensure(typeof result==='string'&&result.length<=2_000_000,'Lineage record exceeds capacity');JSON.parse(result);return result;}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function frozenProposalDigest(proposal:Proposal):string {const {status:_status,version:_version,reviewId:_review,reviewEnvironmentDigest:_environment,...frozen}=proposal;return lineageDigest(frozen);}
export class UnresolvedVerificationLineageError extends Error {
  override name='UnresolvedVerificationLineageError';
  constructor(message:string,readonly issues:LineageBindingIssue[]=[]){super(message);}
}
/** Exact provenance and atomic pointers only. P4 still owns actual model/process
 * qualification; no lineage method authorizes contract edits or releases cost. */
export class VerificationLineageRepository {
  constructor(private readonly db:DatabaseSync){}
  transaction<T>(body:()=>T):T {const own=!this.db.isTransaction;if(own)this.db.exec('BEGIN IMMEDIATE');try{const result=body();ensure(!result||typeof (result as {then?:unknown}).then!=='function','Asynchronous lineage transaction prohibited');if(own)this.db.exec('COMMIT');return result;}catch(error){if(own)this.db.exec('ROLLBACK');throw error;}}
  private command<T>(commandId:string,request:unknown,body:()=>T):T {return this.transaction(()=>{text(commandId);const old=this.db.prepare('SELECT request,result FROM verification_lineage_receipts WHERE command_id=?').get(commandId);if(old){ensure(old.request===json(request),'Conflicting lineage commandId');return JSON.parse(String(old.result)) as T;}const result=body();this.db.prepare('INSERT INTO verification_lineage_receipts(command_id,request,result) VALUES (?,?,?)').run(commandId,json(request),json(result));return result;});}
  private run(projectId:string,runId:string):Run {const row=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(projectId,runId);ensure(row,'Unknown lineage Run');const run=JSON.parse(String(row.snapshot)) as Run;ensure(run.id===runId&&run.projectId===projectId,'Lineage Run identity mismatch');return run;}
  private record<T>(kind:string,id:string):T {const row=this.db.prepare('SELECT record FROM verification_records WHERE kind=? AND id=?').get(kind,id);ensure(row,'Missing lineage '+kind);return JSON.parse(String(row.record)) as T;}
  private proposals(projectId:string,runId?:string):Proposal[] {return this.db.prepare("SELECT record FROM verification_records WHERE kind='proposal' AND project_id=? ORDER BY id").all(projectId).map(row=>JSON.parse(String(row.record)) as Proposal).filter(p=>!runId||p.runId===runId);}
  private round(projectId:string,runId:string):ConversationRound|null {const row=this.db.prepare('SELECT record FROM conversation_rounds WHERE project_id=? AND run_id=?').get(projectId,runId);return row?JSON.parse(String(row.record)) as ConversationRound:null;}
  private storedBinding(projectId:string,runId:string):RunAcceptanceBinding|null {const row=this.db.prepare('SELECT record FROM verification_run_bindings WHERE project_id=? AND run_id=?').get(projectId,runId);return row?JSON.parse(String(row.record)) as RunAcceptanceBinding:null;}
  issues(projectId?:string):LineageBindingIssue[] {return this.db.prepare('SELECT record FROM verification_binding_issues ORDER BY id').all().map(row=>JSON.parse(String(row.record)) as LineageBindingIssue).filter(i=>!projectId||i.projectId===projectId);}
  resolveRun(projectId:string,runId:string):RunAcceptanceBinding {this.run(projectId,runId);const issues=this.issues(projectId).filter(i=>i.runId===runId||i.runId===null);if(issues.length)throw new UnresolvedVerificationLineageError('Verification lineage requires explicit migration resolution',issues);const value=this.storedBinding(projectId,runId);if(!value)throw new UnresolvedVerificationLineageError('Verification Run has no explicit acceptance lineage');return value;}
  lineage(id:string):AcceptanceLineage {const row=this.db.prepare('SELECT record FROM verification_lineages WHERE id=?').get(id);ensure(row,'Unknown acceptance lineage');return JSON.parse(String(row.record)) as AcceptanceLineage;}
  private head(lineageId:string):BoundHead|null {const row=this.db.prepare('SELECT record FROM verification_lineage_heads WHERE lineage_id=?').get(lineageId);return row?JSON.parse(String(row.record)) as BoundHead:null;}
  headForRun(projectId:string,runId:string):BoundHead|null {const binding=this.resolveRun(projectId,runId),head=this.head(binding.lineageId);if(head){const proposal=this.record<Proposal>('proposal',head.proposalId),p=this.bindingForProposal(proposal.id);ensure(p.base.lineageId===binding.lineageId&&proposal.status==='published'&&proposal.version===head.catalogVersion&&proposal.projectId===projectId&&proposal.contractDigest===head.contract.contractDigest&&proposal.runId===head.contract.runId,'Scoped head is inconsistent');}return head;}
  private saveRoot(projectId:string,runId:string):RunAcceptanceBinding {
    const round=this.round(projectId,runId);ensure(!round||round.ordinal===1&&round.predecessorRunId===null&&round.predecessorDeliveryId===null,'Continuation cannot become an independent root');
    const existing=this.storedBinding(projectId,runId);if(existing){ensure(existing.predecessorRunId===null,'Run is already a continuation');return existing;}
    const lineage:AcceptanceLineage={id:'lineage-'+lineageDigest({projectId,runId}).slice(0,24),projectId,rootRunId:runId,conversationId:round?.conversationId??null};
    const binding:RunAcceptanceBinding={projectId,runId,lineageId:lineage.id,predecessorRunId:null,predecessorDeliveryId:null,predecessorProposalId:null};
    this.db.prepare('INSERT INTO verification_lineages(id,project_id,root_run_id,conversation_id,record) VALUES (?,?,?,?,?)').run(lineage.id,projectId,runId,lineage.conversationId,json(lineage));this.insertBinding(binding);return binding;
  }
  private insertBinding(binding:RunAcceptanceBinding){this.db.prepare('INSERT INTO verification_run_bindings(project_id,run_id,lineage_id,record) VALUES (?,?,?,?)').run(binding.projectId,binding.runId,binding.lineageId,json(binding));}
  bindRoot(input:{commandId:string;projectId:string;runId:string}):RunAcceptanceBinding {return this.command(input.commandId,{method:'bind-root',...input},()=>{this.run(input.projectId,input.runId);ensure(!this.issues(input.projectId).some(i=>i.runId===input.runId||i.runId===null),'Unresolved legacy lineage');ensure(this.storedBinding(input.projectId,input.runId)||this.proposals(input.projectId,input.runId).length===0,'Existing proposals require explicit legacy migration');return this.saveRoot(input.projectId,input.runId);});}
  private predecessor(projectId:string,runId:string,conversationId:string,predecessorRunId:string,deliveryId:string) {
    const round=this.round(projectId,runId),conversations=new ConversationRepository(this.db),conversation=conversations.get(conversationId);
    ensure(round?.conversationId===conversationId&&round.ordinal>1&&round.predecessorRunId===predecessorRunId&&round.predecessorDeliveryId===deliveryId&&conversation.projectId===projectId,'Continuation round does not bind the requested predecessor');
    const parent=conversations.rounds(conversationId).find(r=>r.ordinal===round.ordinal-1);ensure(parent?.runId===predecessorRunId&&parent.projectId===projectId,'Continuation must use the immediately preceding round');
    const row=this.db.prepare('SELECT record FROM goal_sessions WHERE id=?').get(round.sessionId);ensure(row,'Missing continuation Goal');const goal=JSON.parse(String(row.record)) as GoalSession;
    ensure(goal.projectId===projectId&&goal.workspace===conversation.workspace&&goal.continuation?.conversationId===conversationId&&goal.continuation.predecessorRunId===predecessorRunId&&goal.continuation.predecessorDeliveryId===deliveryId&&goal.continuation.predecessorSessionId===parent.sessionId,'Goal and conversation predecessor disagree');
    const run=this.run(projectId,predecessorRunId);ensure(run.status==='succeeded'&&run.attempts.every(a=>a.settled&&a.status!=='running')&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released),'Predecessor is not delivered and settled');
    const delivery=this.record<Delivery>('delivery',deliveryId),plan=this.record<FrozenPlan>('plan',delivery.planId),proposal=this.record<Proposal>('proposal',plan.proposalId),job=this.record<VerificationJob>('job',delivery.jobId);
    for(const record of [delivery,plan,proposal,job])ensure(record.projectId===projectId&&record.runId===predecessorRunId&&record.runtimeId===delivery.runtimeId,'Predecessor delivery crosses Run identity');
    ensure(plan.id===delivery.planId&&job.planId===plan.id&&job.proposalId===proposal.id&&job.kind==='verification'&&job.status==='finished'&&job.approved&&job.evaluation?.complete&&job.stopConfirmed&&!job.usageUnknown&&!job.error,'Predecessor delivery lacks completed independent verification');
    ensure(plan.selection.mode==='final'&&plan.selection.completeScope&&proposal.status==='published'&&proposal.version===plan.catalogVersion&&plan.contractDigest===lineageDigest(run.contract)&&proposal.contractDigest===plan.contractDigest&&plan.definitionDigest===proposal.bundle.digest&&delivery.definitionDigest===plan.definitionDigest&&delivery.candidateDigest===plan.candidate.digest&&run.artifact?.id===plan.id,'Predecessor delivery contract or artifact binding mismatch');
    const attempt=run.attempts.find(a=>a.id===job.attemptId);ensure(attempt?.settled&&attempt.actual===job.usage&&attempt.purpose==='verification','Predecessor delivery usage is not settled');
    return {round,run,delivery,plan,proposal};
  }
  bindContinuation(input:{commandId:string;conversationId:string;runId:string;predecessorRunId:string;predecessorDeliveryId:string}):RunAcceptanceBinding {return this.command(input.commandId,{method:'bind-continuation',...input},()=>{
    const conversation=new ConversationRepository(this.db).get(input.conversationId),projectId=conversation.projectId;this.run(projectId,input.runId);
    const prior=this.storedBinding(projectId,input.runId);if(prior){ensure(prior.predecessorRunId===input.predecessorRunId&&prior.predecessorDeliveryId===input.predecessorDeliveryId,'Conflicting continuation binding');return this.resolveRun(projectId,input.runId);}
    ensure(!this.proposals(projectId,input.runId).length,'Existing child proposals require legacy migration');const target=this.predecessor(projectId,input.runId,input.conversationId,input.predecessorRunId,input.predecessorDeliveryId),parent=this.resolveRun(projectId,input.predecessorRunId),head=this.headForRun(projectId,input.predecessorRunId);
    ensure(head?.proposalId===target.proposal.id,'Predecessor delivery is not the exact scoped head');ensure(this.lineage(parent.lineageId).conversationId===input.conversationId,'Continuation conversation differs from root lineage');
    const binding:RunAcceptanceBinding={projectId,runId:input.runId,lineageId:parent.lineageId,predecessorRunId:input.predecessorRunId,predecessorDeliveryId:input.predecessorDeliveryId,predecessorProposalId:target.proposal.id};this.insertBinding(binding);return binding;
  });}
  transition(id:string):AppliedContractTransition {const row=this.db.prepare('SELECT record FROM verification_contract_transitions WHERE id=?').get(id);ensure(row,'Missing applied contract transition');const value=JSON.parse(String(row.record)) as AppliedContractTransition;this.validateTransition(value,false);return value;}
  private transitionChain(binding:RunAcceptanceBinding,from:ContractRef,to:ContractRef):string[] {
    const chain:string[]=[],seen=new Set<string>();let current=to;
    while(!same(current,from)){const row=this.db.prepare('SELECT record FROM verification_contract_transitions WHERE project_id=? AND run_id=? AND to_contract_digest=?').get(current.projectId,current.runId,current.contractDigest);if(!row)throw new UnresolvedVerificationLineageError('Contract evolution lacks its exact applied authorization chain');const transition=this.transition((JSON.parse(String(row.record)) as AppliedContractTransition).id);ensure(transition.lineageId===binding.lineageId&&!seen.has(transition.id),'Invalid contract transition ancestry');seen.add(transition.id);chain.unshift(transition.id);current=transition.from;}
    return chain;
  }
  captureBase(projectId:string,runId:string):ProposalBase {const binding=this.resolveRun(projectId,runId),run=this.run(projectId,runId),head=this.headForRun(projectId,runId);ensure(run.admission!=='draft','Draft Run cannot propose acceptance');const target={projectId,runId,contractDigest:lineageDigest(run.contract)};
    if(binding.predecessorProposalId&&!this.proposals(projectId,runId).some(p=>p.status==='published'))ensure(head?.proposalId===binding.predecessorProposalId,'Child first proposal no longer matches exact predecessor delivery');
    return {lineageId:binding.lineageId,expectedHeadRevision:head?.revision??0,baseProposalId:head?.proposalId??null,baseDefinitionDigest:head?this.record<Proposal>('proposal',head.proposalId).bundle.digest:null,target,transitionIds:head?this.transitionChain(binding,head.contract,target):[]};
  }
  bindingForProposal(proposalId:string):ProposalAcceptanceBinding {const row=this.db.prepare('SELECT record FROM verification_proposal_bindings WHERE proposal_id=?').get(proposalId);if(!row)throw new UnresolvedVerificationLineageError('Proposal has no frozen acceptance base');const value=JSON.parse(String(row.record)) as ProposalAcceptanceBinding;ensure(value.proposalDigest===frozenProposalDigest(this.record<Proposal>('proposal',proposalId)),'Frozen proposal content changed');return value;}
  baseForProposal(proposalId:string):ProposalBase{return this.bindingForProposal(proposalId).base;}
  private insertProposalBinding(value:ProposalAcceptanceBinding){this.db.prepare('INSERT INTO verification_proposal_bindings(proposal_id,lineage_id,record) VALUES (?,?,?)').run(value.proposalId,value.base.lineageId,json(value));}
  bindProposal(input:{commandId:string;proposalId:string;base:ProposalBase;definitionFormat:ProposalAcceptanceBinding['definitionFormat']}):ProposalAcceptanceBinding {return this.command(input.commandId,{method:'bind-proposal',...input},()=>{
    ensure(['legacy-v1','qualified-v2'].includes(input.definitionFormat),'Unknown definition format');const proposal=this.record<Proposal>('proposal',input.proposalId);ensure(proposal.status==='proposed'&&proposal.version===null,'New binding requires an unpublished proposal');ensure(proposal.contractDigest===input.base.target.contractDigest&&proposal.projectId===input.base.target.projectId&&proposal.runId===input.base.target.runId,'Proposal target binding differs');ensure(same(this.captureBase(proposal.projectId,proposal.runId),input.base),'Proposal base changed');const head=this.head(input.base.lineageId);ensure(proposal.baseVersion===(head?.catalogVersion??0),'Proposal version does not match scoped base');const value:ProposalAcceptanceBinding={proposalId:proposal.id,proposalDigest:frozenProposalDigest(proposal),base:structuredClone(input.base),definitionFormat:input.definitionFormat};const old=this.db.prepare('SELECT record FROM verification_proposal_bindings WHERE proposal_id=?').get(proposal.id);if(old){ensure(old.record===json(value),'Conflicting proposal base');return value;}this.insertProposalBinding(value);return value;
  });}
  recordAppliedTransition(input:{commandId:string;transition:AppliedContractTransition}):AppliedContractTransition {return this.command(input.commandId,{method:'contract-transition',...input},()=>{
    const value=input.transition;this.validateTransition(value);const old=this.db.prepare('SELECT record FROM verification_contract_transitions WHERE id=?').get(value.id);if(old){ensure(old.record===json(value),'Conflicting applied transition');return value;}
    this.db.prepare('INSERT INTO verification_contract_transitions(id,lineage_id,project_id,run_id,to_contract_digest,record) VALUES (?,?,?,?,?,?)').run(value.id,value.lineageId,value.to.projectId,value.to.runId,value.to.contractDigest,json(value));return structuredClone(value);
  });}
  /** Each proposal covers only its frozen base-to-target interval. Published
   * ancestors retain their own actual review authority; they are never treated
   * as current-source evidence for a later generation. */
  assertRefreshPublicationSupported(projectId:string,runId:string,actualReview?:{proposalId:string;reviewId:string}):void {
    if(!actualReview){
      let ref={projectId,runId,contractDigest:lineageDigest(this.run(projectId,runId).contract)};
      const seen=new Set<string>();
      for(;;){
        const row=this.db.prepare('SELECT id FROM verification_contract_transitions WHERE project_id=? AND run_id=? AND to_contract_digest=?').get(ref.projectId,ref.runId,ref.contractDigest);
        if(!row)return;
        ensure(seen.size<32&&!seen.has(String(row.id)),'Refresh publication ancestry is unresolved');
        seen.add(String(row.id));const t=this.transition(String(row.id));
        ensure(!t.sourceRefresh,'Source refresh publication blocked until adapted P4 qualification is implemented');ref=t.from;
      }
    }
    const current=this.record<Proposal>('proposal',actualReview.proposalId);
    ensure(current.projectId===projectId&&current.runId===runId,'Refresh publication crosses the actual target Run');
    const visited=new Set<string>();
    let proposal=current,reviewId=actualReview.reviewId;
    for(;;){
      ensure(visited.size<32&&!visited.has(proposal.id),'Refresh publication base ancestry is unresolved');visited.add(proposal.id);
      const binding=this.bindingForProposal(proposal.id),base=binding.base,runBinding=this.resolveRun(proposal.projectId,proposal.runId);
      ensure(base.lineageId===runBinding.lineageId&&same(base.target,{projectId:proposal.projectId,runId:proposal.runId,contractDigest:proposal.contractDigest}),
        'Refresh publication frozen target differs');
      const previous=base.baseProposalId?this.record<Proposal>('proposal',base.baseProposalId):null;
      if(previous){
        ensure(previous.status==='published'&&previous.reviewId&&previous.bundle.digest===base.baseDefinitionDigest
          &&previous.version===proposal.baseVersion&&base.expectedHeadRevision===this.bindingForProposal(previous.id).base.expectedHeadRevision+1,
          'Refresh publication predecessor authority differs');
        ensure(same(this.transitionChain(runBinding,{projectId:previous.projectId,runId:previous.runId,contractDigest:previous.contractDigest},base.target),base.transitionIds),
          'Refresh publication omits or changes the actual transition interval');
      }else ensure(base.expectedHeadRevision===0&&base.baseDefinitionDigest===null&&base.transitionIds.length===0,'Refresh root base is inconsistent');
      const transitions=base.transitionIds.map(id=>this.transition(id)),refreshes=transitions.filter(t=>t.sourceRefresh);
      if(refreshes.length){
        const qualification=assertControlQualificationPublication(this.db,{proposalId:proposal.id,reviewId});
        ensure(refreshes.length===1&&qualification.assembled.matrix.sourceRefresh?.context.generation.authorization.transitionId===refreshes[0]!.id
          &&qualification.assembled.matrix.sourceRefresh.adaptations.length>0,'Refresh publication lacks complete adapted actual qualification');
      }
      if(!previous)return;
      proposal=previous;reviewId=previous.reviewId!;
    }
  }
  /** Existing applied lineage receipt only; no new approval or acquisition. */
  sourceRefreshAuthorization(id:string):SourceRefreshAuthorization {
    const t=this.transition(id);ensure(t.sourceRefresh,'Transition has no explicit source refresh');
    const row=this.db.prepare('SELECT record FROM goal_sessions WHERE id=?').get(t.sessionId)!;
    const session=JSON.parse(String(row.record)) as GoalSession;
    const body={schemaVersion:1 as const,authority:'actual-applied-refresh-integrity-only' as const,transitionId:t.id,transitionDigest:lineageDigest(t),lineageId:t.lineageId,projectId:t.to.projectId,previousRunId:t.from.runId,currentRunId:t.to.runId,intent:t.sourceRefresh,researchConfigurationDigest:lineageDigest(session.research),criteriaDigest:lineageDigest(t.fromContract.criteria)};
    return {...body,digest:lineageDigest(body)};
  }
  private validateTransition(value:AppliedContractTransition,currentTarget=true):void {
    text(value.id);const binding=this.resolveRun(value.to.projectId,value.to.runId);ensure(value.lineageId===binding.lineageId&&value.from.projectId===value.to.projectId,'Foreign transition lineage');ensure(lineageDigest(value.fromContract)===value.from.contractDigest&&lineageDigest(value.toContract)===value.to.contractDigest,'Transition contract digest mismatch');if(currentTarget)ensure(same(this.run(value.to.projectId,value.to.runId).contract,value.toContract),'Transition must bind the actually applied contract');
    ensure(value.from.runId===value.to.runId||binding.predecessorRunId===value.from.runId,'Transition has unrelated predecessor');
    if(value.from.runId!==value.to.runId)ensure(same(this.run(value.from.projectId,value.from.runId).contract,value.fromContract),'Predecessor contract changed');
    const conversations=new ConversationRepository(this.db),conversation=conversations.get(value.conversationId),message=conversations.message(value.messageId),round=this.round(value.to.projectId,value.to.runId);
    ensure(conversation.projectId===value.to.projectId&&round?.conversationId===value.conversationId&&round.sessionId===value.sessionId&&message.conversationId===value.conversationId&&message.kind!=='question'&&message.state==='applied'&&message.sequence===value.messageSequence&&message.appliedContractVersion===value.toContract.version,'Transition message is not the applied requirement');
    const row=this.db.prepare('SELECT record FROM goal_sessions WHERE id=?').get(value.sessionId);ensure(row,'Missing transition Goal');const session=JSON.parse(String(row.record)) as GoalSession,job=session.jobs.find(j=>j.id===value.reasoningJobId),frozen=job?.followup;
    ensure(job?.purpose==='followup'&&frozen&&job.status==='finished'&&!job.error&&job.stopConfirmed&&job.usage!==null&&job.followupResult?.decision==='revise'&&frozen.messageId===value.messageId&&frozen.messageSequence===value.messageSequence&&frozen.processingAttempt===value.processingAttempt&&frozen.appliedContractVersion===value.toContract.version&&same(frozen.relatedMessageIds,value.relatedMessageIds),'Transition lacks applied accounted follow-up');
    const context=job.context as {input?:{originalContract?:TaskContract};callReceipts?:{id:string;output:unknown;outputDigest:string;threadId:string|null;usage:number|null;stopConfirmed:boolean;proofs:Record<string,string>}[]}|null;
    ensure(same(context?.input?.originalContract,value.fromContract)&&same(job.followupResult.criterionChanges,value.changes),'Transition differs from frozen planner input or authorized delta');
    const calls=context?.callReceipts;ensure(calls?.length===2&&calls[0]!.id===job.id&&calls[1]!.id===job.id+'-review'&&calls.every(c=>c.threadId&&c.stopConfirmed&&c.usage!==null&&Number.isSafeInteger(c.usage)&&c.usage>=0&&Object.keys(c.proofs).length>0)&&calls[0]!.threadId!==calls[1]!.threadId&&calls[1]!.outputDigest===lineageDigest(value.review)&&calls.reduce((sum,c)=>sum+c.usage!,0)===job.usage,'Transition lacks two independent accounted authorization calls');
    for(const call of calls){ensure(call.outputDigest===lineageDigest(call.output),'Transition raw output digest changed');for(const [path,digest]of Object.entries(call.proofs))ensure(job.proofs[path]===digest,'Transition call proofs differ from settled job');}
    ensure(same(calls[1]!.output,value.review),'Transition review differs from actual saved output');
    const raw=calls[0]!.output;ensure(raw&&typeof raw==='object'&&!Array.isArray(raw),'Transition planner has no raw structured output');const {criterionChanges:requests,...rawLegacy}=raw as Record<string,unknown>,{criterionChanges:_enriched,...savedLegacy}=job.followupResult;
    ensure(same(rawLegacy,savedLegacy)&&Array.isArray(requests),'Transition planner output differs from saved proposal');
    const expected=value.changes.map(({kind,criterionId,sources})=>({kind,criterionId,sources}));ensure(requests.length===expected.length&&new Set(requests.map(r=>(r as {criterionId?:unknown})?.criterionId)).size===expected.length&&expected.every(change=>requests.some(request=>same(request,change))),'Transition raw source requests differ from enriched changes');
    const run=this.run(value.to.projectId,value.to.runId),attempt=run.attempts.find(a=>a.id===job.attemptId);ensure(attempt?.settled&&attempt.actual===job.usage,'Transition reasoning cost is unresolved');
    ensure(same((job.context as {acceptanceReview?:unknown}|null)?.acceptanceReview,value.review)&&value.review.approved===true&&value.review.proposalDigest===lineageDigest(job.followupResult.proposal),'Transition independent review is missing or unbound');
    const group=[...value.relatedMessageIds,value.messageId].map(id=>conversations.message(id)).sort((a,b)=>a.sequence-b.sequence);ensure(new Set(group.map(m=>m.id)).size===group.length&&group.every(m=>m.conversationId===value.conversationId&&m.state==='applied'&&m.appliedContractVersion===value.toContract.version),'Transition source group was not applied together');
    ensure(value.review.sourceDigest===lineageDigest(group.map(m=>({id:m.id,text:m.text,sequence:m.sequence}))),'Transition source digest mismatch');
    ensure(same(job.proofs,value.proofs)&&Object.keys(value.proofs).length>0,'Transition proof binding mismatch');for(const [path,digest]of Object.entries(value.proofs))ensure(createHash('sha256').update(readFileSync(path)).digest('hex')===digest,'Transition proof bytes changed');
    ensure(same(value.sourceRefresh??null,job.followupResult.sourceRefresh??null),'Applied refresh differs from actual planner output');
    if(value.sourceRefresh){
      const config=session.research;
      const frozenConfig=(context?.input as {researchConfiguration?:GoalResearchConfiguration}|undefined)?.researchConfiguration;
      ensure(config&&frozenConfig&&same(config,frozenConfig),'Refresh research configuration changed after reasoning');
      const originalSessionRow=this.db.prepare('SELECT record FROM goal_sessions WHERE id=?').get(value.from.runId);ensure(originalSessionRow,'Original research session missing');const originalSession=JSON.parse(String(originalSessionRow.record)) as GoalSession;ensure(originalSession.runtimeId,'Original research runtime missing');
      const actualOriginalOperations=this.db.prepare('SELECT record FROM runtime_outbox WHERE runtime_id=? ORDER BY rowid').all(originalSession.runtimeId).map(row=>JSON.parse(String(row.record)));
      assertSourceRefreshConfiguration(config,actualOriginalOperations,value.fromContract.version);

      if(session.continuation){const parent=this.db.prepare('SELECT record FROM goal_sessions WHERE id=?').get(session.continuation.predecessorSessionId);ensure(parent&&same((JSON.parse(String(parent.record)) as GoalSession).research,config),'Refresh changes original input/cutoff configuration');}
      assertSourceRefreshIntent(value.sourceRefresh,config,group,value.fromContract,value.toContract);
      const reviewed=value.review.sourceRefresh;
      ensure(value.changes.length===0&&reviewed?.authorized===true&&reviewed.intentDigest===sourceRefreshDigest(value.sourceRefresh)&&reviewed.reasons.length>0&&reviewed.reasons.every(r=>typeof r==='string'&&r.trim()),'Refresh needs exact independent authorization and unchanged criteria');
    }else ensure(!value.review.sourceRefresh,'Review cannot introduce an absent refresh request');
    const before=new Map(value.fromContract.criteria.map(c=>[c.id,c])),after=new Map(value.toContract.criteria.map(c=>[c.id,c]));ensure(before.size===value.fromContract.criteria.length&&after.size===value.toContract.criteria.length,'Duplicate transition criterion');const changed=[...new Set([...before.keys(),...after.keys()])].filter(id=>!same(before.get(id)??null,after.get(id)??null));
    ensure(value.changes.length===changed.length&&new Set(value.changes.map(c=>c.criterionId)).size===changed.length&&value.review.changes.length===changed.length,'Transition delta must cover every actual criterion change');
    for(const change of value.changes){const old=before.get(change.criterionId),next=after.get(change.criterionId),kind=!old?'add':!next?'retire':'modify';ensure(changed.includes(change.criterionId)&&change.kind===kind&&change.beforeDigest===(old?lineageDigest(old):null)&&change.afterDigest===(next?lineageDigest(next):null),'Transition criterion delta mismatch');ensure(change.sources.length>0&&change.sources.every(source=>source.quote.trim()&&group.some(m=>m.id===source.messageId&&m.text.includes(source.quote))),'Transition change lacks exact user provenance');const reviews=value.review.changes.filter(r=>r.criterionId===change.criterionId&&r.kind===change.kind);ensure(reviews.length===1&&reviews[0]!.authorized===true&&reviews[0]!.reasons.length>0,'Transition change lacks independent authorization');}
  }
  /** Caller still performs async actual-stop/environment/definition checks. This
   * joins its transaction and rechecks durable review, proofs, fence and exact base. */
  publishBound(input:{commandId:string;proposalId:string;reviewId:string;expectedBaseProposalId:string|null;expectedHeadRevision:number}):BoundHead {return this.command(input.commandId,{method:'publish-bound',...input},()=>{
    const proposal=this.record<Proposal>('proposal',input.proposalId),binding=this.bindingForProposal(proposal.id),base=binding.base;ensure(same(this.captureBase(proposal.projectId,proposal.runId),base),'Publication base or contract changed');ensure(base.baseProposalId===input.expectedBaseProposalId&&base.expectedHeadRevision===input.expectedHeadRevision,'Publication CAS differs from frozen base');this.assertRefreshPublicationSupported(proposal.projectId,proposal.runId,{proposalId:proposal.id,reviewId:input.reviewId});ensure(proposal.status==='proposed'&&proposal.version===null,'Proposal already published by a different command');ensure(proposal.baseVersion===(this.head(base.lineageId)?.catalogVersion??0),'Publication catalog version changed');
    ensure(!new ConversationRepository(this.db).hasPendingForRun(proposal.projectId,proposal.runId),'Pending follow-up prevents publication');const run=this.run(proposal.projectId,proposal.runId);ensure(!['paused','cancelled','succeeded'].includes(run.status)&&run.attempts.every(a=>a.settled&&a.status!=='running')&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released),'Publication needs a current settled Run');
    const review=this.record<VerificationJob>('job',input.reviewId),attempt=run.attempts.find(a=>a.id===review.attemptId);ensure(review.projectId===proposal.projectId&&review.runId===proposal.runId&&review.runtimeId===proposal.runtimeId&&review.proposalId===proposal.id&&review.kind==='review'&&review.status==='finished'&&review.approved&&!review.error&&!review.usageUnknown&&review.stopConfirmed&&attempt?.settled&&attempt.actual===review.usage,'Publication needs the exact settled independent review');ensure(Object.keys(review.proofs).length>0,'Publication lacks review proof');for(const [path,expected]of Object.entries(review.proofs))ensure(createHash('sha256').update(readFileSync(path)).digest('hex')===expected,'Publication review proof changed');
    if(binding.definitionFormat==='qualified-v2')assertControlQualificationPublication(this.db,{proposalId:proposal.id,reviewId:review.id});
    else {ensure(!proposal.controlDraftDigest,'Legacy publication cannot bypass control qualification');const database=this.db.prepare('PRAGMA database_list').all().find(r=>r.name==='main');ensure(database?.file,'Publication needs its actual database directory');assertLegacyControlReviewEvidence({dataDir:dirname(String(database.file)),proposal,review});}
    new ControlMaintenanceRepository(this.db).assertPublication(proposal.id,review.id);
    if(persistedResearchWorkflow(this.db,proposal.id))assertResearchMappingApproval(this.db,proposal,review);
    proposal.version=proposal.baseVersion+1;proposal.status='published';proposal.reviewId=review.id;proposal.reviewEnvironmentDigest=review.environmentDigest;const head:BoundHead={lineageId:base.lineageId,revision:base.expectedHeadRevision+1,proposalId:proposal.id,catalogVersion:proposal.version,contract:base.target};
    this.db.prepare("UPDATE verification_records SET record=? WHERE kind='proposal' AND id=?").run(json(proposal),proposal.id);
    if(base.expectedHeadRevision===0)this.db.prepare('INSERT INTO verification_lineage_heads(lineage_id,proposal_id,revision,record) VALUES (?,?,?,?)').run(head.lineageId,head.proposalId,head.revision,json(head));else {const updated=this.db.prepare('UPDATE verification_lineage_heads SET proposal_id=?,revision=?,record=? WHERE lineage_id=? AND revision=? AND proposal_id=?').run(head.proposalId,head.revision,json(head),head.lineageId,base.expectedHeadRevision,base.baseProposalId);ensure(updated.changes===1,'Scoped head CAS failed');}return head;
  });}
  private issue(projectId:string,runId:string|null,proposalId:string|null,reasonCode:string,reason:string):LineageBindingIssue {const value:LineageBindingIssue={id:'lineage-issue-'+lineageDigest({projectId,runId,proposalId,reasonCode,reason}).slice(0,24),projectId,runId,proposalId,reasonCode,reason};this.db.prepare('INSERT OR IGNORE INTO verification_binding_issues(id,project_id,run_id,proposal_id,record) VALUES (?,?,?,?,?)').run(value.id,projectId,runId,proposalId,json(value));return value;}
  migrateLegacyBindings(input:{commandId:string}):LegacyLineageMigration {return this.command(input.commandId,{method:'migrate-legacy',...input},()=>{
    const result:LegacyLineageMigration={bindings:[],proposalBindings:[],heads:[],issues:[]};const runs=this.db.prepare('SELECT project_id,id FROM runs ORDER BY project_id,id').all().map(row=>({projectId:String(row.project_id),runId:String(row.id)}));
    runs.sort((a,b)=>(this.round(a.projectId,a.runId)?.ordinal??1)-(this.round(b.projectId,b.runId)?.ordinal??1)||a.runId.localeCompare(b.runId));
    for(const {projectId,runId}of runs){
      if(this.issues(projectId).some(i=>i.runId===runId||i.runId===null))continue;
      // A savepoint isolates an unresolved legacy scope, even in an outer caller transaction.
      this.db.exec('SAVEPOINT lineage_legacy_scope');
      try{
        const existing=this.storedBinding(projectId,runId);if(existing){result.bindings.push(existing);this.db.exec('RELEASE lineage_legacy_scope');continue;}
        const round=this.round(projectId,runId);let binding:RunAcceptanceBinding;
        if(round&&round.ordinal>1){ensure(round.predecessorRunId&&round.predecessorDeliveryId,'Legacy continuation lacks predecessor');const target=this.predecessor(projectId,runId,round.conversationId,round.predecessorRunId,round.predecessorDeliveryId),parent=this.resolveRun(projectId,round.predecessorRunId);ensure(this.head(parent.lineageId)?.proposalId===target.proposal.id,'Legacy continuation predecessor is not exact head');binding={projectId,runId,lineageId:parent.lineageId,predecessorRunId:round.predecessorRunId,predecessorDeliveryId:round.predecessorDeliveryId,predecessorProposalId:target.proposal.id};this.insertBinding(binding);}else binding=this.saveRoot(projectId,runId);
        const all=this.proposals(projectId),own=all.filter(p=>p.runId===runId),published=own.filter(p=>p.status==='published').sort((a,b)=>a.version!-b.version!);ensure(!own.some(p=>p.status!=='published'),'Legacy unpublished proposal has no frozen review base');let head=this.head(binding.lineageId);const staged:ProposalAcceptanceBinding[]=[];
        for(const proposal of published){ensure(proposal.version!==null&&proposal.version===proposal.baseVersion+1&&all.filter(p=>p.status==='published'&&p.version===proposal.version).length===1,'Legacy catalog version is ambiguous');const predecessor=proposal.baseVersion===0?null:all.filter(p=>p.status==='published'&&p.version===proposal.baseVersion);ensure(predecessor===null||predecessor.length===1,'Legacy base version is missing or ambiguous');ensure((predecessor?.[0]?.id??null)===(head?.proposalId??null),'Legacy project head crosses an unrelated task or missing ancestry');const review=proposal.reviewId?this.record<VerificationJob>('job',proposal.reviewId):null;ensure(review?.kind==='review'&&review.proposalId===proposal.id&&review.runId===runId&&review.projectId===projectId&&review.approved&&review.stopConfirmed&&!review.usageUnknown&&!review.error&&review.status==='finished','Legacy publication lacks independent review provenance');
          const base:ProposalBase={lineageId:binding.lineageId,expectedHeadRevision:head?.revision??0,baseProposalId:head?.proposalId??null,baseDefinitionDigest:head?this.record<Proposal>('proposal',head.proposalId).bundle.digest:null,target:{projectId,runId,contractDigest:proposal.contractDigest},transitionIds:[]};const value:ProposalAcceptanceBinding={proposalId:proposal.id,proposalDigest:frozenProposalDigest(proposal),base,definitionFormat:'legacy-v1'};this.insertProposalBinding(value);staged.push(value);head={lineageId:binding.lineageId,revision:base.expectedHeadRevision+1,proposalId:proposal.id,catalogVersion:proposal.version,contract:base.target};this.db.prepare('INSERT INTO verification_lineage_heads(lineage_id,proposal_id,revision,record) VALUES (?,?,?,?) ON CONFLICT(lineage_id) DO UPDATE SET proposal_id=excluded.proposal_id,revision=excluded.revision,record=excluded.record').run(head.lineageId,head.proposalId,head.revision,json(head));}
        this.db.exec('RELEASE lineage_legacy_scope');result.bindings.push(binding);result.proposalBindings.push(...staged);if(head)result.heads.push(head);
      }catch(error){this.db.exec('ROLLBACK TO lineage_legacy_scope');this.db.exec('RELEASE lineage_legacy_scope');result.issues.push(this.issue(projectId,runId,null,'legacy-ancestry-unresolved',error instanceof Error?error.message:String(error)));}
    }
    return result;
  });}
}
