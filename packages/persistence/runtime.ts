import { ConversationRepository } from './conversations.js';
import { VerificationRepository } from './verification.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { basename, join, relative, sep } from 'node:path';
import type { Run, RunAction, TaskContract, CreateRunInput } from '../contracts/p1.js';
import { parseRuntimeAction, type RuntimeBinding, type RuntimeCheckpoint, type RuntimeControl, type RuntimeEvent, type RuntimeOperation, type RuntimeRecord, type RuntimeReport, type RuntimeSubmit } from '../contracts/p3.js';
import { applyAction, createRun } from '../domain/index.js';
import type { FutureVerificationAllocation, RuntimeAppendRepair, RuntimeFutureVerification, RuntimeRepairBoundary, RuntimeRetryFailure } from '../contracts/p6-loop.js';
import type { ExecutionRecord } from '../contracts/p2.js';
import type { SupervisionJob, SupervisionRecord } from '../contracts/p6-supervision.js';
import type { Candidate } from '../verification/candidate.js';
import { canonical as verificationCanonical, exclusions } from '../verification/candidate.js';
import { evaluateVerification } from '../verification/rules.js';

export function runtimeCanonical(v: unknown): string {
  if(v===null||typeof v!=='object')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(runtimeCanonical).join(',')+']';
  return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+runtimeCanonical(x)).join(',')+'}';
}
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const ensure=(v:unknown,message:string):void=>{if(!v)throw new Error(message);};
/** Same bounded file/mode evidence as P4; kept synchronous inside the mutation transaction. */
function assertRepairCandidate(candidate:Candidate,workspace:string):void {
  ensure(candidate.root===realpathSync(workspace),'Repair candidate belongs to another workspace');
  const scan=(directory:string)=>{
    const root=realpathSync(directory),files:Record<string,string>=Object.create(null) as Record<string,string>;let bytes=0;
    const walk=(directory:string):void=>{for(const name of readdirSync(directory).sort()){
      if(exclusions.includes(name))continue;const absolute=join(directory,name),info=lstatSync(absolute),local=relative(root,absolute).split(sep).join('/');
      ensure(!info.isSymbolicLink(),'Repair candidate contains an unsupported symlink');
      if(info.isDirectory())walk(absolute);else {ensure(info.isFile(),'Repair candidate contains an unsupported file');bytes+=info.size;ensure(Object.keys(files).length<10000&&bytes<=256*1024*1024,'Repair candidate exceeds P4 capacity');files[local]=createHash('sha256').update(readFileSync(absolute)).update('\0executable:'+String(info.mode&0o111)).digest('hex');}
    }};walk(root);ensure(Object.keys(files).length>0,'Repair candidate has no deliverable files');return files;
  };
  ensure(hash(verificationCanonical(candidate.files))===candidate.digest,'Repair frozen candidate digest mismatch');
  ensure(verificationCanonical(scan(candidate.tree))===verificationCanonical(candidate.files),'Repair frozen candidate changed');
  ensure(verificationCanonical(scan(candidate.root))===verificationCanonical(candidate.files),'Repair current candidate changed');
}
function validateBoundary(input:RuntimeRepairBoundary,keys:string[]):void {
  ensure(input&&typeof input==='object'&&!Array.isArray(input),'Invalid runtime repair request');
  const descriptors=Object.getOwnPropertyDescriptors(input);
  for(const key of Reflect.ownKeys(descriptors))ensure(typeof key==='string'&&keys.includes(key)&&'value' in descriptors[key]!&&descriptors[key]!.enumerable,'Unknown or unsafe runtime repair field');
  for(const key of keys)ensure(Object.hasOwn(input,key),'Missing runtime repair field '+key);
  for(const key of ['commandId','runtimeId','reason']){const value=input[key as keyof RuntimeRepairBoundary];ensure(typeof value==='string'&&value.trim()&&!value.includes('\0')&&value.length<=(key==='reason'?12000:200),'Invalid runtime repair '+key);}
  ensure(Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0,'Invalid runtime repair revision');
  ensure(Number.isSafeInteger(input.expectedContractVersion)&&input.expectedContractVersion>=1,'Invalid runtime repair contract');
}
const boundaryKeys=['commandId','runtimeId','expectedContractVersion','expectedRevision','reason'];
export class RuntimeRepository {
  constructor(private readonly db: DatabaseSync) {}
  private tx<T>(work:()=>T):T {
    // Conversation acknowledgement and plan replacement share their outer
    // transaction. Never commit an enclosing repository's transaction here.
    const owns=!this.db.isTransaction;
    if(owns)this.db.exec('BEGIN IMMEDIATE');
    try{const result=work();if(result&&typeof (result as {then?:unknown}).then==='function')throw new Error('Runtime transactions must be synchronous');if(owns)this.db.exec('COMMIT');return result;}
    catch(e){if(owns)this.db.exec('ROLLBACK');throw e;}
  }
  get(id:string):RuntimeRecord {const row=this.db.prepare('SELECT record FROM runtime_runs WHERE id=?').get(id);if(!row)throw new Error('Unknown runtime');return JSON.parse(String(row.record)) as RuntimeRecord;}
  list():RuntimeRecord[] {return this.db.prepare('SELECT record FROM runtime_runs ORDER BY rowid DESC').all().map(r=>JSON.parse(String(r.record)) as RuntimeRecord);}
  operations(id?:string):RuntimeOperation[] {return (id?this.db.prepare('SELECT record FROM runtime_outbox WHERE runtime_id=? ORDER BY rowid').all(id):this.db.prepare('SELECT record FROM runtime_outbox ORDER BY rowid').all()).map(r=>JSON.parse(String(r.record)) as RuntimeOperation);}
  currentOperations(id:string):RuntimeOperation[] {
    const version=this.run(this.get(id)).contract.version,current=new Map<number,RuntimeOperation>();
    for(const op of this.operations(id).filter(o=>o.contractVersion===version)){
      const prior=current.get(op.stepIndex);
      if(!prior||((op.generation??0)>(prior.generation??0)))current.set(op.stepIndex,op);
    }
    return [...current.values()].sort((a,b)=>a.stepIndex-b.stepIndex);
  }
  private operation(id:string):RuntimeOperation {const row=this.db.prepare('SELECT record FROM runtime_outbox WHERE id=?').get(id);if(!row)throw new Error('Unknown operation');return JSON.parse(String(row.record)) as RuntimeOperation;}
  private run(r:RuntimeRecord):Run {const row=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(r.projectId,r.runId);if(!row)throw new Error('Missing runtime domain Run');return JSON.parse(String(row.snapshot)) as Run;}
  private action(r:RuntimeRecord,action:RunAction) {const value=applyAction(this.run(r),action);this.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(runtimeCanonical(value.run),value.run.revision,r.projectId,r.runId);for(const e of value.events)this.db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES (?,?,?,?,?)').run(r.id,r.projectId,r.runId,e.type,runtimeCanonical(e));return value.run;}
  private save(r:RuntimeRecord,kind:string,payload:unknown) {r.projectionVersion++;r.updatedAt=new Date().toISOString();this.db.prepare('UPDATE runtime_runs SET record=? WHERE id=?').run(runtimeCanonical(r),r.id);this.db.prepare('INSERT INTO runtime_events(runtime_id,kind,payload,created_at) VALUES (?,?,?,?)').run(r.id,kind,runtimeCanonical(payload),r.updatedAt);}
  private saveOp(o:RuntimeOperation) {this.db.prepare('UPDATE runtime_outbox SET record=? WHERE id=?').run(runtimeCanonical(o),o.id);}
  events(id:string,after:number):RuntimeEvent[] {this.get(id);return this.db.prepare('SELECT * FROM runtime_events WHERE runtime_id=? AND seq>? ORDER BY seq LIMIT 500').all(id,after).map(r=>({seq:Number(r.seq),runtimeId:id,kind:String(r.kind),payload:JSON.parse(String(r.payload)),createdAt:String(r.created_at)}));}
  inspect(id:string) {const runtime=this.get(id);return {runtime,run:this.run(runtime),operations:this.operations(id),checkpoints:this.db.prepare('SELECT record,digest FROM runtime_checkpoints WHERE runtime_id=? ORDER BY rowid').all(id).map(r=>({checkpoint:JSON.parse(String(r.record)) as RuntimeCheckpoint,digest:String(r.digest),valid:hash(String(r.record))===r.digest}))};}
  checkpoint(id:string):RuntimeCheckpoint|null {const r=this.get(id);if(!r.checkpointId)return null;const row=this.db.prepare('SELECT record,digest FROM runtime_checkpoints WHERE id=?').get(r.checkpointId);ensure(row,'Missing checkpoint');ensure(hash(String(row!.record))===row!.digest,'Checkpoint digest mismatch');const c=JSON.parse(String(row!.record)) as RuntimeCheckpoint;ensure(c.schemaVersion===1&&c.workflowVersion===1,'Unsupported checkpoint version');ensure(c.runtimeId===r.id&&c.cursor===r.cursor,'Checkpoint position mismatch');ensure(c.contractVersion===this.run(r).contract.version,'Checkpoint contract version mismatch');return c;}
  private checkpointWrite(r:RuntimeRecord, parent?:RuntimeCheckpoint|null) {
    const run=this.run(r);const old=parent===undefined?(r.checkpointId?this.checkpoint(r.id):null):parent;
    const plans=[...this.db.prepare('SELECT definition FROM verification_plans WHERE project_id=? AND run_id=? ORDER BY id').all(r.projectId,r.runId).map(x=>JSON.parse(String(x.definition)) as unknown),...new VerificationRepository(this.db).list('plan',r.id)];
    const retained=new Map<string,unknown>();for(const p of [...(old?.frozenPlans??[]),...plans]){const v=p as {id:string};if(retained.has(v.id))ensure(runtimeCanonical(retained.get(v.id))===runtimeCanonical(p),'Frozen plan changed');retained.set(v.id,p);}
    const c:RuntimeCheckpoint={id:`${r.id}:checkpoint:${r.projectionVersion+1}`,runtimeId:r.id,schemaVersion:1,workflowVersion:1,cursor:r.cursor,contractVersion:run.contract.version,domainRevision:run.revision,budget:run.budget,attempts:run.attempts,operations:run.operations,artifact:run.artifact,frozenPlans:[...retained.values()],createdAt:new Date().toISOString()};
    if(old)c.parentId=old.id;
    const content=runtimeCanonical(c);this.db.prepare('INSERT INTO runtime_checkpoints(id,runtime_id,digest,record) VALUES (?,?,?,?)').run(c.id,r.id,hash(content),content);r.checkpointId=c.id;
  }
  private enqueue(r:RuntimeRecord,generation=0,supersedes?:string) {
    const step=r.definition.steps[r.cursor];if(!step)return;
    const id='op-'+hash(`${r.id}:${this.run(r).contract.version}:${step.id}`+(generation?`:generation:${generation}`:'')).slice(0,32);
    const attemptId=step.kind==='codex'?'exec-'+hash(id).slice(0,24):id;
    const op:RuntimeOperation={id,runtimeId:r.id,stepIndex:r.cursor,step,attemptId,contractVersion:this.run(r).contract.version,owner:null,state:'queued',executionId:step.kind==='codex'?attemptId:null,result:null,error:null};
    if(generation){op.generation=generation;if(supersedes)op.supersedes=supersedes;}
    this.db.prepare('INSERT INTO runtime_outbox(id,runtime_id,record) VALUES (?,?,?)').run(id,r.id,runtimeCanonical(op));
  }
  submit(input:RuntimeSubmit&{workspace:string;workspaceKind:'project'|'managed'}):RuntimeRecord {
    const {workspaceKind,...request}=input;parseRuntimeAction(request);
    return this.tx(()=>{
      const receipt=this.db.prepare('SELECT request,result FROM runtime_receipts WHERE command_id=?').get(input.commandId);
      if(receipt){ensure(receipt.request===runtimeCanonical(input),'Runtime commandId conflicts with prior request');return this.get(String(JSON.parse(String(receipt.result)).id));}
      new VerificationRepository(this.db).assertNoVerificationWriter(input.workspace);
      const id='runtime-'+hash(input.commandId).slice(0,24),projectId='workspace-'+hash(input.workspace).slice(0,24),now=new Date().toISOString();
      for(const active of this.list().filter(r=>r.workspace===input.workspace||r.workspace.startsWith(input.workspace+sep)||input.workspace.startsWith(r.workspace+sep))) ensure(['cancelled','awaiting-verification'].includes(active.phase)&&this.currentOperations(active.id).every(o=>['confirmed','cancelled'].includes(o.state)),'Workspace has unresolved runtime work');
      for(const row of this.db.prepare('SELECT record FROM executions').all()){const e=JSON.parse(String(row.record)) as {workspace:string;stopConfirmed:boolean};ensure(e.stopConfirmed||!(e.workspace===input.workspace||e.workspace.startsWith(input.workspace+sep)||input.workspace.startsWith(e.workspace+sep)),'Workspace has an active or unverified writer');}
      this.db.prepare('INSERT OR IGNORE INTO projects(id,name) VALUES (?,?)').run(projectId,basename(input.workspace));
      const run=createRun({id,projectId,contract:{version:1,goal:input.goal,criteria:[{id:'independent-acceptance',description:'Independently verify the candidate; completing workflow steps is not delivery acceptance',required:true}]},nodes:input.steps.map((s,i)=>({id:s.id,dependencies:i?[input.steps[i-1]!.id]:[],required:true})),budget:{unit:'token',limit:input.tokenLimit,verificationReserve:input.verificationReserve}});
      this.db.prepare('INSERT INTO runs(project_id,id,revision,snapshot) VALUES (?,?,?,?)').run(projectId,id,run.revision,runtimeCanonical(run));
      const r:RuntimeRecord={id,engine:'local-v1',workflowVersion:1,projectionVersion:0,projectId,runId:id,workspace:input.workspace,workspaceKind,definition:request,cursor:0,phase:input.steps[0]?.kind==='input'?'waiting-input':'ready',paused:false,cancelled:false,createdAt:now,updatedAt:now,error:null,inputs:{},checkpointId:null};
      this.db.prepare('INSERT INTO runtime_runs(id,project_id,run_id,record) VALUES (?,?,?,?)').run(id,projectId,id,runtimeCanonical(r));this.enqueue(r);this.checkpointWrite(r);this.save(r,'submitted',{definition:request});
      this.db.prepare('INSERT INTO runtime_receipts(command_id,request,result) VALUES (?,?,?)').run(input.commandId,runtimeCanonical(input),runtimeCanonical(r));return r;
    });
  }
  assertWorkspaceAvailable(workspace:string):void {
    new VerificationRepository(this.db).assertNoVerificationWriter(workspace);
    for(const active of this.list().filter(r=>r.workspace===workspace||r.workspace.startsWith(workspace+sep)||workspace.startsWith(r.workspace+sep)))ensure(['cancelled','awaiting-verification'].includes(active.phase)&&this.currentOperations(active.id).every(o=>['confirmed','cancelled'].includes(o.state)),'Workspace has unresolved runtime work');
    for(const row of this.db.prepare('SELECT record FROM executions').all()){const e=JSON.parse(String(row.record)) as {workspace:string;stopConfirmed:boolean};ensure(e.stopConfirmed||!(e.workspace===workspace||e.workspace.startsWith(workspace+sep)||workspace.startsWith(e.workspace+sep)),'Workspace has an active or unverified writer');}
  }
  /** Called only inside the goal admission transaction; retains the existing domain ledger. */
  adoptGoal(input:RuntimeSubmit & {workspace:string;workspaceKind:'project'|'managed'},projectId:string,runId:string):RuntimeRecord {
    const {workspaceKind,...request}=input;parseRuntimeAction(request);
    this.assertWorkspaceAvailable(input.workspace);
    const now=new Date().toISOString();
    const r:RuntimeRecord={id:runId,engine:'local-v1',workflowVersion:1,projectionVersion:0,projectId,runId,workspace:input.workspace,workspaceKind,definition:request,cursor:0,phase:'ready',paused:false,cancelled:false,createdAt:now,updatedAt:now,error:null,inputs:{},checkpointId:null};
    ensure(this.run(r).admission==='admitted','Draft cannot execute');
    this.db.prepare('INSERT INTO runtime_runs(id,project_id,run_id,record) VALUES (?,?,?,?)').run(r.id,projectId,runId,runtimeCanonical(r));this.enqueue(r);this.checkpointWrite(r);this.save(r,'admitted',{definition:request});return r;
  }
  /** Revision is a single durable transition, after all old effects and costs are known.
   * The commit hook lets the conversation controller acknowledge its frozen message
   * in this same transaction; a failed acknowledgement rolls back the plan/outbox. */
  revise(input:{commandId:string;runtimeId:string;expectedContractVersion:number;contract:TaskContract;nodes:CreateRunInput['nodes'];steps:RuntimeSubmit['steps'];reason:string},commit?:()=>void):RuntimeRecord {
    return this.tx(()=>{
      const request=runtimeCanonical(input),prior=this.db.prepare('SELECT request,result FROM runtime_receipts WHERE command_id=?').get(input.commandId);
      if(prior){ensure(prior.request===request,'Runtime commandId conflicts with prior revision');return this.get(input.runtimeId);}
      const r=this.get(input.runtimeId);this.compatible(r);const run=this.run(r);
      ensure(run.contract.version===input.expectedContractVersion,'Contract changed before plan revision');
      ensure(!r.cancelled&&!['succeeded','cancelled'].includes(run.status),'Terminal runtime cannot revise');
      new VerificationRepository(this.db).assertNoVerificationWriter(r.workspace);
      for(const row of this.db.prepare('SELECT record FROM executions').all()){
        const e=JSON.parse(String(row.record)) as {workspace:string;stopConfirmed:boolean};
        ensure(e.stopConfirmed||!(e.workspace===r.workspace||e.workspace.startsWith(r.workspace+sep)||r.workspace.startsWith(e.workspace+sep)),'Plan revision has an active or unverified writer');
      }
      const operations=this.currentOperations(r.id);
      ensure(operations.every(o=>['queued','confirmed','failed','cancelled'].includes(o.state)),'Plan revision has unresolved runtime work');
      const definition:RuntimeSubmit={...r.definition,commandId:input.commandId,goal:input.contract.goal,steps:input.steps};parseRuntimeAction(definition);
      ensure(runtimeCanonical(input.nodes.map(n=>n.id))===runtimeCanonical(input.steps.map(s=>s.id)),'Revised steps must exactly match ordered domain nodes');
      ensure(input.nodes.every((n,i)=>runtimeCanonical(n.dependencies)===runtimeCanonical(i?[input.nodes[i-1]!.id]:[])&&n.required),'Sequential runtime requires required ordered dependencies');
      const parent=this.checkpoint(r.id),previousDefinition=r.definition,previousInputs=r.inputs;
      this.action(r,{type:'revisePlan',contract:input.contract,nodes:input.nodes,reason:input.reason});
      for(const op of operations)if(op.state==='queued'){op.state='cancelled';op.error='Superseded by contract revision';this.saveOp(op);}
      r.definition=structuredClone(definition);r.cursor=0;r.error=null;r.inputs={};
      this.enqueue(r);this.checkpointWrite(r,parent);r.phase=this.phase(r);
      this.save(r,'plan-revised',{reason:input.reason,previousDefinition,previousInputs,previousContractVersion:run.contract.version,contractVersion:input.contract.version,parentCheckpointId:parent?.id??null});
      commit?.();
      this.db.prepare('INSERT INTO runtime_receipts(command_id,request,result) VALUES (?,?,?)').run(input.commandId,request,runtimeCanonical(r));return r;
    });
  }
  private repairBoundary(input:RuntimeRepairBoundary):{runtime:RuntimeRecord;run:Run} {
    const runtime=this.get(input.runtimeId);this.compatible(runtime);const run=this.run(runtime);
    ensure(run.contract.version===input.expectedContractVersion,'Repair contract changed');ensure(run.revision===input.expectedRevision,'Repair domain revision changed');
    ensure(!runtime.paused&&!runtime.cancelled&&!['paused','succeeded','cancelled'].includes(run.status),'Repair boundary is paused or terminal');
    ensure(run.admission!=='draft','Repair boundary needs admitted requirements');
    ensure(!new ConversationRepository(this.db).hasPendingForRun(run.projectId,run.id),'Pending follow-up prevents repair boundary');
    ensure(run.attempts.every(a=>a.status!=='running'&&a.settled)&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released),'Repair has unresolved attempts, usage, effects or leases');
    new VerificationRepository(this.db).assertNoVerificationWriter(runtime.workspace);
    for(const row of this.db.prepare('SELECT record FROM executions').all()){
      const e=JSON.parse(String(row.record)) as ExecutionRecord;
      ensure(e.stopConfirmed||!(e.workspace===runtime.workspace||e.workspace.startsWith(runtime.workspace+sep)||runtime.workspace.startsWith(e.workspace+sep)),'Repair has an active or unverified writer');
    }
    return {runtime,run};
  }
  private repairReceipt(input:RuntimeRepairBoundary):RuntimeRecord|null {
    const prior=this.db.prepare('SELECT request,result FROM runtime_receipts WHERE command_id=?').get(input.commandId);
    if(!prior)return null;ensure(prior.request===runtimeCanonical(input),'Runtime commandId conflicts with prior repair boundary');return this.get(input.runtimeId);
  }
  private repairCommit(input:RuntimeRepairBoundary,r:RuntimeRecord,kind:string,payload:unknown,commit?:()=>void):RuntimeRecord {
    this.checkpointWrite(r);r.phase=this.phase(r);this.save(r,kind,payload);
    const result=commit?.();ensure(!result||typeof (result as {then?:unknown}).then!=='function','Repair commit must be synchronous');
    this.db.prepare('INSERT INTO runtime_receipts(command_id,request,result) VALUES (?,?,?)').run(input.commandId,runtimeCanonical(input),runtimeCanonical(r));return r;
  }
  futureVerification(runtimeId:string):FutureVerificationAllocation|null {return this.run(this.get(runtimeId)).budget.futureVerification??null;}
  setFutureVerification(input:RuntimeFutureVerification,commit?:()=>void):RuntimeRecord {
    validateBoundary(input,[...boundaryKeys,'allocationId','amount']);
    return this.tx(()=>{
      const prior=this.repairReceipt(input);if(prior)return prior;const {runtime}=this.repairBoundary(input);
      this.action(runtime,{type:'setFutureVerification',contractVersion:input.expectedContractVersion,allocationId:input.allocationId,amount:input.amount,reason:input.reason});
      return this.repairCommit(input,runtime,'future-verification-allocated',input,commit);
    });
  }
  appendRepair(input:RuntimeAppendRepair,commit?:()=>void):RuntimeRecord {
    validateBoundary(input,[...boundaryKeys,'steps','failureJobId','failedObligationIds']);
    return this.tx(()=>{
      const prior=this.repairReceipt(input);if(prior)return prior;const {runtime,run}=this.repairBoundary(input);
      ensure(runtime.cursor===runtime.definition.steps.length&&this.currentOperations(runtime.id).every(o=>o.state==='confirmed'),'Repair append requires a completed workflow');
      ensure(Array.isArray(input.steps)&&input.steps.length>0&&input.steps.every(s=>s.kind==='codex'),'Repair append needs Codex steps');
      ensure(typeof input.failureJobId==='string'&&input.failureJobId.trim(),'Repair needs a verification job');
      const repo=new VerificationRepository(this.db),job=repo.get('job',input.failureJobId);
      ensure(job.runtimeId===runtime.id&&job.runId===run.id&&job.projectId===run.projectId&&job.kind==='verification'&&job.status==='finished'&&!job.approved&&job.evaluation?.passed===false&&!job.error&&job.stopConfirmed&&!job.usageUnknown,'Repair requires actual product verification failure, not a verifier error');
      ensure(job.planId&&run.artifact?.id===job.planId,'Repair failure is not the current artifact');
      const plan=repo.get('plan',job.planId!),proposal=repo.get('proposal',plan.proposalId);
      ensure(plan.runtimeId===runtime.id&&plan.runId===run.id&&plan.projectId===run.projectId&&job.proposalId===proposal.id&&job.environmentDigest===plan.environmentDigest&&plan.definitionDigest===proposal.bundle.digest&&plan.catalogVersion===proposal.version&&plan.contractDigest===hash(verificationCanonical(run.contract))&&proposal.contractDigest===plan.contractDigest&&repo.head(run.projectId)?.id===proposal.id,'Repair failure has stale contract or catalog');
      const failedAttempt=run.attempts.find(a=>a.id===job.attemptId);
      ensure(failedAttempt?.purpose==='verification'&&failedAttempt.status==='failed'&&failedAttempt.settled&&failedAttempt.actual===job.usage&&Number.isSafeInteger(job.usage)&&job.usage>=0,'Repair failure lacks matching actual verification settlement');
      ensure(job.results.length>0&&job.results.every(r=>r.executionStatus==='executed'),'Repair cannot reinterpret an unexecuted or erroneous verifier');
      ensure(verificationCanonical(evaluateVerification(proposal.spec,plan.selection,job.results))===verificationCanonical(job.evaluation),'Repair report does not match the frozen verification selection');
      ensure(Array.isArray(input.failedObligationIds)&&input.failedObligationIds.length>0&&new Set(input.failedObligationIds).size===input.failedObligationIds.length,'Repair needs unique failed obligations');
      for(const id of input.failedObligationIds)ensure(proposal.spec.obligations.some(o=>o.id===id&&o.required&&o.applicable)&&job.results.some(r=>r.checks.some(c=>c.obligationId===id&&c.verdict==='failed')),'Repair obligation lacks actual necessary failure');
      ensure(Object.keys(job.proofs).length>0&&job.identities.length>0&&job.intents.length===job.identities.length,'Repair failure lacks completed process evidence');
      for(const [path,digest] of Object.entries(job.proofs))ensure(createHash('sha256').update(readFileSync(path)).digest('hex')===digest,'Repair verification evidence changed');
      assertRepairCandidate(plan.candidate,runtime.workspace);
      const definition={...runtime.definition,steps:[...runtime.definition.steps,...input.steps]};parseRuntimeAction(definition);
      const nodes=input.steps.map((s,i)=>({id:s.id,required:true,dependencies:[i?input.steps[i-1]!.id:runtime.definition.steps.at(-1)!.id]}));
      const repaired=this.action(runtime,{type:'appendRepairNodes',contractVersion:input.expectedContractVersion,nodes,reason:input.reason,failureJobId:input.failureJobId,failedObligationIds:input.failedObligationIds});
      // Reject an unfundable first repair before committing a new outbox or invalidating evidence.
      applyAction(repaired,{type:'startAttempt',attemptId:'@repair-budget-check',nodeId:input.steps[0]!.id,contractVersion:repaired.contract.version,reservation:input.steps[0]!.reservation,purpose:'execution',resources:[]});
      runtime.definition=structuredClone(definition);runtime.error=null;this.enqueue(runtime);
      return this.repairCommit(input,runtime,'repair-appended',input,commit);
    });
  }
  retryConfirmedFailure(input:RuntimeRetryFailure,commit?:()=>void):RuntimeRecord {
    validateBoundary(input,[...boundaryKeys,'operationId','replacement']);
    return this.tx(()=>{
      const prior=this.repairReceipt(input);if(prior)return prior;const {runtime,run}=this.repairBoundary(input),op=this.operation(input.operationId);
      ensure(op.runtimeId===runtime.id&&op.contractVersion===run.contract.version&&op.stepIndex===runtime.cursor&&this.currentOperations(runtime.id).find(o=>o.stepIndex===runtime.cursor)?.id===op.id&&op.state==='failed'&&op.step.kind==='codex','Retry needs the current confirmed failed Codex operation');
      const row=this.db.prepare('SELECT record FROM executions WHERE id=?').get(op.executionId!);ensure(row,'Retry has no execution receipt');const execution=JSON.parse(String(row!.record)) as ExecutionRecord;
      ensure(execution.id===op.attemptId&&execution.runId===run.id&&execution.state==='failed'&&execution.stopConfirmed&&execution.usageStatus==='reported'&&execution.usage!==null&&!execution.cancelRequested,'Retry has unknown usage, effects or stop');
      const attempt=run.attempts.find(a=>a.id===op.attemptId);ensure(attempt?.status==='failed'&&attempt.settled&&attempt.actual===execution.usage!.totalTokens,'Retry failed attempt lacks actual settlement');
      ensure(input.replacement?.kind==='codex'&&input.replacement.id===op.step.id,'Retry must preserve the failed step id');
      const definition=structuredClone(runtime.definition);definition.steps[runtime.cursor]=input.replacement;parseRuntimeAction(definition);
      applyAction(run,{type:'startAttempt',attemptId:'@retry-budget-check',nodeId:op.step.id,contractVersion:run.contract.version,reservation:input.replacement.reservation,purpose:'execution',resources:[]});
      runtime.definition=definition;runtime.error=null;this.enqueue(runtime,(op.generation??0)+1,op.id);
      return this.repairCommit(input,runtime,'confirmed-failure-retried',input,commit);
    });
  }
  control(input:RuntimeControl):RuntimeRecord {parseRuntimeAction(input);return this.tx(()=>{
    const receipt=this.db.prepare('SELECT request,result FROM runtime_receipts WHERE command_id=?').get(input.commandId);if(receipt){ensure(receipt.request===runtimeCanonical(input),'Runtime commandId conflicts with prior request');return JSON.parse(String(receipt.result)) as RuntimeRecord;}
    const r=this.get(input.runtimeId);this.compatible(r);
    if(input.type==='cancel') {if(!r.cancelled){r.cancelled=true;r.paused=false;r.phase='cancelled';this.action(r,{type:'cancel'});for(const o of this.operations(r.id))if(o.state==='queued'){o.state='cancelled';this.saveOp(o);}}}
    else {ensure(!r.cancelled||input.type==='reconcile','Cancelled runtime cannot resume or accept input');
      if(input.type==='pause'){if(!r.paused){r.paused=true;r.phase='paused';this.action(r,{type:'pause'});}}
      if(input.type==='resume'){this.checkpoint(r.id);ensure(r.paused,'Runtime is not paused');r.paused=false;this.action(r,{type:'resume'});r.phase=this.phase(r);}
      if(input.type==='input'){const s=r.definition.steps[r.cursor];ensure(s?.kind==='input'&&s.id===input.stepId,'Input is only accepted at the declared current wait');ensure(!Object.hasOwn(r.inputs,input.stepId),'Input already supplied');r.inputs[input.stepId]=input.text;r.phase=this.phase(r);}
      if(input.type==='reconcile'){r.error=null;/* A durable request, consumed by worker query-only reconciliation. */}
    }
    this.save(r,input.type,input);this.db.prepare('INSERT INTO runtime_receipts(command_id,request,result) VALUES (?,?,?)').run(input.commandId,runtimeCanonical(input),runtimeCanonical(r));return r;
  });}
  private compatible(r:RuntimeRecord){ensure(r.engine==='local-v1'&&r.workflowVersion===1,'Unsupported runtime workflow version');this.checkpoint(r.id);}
  private phase(r:RuntimeRecord):RuntimeRecord['phase'] {if(r.cancelled)return 'cancelled';if(r.paused)return 'paused';if(r.cursor>=r.definition.steps.length)return 'awaiting-verification';const o=this.currentOperations(r.id).find(x=>x.stepIndex===r.cursor);if(o&&['unknown','failed'].includes(o.state))return 'blocked';if(o&&['claimed','started'].includes(o.state))return 'running';const s=r.definition.steps[r.cursor]!;return s.kind==='input'&&!Object.hasOwn(r.inputs,s.id)?'waiting-input':'ready';}
  /** A known in-flight read-only inspection briefly delays the next node. It
   * cannot turn arbitrary pending effects or unknown accounting into a wait. */
  private awaitingInspection(r:RuntimeRecord):boolean {
    const run=this.run(r),outstanding=run.attempts.filter(a=>!a.settled||a.status==='running');
    if(outstanding.length!==1||outstanding[0]!.purpose!=='inspection')return false;
    const attempt=outstanding[0]!;
    ensure(attempt.status==='running'&&!attempt.settled&&attempt.nodeId==='@inspection'&&attempt.contractVersion===run.contract.version,'Inspection accounting requires reconciliation');
    ensure(run.operations.every(o=>o.status==='confirmed'||o.status==='pending'&&o.attemptId===attempt.id)&&run.operations.some(o=>o.id===attempt.id&&o.attemptId===attempt.id&&o.status==='pending')&&run.leases.every(l=>l.released),'Inspection wait cannot bypass unresolved effects or leases');
    const row=this.db.prepare('SELECT record FROM supervision_jobs WHERE id=?').get(attempt.id);ensure(row,'Inspection wait has no durable job');const job=JSON.parse(String(row!.record)) as SupervisionJob;
    const saved=this.db.prepare('SELECT record FROM supervision_loops WHERE id=?').get(job.loopId);ensure(saved,'Inspection wait has no supervision owner');const loop=JSON.parse(String(saved!.record)) as SupervisionRecord;
    ensure(job.purpose==='inspection'&&job.status==='running'&&job.attemptId===attempt.id&&job.runtimeId===r.id&&job.projectId===r.projectId&&job.runId===r.runId&&job.contractVersion===run.contract.version&&job.config.reservation===attempt.reservation&&loop.runtimeId===r.id&&loop.contractVersion===run.contract.version&&loop.contractDigest===job.contractDigest&&job.contractDigest===hash(runtimeCanonical(run.contract)),'Inspection wait boundary is stale or inconsistent');
    ensure((loop.monitor as {activeJobId?:string}|null)?.activeJobId===job.id,'Inspection wait has no active monitor binding');
    return true;
  }
  claim(id:string,owner:string):RuntimeOperation|null {return this.tx(()=>{
    const r=this.get(id);this.compatible(r);if(r.paused||r.cancelled||new ConversationRepository(this.db).hasPendingForRun(r.projectId,r.runId))return null;const o=this.currentOperations(id).find(x=>x.stepIndex===r.cursor&&x.state==='queued');if(!o)return null;if(o.step.kind==='input'&&!Object.hasOwn(r.inputs,o.step.id))return null;
    if(this.awaitingInspection(r))return null;
    this.action(r,{type:'startAttempt',attemptId:o.attemptId,nodeId:o.step.id,contractVersion:o.contractVersion,reservation:o.step.kind==='codex'?o.step.reservation:0,purpose:'execution',resources:o.step.kind==='codex'?['workspace:'+r.workspace]:[]});this.action(r,{type:'setOperation',operationId:o.attemptId,attemptId:o.attemptId,status:'pending'});
    o.owner=owner;o.state='claimed';this.saveOp(o);r.phase='running';this.save(r,'claimed',{operationId:o.id,owner});return o;
  });}
  eligible(id:string,owner:string):void {const o=this.operation(id),r=this.get(o.runtimeId);this.compatible(r);ensure(o.owner===owner,'Stale worker qualification');ensure(!r.paused&&!r.cancelled,'Runtime dispatch is paused or cancelled');ensure(['claimed','started'].includes(o.state),'Operation is not eligible');const run=this.run(r);ensure(run.contract.version===o.contractVersion&&run.attempts.find(a=>a.id===o.attemptId)?.status==='running','Stale attempt qualification');}
  markStarted(id:string,owner:string):RuntimeOperation {return this.tx(()=>{this.eligible(id,owner);const o=this.operation(id);if(o.state==='started')return o;o.state='started';this.saveOp(o);const r=this.get(o.runtimeId);this.save(r,'effect-intent',{operationId:id,owner});return o;});}
  binding(id:string,owner:string):RuntimeBinding {this.eligible(id,owner);const o=this.operation(id),r=this.get(o.runtimeId);return {runtimeId:r.id,operationId:id,owner,projectId:r.projectId,runId:r.runId,attemptId:o.attemptId};}
  adopt(id:string,owner:string):RuntimeOperation {return this.tx(()=>{const o=this.operation(id),r=this.get(o.runtimeId);this.compatible(r);ensure(!['confirmed','failed','cancelled'].includes(o.state),'Terminal operation cannot be adopted');o.owner=owner;this.saveOp(o);this.save(r,'recovery-adopted',{operationId:id,owner});return o;});}
  report(id:string,owner:string,report:RuntimeReport):RuntimeRecord {return this.tx(()=>{
    const request=runtimeCanonical({id,owner,report});const prior=this.db.prepare('SELECT request,result FROM runtime_inbox WHERE message_id=?').get(report.messageId);if(prior){ensure(prior.request===request,'Conflicting inbox delivery');return JSON.parse(String(prior.result)) as RuntimeRecord;}
    const o=this.operation(id),r=this.get(o.runtimeId);ensure(o.owner===owner,'Stale worker report');ensure(!['confirmed','failed','cancelled'].includes(o.state),'Operation already terminal');
    let run=this.run(r);ensure(o.contractVersion===run.contract.version,'Stale operation cannot advance revised runtime');let attempt=run.attempts.find(a=>a.id===o.attemptId);ensure(attempt,'Operation has no attempt');
    if(o.step.kind!=='codex'){
      if(report.outcome!=='unknown'&&attempt!.status==='running')this.action(r,{type:'finishAttempt',attemptId:o.attemptId,outcome:report.outcome==='confirmed'?'succeeded':report.outcome==='cancelled'?'cancelled':'failed'});
      if(report.outcome!=='unknown'&&!attempt!.settled)this.action(r,{type:'settleAttempt',attemptId:o.attemptId,actual:0});
      this.action(r,{type:'setOperation',operationId:o.attemptId,attemptId:o.attemptId,status:report.outcome==='confirmed'||(o.state==='claimed'&&report.outcome==='cancelled')?'confirmed':'unknown'});
    } else {
      const execution=this.db.prepare('SELECT record FROM executions WHERE id=?').get(o.executionId!);
      if(!execution && ['claimed','started'].includes(o.state) && report.outcome==='cancelled') {
        if(attempt!.status==='running')this.action(r,{type:'finishAttempt',attemptId:o.attemptId,outcome:'cancelled'});
        if(!attempt!.settled)this.action(r,{type:'settleAttempt',attemptId:o.attemptId,actual:0});
        this.action(r,{type:'setOperation',operationId:o.attemptId,attemptId:o.attemptId,status:'confirmed'});
        const lease=this.run(r).leases.find(l=>l.attemptId===o.attemptId&&!l.released);if(lease)this.action(r,{type:'releaseLease',attemptId:o.attemptId,resource:lease.resource});
      } else {
        ensure(execution,'Codex report needs durable execution receipt');const e=JSON.parse(String(execution!.record)) as {state:string;stopConfirmed:boolean};ensure(e.stopConfirmed||report.outcome==='unknown','Codex writer not confirmed stopped');if(report.outcome==='confirmed')ensure(e.state==='completed'&&attempt!.settled,'Codex result is not completed and settled');
      }
    }
    o.state=report.outcome;o.result=report.result;o.error=report.error??null;this.saveOp(o);r.error=o.error;
    if(report.outcome==='confirmed'&&!r.cancelled){r.cursor++;this.enqueue(r);}
    // Read prior checkpoint before saving the changed cursor; it remains the immutable parent.
    this.checkpointWrite(r);r.phase=this.phase(r);this.save(r,'reported',{operationId:id,report});
    this.db.prepare('INSERT INTO runtime_inbox(message_id,request,result) VALUES (?,?,?)').run(report.messageId,request,runtimeCanonical(r));return r;
  });}
  block(id:string,error:string):void {this.tx(()=>{const r=this.get(id);r.error=error;if(!r.cancelled&&!r.paused)r.phase='blocked';this.save(r,'recovery-blocked',{error});});}
}
