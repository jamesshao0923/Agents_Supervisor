import {createHash} from 'node:crypto';
import type {SupervisorStore} from '../persistence/store.js';
import type {SupervisionJob} from '../contracts/p6-supervision.js';
import type {Candidate} from '../verification/candidate.js';
import {assertCandidate} from '../verification/candidate.js';
import {inspectProcess,type ProcessIdentity} from '../process-control/index.js';
import {authorStageDigest,parseAuthorStageInput} from './author-stage-protocol.js';
import {authorStageChargePrefix,assertAuthorStagePolicy,assertAuthorStageParents,readRejectedAuthorStage,stageAttemptRef} from './author-stage-proofs.js';
import {assertStageRecoveryRootPolicy,parseStageRecoveryInput,renderStageRecoveryInput} from './author-stage-recovery-presentation.js';

function ensure(value:unknown,message:string):asserts value {if(!value)throw Error('Author stage recovery: '+message);}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const same=(a:unknown,b:unknown)=>authorStageDigest(a)===authorStageDigest(b);

/** Session cost is backed by the same actual Run attempts, including rejected and known-zero jobs. */
export function assertStageAttemptLedger(store:SupervisorStore,job:SupervisionJob,sources:SupervisionJob[]):void {
  const {run}=store.runtime.inspect(job.runtimeId);
  for(const source of sources){
    const attempt=run.attempts.find(a=>a.id===source.attemptId);
    ensure(attempt?.purpose==='reasoning'&&attempt.nodeId==='@supervisor'&&attempt.contractVersion===source.contractVersion
      &&attempt.reservation===source.config.reservation&&attempt.settled&&attempt.actual===source.usage
      &&attempt.status===(source.error?'failed':'succeeded'),'actual charged attempt differs');
    ensure(run.operations.some(o=>o.id===source.id&&o.attemptId===source.attemptId&&o.status==='confirmed')
      &&run.leases.filter(l=>l.attemptId===source.attemptId).every(l=>l.released),'charged operation unresolved');
  }
}
function actual(store:SupervisorStore,dataDir:string,failedJobId:string){
  const repo=store.supervision,job=repo.job(failedJobId),loop=repo.get(job.loopId),{runtime,run}=store.runtime.inspect(job.runtimeId);
  repo.assertEligible(loop.id);
  ensure(loop.phase==='authoring'&&loop.references.authorJobId===job.id&&!runtime.paused&&!runtime.cancelled,'failed fragment is not current');
  ensure(loop.authoringProtocol==='acceptance-stages-v2'&&job.contractVersion===run.contract.version&&job.contractDigest===loop.contractDigest,'current contract changed');
  const input=parseAuthorStageInput(job.input);ensure(input,'missing fragment');
  ensure(job.runtimeId===loop.runtimeId&&job.projectId===run.projectId&&job.runId===run.id
    &&same(input.context.acceptance.contract,run.contract)&&(input.context.candidate as Candidate).root===runtime.workspace,'frozen fragment scope changed');
  assertAuthorStagePolicy(job,loop,id=>repo.job(id),run.budget.limit);
  const rejected=readRejectedAuthorStage(job,dataDir);
  assertAuthorStageParents(job,id=>repo.job(id),dataDir);
  const prior=authorStageChargePrefix(job,id=>repo.job(id),dataDir);
  assertStageRecoveryRootPolicy([...prior.flatMap(job=>{const recovery=parseStageRecoveryInput(job.input);return recovery?[{
  schemaVersion:recovery.context.stageRecovery.schemaVersion,sessionId:recovery.context.authorStage.sessionId,
  index:recovery.context.authorStage.index,rejectionJobId:recovery.context.stageRecovery.rejection.jobId}]:[];}),{
  schemaVersion:2,sessionId:input.context.authorStage.sessionId,index:input.context.authorStage.index,rejectionJobId:job.id}]);
  const charged=[...prior,job];assertStageAttemptLedger(store,job,charged);
  ensure(run.attempts.every(a=>a.settled)&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released),'quiet settled boundary required');
  const workspaceBoundary=store.authorRouting.workspaceBoundary(runtime.workspace);
  const binding=input.context.authorStage;
  ensure(loop.reasoningCount+1+(2-binding.index)<=loop.limits.maxReasoningCalls,'not enough calls for fragment recovery and remaining stages');
  ensure(binding.loopDeadlineMs-Date.now()>=1000,'original Loop deadline exhausted');
  const reservation=binding.sessionTokenCeiling===null?loop.config.reservation:binding.sessionTokenCeiling-charged.reduce((sum,j)=>sum+j.usage!,0);
  ensure(Number.isSafeInteger(reservation)&&reservation>0,'shared session budget exhausted');
  const next=renderStageRecoveryInput({acceptance:input.context.acceptance,candidate:input.context.candidate,binding:binding as import('../contracts/p6-author-stages.js').HostAuthorStageBindingV2,parents:input.context.authorStageParents},
    {schemaVersion:2,rejection:rejected.ref,raw:rejected.raw,previousAttempt:null});
  return {job,loop,run,input:next,reservation,charged,workspaceBoundary};
}
/** Complete raw rejection + actual stop outside, exact re-read and reservation inside the original transaction. */
export async function beginAuthorStageRecovery(store:SupervisorStore,dataDir:string,failedJobId:string,beforeReserve:()=>void=()=>{}):Promise<SupervisionJob>{
  const original=store.supervision.job(failedJobId),stage=parseAuthorStageInput(original.input);ensure(stage,'missing fragment');
  const commandId=stage.context.authorStage.sessionId+':fragment-recovery:'+failedJobId;
  const prior=store.supervision.jobs(original.loopId).find(j=>j.id==='supervision-job-'+hash(commandId).slice(0,24));
  if(prior){
    const input=parseStageRecoveryInput(prior.input);ensure(input?.context.stageRecovery.rejection.jobId===failedJobId,'conflicting recovery command');
    authorStageChargePrefix(prior,id=>store.supervision.job(id),dataDir);return prior;
  }
  const before=actual(store,dataDir,failedJobId);
  await assertCandidate(stage.context.candidate as Candidate);
  const identities:ProcessIdentity[]=before.charged.flatMap(job=>job.identities);
  for(const execution of before.workspaceBoundary.executions)if(execution.identity)identities.push(execution.identity as ProcessIdentity);
  for(const verification of before.workspaceBoundary.jobs)identities.push(...verification.identities);
  for(const identity of [...new Map(identities.map(identity=>[identity.operationId,identity])).values()])
    ensure((await inspectProcess(identity)).status==='stopped','author boundary process remains active');
  await assertCandidate(stage.context.candidate as Candidate);
  return store.supervision.transaction(()=>{
    const after=actual(store,dataDir,failedJobId);
    ensure(same(before,after),'recovery boundary changed during physical inspection');beforeReserve();
    const job=store.supervision.beginJob({commandId,loopId:after.loop.id,expectedRevision:after.loop.revision,purpose:'acceptance-authoring',context:after.input,
      config:{...after.job.config,reservation:after.reservation,timeoutMs:Math.min(after.job.config.timeoutMs,stage.context.authorStage.loopDeadlineMs-Date.now())}});
    const loop=store.supervision.get(after.loop.id);
    store.supervision.update(loop.id,loop.revision,{phase:'authoring',reason:null,references:{...loop.references,authorJobId:job.id}});
    return job;
  });
}
/** Explicit host link for known-zero pause/resume. No input-equality inference or new recovery allowance. */
export function resumeAuthorStageRecovery(store:SupervisorStore,dataDir:string,previous:SupervisionJob):SupervisionJob{
  const repo=store.supervision,actualPrevious=repo.job(previous.id);ensure(same(actualPrevious,previous),'paused attempt changed');
  const input=parseStageRecoveryInput(previous.input);ensure(input,'missing recovery input');
  ensure(previous.status==='finished'&&previous.stopConfirmed&&!previous.modelStarted&&previous.usage===0&&previous.error
    &&/cancelled|dispatch disabled|paused/i.test(previous.error),'charged or unresolved recovery cannot resume');
  authorStageChargePrefix(previous,id=>repo.job(id),dataDir);
  assertStageAttemptLedger(store,previous,[previous]);
  const loop=repo.get(previous.loopId),b=input.context.authorStage;
  ensure(loop.references.authorJobId===previous.id&&loop.reasoningCount+1+(2-b.index)<=loop.limits.maxReasoningCalls,'resume cannot refund consumed calls');
  const next=renderStageRecoveryInput({acceptance:input.context.acceptance,candidate:input.context.candidate,binding:b,parents:input.context.authorStageParents},
    {...input.context.stageRecovery,previousAttempt:stageAttemptRef(previous)});
  return repo.beginJob({commandId:'stage-recovery-resume:'+previous.id,loopId:loop.id,expectedRevision:loop.revision,purpose:'acceptance-authoring',context:next,config:previous.config});
}
