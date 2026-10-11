import {createHash} from 'node:crypto';
import type {SupervisorStore} from '../persistence/store.js';
import type {ScheduledClaim} from '../contracts/p7-dispatch.js';
import type {ResultRef,TaskResultManifest} from '../contracts/p7-results.js';
import type {Run} from '../contracts/p1.js';
import {canonical} from '../verification/candidate.js';
function ensure(value:unknown,message:string):asserts value{if(!value)throw Error('Scheduled publication: '+message);}
/** Every retry with a different CAS has a different command identity. A receipt
 * never silently gains a changed expected revision, head, manifest or scope. */
export function scheduledPublicationCommand(kind:'stage'|'prepare'|'submit'|'release',request:unknown):string{return 'scheduled-result-'+kind+':'+createHash('sha256').update(canonical(request)).digest('hex');}
/** Existing immutable result ledger and package intents are the recovery log.
 * This adapter neither invokes a model nor grants branch verification. */
export class ScheduledResultPublisher {
 constructor(private readonly store:SupervisorStore){}
 async publish(claim:ScheduledClaim):Promise<ResultRef>{
  const actual=this.store.scheduler.claimGet(claim.id);ensure(canonical(actual)===canonical(claim),'claim changed');const scope={projectId:claim.projectId,runId:claim.runId};
  const ledger=this.store.taskResults.inspect(scope),versions=ledger.versions.filter(version=>version.manifest.attemptId===claim.attemptId&&version.ref.taskId===claim.taskId);ensure(versions.length<=1,'ambiguous branch publication history');let version=versions[0];
  if(version&&['submitted','verified'].includes(version.state)){this.store.taskResults.readPublished({...scope,ref:version.ref,minimumState:'submitted'});return version.ref;}
  ensure(!version||version.state==='draft','branch result invalidated');
  const descriptor=await this.store.taskResults.qualifyScheduledProducer({...scope,operationId:claim.operationId});
  if(!version){
   const execution=this.store.executionGet(claim.attemptId),manifest:TaskResultManifest={schemaVersion:1,...descriptor.producer,inputs:descriptor.inputs,artifacts:descriptor.artifacts,conclusion:execution.message.trim()||'Actual branch execution completed; output submitted for integration.',sources:[],checks:[],limitations:['Submitted execution output; no independent scoped P4 verification authority.'],unresolved:[]};
   const fresh=this.store.taskResults.inspect(scope),request={...scope,operationId:claim.operationId,expectedRevision:fresh.revision,expectedHead:fresh.heads.find(head=>head.taskId===claim.taskId)?.ref??null,manifest};
   const ref=await this.store.taskResults.stageDraft({...request,commandId:scheduledPublicationCommand('stage',request)});version=this.store.taskResults.inspect(scope).versions.find(version=>canonical(version.ref)===canonical(ref));ensure(version,'committed draft missing');
  }
  // A prior draft is immutable. Do not regenerate its free-form explanation from
  // a later receipt; the producer qualifier revalidates its exact bytes/inputs.
  const prepare={...scope,ref:version.ref,operationId:claim.operationId};
  const intent=await this.store.taskResults.preparePackage({...prepare,commandId:scheduledPublicationCommand('prepare',prepare)});
  this.store.taskResults.materializePackage(intent.id);
  const fresh=this.store.taskResults.inspect(scope),request={...scope,ref:version.ref,intentId:intent.id,expectedRevision:fresh.revision,expectedHead:fresh.heads.find(head=>head.taskId===claim.taskId)?.ref??null};
  const ref=await this.store.taskResults.submit({...request,commandId:scheduledPublicationCommand('submit',request)});
  this.store.taskResults.readPublished({...scope,ref,minimumState:'submitted'});return ref;
 }
 releaseIfReady(schedulerId:string):boolean {
  const scheduler=this.store.scheduler.get(schedulerId);if(scheduler.state==='drained'&&scheduler.fence==='released')return true;
  const runtime=this.store.runtime.get(scheduler.plan.runtimeId),scope={projectId:scheduler.plan.projectId,runId:scheduler.plan.runId},run=this.store.query({type:'run',...scope}) as Run;
  if(scheduler.state!=='active'||scheduler.fence!=='held'||runtime.paused||runtime.cancelled||!['ready','running'].includes(run.status))return false;
  const loop=this.store.scheduledLoops.inspect(schedulerId);if(loop&&loop.frames.find(f=>f.key===loop.rootKey)?.state!=='yielded')return false;
  const claims=this.store.scheduler.claims(schedulerId),operations=this.store.scheduler.operations(schedulerId),ledger=this.store.taskResults.inspect(scope);
  if(run.attempts.some(attempt=>!attempt.settled||attempt.status==='running')||run.operations.some(operation=>operation.status!=='confirmed')||run.leases.some(lease=>!lease.released)||this.store.scheduler.leases().some(lease=>claims.some(claim=>claim.id===lease.claimId)&&lease.state==='held'))return false;
  for(const task of scheduler.plan.tasks){const claim=claims.find(claim=>claim.taskId===task.node.id&&claim.generation===task.generation);if(!task.node.required&&!claim)continue;if(!claim||operations.find(operation=>operation.claimId===claim.id)?.state!=='confirmed')return false;
   const head=ledger.heads.find(head=>head.taskId===claim.taskId),version=ledger.versions.find(version=>head&&canonical(version.ref)===canonical(head.ref));if(!version||!['submitted','verified'].includes(version.state)||version.manifest.attemptId!==claim.attemptId)return false;
   this.store.taskResults.readPublished({...scope,ref:version.ref,minimumState:'submitted'});
  }
  if(!this.store.scheduler.completionEligibility(schedulerId).ready)return false;
  const request={id:schedulerId,expected:this.store.scheduler.expected(schedulerId)};this.store.scheduler.releaseIntegration({...request,commandId:scheduledPublicationCommand('release',request)});return true;
 }
}
