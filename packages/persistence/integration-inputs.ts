import {assertScheduledProjection,assertScheduledClaimOrigin,loopProgramComplete} from './scheduled-plan-history.js';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {Run} from '../contracts/p1.js';
import type {RuntimeOperation,RuntimeRecord} from '../contracts/p3.js';
import type {ExecutionRecord} from '../contracts/p2.js';
import type {ScheduledRecord,ScheduledClaim,ScheduledOperation} from '../contracts/p7-dispatch.js';
import type {IntegrationInputBinding,IntegrationInputReceipt} from '../contracts/p7-integration-inputs.js';
import {HostIntegrationInputs,type IntegrationInputSource} from '../workspace/integration-inputs.js';
import {TaskResultRepository} from './task-results.js';
import {canonical} from '../verification/candidate.js';
import {ConversationRepository} from './conversations.js';
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function ensure(value:unknown,message:string):asserts value{if(!value)throw Error('Integration inputs: '+message);}
/** Derived from actual same-DB immutable scheduler records and result packages.
 * The atomic filesystem index is the frozen relationship; no second DB ledger. */
export class ScheduledIntegrationInputsRepository {
 constructor(private readonly db:DatabaseSync){}
 private record<T>(table:string,id:string):T {const row=this.db.prepare('SELECT record FROM '+table+' WHERE id=?').get(id);ensure(row,'missing '+table);return JSON.parse(String(row.record)) as T;}
 private context(operationId:string):{operation:RuntimeOperation;runtime:RuntimeRecord;scheduler:ScheduledRecord}|null {
  const operation=this.record<RuntimeOperation>('runtime_outbox',operationId),runtime=this.record<RuntimeRecord>('runtime_runs',operation.runtimeId),row=this.db.prepare('SELECT record FROM scheduled_records WHERE runtime_id=?').get(runtime.id);if(!row)return null;
  const scheduler=JSON.parse(String(row.record)) as ScheduledRecord;if(operation.step.id!==scheduler.plan.integrationNodeId||operation.contractVersion!==scheduler.plan.contractVersion)return null;ensure(operation.step.kind==='codex','integration requires an actual Codex step');return {operation,runtime,scheduler};
 }
 applies(operationId:string):boolean{return this.context(operationId)!==null;}
 private read(operationId:string):{binding:IntegrationInputBinding;sources:IntegrationInputSource[]} {
  const context=this.context(operationId);ensure(context,'no scheduled integration');const {operation,runtime,scheduler}=context;assertScheduledProjection(this.db,scheduler);ensure(loopProgramComplete(this.db,scheduler.id),'loop program has not yielded');
  ensure(scheduler.state==='drained'&&scheduler.fence==='released'&&!runtime.paused&&!runtime.cancelled,'integration boundary not released');
  const row=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(runtime.projectId,runtime.runId);ensure(row,'missing Run');const run=JSON.parse(String(row.snapshot)) as Run;
  ensure(['ready','running'].includes(run.status)&&scheduler.plan.projectId===run.projectId&&scheduler.plan.runId===run.id&&scheduler.plan.runtimeId===runtime.id&&scheduler.plan.contractVersion===run.contract.version&&scheduler.plan.contractDigest===hash(run.contract)&&operation.contractVersion===run.contract.version,'integration contract or scope stale');
  ensure(!new ConversationRepository(this.db).hasPendingForRun(run.projectId,run.id),'pending follow-up fences integration inputs');
  const dbPath=this.db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;ensure(typeof dbPath==='string'&&isAbsolute(dbPath),'file-backed host data root required');const results=new TaskResultRepository(this.db,dirname(dbPath)),ledger=results.inspect({projectId:run.projectId,runId:run.id}),claims=this.db.prepare('SELECT record FROM scheduled_claims WHERE scheduler_id=?').all(scheduler.id).map(row=>JSON.parse(String(row.record)) as ScheduledClaim);
  const inputBindings:IntegrationInputBinding['inputBindings']=[],sources:IntegrationInputSource[]=[];
  for(const task of scheduler.plan.tasks){const claim=claims.find(claim=>claim.taskId===task.node.id&&claim.generation===task.generation);if(!task.node.required&&!claim)continue;ensure(claim,'required or attempted branch missing');assertScheduledClaimOrigin(this.db,scheduler,claim);const op=this.record<ScheduledOperation>('scheduled_outbox',claim.operationId);ensure(op.state==='confirmed','branch execution unresolved');
   const head=ledger.heads.find(head=>head.taskId===task.node.id),version=ledger.versions.find(version=>head&&hash(version.ref)===hash(head.ref));ensure(head&&version&&version.manifest.attemptId===claim.attemptId&&version.manifest.planRevision===claim.planRevision&&version.manifest.generation===claim.generation&&hash(version.manifest.inputs)===hash(claim.inputBindings),'branch head/claim changed');
   const pack=results.readPublished({projectId:run.projectId,runId:run.id,ref:head.ref,minimumState:'submitted'});inputBindings.push({dependencyNodeId:task.node.id,result:head.ref,minimumState:'submitted'});sources.push({manifest:version.manifest,package:pack});
  }
  ensure(inputBindings.length>0,'no actual integration inputs');
  const binding:IntegrationInputBinding={schemaVersion:1,id:'integration-'+hash({schedulerId:scheduler.id,planDigest:scheduler.planDigest,runtimeId:runtime.id,integrationNodeId:scheduler.plan.integrationNodeId}),schedulerId:scheduler.id,runtimeId:runtime.id,integrationNodeId:scheduler.plan.integrationNodeId,projectId:run.projectId,runId:run.id,planDigest:scheduler.planDigest,contractVersion:run.contract.version,contractDigest:hash(run.contract),workspace:runtime.workspace,inputBindings};
  return {binding,sources};
 }
 prepare(operationId:string):IntegrationInputReceipt|null {
  if(!this.applies(operationId))return null;ensure(!this.db.isTransaction,'filesystem preparation must precede transaction');const {binding}=this.read(operationId),host=new HostIntegrationInputs(),read=()=>{const fresh=this.read(operationId);ensure(canonical(fresh.binding)===canonical(binding),'integration inputs changed during copy');return fresh.sources;},operation=this.context(operationId)!.operation,row=this.db.prepare('SELECT record FROM executions WHERE id=?').get(operation.attemptId);
  if(row){const execution=JSON.parse(String(row.record)) as ExecutionRecord;if(execution.identity||execution.turnIntent)return host.verify(binding,read);}
  return host.prepare(binding,read);
 }
 verify(operationId:string):IntegrationInputBinding|null {
  if(!this.applies(operationId))return null;const {binding}=this.read(operationId);new HostIntegrationInputs().verify(binding,()=>{const fresh=this.read(operationId);ensure(canonical(fresh.binding)===canonical(binding),'integration inputs changed during verification');return fresh.sources;});return binding;
 }
}
