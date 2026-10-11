import type {Run,DomainEvent} from '../contracts/p1.js';
import type {ScheduledPlan,ScheduledDomainInput,ScheduledDomainResult,ScheduledClaim,ScheduledOperation,ScheduledLease} from '../contracts/p7-dispatch.js';
import type {ResultLedger} from '../contracts/p7-results.js';
import type {SchedulerSnapshot} from '../contracts/p7-scheduler.js';
import {safeResultJSON} from '../contracts/p7-results.js';
import {createTaskScheduler,schedulerResourcesConflict} from './task-scheduler.js';
import {createTaskResultDomain} from './task-results.js';
import {futureVerificationFloor,futureExecutionFloor} from './index.js';
const ensure=(ok:unknown,message:string):void=>{if(!ok)throw Error('Scheduled dispatch: '+message);};
export function createScheduledDispatch({sha256}:{sha256:(text:string)=>string}){
 const results=createTaskResultDomain({sha256}),scheduler=createTaskScheduler({sha256,decisionId:d=>'schedule-'+d});
 const digest=(v:unknown)=>results.resultDigest(v),same=(a:unknown,b:unknown)=>digest(a)===digest(b);
 function validatePlan(run:Run,plan:ScheduledPlan):void{
  safeResultJSON(plan);ensure(plan.schemaVersion===1&&plan.engine==='scheduled-v1'&&plan.workflowVersion===2,'unsupported plan');
  ensure(plan.projectId===run.projectId&&plan.runId===run.id&&plan.contractVersion===run.contract.version&&plan.contractDigest===digest(run.contract),'stale plan contract');
  ensure(Number.isSafeInteger(plan.revision)&&plan.revision>0&&plan.id.trim()&&plan.runtimeId.trim(),'invalid plan identity');
  ensure(plan.tasks.length>0&&new Set(plan.tasks.map(t=>t.node.id)).size===plan.tasks.length,'invalid task set');
  for(const task of plan.tasks){
   ensure(task.node.id!==plan.integrationNodeId&&task.step.id===task.node.id&&task.step.kind==='codex'&&task.step.reservation===task.node.reservation,'step does not match task');
   ensure(Number.isSafeInteger(task.generation)&&task.generation>0&&task.workspace.startsWith('/')&&!task.workspace.includes('\0'),'invalid generation or workspace');
   ensure(task.node.admission.requirementRefs.length>0&&task.node.admission.requirementRefs.every(ref=>run.contract.criteria.some(c=>c.required&&c.id===ref)),'branch must bind existing required criteria');
   ensure(task.inputRequirements.length===task.node.dependencies.length&&new Set(task.inputRequirements.map(i=>i.dependencyNodeId)).size===task.inputRequirements.length&&task.inputRequirements.every(i=>task.node.dependencies.includes(i.dependencyNodeId)&&['submitted','verified'].includes(i.minimumState)),'dependency requirements differ');
   ensure(task.node.dependencies.every(id=>plan.tasks.some(t=>t.node.id===id)),'dependency outside scheduled graph');
   ensure(task.node.resources.some(r=>r.kind==='path'&&r.key===task.workspace&&r.mode==='write'),'workspace write lease required');
  }
 }
 function snapshot(run:Run,plan:ScheduledPlan,ledger:ResultLedger,claims:ScheduledClaim[],operations:ScheduledOperation[],leases:ScheduledLease[],nowMs:number):SchedulerSnapshot{
  validatePlan(run,plan);
  for(const task of plan.tasks){const node=run.nodes.find(n=>n.id===task.node.id);ensure(node&&same(node.dependencies,task.node.dependencies)&&node.required===task.node.required,'Run graph differs from frozen plan');}
  const anchor=run.nodes.find(n=>n.id===plan.integrationNodeId);ensure(anchor?.status==='pending'&&plan.tasks.filter(t=>t.node.required).every(t=>anchor.dependencies.includes(t.node.id)),'integration anchor is not fenced pending');
  ensure(run.admission!=='draft'&&!run.attempts.some(a=>a.purpose!=='execution'&&!a.settled),'non-execution accounting needs quiet boundary');
  const outstanding=claims.filter(c=>leases.some(l=>l.claimId===c.id&&l.state==='held')||run.attempts.some(a=>a.id===c.attemptId&&(!a.settled||a.status==='running'))||run.operations.some(o=>o.attemptId===c.attemptId&&o.status!=='confirmed'));
  for(const c of outstanding){const task=plan.tasks.find(t=>t.node.id===c.taskId),a=run.attempts.find(a=>a.id===c.attemptId),op=operations.find(o=>o.claimId===c.id);ensure(task&&a&&op&&c.planDigest===digest(plan)&&c.planRevision===plan.revision&&c.generation===task.generation&&c.contractVersion===run.contract.version&&c.contractDigest===plan.contractDigest&&a.nodeId===c.taskId&&a.purpose==='execution'&&a.reservation===c.reservation&&same(task.node.resources,c.resources),'unbound or stale outstanding claim');}
  ensure(run.attempts.every(a=>a.settled&&a.status!=='running'||outstanding.some(c=>c.attemptId===a.id)),'unsettled history blocks dispatch');
  ensure(run.operations.every(o=>o.status==='confirmed'||outstanding.some(c=>c.attemptId===o.attemptId&&c.operationId===o.id)),'unbound unresolved operation');
  ensure(run.leases.every(l=>l.released||outstanding.some(c=>c.attemptId===l.attemptId)),'unbound writer lease');
  const spent=(loopId:string)=>claims.filter(c=>c.loopIds.includes(loopId)).reduce((total,c)=>{const a=run.attempts.find(a=>a.id===c.attemptId);return total+(a?.settled?a.actual!:0);},0);
  return {schemaVersion:1,revision:run.revision,scope:{projectId:run.projectId,runId:run.id,contractVersion:run.contract.version,contractDigest:plan.contractDigest},status:run.status,tier:plan.tier,
   nodes:plan.tasks.map(t=>{const n=run.nodes.find(n=>n.id===t.node.id)!;const conflict=leases.some(l=>l.state==='held'&&!outstanding.some(c=>c.id===l.claimId&&c.taskId===n.id)&&t.node.resources.some(r=>schedulerResourcesConflict(r,l.resource)));return {...structuredClone(t.node),status:conflict&&n.status==='pending'?'blocked':n.status,inputs:t.inputRequirements.flatMap(i=>{const head=ledger.heads.find(h=>h.taskId===i.dependencyNodeId);return head?[{dependencyNodeId:i.dependencyNodeId,result:head.ref,minimumState:i.minimumState}]:[];})};}),
   attemptedTaskIds:[...new Set(claims.filter(c=>plan.tasks.some(task=>task.node.id===c.taskId&&task.generation===c.generation)).map(c=>c.taskId))],
   results:ledger,claims:outstanding.map(c=>{const a=run.attempts.find(a=>a.id===c.attemptId)!,op=operations.find(o=>o.claimId===c.id)!;return {id:c.id,taskId:c.taskId,reservation:a.settled?0:c.reservation,resources:leases.filter(l=>l.claimId===c.id&&l.state==='held').map(l=>l.resource),loopIds:c.loopIds,usage:!a.settled&&(a.status!=='running'||op.state==='unknown')?'unknown':'known',effects:op.state==='unknown'?'unknown':'pending'};}),
   loops:plan.loops.map(l=>({...l,spent:spent(l.id)})),budget:{limit:run.budget.limit,spent:run.budget.spent,verificationRemaining:Math.max(0,run.budget.verificationReserve-run.attempts.filter(a=>a.purpose==='verification'&&a.contractVersion===run.contract.version).reduce((s,a)=>s+(a.settled?a.actual!:a.reservation),0)),futureVerificationFloor:futureVerificationFloor(run),futureExecutionFloor:futureExecutionFloor(run)},limits:{...plan.limits,nowMs}};
 }
 function install(run:Run,plan:ScheduledPlan):{run:Run;events:DomainEvent[]}{
  validatePlan(run,plan);const anchor=run.nodes.find(n=>n.id===plan.integrationNodeId);
  ensure(run.nodes.length===1&&anchor?.status==='pending'&&anchor.dependencies.length===0&&anchor.required,'only unique unstarted integration anchor supported');
  ensure(!run.artifact&&run.evidence.length===0&&run.attempts.every(a=>a.purpose==='reasoning'&&a.settled&&a.status!=='running')&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released),'graph extension requires settled planning and no execution artifact or effects');
  ensure(run.admission!=='draft'&&['ready','running'].includes(run.status),'run not active admitted');
  const next=structuredClone(run);next.nodes.unshift(...plan.tasks.map(t=>({id:t.node.id,dependencies:[...t.node.dependencies],required:t.node.required,status:'pending' as const})));next.nodes.at(-1)!.dependencies=plan.tasks.filter(t=>t.node.required).map(t=>t.node.id);next.revision++;
  // Actual policy validation rejects cycles, resources and nested hard bounds.
  scheduler.evaluate(snapshot(next,plan,results.createResultLedger(),[],[],[],0));
  return {run:next,events:[{type:'scheduled-graph-extension',runId:run.id,revision:next.revision,details:{planId:plan.id,planDigest:digest(plan),integrationNodeId:plan.integrationNodeId,addedTaskIds:plan.tasks.map(t=>t.node.id),inputSource:'Current admitted same-contract Run criteria and host frozen execution plan'}}]};
 }
 function evaluate(input:Omit<ScheduledDomainInput,'taskId'|'attemptId'|'claimId'|'operationId'|'owner'>){const current=snapshot(input.run,input.plan,input.ledger,input.claims,input.operations,input.leases,input.nowMs);if(input.effectiveTier!==undefined)current.tier=input.effectiveTier;for(const id of input.blockedTaskIds??[]){const node=current.nodes.find(n=>n.id===id);ensure(node,'unknown host dependency block');if(node&&['pending','failed'].includes(node.status))node.status='blocked';}return scheduler.evaluate(current);}
 function start(input:ScheduledDomainInput):ScheduledDomainResult{
  safeResultJSON(input);const {run,plan}=input,decision=evaluate(input),chosen=decision.nodes.find(n=>n.taskId===input.taskId);
  ensure(chosen?.dispatch,'task not dispatchable');ensure(!run.attempts.some(a=>a.id===input.attemptId)&&!input.claims.some(c=>c.id===input.claimId)&&!run.operations.some(o=>o.id===input.operationId),'duplicate claim attempt or operation');
  const task=plan.tasks.find(t=>t.node.id===input.taskId)!,next=structuredClone(run);const claim:ScheduledClaim={schemaVersion:1,id:input.claimId,schedulerId:plan.id,runtimeId:plan.runtimeId,projectId:run.projectId,runId:run.id,taskId:input.taskId,attemptId:input.attemptId,operationId:input.operationId,planRevision:plan.revision,planDigest:digest(plan),generation:task.generation,contractVersion:run.contract.version,contractDigest:plan.contractDigest,owner:input.owner,workspace:task.workspace,workspaceKind:task.workspaceKind,inputBindings:structuredClone(chosen!.inputs),resources:structuredClone(task.node.resources),reservation:task.node.reservation,loopIds:[...task.node.loopIds]};
  next.attempts.push({id:claim.attemptId,nodeId:claim.taskId,contractVersion:claim.contractVersion,status:'running',reservation:claim.reservation,purpose:'execution',settled:false,actual:null});next.operations.push({id:claim.operationId,attemptId:claim.attemptId,status:'pending'});next.leases.push({resource:'workspace:'+claim.workspace,attemptId:claim.attemptId,released:false});next.nodes.find(n=>n.id===claim.taskId)!.status='running';next.status='running';next.revision++;
  const operation:ScheduledOperation={id:claim.operationId,claimId:claim.id,state:'claimed',executionId:null,result:null,error:null};return {run:next,claim,operation,decision,events:[{type:'scheduled-attempt-started',runId:run.id,revision:next.revision,details:{claimId:claim.id,operationId:operation.id,taskId:claim.taskId,attemptId:claim.attemptId,planDigest:claim.planDigest,inputBindings:claim.inputBindings,reservation:claim.reservation}}]};
 }
 return {digest,validatePlan,snapshot,evaluate,install,start};
}
