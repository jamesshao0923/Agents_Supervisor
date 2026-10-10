import { VerificationLineageRepository, lineageDigest } from './verification-lineage.js';
import type { AppliedContractTransition } from '../contracts/p4-lineage.js';
import { validateFollowupEvolution, validateEvolutionReview } from '../orchestration/followup-evolution.js';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Run, RunAction } from '../contracts/p1.js';
import type { GoalInspection,GoalSession,OrchestrationAction,ReasoningJob } from '../contracts/p5.js';
import { applyAction,createDraftRun } from '../domain/index.js';
import { admittedPlan } from '../orchestration/admission.js';
import { RuntimeRepository,runtimeCanonical as canonical } from './runtime.js';
import { ConversationRepository } from './conversations.js';
import { VerificationRepository } from './verification.js';
import { sep } from 'node:path';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function ensure(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
export class GoalRepository {
  constructor(private db:DatabaseSync){}
  private tx<T>(f:()=>T):T {if(this.db.isTransaction)return f();this.db.exec('BEGIN IMMEDIATE');try{const x=f();this.db.exec('COMMIT');return x;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  list():GoalSession[]{return this.db.prepare('SELECT record FROM goal_sessions ORDER BY rowid DESC').all().map(r=>JSON.parse(String(r.record)) as GoalSession);}
  get(id:string):GoalSession {const row=this.db.prepare('SELECT record FROM goal_sessions WHERE id=?').get(id);ensure(row,'Unknown goal');return JSON.parse(String(row.record)) as GoalSession;}
  inspect(id:string):GoalInspection {const session=this.get(id);return {session,run:this.run(session)};}
  private run(s:GoalSession):Run {const row=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(s.projectId,s.id);ensure(row,'Missing goal ledger');return JSON.parse(String(row.snapshot)) as Run;}
  private act(s:GoalSession,a:RunAction):Run {const x=applyAction(this.run(s),a);this.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(canonical(x.run),x.run.revision,s.projectId,s.id);for(const e of x.events)this.db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES (?,?,?,?,?)').run(s.id,s.projectId,s.id,e.type,canonical(e));return x.run;}
  private save(s:GoalSession):void{s.revision++;s.updatedAt=new Date().toISOString();this.db.prepare('UPDATE goal_sessions SET record=? WHERE id=?').run(canonical(s),s.id);}
  private receipt(a:Exclude<OrchestrationAction,{type:'list'}|{type:'inspect';sessionId:string}>):GoalSession|null {const old=this.db.prepare('SELECT request,session_id FROM goal_receipts WHERE command_id=?').get(a.commandId);if(!old)return null;ensure(old.request===canonical(a),'Conflicting goal commandId');return this.get(String(old.session_id));}
  private receipted(a:unknown,id:string,commandId:string){this.db.prepare('INSERT INTO goal_receipts(command_id,request,session_id) VALUES (?,?,?)').run(commandId,canonical(a),id);}
  private begin(s:GoalSession,purpose:ReasoningJob['purpose']):void {
    ensure(!s.jobs.some(j=>j.status==='running'),'Reasoner already running');
    const id=`${s.id}-reason-${s.jobs.length+1}`;
    this.act(s,{type:'startAttempt',attemptId:id,nodeId:'@supervisor',contractVersion:this.run(s).contract.version,purpose:'reasoning',reservation:s.config.reservation,resources:[]});
    this.act(s,{type:'setOperation',operationId:id,attemptId:id,status:'pending'});
    s.jobs.push({id,purpose,status:'running',attemptId:id,config:s.config,intents:[],identities:[],startedAt:new Date().toISOString(),finishedAt:null,modelStarted:false,usage:null,stopConfirmed:false,error:null,proofs:{},context:null,proposal:null,threadId:null});s.phase='thinking';s.error=null;
  }
  private quiet(s:GoalSession):void {
    const run=this.run(s);
    ensure(run.attempts.every(a=>a.status!=='running'&&a.settled)&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released),'Follow-up requires settled attempts, confirmed effects and released leases');
    ensure(s.jobs.every(j=>j.status==='finished'&&j.stopConfirmed&&j.usage!==null),'Unresolved model work prevents follow-up');
    new VerificationRepository(this.db).assertNoVerificationWriter(s.workspace);
    for(const row of this.db.prepare('SELECT record FROM executions').all()){
      const execution=JSON.parse(String(row.record)) as {workspace:string;stopConfirmed:boolean};
      const overlaps=execution.workspace===s.workspace||execution.workspace.startsWith(s.workspace+sep)||s.workspace.startsWith(execution.workspace+sep);
      ensure(!overlaps||execution.stopConfirmed,'Follow-up has an active or unverified workspace writer');
    }
    if(s.runtimeId)ensure(new RuntimeRepository(this.db).currentOperations(s.runtimeId).every(o=>['queued','confirmed','failed','cancelled'].includes(o.state)),'Follow-up has unresolved runtime work');
  }
  /** Safe boundary dispatch: the message fence and frozen input are durable before any model call. */
  beginFollowup(sessionId:string,messageId:string):GoalInspection {return this.tx(()=>{
    const s=this.get(sessionId),repository=new ConversationRepository(this.db),message=repository.message(messageId),conversation=repository.get(message.conversationId);
    ensure(conversation.activeSessionId===s.id&&conversation.activeRunId===s.id&&conversation.projectId===s.projectId,'Follow-up must target the active conversation round');
    const previous=s.jobs.findLast(j=>j.followup?.messageId===messageId&&j.followup.processingAttempt===message.processing?.attempt);
    if(previous&&['processing','applied'].includes(message.state))return this.inspect(s.id);
    ensure(!['succeeded','cancelled'].includes(this.run(s).status)&&s.phase!=='cancelled','Terminal goal cannot accept follow-up execution');
    this.quiet(s);
    const parents=repository.clarificationParents(messageId);
    const processing=repository.beginProcessing(messageId);ensure(processing.processing?.runId===s.id&&processing.processing.baseContractVersion===this.run(s).contract.version,'Follow-up message has a stale processing boundary');
    for(const source of [...parents,message]){
      const requirement={id:source.id,role:'user' as const,text:source.text,createdAt:source.createdAt};
      const existing=s.messages.find(m=>m.id===source.id);
      if(source.kind==='question')ensure(!existing,'Read-only question was incorrectly included in requirements');
      else if(existing)ensure(canonical(existing)===canonical(requirement),'Immutable follow-up requirement changed');else s.messages.push(requirement);
    }
    this.begin(s,'followup');
    s.jobs.at(-1)!.followup={conversationId:conversation.id,messageId,messageSequence:processing.processing.throughSequence,processingAttempt:processing.processing.attempt,baseContractVersion:processing.processing.baseContractVersion,relatedMessageIds:parents.map(parent=>parent.id),messages:structuredClone(s.messages),appliedContractVersion:null};
    this.save(s);return this.inspect(s.id);
  });}
  /** No reasoning is started here: attaching a pristine draft must precede its first reservation. */
  createContinuation(conversationId:string,commandId:string):GoalInspection {return this.tx(()=>{
    ensure(typeof commandId==='string'&&commandId.trim()&&commandId.length<=4096&&!commandId.includes('\0'),'Invalid continuation commandId');
    const request={type:'createContinuation',conversationId,commandId},prior=this.db.prepare('SELECT request,session_id FROM goal_receipts WHERE command_id=?').get(commandId);
    if(prior){ensure(prior.request===canonical(request),'Conflicting continuation commandId');return this.inspect(String(prior.session_id));}
    const repository=new ConversationRepository(this.db),conversation=repository.get(conversationId),authorization=repository.childAuthorization(conversationId),previous=this.get(conversation.activeSessionId);this.quiet(previous);
    const id='goal-'+hash('continuation:'+commandId).slice(0,24),now=new Date().toISOString();
    const run=createDraftRun({id,projectId:authorization.projectId,goal:previous.goal,budget:{unit:'token',limit:authorization.tokenLimit,verificationReserve:authorization.verificationReserve}});
    this.db.prepare('INSERT INTO runs(project_id,id,revision,snapshot) VALUES (?,?,?,?)').run(run.projectId,id,run.revision,canonical(run));
    const conversationMessages=new Map(repository.messages(conversationId).map(m=>[m.id,m]));
    const confirmedMessages=previous.messages.filter(m=>!conversationMessages.has(m.id)||conversationMessages.get(m.id)!.state==='applied');
    const s:GoalSession={id,projectId:authorization.projectId,workspace:authorization.workspace,workspaceKind:previous.workspaceKind,revision:0,goal:previous.goal,phase:'ready',messages:structuredClone(confirmedMessages),jobs:[],proposal:structuredClone(previous.proposal),runtimeId:null,error:null,createdAt:now,updatedAt:now,config:structuredClone(previous.config),maxContextChars:previous.maxContextChars,continuation:{conversationId,predecessorSessionId:previous.id,predecessorRunId:authorization.predecessorRunId,predecessorDeliveryId:authorization.predecessorDeliveryId,proposalJobId:previous.jobs.findLast(j=>j.proposal&&canonical(j.proposal)===canonical(previous.proposal))?.id??null}};
    this.db.prepare('INSERT INTO goal_sessions(id,project_id,run_id,record) VALUES (?,?,?,?)').run(id,s.projectId,id,canonical(s));
    repository.attachRound(conversationId,id,authorization.predecessorDeliveryId);new VerificationLineageRepository(this.db).bindContinuation({commandId:'lineage:'+commandId,conversationId,runId:id,predecessorRunId:authorization.predecessorRunId,predecessorDeliveryId:authorization.predecessorDeliveryId});this.receipted(request,id,commandId);return this.inspect(id);
  });}
  /** Controller verifies the assessment proof bytes and stopped identities first. */
  promoteAssessment(assessmentId:string):GoalInspection {return this.tx(()=>{
    const repository=new ConversationRepository(this.db),job=repository.assessment(assessmentId);
    if(job.promotion)return this.inspect(job.promotion.childSessionId);
    return repository.promoteAssessment(assessmentId,()=>{
      const child=this.createContinuation(job.conversationId,`assessment-continuation:${job.id}`);
      const begun=this.beginFollowup(child.session.id,job.messageId);
      return {value:begun,childSessionId:begun.session.id,childRunId:begun.run.id,childProcessingAttempt:repository.message(job.messageId).processing!.attempt};
    });
  });}
  /** Controller must inspect actual process identities and rehash proof files before this call. */
  applyFollowup(sessionId:string,jobId:string):GoalInspection {return this.tx(()=>{
    const s=this.get(sessionId),job=s.jobs.find(j=>j.id===jobId);ensure(job?.purpose==='followup'&&job.followup,'Missing follow-up job');
    const frozen=job.followup,repository=new ConversationRepository(this.db),message=repository.message(frozen.messageId),conversation=repository.get(frozen.conversationId);
    if(frozen.appliedContractVersion!==null){ensure(message.state==='applied'&&message.appliedContractVersion===frozen.appliedContractVersion,'Follow-up application receipt conflicts');return this.inspect(sessionId);}
    ensure(conversation.activeSessionId===sessionId&&conversation.activeRunId===sessionId&&message.conversationId===conversation.id,'Follow-up round changed');
    ensure(message.state==='processing'&&message.sequence===frozen.messageSequence&&message.processing?.runId===sessionId&&message.processing.baseContractVersion===frozen.baseContractVersion&&message.processing.throughSequence===frozen.messageSequence&&message.processing.attempt===frozen.processingAttempt,'Follow-up message processing boundary changed');
    ensure(job.status==='finished'&&!job.error&&job.stopConfirmed&&job.usage!==null&&Object.keys(job.proofs).length>0&&Object.values(job.proofs).every(value=>/^[a-f0-9]{64}$/.test(value)),'Follow-up requires finished, stopped, accounted reasoning and proof receipts');
    ensure(canonical(s.messages)===canonical(frozen.messages),'Follow-up requirement snapshot changed');
    const run=this.run(s);ensure(run.contract.version===frozen.baseContractVersion,'Contract changed after follow-up reasoning');ensure(!['succeeded','cancelled'].includes(run.status),'Terminal goal cannot apply follow-up');this.quiet(s);
    ensure(job.followupResult?.decision==='revise'&&canonical(job.followupResult.proposal)===canonical(job.proposal),'Follow-up application requires the complete revise decision');
    const originalRun=s.continuation&&run.admission==='draft'?this.inspect(s.continuation.predecessorSessionId).run:run;
    const originalContract=run.admission==='draft'&&!s.continuation&&s.proposal?.decision==='ready'?{...run.contract,criteria:s.proposal.criteria.map(criterion=>({id:criterion.id,required:true,description:[criterion.description,`Acceptance kind: ${criterion.kind}; target: ${criterion.target}`,...criterion.checks].join('\n')}))}:originalRun.contract;
    const context={originalContract,originalProposal:s.proposal,frozenMessages:repository.messages(frozen.conversationId).filter(item=>item.sequence<=frozen.messageSequence),newMessageId:frozen.messageId,session:{...s,messages:frozen.messages}};
    const evolution=job.followupResult.criterionChanges?validateFollowupEvolution(job.followupResult,context,frozen.relatedMessageIds):null;
    const reviewed=evolution?validateEvolutionReview((job.context as {acceptanceReview?:unknown}|null)?.acceptanceReview,evolution,context,frozen.relatedMessageIds):null;
    if(reviewed)ensure(reviewed.approved,'Contract evolution lacks independent authorization');
    const candidate={...s,messages:structuredClone(frozen.messages),proposal:job.proposal},plan=admittedPlan(candidate,run);
    ensure(run.budget.limit-run.budget.spent-run.budget.verificationReserve>=s.config.reservation,'Insufficient execution budget after follow-up reasoning');
    const nodes=plan.steps.map((step,i)=>({id:step.id,dependencies:i?[plan.steps[i-1]!.id]:[],required:true})),runtime=new RuntimeRepository(this.db);
    const acknowledge=()=>{repository.applyProcessingGroup(frozen.messageId,frozen.relatedMessageIds,plan.contract.version,job.followupResult?.response);frozen.appliedContractVersion=plan.contract.version;s.proposal=structuredClone(job.proposal);s.phase='admitted';s.error=null;this.save(s);
      if(evolution&&reviewed&&(run.admission==='admitted'||s.continuation)){
        const lineage=new VerificationLineageRepository(this.db),binding=lineage.resolveRun(s.projectId,s.id);
        const transition:AppliedContractTransition={id:'transition:'+job.id,lineageId:binding.lineageId,from:{projectId:s.projectId,runId:originalRun.id,contractDigest:lineageDigest(originalContract)},to:{projectId:s.projectId,runId:s.id,contractDigest:lineageDigest(plan.contract)},fromContract:originalContract,toContract:plan.contract,conversationId:frozen.conversationId,sessionId:s.id,reasoningJobId:job.id,messageId:frozen.messageId,messageSequence:frozen.messageSequence,processingAttempt:frozen.processingAttempt,relatedMessageIds:frozen.relatedMessageIds,changes:evolution.criterionChanges!,review:reviewed as AppliedContractTransition['review'],proofs:job.proofs};
        lineage.recordAppliedTransition({commandId:'transition:'+job.id,transition});
      }
    };
    if(s.runtimeId){runtime.revise({commandId:`${job.id}:apply-followup`,runtimeId:s.runtimeId,expectedContractVersion:frozen.baseContractVersion,contract:plan.contract,nodes,steps:plan.steps,reason:`User follow-up ${frozen.messageId} at conversation sequence ${frozen.messageSequence}`},acknowledge);}
    else {
      ensure(run.admission==='draft','Admitted goal is missing its runtime');runtime.assertWorkspaceAvailable(s.workspace);
      this.act(s,{type:'admit',contract:plan.contract,nodes});
      s.runtimeId=runtime.adoptGoal({type:'submit',commandId:`${job.id}:apply-followup`,workspace:s.workspace,workspaceKind:s.workspaceKind,goal:plan.contract.goal,tokenLimit:run.budget.limit,verificationReserve:run.budget.verificationReserve,steps:plan.steps},s.projectId,s.id).id;acknowledge();
    }
    return this.inspect(s.id);
  });}
  startReceipt(a:Extract<OrchestrationAction,{type:'start'}>):GoalInspection|null {const prior=this.receipt(a);return prior?this.inspect(prior.id):null;}
  start(a:Extract<OrchestrationAction,{type:'start'}>,workspace:string,workspaceKind:'project'|'managed'):GoalInspection {return this.tx(()=>{
    const prior=this.receipt(a);if(prior)return this.inspect(prior.id);
    const id='goal-'+hash(a.commandId).slice(0,24),projectId='workspace-'+hash(workspace).slice(0,24),now=new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO projects(id,name) VALUES (?,?)').run(projectId,basename(workspace));
    const run=createDraftRun({id,projectId,goal:a.goal,budget:{unit:'token',limit:a.tokenLimit,verificationReserve:a.verificationReserve}});
    this.db.prepare('INSERT INTO runs(project_id,id,revision,snapshot) VALUES (?,?,?,?)').run(projectId,id,run.revision,canonical(run));
    const s:GoalSession={id,projectId,workspace,workspaceKind,revision:0,goal:a.goal,phase:'thinking',messages:[{id:`${id}:message:1`,role:'user',text:a.goal,createdAt:now}],jobs:[],proposal:null,runtimeId:null,error:null,createdAt:now,updatedAt:now,config:{model:a.model,effort:a.effort,reservation:a.reservation,timeoutMs:a.timeoutMs},maxContextChars:a.maxContextChars??60000};
    this.db.prepare('INSERT INTO goal_sessions(id,project_id,run_id,record) VALUES (?,?,?,?)').run(id,projectId,id,canonical(s));this.begin(s,'requirements');this.save(s);new ConversationRepository(this.db).ensureForGoal(s.id);new VerificationLineageRepository(this.db).bindRoot({commandId:'lineage-root:'+a.commandId,projectId,runId:id});this.receipted(a,id,a.commandId);return this.inspect(id);
  });}
  validateAdmission(a:Extract<OrchestrationAction,{type:'admit'}>):void {
    if(this.receipt(a))return;const s=this.get(a.sessionId),run=this.run(s);
    ensure(!new ConversationRepository(this.db).hasPendingForRun(s.projectId,s.id),'Pending follow-up prevents ordinary admission');
    ensure(a.expectedRevision===s.revision,'Goal revision changed');ensure(s.phase==='ready'&&!s.runtimeId,'Goal is not ready for admission');
    ensure(s.jobs.every(j=>j.status==='finished'&&j.stopConfirmed&&j.usage!==null),'Unresolved model work prevents admission');
    const plan=admittedPlan(s,run);applyAction(run,{type:'admit',contract:plan.contract,nodes:plan.steps.map((step,i)=>({id:step.id,dependencies:i?[plan.steps[i-1]!.id]:[],required:true}))});
    ensure(run.budget.limit-run.budget.spent-run.budget.verificationReserve>=s.config.reservation,'Insufficient execution budget');
  }
  control(a:Exclude<OrchestrationAction,{type:'start'}|{type:'list'}|{type:'inspect';sessionId:string}>):GoalInspection {return this.tx(()=>{
    const prior=this.receipt(a);if(prior)return this.inspect(prior.id);const s=this.get(a.sessionId);
    if(a.type==='cancel'){ensure(!s.runtimeId,'Cancel admitted tasks through runtime');this.act(s,{type:'cancel'});s.phase='cancelled';}
    else {ensure(s.phase!=='cancelled','Goal is cancelled');ensure(a.expectedRevision===s.revision,'Goal revision changed');
      if(a.type==='admit'){
        ensure(!new ConversationRepository(this.db).hasPendingForRun(s.projectId,s.id),'Pending follow-up prevents ordinary admission');
        ensure(s.phase==='ready'&&!s.runtimeId,'Goal is not ready for admission');const plan=admittedPlan(s,this.run(s));
        ensure(s.jobs.every(j=>j.status==='finished'&&j.stopConfirmed&&j.usage!==null),'Unresolved model work prevents admission');
        this.act(s,{type:'admit',contract:plan.contract,nodes:plan.steps.map((step,i)=>({id:step.id,dependencies:i?[plan.steps[i-1]!.id]:[],required:true}))});
        const run=this.run(s);ensure(run.budget.limit-run.budget.spent-run.budget.verificationReserve>=s.config.reservation,'Insufficient execution budget');
        const runtime=new RuntimeRepository(this.db).adoptGoal({type:'submit',commandId:a.commandId,workspace:s.workspace,workspaceKind:s.workspaceKind,goal:s.goal,tokenLimit:run.budget.limit,verificationReserve:run.budget.verificationReserve,steps:plan.steps},s.projectId,s.id);s.runtimeId=runtime.id;s.phase='admitted';
      }else {
        const conversations=new ConversationRepository(this.db);
        ensure(!conversations.hasPendingForRun(s.projectId,s.id)&&!s.jobs.some(j=>j.followup&&conversations.message(j.followup.messageId).state==='processing'),'Pending follow-up prevents legacy answer or restore');
        if(a.type==='answer'){ensure(!s.runtimeId&&!s.jobs.some(j=>j.status==='running'),'Cannot change requirements during execution or reasoning');s.messages.push({id:`${s.id}:message:${s.messages.length+1}`,role:'user',text:a.text,createdAt:new Date().toISOString()});s.proposal=null;}
        if(a.type==='restore'&&s.runtimeId){const runtime=new RuntimeRepository(this.db).inspect(s.runtimeId);ensure(['awaiting-verification','paused','blocked'].includes(runtime.runtime.phase)&&runtime.run.attempts.every(x=>x.status!=='running'&&x.settled),'Runtime must be quiescent before context restoration');}
        this.begin(s,a.type==='restore'?'restore':'requirements');
      }
    }
    this.save(s);this.receipted(a,s.id,a.commandId);return this.inspect(s.id);
  });}
  update(id:string,jobId:string,change:(job:ReasoningJob,session:GoalSession)=>void):GoalInspection {return this.tx(()=>{const s=this.get(id),j=s.jobs.find(j=>j.id===jobId);ensure(j?.status==='running','Reasoning job is not running');change(j,s);this.save(s);return this.inspect(id);});}
  finish(id:string,jobId:string,change:(job:ReasoningJob)=>void):GoalInspection{return this.tx(()=>{
    const s=this.get(id),j=s.jobs.find(j=>j.id===jobId);ensure(j,'Missing job');if(j.status==='finished')return this.inspect(id);change(j);if(this.run(s).status==='cancelled')s.phase='cancelled';j.status='finished';j.finishedAt=new Date().toISOString();
    this.act(s,{type:'finishAttempt',attemptId:j.attemptId,outcome:s.phase==='cancelled'?'cancelled':j.error?'failed':'succeeded'});
    if(j.usage!==null)this.act(s,{type:'settleAttempt',attemptId:j.attemptId,actual:j.usage});
    this.act(s,{type:'setOperation',operationId:j.attemptId,attemptId:j.attemptId,status:j.stopConfirmed?'confirmed':'unknown'});
    if(j.followup){
      if(j.followupResult)j.proposal=structuredClone(j.followupResult.proposal);
      const answered=j.followupResult?.decision==='answer';
      const error=j.error??(j.usage===null?'Follow-up reasoning usage is unknown':!j.stopConfirmed?'Follow-up reasoning writer is not confirmed stopped':!answered&&!j.proposal?'Follow-up reasoning returned no proposal':null);
      if(!error&&answered){
        const message=new ConversationRepository(this.db).message(j.followup.messageId);
        ensure(message.kind!=='change','Explicit changes cannot be answered as read-only inquiries');
        if(message.kind==='unclassified')s.messages=s.messages.filter(requirement=>requirement.id!==message.id);
      }
      if(s.phase!=='cancelled'){s.error=error;s.phase=error?'blocked':j.proposal?.decision==='clarify'?'clarifying':s.runtimeId?'admitted':s.proposal?.decision==='clarify'?'clarifying':'ready';}
      if(error||s.phase==='cancelled'){
        const repository=new ConversationRepository(this.db),message=repository.message(j.followup.messageId);
        if(message.state==='processing')repository.transition(message.id,'failed',{reason:error??'Follow-up was cancelled'});
      }
    }else if(s.phase!=='cancelled'){s.error=j.error;s.phase=j.error||j.usage===null||!j.stopConfirmed?'blocked':s.runtimeId?'admitted':j.proposal?.decision==='ready'?'ready':'clarifying';if(j.proposal&&!j.error&&!s.runtimeId)s.proposal=j.proposal;}
    this.save(s);return this.inspect(id);
  });}
}
