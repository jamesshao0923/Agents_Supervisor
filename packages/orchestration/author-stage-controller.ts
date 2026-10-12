import {authorStageChargePrefix} from './author-stage-proofs.js';
import {assertStageAttemptLedger} from './author-stage-recovery.js';
import {createHash} from 'node:crypto';
import type {SupervisorStore} from '../persistence/store.js';
import type {SupervisionJob} from '../contracts/p6-supervision.js';
import {AUTHOR_STAGE_ORDER,type AnyHostAuthorStageBinding} from '../contracts/p6-author-stages.js';
import type {AcceptanceAuthoringContext} from './acceptance-authoring.js';
import {isAuthorStageProtocol,parseAuthorStageInput,renderAuthorStageInput,renderNewAuthorStageInput,parseAuthorStageOutput,authorStageDigest} from './author-stage-protocol.js';
import {assertAuthorStageParents,assertStoredAuthorStage,authorStageParent} from './author-stage-proofs.js';

function ensure(value:unknown,message:string):asserts value {if(!value)throw Error('Author stages: '+message);}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Snapshot={acceptance:AcceptanceAuthoringContext;candidate:unknown};

/** Uses the existing transaction, immutable jobs and receipt log; never a parallel ledger. */
export function beginAuthorStages(store:SupervisorStore,loopId:string,context:Snapshot):SupervisionJob {
  const repo=store.supervision;
  return repo.transaction(()=>{
    const loop=repo.get(loopId);repo.assertEligible(loopId);ensure(isAuthorStageProtocol(loop.authoringProtocol),'Loop did not select staged authoring');
    ensure(loop.reasoningCount+AUTHOR_STAGE_ORDER.length<=loop.limits.maxReasoningCalls,'not enough actual calls for the complete author session');
    const deadline=Date.parse(loop.createdAt)+loop.limits.maxDurationMs;
    ensure(deadline-Date.now()>=1000,'Loop deadline exhausted');
    const sessionId='author-session-'+authorStageDigest({loopId,revision:loop.revision,contractDigest:loop.contractDigest,context});
    const binding:AnyHostAuthorStageBinding={protocol:loop.authoringProtocol,sessionId,index:0,stage:'definition',
      sessionTokenCeiling:store.runtime.inspect(loop.runtimeId).run.budget.limit===null?null:loop.config.reservation,perCallTimeoutMs:loop.config.timeoutMs,loopDeadlineMs:deadline,parents:[]};
    const input=renderNewAuthorStageInput({...context,binding,parents:[]});
    const job=repo.beginJob({commandId:sessionId+':0',loopId,expectedRevision:loop.revision,purpose:'acceptance-authoring',context:input});
    const current=repo.get(loopId);repo.update(loopId,current.revision,{phase:'authoring',reason:null,references:{...current.references,authorJobId:job.id}});
    return job;
  });
}

/** The caller first verifies the current result with the actual runner and physical stop checks. */
export function advanceAuthorStage(store:SupervisorStore,dataDir:string,job:SupervisionJob):SupervisionJob|null {
  const input=parseAuthorStageInput(job.input);if(!input)return null;
  const binding=input.context.authorStage;if(binding.index===2)return null;
  const repo=store.supervision;
  return repo.transaction(()=>{
    const actual=repo.job(job.id),loop=repo.get(job.loopId);repo.assertEligible(loop.id);
    ensure(authorStageDigest(actual)===authorStageDigest(job),'current fragment changed');
    ensure(loop.phase==='authoring'&&loop.references.authorJobId===job.id,'fragment is no longer current');
    const prior=assertAuthorStageParents(actual,id=>repo.job(id),dataDir);
    assertStoredAuthorStage(actual,dataDir);
    parseAuthorStageOutput(actual.result,input.context.acceptance,binding,input.context.authorStageParents);
    const all=[...prior,actual],charged=[...authorStageChargePrefix(actual,id=>repo.job(id),dataDir),actual],{run}=store.runtime.inspect(loop.runtimeId);
    for(const parent of all){
      const attempt=run.attempts.find(a=>a.id===parent.attemptId);
      ensure(attempt?.purpose==='reasoning'&&attempt.nodeId==='@supervisor'&&attempt.contractVersion===parent.contractVersion
        &&attempt.status==='succeeded'&&attempt.settled&&attempt.actual===parent.usage&&attempt.reservation===parent.config.reservation,'fragment has no matching actual ledger');
      ensure(run.operations.some(o=>o.id===parent.id&&o.attemptId===parent.attemptId&&o.status==='confirmed'),'fragment operation unresolved');
    }
    const index=(binding.index+1) as 1|2;
    ensure(loop.reasoningCount+AUTHOR_STAGE_ORDER.length-index<=loop.limits.maxReasoningCalls,'not enough remaining calls for complete assembly');
    ensure(binding.loopDeadlineMs-Date.now()>=1000,'Loop deadline exhausted');
    assertStageAttemptLedger(store,actual,charged);
    const spent=charged.reduce((n,parent)=>n+parent.usage!,0),reservation=binding.sessionTokenCeiling===null?loop.config.reservation:binding.sessionTokenCeiling-spent;
    ensure(Number.isSafeInteger(spent)&&Number.isSafeInteger(reservation)&&reservation>0,'shared author session budget exhausted');
    const next:AnyHostAuthorStageBinding={...binding,index,stage:AUTHOR_STAGE_ORDER[index],parents:all.map(parent=>authorStageParent(parent,dataDir))};
    const nextInput=renderAuthorStageInput({acceptance:input.context.acceptance,candidate:input.context.candidate,binding:next,parents:all.map(parent=>parent.result)},input.context.authorPresentation.schemaVersion===10?9:input.context.authorPresentation.schemaVersion);
    const commandId=binding.sessionId+':'+index;
    // A previously published next job would already be the current reference. It must never be silently dispatched twice.
    ensure(!repo.jobs(loop.id).some(j=>j.id==='supervision-job-'+sha(commandId).slice(0,24)),'next fragment already exists outside current reference');
    const started=repo.beginJob({commandId,loopId:loop.id,expectedRevision:loop.revision,purpose:'acceptance-authoring',context:nextInput,
      config:{...loop.config,reservation,timeoutMs:binding.perCallTimeoutMs}});
    const current=repo.get(loop.id);repo.update(loop.id,current.revision,{phase:'authoring',reason:null,references:{...current.references,authorJobId:started.id}});
    return started;
  });
}
