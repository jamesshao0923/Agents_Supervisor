import {ScheduledLoopController} from './scheduled-loop-advance.js';
import {ScheduledResultPublisher} from './scheduled-publication.js';
import {createHash} from 'node:crypto';
import type {SupervisorStore} from '../persistence/store.js';
import {ExecutionManager} from '../execution/manager.js';
import type {Run} from '../contracts/p1.js';
import type {ScheduledClaim,ScheduledRecord} from '../contracts/p7-dispatch.js';

/** Invoked only by the existing process-qualified runtime worker. Each tick
 * releases independent starts without awaiting another branch's completion. */
export class ScheduledRuntimeWorker {
 private readonly manager:ExecutionManager;
 private readonly publisher:ScheduledResultPublisher;
 private readonly loops:ScheduledLoopController;
 private readonly observed=new Map<string,number>();
 private readonly faults=new Map<string,string>();
 private closed=false;
 constructor(private readonly store:SupervisorStore,dataDir:string,private readonly owner:string,codex=process.env.SUPERVISOR_CODEX_PATH??'codex'){
  this.publisher=new ScheduledResultPublisher(store);
  this.loops=new ScheduledLoopController(store);
  this.manager=new ExecutionManager(store,dataDir,codex,{scope:'scheduled',eligibility:id=>{const record=store.executionGet(id);if(!record.scheduledBinding)throw Error('Scheduled execution lacks claim binding');store.scheduler.eligible(record.scheduledBinding.operationId,record.scheduledBinding.owner);}});
 }
 async initialize():Promise<void>{await this.manager.initialize();}
 errors():{schedulerId:string;reason:string}[]{return [...this.faults].map(([schedulerId,reason])=>({schedulerId,reason}));}
 async tick():Promise<void>{
  for(const record of this.store.scheduler.list()){
   if(this.closed)return;
   try{await this.advance(record);this.faults.delete(record.id);}catch(error){this.faults.set(record.id,error instanceof Error?error.message:String(error));}
  }
 }
 private async start(claim:ScheduledClaim):Promise<void>{
  // A different owner's unstarted intent needs explicit host handover proof;
  // this first adapter never impersonates that owner or replays unknown work.
  if(claim.owner!==this.owner)throw Error('Prior scheduled owner requires qualified recovery');
  this.store.scheduler.prepareInputs(claim.id,this.owner);
  // Frozen executionInput owns its prompt; never append input context here.
  const binding=this.store.scheduler.binding(claim.id,this.owner);
  this.store.scheduler.markStarted(binding);
  const {workspaceKind,...input}=this.store.scheduler.executionInput(claim.id);
  await this.manager.startScheduled(input,binding);
 }
 private async advance(record:ScheduledRecord):Promise<void>{
  const runtime=this.store.runtime.get(record.plan.runtimeId),run=this.store.query({type:'run',projectId:record.plan.projectId,runId:record.plan.runId}) as Run;
  const cancelled=runtime.cancelled||['cancelled','blocked'].includes(record.state)||run.status==='cancelled';
  const expired=Date.now()>=record.plan.limits.deadlineMs;
  this.store.scheduledLoops.observeDeadlines(record.id);
  const publicationErrors:string[]=[];
  for(const claim of this.store.scheduler.claims(record.id)){
   const operation=this.store.scheduler.operation(claim.operationId);
   if(operation.state==='confirmed'){if(!cancelled&&!runtime.paused&&record.state==='active'&&record.fence==='held')try{await this.publisher.publish(claim);}catch(error){const reason=error instanceof Error?error.message:String(error);this.store.scheduledLoops.publicationBlocked(claim,reason);publicationErrors.push(claim.taskId+': '+reason);}continue;}
   if(['failed','cancelled'].includes(operation.state))continue;
   const execution=this.store.executionList().find(e=>e.id===claim.attemptId);
   if(execution){
    if((cancelled||expired||this.store.scheduledLoops.shouldStopClaim(claim))&&!execution.stopConfirmed)await this.manager.cancel(execution.id);
    const latest=this.store.executionGet(execution.id);
    if((latest.stopConfirmed||latest.state==='unknown')&&this.observed.get(latest.id)!==latest.lastEventSeq){
     const settled=await this.store.scheduler.reconcileExecution({commandId:'scheduled-observe:'+latest.id+':'+latest.lastEventSeq,claimId:claim.id,executionId:latest.id});this.observed.set(latest.id,latest.lastEventSeq);if(settled.state==='confirmed'&&!cancelled&&!runtime.paused&&record.state==='active'&&record.fence==='held')try{await this.publisher.publish(claim);}catch(error){const reason=error instanceof Error?error.message:String(error);this.store.scheduledLoops.publicationBlocked(claim,reason);publicationErrors.push(claim.taskId+': '+reason);}
    }else if(latest.state==='queued'&&!latest.identity&&!latest.turnIntent&&!runtime.paused&&!cancelled&&!expired&&record.state==='active')await this.start(claim);
   }else if(['claimed','started'].includes(operation.state)&&!runtime.paused&&!cancelled&&!expired&&record.state==='active')await this.start(claim);
  }
  if(!cancelled&&!runtime.paused&&!expired)try{await this.loops.advance(record.id);}catch(error){publicationErrors.push('loop: '+(error instanceof Error?error.message:String(error)));}
  if(record.state==='active'&&!cancelled&&!runtime.paused){const expected=this.store.scheduler.expected(record.id);const commandId='scheduled-terminal:'+createHash('sha256').update(JSON.stringify({id:record.id,expected,expired})).digest('hex');const terminal=await this.store.scheduler.reconcileTerminal({commandId,id:record.id,expected});if(terminal.kind==='blocked'||terminal.kind==='drained')return;}
  let released=false;if(!cancelled&&!runtime.paused)try{released=this.publisher.releaseIfReady(record.id);}catch(error){publicationErrors.push(error instanceof Error?error.message:String(error));}
  if(released||record.state!=='active'||record.fence!=='held'||runtime.paused||cancelled||expired){if(publicationErrors.length)throw Error(publicationErrors.join('; '));return;}
  for(let count=0;count<record.plan.limits.maxActive;count++){
   const expected=this.store.scheduler.expected(record.id);
   // A stable frontier receipt within each non-LLM observation interval avoids
   // hundreds of identical waiting rows; next interval rechecks actual files.
   const digest=createHash('sha256').update(JSON.stringify({schedulerId:record.id,expected,interval:Math.floor(Date.now()/15000)})).digest('hex');
   const commandId='scheduled-claim:'+digest;
   const result=this.store.scheduler.claim({commandId,id:record.id,expected,owner:this.owner});
   if(result.kind==='waiting')break;
   await this.start(result.claim);
  }
  if(publicationErrors.length)throw Error(publicationErrors.join('; '));
 }
 async close():Promise<void>{this.closed=true;await this.manager.close({cancel:false});}
}
