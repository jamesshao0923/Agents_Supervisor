import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,sep} from 'node:path';
import type {SupervisionJob,SupervisionRecord} from '../contracts/p6-supervision.js';
import type {AnyHostAuthorStageBinding} from '../contracts/p6-author-stages.js';
import {runtimeCanonical} from '../persistence/runtime.js';
import {parseReasonerOutput} from './reasoner-schema.js';
import {assertAuthorWireProof} from './author-presentation-proofs.js';
import {parseAuthorStageInput,authorStageDigest,expandAuthorStages} from './author-stage-protocol.js';
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
  let priorSpent=0;
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
    ensure(parent.config.reservation===binding.sessionTokenCeiling-priorSpent,'prior fragment reservation differs');
    priorSpent+=parent.usage!;
    return parent;
  });
  const spent=parents.reduce((n,parent)=>n+parent.usage!,0);
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
  let spent=0;
  for(const ref of b.parents){const parent=readJob(ref.jobId);ensure(parent.status==='finished'&&!parent.error&&parent.stopConfirmed&&parent.usage!==null,'stage has unresolved parent');spent+=parent.usage;}
  ensure(Number.isSafeInteger(spent)&&job.config.reservation===b.sessionTokenCeiling-spent&&job.config.reservation>0,'stage budget differs from actual prior usage');
  ensure(job.config.timeoutMs<=b.perCallTimeoutMs&&Date.parse(job.startedAt)<b.loopDeadlineMs,'stage time policy changed');
}

export async function assertAuthorStagePhysical(job:SupervisionJob,readJob:ReadJob,dataDir:string):Promise<void> {
  for(const parent of assertAuthorStageParents(job,readJob,dataDir))
    for(const identity of parent.identities)ensure((await inspectProcess(identity)).status==='stopped','fragment process is not actually stopped');
}

/** Raw final-stage output stays a fragment. The bundle is deterministic derived data. */
export function resolveStagedAuthor(job:SupervisionJob,readJob:ReadJob,dataDir:string) {
  const input=parseAuthorStageInput(job.input);ensure(input&&input.context.authorStage.index===2,'assembly requires the final stage');
  const parents=assertAuthorStageParents(job,readJob,dataDir);
  const bundle=expandAuthorStages(input.context.acceptance,parents[0]!.result,parents[1]!.result,job.result);
  return {bundle,receipt:{schemaVersion:1,kind:'acceptance-stage-assembly',jobId:job.id,inputDigest:job.inputDigest,
    session:input.context.authorStage,fragmentDigest:authorStageDigest(job.result),bundleDigest:authorStageDigest(bundle)}};
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
