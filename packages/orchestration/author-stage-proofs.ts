import {assertStageRecoveryRootPolicy,parseStageRecoveryInput,type StageAttemptRef,type StageRejectionRef} from './author-stage-recovery-presentation.js';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,sep} from 'node:path';
import type {SupervisionJob,SupervisionRecord} from '../contracts/p6-supervision.js';
import type {AnyHostAuthorStageBinding} from '../contracts/p6-author-stages.js';
import {runtimeCanonical} from '../persistence/runtime.js';
import {parseReasonerOutput} from './reasoner-schema.js';
import {assertAuthorWireProof} from './author-presentation-proofs.js';
import {parseAuthorStageInput,parseAuthorStageOutput,authorStageDigest,expandAuthorStages} from './author-stage-protocol.js';
import {inspectProcess} from '../process-control/index.js';

type ReadJob=(id:string)=>SupervisionJob;
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const same=(a:unknown,b:unknown)=>authorStageDigest(a)===authorStageDigest(b);
function ensure(value:unknown,message:string):asserts value {if(!value)throw Error('Author stages: '+message);}
const scope=['loopId','runtimeId','projectId','runId','contractVersion','contractDigest','purpose'] as const;

/** These checks establish completed fragment provenance, not semantic acceptance. */
export function assertStoredAuthorStage(job:SupervisionJob,dataDir:string):void {
  const input=parseAuthorStageInput(job.input);ensure(input,'missing stage input');
  assertStoredAuthorOutput(job,dataDir);
}

/** Complete immutable raw/output/turn/process evidence, shared by stage-derived patches. */
export function assertStoredAuthorOutput(job:SupervisionJob,dataDir:string):void {
  const input=job.input as {outputSchema:Record<string,unknown>};
  ensure(job.purpose==='acceptance-authoring'&&job.status==='finished'&&!job.error&&job.result!==null
    &&job.modelStarted&&job.stopConfirmed&&job.threadId&&job.usage!==null
    &&Number.isSafeInteger(job.usage)&&job.usage>=job.observedUsage&&job.usage<=job.config.reservation,'fragment not completed with known cost');
  ensure(sha(runtimeCanonical(job.input))===job.inputDigest,'fragment input changed');
  ensure(sha(runtimeCanonical({usage:job.reportedUsage??job.usage,stopConfirmed:job.stopConfirmed,error:job.error,
    proofs:job.proofs,threadId:job.threadId,result:job.result}))===job.completionDigest,'fragment completion changed');
  parseReasonerOutput(JSON.stringify(job.result),input.outputSchema);
  const directory=join(realpathSync(dataDir),'supervision-reasoning',sha(job.id));let total=0;
  ensure(Object.keys(job.proofs).length>0&&Object.keys(job.proofs).length<=512,'fragment proof inventory missing');
  for(const [path,digest] of Object.entries(job.proofs)){
    const stat=lstatSync(path),actual=realpathSync(path),suffix=relative(directory,actual);
    ensure(stat.isFile()&&!stat.isSymbolicLink()&&suffix!==''&&suffix!=='..'&&!suffix.startsWith('..'+sep)&&!isAbsolute(suffix),'fragment proof escaped');
    total+=stat.size;ensure(total<=64*1024*1024&&sha(readFileSync(path))===digest,'fragment proof changed or oversized');
  }
  const read=(name:string)=>{const path=join(directory,name);ensure(Object.hasOwn(job.proofs,path),'fragment proof missing: '+name);return readFileSync(path,'utf8');};
  const raw=read('output.txt'),transport=JSON.parse(read('result.json'));
  ensure(same(JSON.parse(raw),job.result)&&same(transport.value,job.result),'fragment raw differs from completed result');
  ensure(transport.threadId===job.threadId&&transport.usage===job.usage&&transport.stopConfirmed===true&&transport.modelStarted===true,'fragment transport accounting changed');
  assertAuthorWireProof(job,directory);
  const events=read('events.jsonl').trim().split('\n').map(line=>JSON.parse(line));
  const completed=events.filter(e=>e.kind==='codex-event'&&e.value?.raw?.method==='turn/completed').map(e=>e.value.raw.params);
  ensure(completed.length===1&&completed[0].threadId===job.threadId&&completed[0].turn.id===transport.turnId
    &&completed[0].turn.status==='completed'&&completed[0].turn.items.filter((item:{type:string})=>item.type==='agentMessage').at(-1)?.text===raw,'fragment raw lacks actual final turn');
  ensure(job.identities.length>0&&job.identities.length===job.intents.length&&new Set(job.identities.map(i=>i.operationId)).size===job.identities.length,'fragment process ownership incomplete');
  for(const identity of job.identities){
    const intent=job.intents.find(i=>i.operationId===identity.operationId&&i.ownerToken===identity.ownerToken);
    const stops=events.filter(e=>e.kind==='process-stop'&&same(e.value?.result?.identity,identity));
    ensure(intent&&stops.length===1&&stops[0].value.result.stopped&&stops[0].value.result.stop?.status==='stopped'
      &&stops[0].value.result.stop.stopped&&stops[0].value.result.stop.members.length===0,'fragment stop evidence incomplete');
  }
}

export function stageAttemptRef(job:SupervisionJob):StageAttemptRef {
  ensure(job.completionDigest,'previous stage completion missing');
  return {jobId:job.id,inputDigest:job.inputDigest,completionDigest:job.completionDigest,proofsDigest:authorStageDigest(job.proofs)};
}
function assertStageCompletion(job:SupervisionJob):void {
  ensure(job.status==='finished'&&job.stopConfirmed&&job.usage!==null&&Number.isSafeInteger(job.usage)
    &&job.usage>=job.observedUsage&&job.usage<=job.config.reservation,'stage accounting unresolved');
  ensure(sha(runtimeCanonical(job.input))===job.inputDigest,'stage input changed');
  ensure(sha(runtimeCanonical({usage:job.reportedUsage??job.usage,stopConfirmed:job.stopConfirmed,error:job.error,
    proofs:job.proofs,threadId:job.threadId,result:job.result}))===job.completionDigest,'stage completion changed');
}
/** A complete rejected output is evidence of rejection only, never a successful parent. */
export function readRejectedAuthorStage(job:SupervisionJob,dataDir:string):{ref:StageRejectionRef;raw:unknown} {
  const input=parseAuthorStageInput(job.input);
  ensure(input?.context.authorStage.protocol==='acceptance-stages-v2'&&!parseStageRecoveryInput(job.input),'only an original V2 fragment can be regenerated once');
  assertStageCompletion(job);
  ensure(job.purpose==='acceptance-authoring'&&job.error&&job.result===null&&job.modelStarted&&job.threadId,'stage is not a completed rejected fragment');
  const directory=join(realpathSync(dataDir),'supervision-reasoning',sha(job.id));let total=0;
  ensure(Object.keys(job.proofs).length>0&&Object.keys(job.proofs).length<=512,'rejected stage proof inventory missing');
  for(const [path,digest] of Object.entries(job.proofs)){
    const stat=lstatSync(path),actual=realpathSync(path),suffix=relative(directory,actual);
    ensure(stat.isFile()&&!stat.isSymbolicLink()&&suffix!==''&&suffix!=='..'&&!suffix.startsWith('..'+sep)&&!isAbsolute(suffix),'rejected stage proof escaped');
    total+=stat.size;ensure(total<=64*1024*1024&&sha(readFileSync(path))===digest,'rejected stage proof changed');
  }
  const read=(name:string)=>{const path=join(directory,name);ensure(Object.hasOwn(job.proofs,path),'rejected stage proof missing: '+name);return readFileSync(path,'utf8');};
  const text=read('output.txt'),raw:unknown=JSON.parse(text),transport=JSON.parse(read('result.json'));
  ensure(transport.threadId===job.threadId&&transport.usage===job.usage&&transport.stopConfirmed===true&&transport.modelStarted===true,'rejected stage transport differs');
  assertAuthorWireProof(job,directory);
  const events=read('events.jsonl').trim().split('\n').map(line=>JSON.parse(line));
  const completed=events.filter(e=>e.kind==='codex-event'&&e.value?.raw?.method==='turn/completed').map(e=>e.value.raw.params);
  ensure(completed.length===1&&completed[0].threadId===job.threadId&&completed[0].turn.id===transport.turnId
    &&completed[0].turn.status==='completed'&&completed[0].turn.items.filter((item:{type:string})=>item.type==='agentMessage').at(-1)?.text===text,'rejected stage lacks actual completed output');
  ensure(job.identities.length>0&&job.identities.length===job.intents.length&&new Set(job.identities.map(i=>i.operationId)).size===job.identities.length,'rejected stage ownership incomplete');
  for(const identity of job.identities){
    const intent=job.intents.find(i=>i.operationId===identity.operationId&&i.ownerToken===identity.ownerToken);
    const stops=events.filter(e=>e.kind==='process-stop'&&same(e.value?.result?.identity,identity));
    ensure(intent&&stops.length===1&&stops[0].value.result.stopped&&stops[0].value.result.stop?.status==='stopped'
      &&stops[0].value.result.stop.stopped&&stops[0].value.result.stop.members.length===0,'rejected stage stop proof incomplete');
  }
  let classification:'schema'|'semantic'='schema',message:string|null=null;
  try{parseReasonerOutput(text,input.outputSchema);}catch(error){message=error instanceof Error?error.message:String(error);}
  if(message===null){classification='semantic';try{parseAuthorStageOutput(raw,input.context.acceptance,input.context.authorStage,input.context.authorStageParents);}catch(error){message=error instanceof Error?error.message:String(error);}}
  ensure(message!==null&&message===job.error,'stage error is not the exact schema/semantic rejection');
  if(classification==='semantic')ensure(same(transport.value,raw),'rejected fragment raw differs');
  else ensure(transport.value===null&&same(transport.outputRejection,{schemaVersion:1,kind:'schema',rawOutputDigest:sha(text),message}),'missing typed schema rejection');
  return {ref:{...stageAttemptRef(job),rawOutputDigest:sha(text),classification,message},raw};
}

/** Actual ancestry, in charged order. Failed fragments never satisfy accepted stage slots. */
export function authorStageChargePrefix(job:SupervisionJob,readJob:ReadJob,dataDir?:string):SupervisionJob[] {
  const result:SupervisionJob[]=[],seen=new Set<string>(),visiting=new Set<string>();
  const visit=(node:SupervisionJob,include:boolean):void=>{
    ensure(!visiting.has(node.id)&&seen.size<64,'cyclic or oversized stage attempt ancestry');
    if(seen.has(node.id))return;
    visiting.add(node.id);
    for(const field of scope)ensure(node[field]===job[field],'foreign charged stage scope');
    ensure(node.config.model===job.config.model&&node.config.effort===job.config.effort,'charged stage model differs');
    const input=parseAuthorStageInput(node.input);ensure(input,'charged attempt is not a stage');
    const root=parseAuthorStageInput(job.input)!;
    for(const key of ['protocol','sessionId','sessionTokenCeiling','perCallTimeoutMs','loopDeadlineMs'] as const)
      ensure(input.context.authorStage[key]===root.context.authorStage[key],'charged stage session differs');
    ensure(same(input.context.acceptance,root.context.acceptance)&&same(input.context.candidate,root.context.candidate),'charged stage context differs');
    for(const parent of input.context.authorStage.parents)visit(readJob(parent.jobId),true);
    const recovery=parseStageRecoveryInput(node.input);
    if(recovery){
      const r=recovery.context.stageRecovery,failed=readJob(r.rejection.jobId),failedInput=parseAuthorStageInput(failed.input);
      ensure(failedInput&&!parseStageRecoveryInput(failed.input)&&same(failedInput.context.authorStage,input.context.authorStage)
        &&same(failedInput.context.authorStageParents,input.context.authorStageParents)&&same(failedInput.outputSchema,input.outputSchema),'recovery replaced another stage or its parents');
      ensure(same(stageAttemptRef(failed),{jobId:r.rejection.jobId,inputDigest:r.rejection.inputDigest,completionDigest:r.rejection.completionDigest,proofsDigest:r.rejection.proofsDigest}),'rejected stage reference differs');
      if(dataDir){const actual=readRejectedAuthorStage(failed,dataDir);ensure(same(actual.ref,r.rejection)&&same(actual.raw,r.raw),'rejected stage evidence differs');}
      visit(failed,true);
      if(r.previousAttempt){
        const previous=readJob(r.previousAttempt.jobId),prior=parseStageRecoveryInput(previous.input);
        ensure(prior&&same(stageAttemptRef(previous),r.previousAttempt)&&same(prior.context.stageRecovery.rejection,r.rejection)
          &&same(prior.context.authorStage,input.context.authorStage)&&same(prior.context.stageRecovery.raw,r.raw),'resume previous attempt differs');
        assertStageCompletion(previous);
        ensure(!previous.modelStarted&&previous.usage===0&&previous.result===null&&previous.error&&/cancelled|dispatch disabled|paused/i.test(previous.error),'only explicit known-zero unstarted recovery may resume');
        visit(previous,true);
      }
    }
    visiting.delete(node.id);seen.add(node.id);
    if(include){
      assertStageCompletion(node);
      if(dataDir&&!node.error)assertStoredAuthorStage(node,dataDir);
      if(dataDir&&node.error&&!node.modelStarted){
        ensure(node.usage===0&&node.result===null&&node.intents.length===node.identities.length,'known-zero attempt has unresolved process ownership');
        const directory=join(realpathSync(dataDir),'supervision-reasoning',sha(node.id));let bytes=0;
        for(const [path,digest] of Object.entries(node.proofs)){
          const stat=lstatSync(path),suffix=relative(directory,realpathSync(path));bytes+=stat.size;
          ensure(stat.isFile()&&!stat.isSymbolicLink()&&suffix!==''&&suffix!=='..'&&!suffix.startsWith('..'+sep)&&!isAbsolute(suffix)
            &&bytes<=64*1024*1024&&sha(readFileSync(path))===digest,'known-zero stage evidence differs');
        }
        if(node.identities.length){
          const path=join(directory,'events.jsonl');ensure(Object.hasOwn(node.proofs,path),'known-zero process events missing');
          const events=readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
          for(const identity of node.identities)ensure(node.intents.some(i=>i.operationId===identity.operationId&&i.ownerToken===identity.ownerToken)
            &&events.some(e=>e.kind==='process-stop'&&same(e.value?.result?.identity,identity)&&e.value.result.stopped&&e.value.result.stop?.status==='stopped'
              &&e.value.result.stop.stopped&&e.value.result.stop.members.length===0),'known-zero stop evidence missing');
        }
      }
      ensure(node.config.reservation===root.context.authorStage.sessionTokenCeiling-result.reduce((n,j)=>n+j.usage!,0),'charged attempt reservation differs');
      result.push(node);
    }
  };
  visit(job,false);
  const recoveries=[...result.map(x=>parseStageRecoveryInput(x.input)),parseStageRecoveryInput(job.input)].filter(x=>x!==null);
  assertStageRecoveryRootPolicy(recoveries.map(input=>({schemaVersion:input.context.stageRecovery.schemaVersion,
    sessionId:input.context.authorStage.sessionId,index:input.context.authorStage.index,rejectionJobId:input.context.stageRecovery.rejection.jobId})));
  return result;
}

export function authorStageParent(job:SupervisionJob,dataDir:string):AnyHostAuthorStageBinding['parents'][number] {
  assertStoredAuthorStage(job,dataDir);const input=parseAuthorStageInput(job.input)!;
  return {stage:input.context.authorStage.stage,jobId:job.id,inputDigest:job.inputDigest,
    resultDigest:authorStageDigest(job.result),rawOutputDigest:sha(readFileSync(join(realpathSync(dataDir),'supervision-reasoning',sha(job.id),'output.txt'))),
    proofsDigest:authorStageDigest(job.proofs)};
}

/** Only actual immutable jobs can satisfy the ordered prerequisites. No receipt table or second budget. */
export function assertAuthorStageParents(job:SupervisionJob,readJob:ReadJob,dataDir:string):SupervisionJob[] {
  const input=parseAuthorStageInput(job.input);if(!input)return [];
  const binding=input.context.authorStage;
  const parents=binding.parents.map((ref,index)=>{
    const parent=readJob(ref.jobId);ensure(parent.id!==job.id,'self-referencing fragment');
    for(const field of scope)ensure(parent[field]===job[field],'foreign fragment scope');
    ensure(same(authorStageParent(parent,dataDir),ref),'actual parent binding changed');
    const prior=parseAuthorStageInput(parent.input)!;
    ensure(prior.context.authorStage.index===index,'fragment order changed');
    ensure(prior.context.authorStage.protocol===binding.protocol
      &&prior.context.authorStage.sessionId===binding.sessionId
      &&prior.context.authorStage.sessionTokenCeiling===binding.sessionTokenCeiling
      &&prior.context.authorStage.perCallTimeoutMs===binding.perCallTimeoutMs
      &&prior.context.authorStage.loopDeadlineMs===binding.loopDeadlineMs,'fragment session changed');
    ensure(same(prior.context.authorStage.parents,binding.parents.slice(0,index)),'fragment ancestry changed');
    ensure(same(prior.context.acceptance,input.context.acceptance)&&same(prior.context.candidate,input.context.candidate),'fragment requirements or candidate changed');
    ensure(same(parent.result,input.context.authorStageParents[index]),'rendered parent differs from actual result');
    ensure(same(prior.context.authorStageParents,input.context.authorStageParents.slice(0,index)),'prior rendered ancestry differs');
    ensure(parent.config.model===job.config.model&&parent.config.effort===job.config.effort,'model changed within an author session');
    const charged=authorStageChargePrefix(parent,readJob,dataDir);
    ensure(parent.config.reservation===binding.sessionTokenCeiling-charged.reduce((n,j)=>n+j.usage!,0),'prior fragment reservation differs');
    return parent;
  });
  const spent=authorStageChargePrefix(job,readJob,dataDir).reduce((n,parent)=>n+parent.usage!,0);
  ensure(Number.isSafeInteger(spent)&&job.config.reservation===binding.sessionTokenCeiling-spent&&job.config.reservation>0,'shared author session ceiling changed');
  ensure(job.config.timeoutMs<=binding.perCallTimeoutMs&&job.config.timeoutMs>=1000
    &&Date.parse(job.startedAt)<binding.loopDeadlineMs,'stage exceeds its call or Loop deadline');
  return parents;
}

/** Cheap current-state check; full immutable parent proofs are checked at dispatch/use. */
export function assertAuthorStagePolicy(job:SupervisionJob,loop:SupervisionRecord,readJob:ReadJob):void {
  const input=parseAuthorStageInput(job.input);if(!input)return;
  const b=input.context.authorStage;
  ensure(loop.authoringProtocol===b.protocol,'Loop did not select staged authoring');
  ensure(b.sessionTokenCeiling===loop.config.reservation&&b.perCallTimeoutMs===loop.config.timeoutMs
    &&b.loopDeadlineMs===Date.parse(loop.createdAt)+loop.limits.maxDurationMs&&job.config.model===loop.config.model&&job.config.effort===loop.config.effort,'stage policy differs from original Loop');
  for(const ref of b.parents){const parent=readJob(ref.jobId);ensure(parent.status==='finished'&&!parent.error&&parent.stopConfirmed&&parent.usage!==null,'stage has unresolved parent');}
  const spent=authorStageChargePrefix(job,readJob).reduce((n,parent)=>n+parent.usage!,0);
  ensure(Number.isSafeInteger(spent)&&job.config.reservation===b.sessionTokenCeiling-spent&&job.config.reservation>0,'stage budget differs from actual prior usage');
  ensure(job.config.timeoutMs<=b.perCallTimeoutMs&&Date.parse(job.startedAt)<b.loopDeadlineMs,'stage time policy changed');
}

export async function assertAuthorStagePhysical(job:SupervisionJob,readJob:ReadJob,dataDir:string):Promise<void> {
  if(!parseAuthorStageInput(job.input))return;
  assertAuthorStageParents(job,readJob,dataDir);
  for(const parent of authorStageChargePrefix(job,readJob,dataDir))
    for(const identity of parent.identities)ensure((await inspectProcess(identity)).status==='stopped','fragment process is not actually stopped');
}

/** Raw final-stage output stays a fragment. The bundle is deterministic derived data. */
export function resolveStagedAuthor(job:SupervisionJob,readJob:ReadJob,dataDir:string) {
  const input=parseAuthorStageInput(job.input);ensure(input&&input.context.authorStage.index===2,'assembly requires the final stage');
  const parents=assertAuthorStageParents(job,readJob,dataDir);
  const bundle=expandAuthorStages(input.context.acceptance,parents[0]!.result,parents[1]!.result,job.result);
  return {bundle,receipt:{schemaVersion:1,kind:'acceptance-stage-assembly',jobId:job.id,inputDigest:job.inputDigest,
    session:input.context.authorStage,...(authorStageChargePrefix(job,readJob,dataDir).some(j=>j.error||parseStageRecoveryInput(j.input))||parseStageRecoveryInput(job.input)?{chargedAttempts:authorStageChargePrefix(job,readJob,dataDir).map(stageAttemptRef)}:{}),fragmentDigest:authorStageDigest(job.result),bundleDigest:authorStageDigest(bundle)}};
}

export function authorStageAssemblyRecord(job:SupervisionJob,readJob:ReadJob,dataDir:string):Record<string,unknown>|null {
  const input=parseAuthorStageInput(job.input);if(!input||input.context.authorStage.index!==2)return null;
  assertAuthorStageParents(job,readJob,dataDir);
  try{return resolveStagedAuthor(job,readJob,dataDir).receipt;}
  catch(error){return {schemaVersion:1,kind:'acceptance-stage-assembly-rejected',jobId:job.id,inputDigest:job.inputDigest,
    session:input.context.authorStage,fragmentDigest:authorStageDigest(job.result),error:error instanceof Error?error.message:String(error)};}
}

export function assertAuthorStageAssemblyProof(job:SupervisionJob,readJob:ReadJob,dataDir:string):void {
  const record=authorStageAssemblyRecord(job,readJob,dataDir);if(!record)return;
  const path=join(realpathSync(dataDir),'supervision-reasoning',sha(job.id),'author-assembly.json'),bytes=readFileSync(path);
  ensure(job.proofs[path]===sha(bytes)&&same(JSON.parse(bytes.toString()),record),'assembly proof changed');
}
