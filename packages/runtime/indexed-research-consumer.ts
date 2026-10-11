import {expandedAuthorInput} from '../orchestration/indexed-history-presentation.js';
import {runtimeCanonical} from '../persistence/runtime.js';
import {assertIndexedConsumerArchiveSync} from '../workspace/indexed-consumer-proof.js';
import {readAuthorSourceRefreshGeneration} from '../verification/source-refresh-binding.js';
import {exactIndexedStage} from '../verification/indexed-stage-authority.js';
import {captureIndexedRefreshViews,indexedRefreshViewEntriesSync} from '../verification/indexed-refresh-views.js';
import {assertResearchViewSet} from '../workspace/research-reader-views.js';
import {prepareResearchReader} from '../workspace/research-reader.js';
import type {PreparedResearchViewSet} from '../contracts/p8-research-reader.js';
import {indexedCallScopes,exactIndexedCallScope} from '../verification/indexed-call-scope.js';
import {readdirSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import type {SupervisorStore} from '../persistence/store.js';
import type {PreparedResearchReader} from '../contracts/p8-research-reader.js';
import type {ProcessIdentity} from '../process-control/index.js';
import {MaterialReaderSession} from '../executor-codex/material-reader-session.js';
import {assertResearchReader} from '../workspace/research-reader.js';
import {researchDigest} from '../workspace/research-materials.js';
import {readMaterialBinding} from '../verification/material.js';
import {MATERIAL_READER_SCHEMA_DIGEST} from '../executor-codex/material-reader-baseline.js';
import {assertMaterialIndex,readBounded,bytesDigest} from '../workspace/research-runtime-files.js';
import type {MaterialVerifierBinding} from '../contracts/p4-material.js';
const grants=new WeakSet<object>();
const grantKey=Symbol('actual-host-indexed-grant');
export const isIndexedResearchConsumer=(value:unknown):value is IndexedResearchConsumer=>!!value&&typeof value==='object'&&grants.has(value);
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function ensure(value:unknown,message:string):asserts value {if(!value)throw Error('Indexed consumer: '+message);}
/** Internal host object. It is not an action input, permission or result verdict. */
export class IndexedResearchConsumer {
 #session:MaterialReaderSession|undefined;
 private constructor(key:symbol,readonly reader:PreparedResearchReader,readonly jobId:string,readonly attemptId:string,readonly inputDigest:string,private readonly boundary:()=>void,private readonly identityBound:(identity:ProcessIdentity)=>void,readonly callRoot?:string,readonly viewSet?:PreparedResearchViewSet,readonly stageAuthorityDigest?:string){ensure(key===grantKey,'Host factory required; caller cannot construct a grant');this.reader=freeze(structuredClone(reader));if(viewSet)this.viewSet=freeze(structuredClone(viewSet));for(const name of ['reader','jobId','attemptId','inputDigest','boundary','identityBound','callRoot','viewSet','stageAuthorityDigest'])Object.defineProperty(this,name,{writable:false,configurable:false});grants.add(this);}
 static async execution(store:SupervisorStore,id:string):Promise<IndexedResearchConsumer|null>{
  const record=store.executionGet(id);
  if(record.scheduledBinding){
   const claim=store.scheduler.claimGet(record.scheduledBinding.claimId),input=store.researchGroups.inputForClaim(claim);
   if(!input?.indexed)return null;
   const reader=structuredClone(input.indexed),digest=input.digest;
   const boundary=()=>{const e=store.executionGet(id),actualClaim=store.scheduler.claimGet(claim.id),actual=store.researchGroups.assertDispatch(actualClaim);
    ensure(e.scheduledBinding?.claimId===actualClaim.id&&e.scheduledBinding.operationId===actualClaim.operationId&&e.id===actualClaim.attemptId&&e.runId===actualClaim.runId&&e.projectId===actualClaim.projectId&&!e.cancelRequested&&['starting','running','waiting'].includes(e.state)&&actual?.schemaVersion===2&&actual.digest===digest&&actual.indexed&&researchDigest(actual.indexed)===researchDigest(reader)&&reader.view.role==='current'&&researchDigest(reader.view.allowedMaterialIds)===researchDigest(actual.group.materialIds),'Actual indexed group execution scope changed');
   };boundary();await assertResearchReader(reader);boundary();return new IndexedResearchConsumer(grantKey,reader,id,id,digest,boundary,identity=>{ensure(researchDigest(store.executionGet(id).identity)===researchDigest(identity),'Actual group process identity differs');});
  }
  if(!record.runtimeBinding)return null;
  const op=store.runtime.getOperation(record.runtimeBinding.operationId),input=store.runtime.researchInput(op.id);
  if(!input?.package.indexed)return null;
  ensure(input.package.schemaVersion===2,'Only explicit indexed package supported');
  const digest=input.digest,reader=structuredClone(input.package.indexed);
  const boundary=()=>{const e=store.executionGet(id),o=store.runtime.getOperation(op.id),r=store.runtime.get(o.runtimeId),run=store.runtime.inspect(r.id).run;
   ensure(e.runtimeBinding?.operationId===o.id&&e.runtimeBinding.owner===o.owner&&o.executionId===id&&e.runId===run.id&&e.projectId===run.projectId&&o.contractVersion===run.contract.version&&!r.cancelled&&!r.paused&&!e.cancelRequested&&['starting','running','waiting'].includes(e.state),'Execution scope no longer dispatchable');
   const actual=store.runtime.researchInput(o.id);ensure(actual?.digest===digest&&actual.package.indexed&&researchDigest(actual.package.indexed)===researchDigest(reader),'Actual frozen research grant changed');store.runtime.verifyResearchInputs(o.id);
   ensure(reader.view.role==='current'&&researchDigest(reader.view.allowedMaterialIds)===researchDigest(actual.package.context.index.inputs.map(i=>i.id)),'Exact source grant changed');
  };boundary();await assertResearchReader(reader);boundary();return new IndexedResearchConsumer(grantKey,reader,id,id,digest,boundary,identity=>{ensure(researchDigest(store.executionGet(id).identity)===researchDigest(identity),'Actual execution identity differs');});
 }
 static async supervision(store:SupervisorStore,id:string):Promise<IndexedResearchConsumer|null>{
  const job=store.supervision.job(id),context=(expandedAuthorInput(job.input) as {context?:{evolution?:{sourceRefresh?:import('../contracts/p4-source-refresh.js').SourceRefreshControlContext};acceptance?:{materials?:{binding:MaterialVerifierBinding;evidence:{indexed?:PreparedResearchReader}}[]}}}).context;
  const materials=context?.acceptance?.materials,selected=materials?.filter(m=>m.evidence.indexed);
  if(!selected?.length)return null;
  ensure(selected.length===materials!.length&&new Set(selected.map(m=>m.evidence.indexed!.digest)).size===1,'Multiple/mixed source contexts require separate reviewed protocol');
  const reader=structuredClone(selected[0]!.evidence.indexed!),binding=structuredClone(selected[0]!.binding),digest=job.inputDigest;
  const refresh=context?.evolution?.sourceRefresh;let viewSet:PreparedResearchViewSet|undefined,authority:string|undefined;
  if(refresh){readAuthorSourceRefreshGeneration(store,store.verification.dataDirectory(),id);viewSet=await captureIndexedRefreshViews(binding,refresh);ensure(researchDigest(viewSet.views)===researchDigest(indexedRefreshViewEntriesSync(binding,refresh)),'Author frozen historical/current inventory differs');authority=researchDigest({jobId:job.id,inputDigest:job.inputDigest,refresh:refresh.digest});}
  const actual=await readMaterialBinding(binding);ensure(actual.input.schemaVersion===2&&actual.input.indexed&&researchDigest(actual.input.indexed)===researchDigest(reader),'Author view is not the actual frozen producer');
  ensure(reader.view.role==='current'&&researchDigest(reader.view.allowedMaterialIds)===researchDigest(actual.input.context.index.inputs.map(i=>i.id)),'Author requires all original input identities');
  const boundary=()=>{const j=store.supervision.job(id),run=store.runtime.inspect(j.runtimeId).run,r=store.runtime.get(j.runtimeId);
   ensure(j.status==='running'&&j.inputDigest===digest&&j.contractVersion===run.contract.version&&!r.paused&&!r.cancelled&&!store.supervision.get(j.loopId).stopped,'Author job scope expired');
   ensure(binding.operationId===store.runtime.currentOperations(r.id).find(o=>o.id===binding.operationId)?.id,'Producer is not current');if(refresh)readAuthorSourceRefreshGeneration(store,store.verification.dataDirectory(),id);
  };boundary();await assertResearchReader(reader);if(viewSet)await assertResearchViewSet(viewSet);boundary();return new IndexedResearchConsumer(grantKey,reader,id,job.attemptId,digest,boundary,identity=>{ensure(store.supervision.job(id).identities.some(i=>researchDigest(i)===researchDigest(identity)),'Actual author identity differs');},undefined,viewSet,authority);
 }
 static async verification(store:SupervisorStore,jobId:string,binding:MaterialVerifierBinding,reader:PreparedResearchReader,detectorDigest:string,callRoot:string):Promise<IndexedResearchConsumer>{
  const job=store.verification.get('job',jobId),proposal=store.verification.get('proposal',job.proposalId);
  ensure(proposal.spec.cases.some(c=>c.verifier.kind==='material'&&researchDigest(c.verifier.binding)===researchDigest(binding)),'Reader is not bound to an actual frozen detector');
  const actual=await readMaterialBinding(binding);ensure(actual.input.schemaVersion===2&&actual.input.indexed&&researchDigest(actual.input.indexed)===researchDigest(reader),'Indexed reader is not actual producer input');
  ensure(reader.view.role==='current'&&proposal.runtimeId===job.runtimeId&&store.runtime.getOperation(binding.operationId).runtimeId===job.runtimeId,'Historical/cross-Run indexed consumer unsupported');
  const scope=()=>exactIndexedCallScope(indexedCallScopes(store.verification.dataDirectory(),store.verification.get('job',jobId),store.verification.get('proposal',job.proposalId),job.planId?store.verification.get('plan',job.planId):undefined),callRoot);scope();
  const digest=researchDigest({request:job.request,proposal:proposal.id,definition:proposal.bundle.digest,detectorDigest,binding,reader:reader.digest,callRoot});
  const boundary=()=>{const j=store.verification.get('job',jobId),p=store.verification.get('proposal',j.proposalId),r=store.runtime.get(j.runtimeId),run=store.runtime.inspect(r.id).run;
   scope();ensure(j.status==='running'&&!r.cancelled&&!r.paused&&researchDigest(run.contract)===p.contractDigest&&researchDigest({request:j.request,proposal:p.id,definition:p.bundle.digest,detectorDigest,binding,reader:reader.digest,callRoot})===digest,'Verification grant expired');};
  boundary();await assertResearchReader(reader);return new IndexedResearchConsumer(grantKey,structuredClone(reader),job.id,job.attemptId,digest,boundary,identity=>{ensure(store.verification.get('job',job.id).identities.some(i=>researchDigest(i)===researchDigest(identity)),'Actual verifier identity differs');},callRoot);
 }
 static async verificationStage(store:SupervisorStore,jobId:string,detectorDigest:string,callRoot:string):Promise<IndexedResearchConsumer>{
  const job=store.verification.get('job',jobId),p=store.verification.get('proposal',job.proposalId),scope=exactIndexedStage(store,jobId,callRoot);
  const binding=scope.binding!,actual=await readMaterialBinding(binding);ensure(actual.input.indexed,'Actual indexed stage input missing');
  let reader=actual.input.indexed,viewSet:PreparedResearchViewSet|undefined;
  if(scope.contextRole==='historical'){
   ensure(scope.historicalEpoch?.indexed,'Original indexed epoch required');
   const root=binding.inputPath.slice(0,binding.inputPath.lastIndexOf('/research-inputs/'));
   reader=await prepareResearchReader({intake:actual.intake,context:actual.input.context,
    materialIds:actual.input.indexed.view.allowedMaterialIds,role:'historical',dataRoot:root,limits:actual.input.indexed.view.limits});
  }else if(scope.contextRole==='complete-evolution'){
   ensure(scope.refreshContext,'Exact immutable refresh matrix inventory required');
   viewSet=await captureIndexedRefreshViews(binding,scope.refreshContext);
   ensure(researchDigest(viewSet.views)===researchDigest(indexedRefreshViewEntriesSync(binding,scope.refreshContext)),'Actual prepared inventory differs from frozen contexts');
  }
  const authority=scope.contextRole==='current'?undefined:researchDigest(scope);
  const input={request:job.request,proposal:p.id,definition:p.bundle.digest,detectorDigest,binding,reader:reader.digest,callRoot,
   ...(authority?{stageAuthorityDigest:authority}:{}),...(viewSet?{inventoryDigest:viewSet.digest}:{})};
  const digest=researchDigest(input),frozenScopeDigest=researchDigest(scope);
  const boundary=()=>{const j=store.verification.get('job',jobId),proposal=store.verification.get('proposal',j.proposalId),r=store.runtime.get(j.runtimeId),run=store.runtime.inspect(r.id).run;
   ensure(j.status==='running'&&!r.cancelled&&!r.paused&&researchDigest(run.contract)===proposal.contractDigest&&
    researchDigest(exactIndexedStage(store,jobId,callRoot))===frozenScopeDigest&&researchDigest(j.request)===researchDigest(job.request),
    'Frozen indexed stage/input authority expired');};
  boundary();await assertResearchReader(reader);if(viewSet)await assertResearchViewSet(viewSet);boundary();
  return new IndexedResearchConsumer(grantKey,reader,job.id,job.attemptId,digest,boundary,identity=>{
   ensure(store.verification.get('job',jobId).identities.some(i=>researchDigest(i)===researchDigest(identity)),'Actual stage process identity differs');
  },callRoot,viewSet,authority);
 }
 async start(identity:ProcessIdentity,protocolDirectory:string,version:string,assertEligible:()=>void,signal?:AbortSignal):Promise<MaterialReaderSession>{
  ensure(grants.has(this)&&!this.#session,'Actual fresh host grant required');this.boundary();this.identityBound(identity);
  this.#session=await MaterialReaderSession.create({reader:this.reader,...(this.viewSet?{viewSet:this.viewSet}:{}),owner:{jobId:this.jobId,attemptId:this.attemptId,inputDigest:this.inputDigest,processIdentity:identity},protocolDirectory,version,assertEligible:()=>{this.boundary();this.identityBound(identity);assertEligible();},...(signal?{signal}:{})});return this.#session;
 }
 async cancel():Promise<void>{await this.#session?.cancel('Owning consumer stopped or failed');}
 async finish():Promise<void>{ensure(this.#session,'Actual reader session missing');await this.#session.finish();}
 async archive(directory:string):Promise<string[]>{
  if(!this.#session)return [];await this.#session.drain(false);
  const target=join(directory,'indexed-reader');await mkdir(target,{recursive:true,mode:0o700});const proofs:string[]=[];let size=0;
  for(const name of (await readdir(this.#session.directory)).sort()){
   ensure(name==='owner.json'||/^\d+\.json$/.test(name),'Unexpected session evidence');const original=join(this.#session.directory,name),bytes=readBounded(original,6*1024*1024);size+=bytes.length;ensure(size<=6*1024*1024,'Reader audit exceeds original capacity');
   const path=join(target,name);await writeFile(path,bytes,{flag:'wx',mode:0o600});proofs.push(path);
  }
  const path=join(target,'binding.json');await writeFile(path,JSON.stringify({schemaVersion:1,authority:'material-integrity-only',...(this.stageAuthorityDigest?{grantVersion:3}:this.callRoot?{grantVersion:2}:{}),...(this.callRoot?{callRoot:this.callRoot}:{}),...(this.stageAuthorityDigest?{stageAuthorityDigest:this.stageAuthorityDigest}:{}),...(this.viewSet?{viewSet:this.viewSet}:{}),owner:{jobId:this.jobId,attemptId:this.attemptId,inputDigest:this.inputDigest},reader:this.reader,originalDirectory:this.#session.directory,files:Object.fromEntries(await Promise.all(proofs.map(async p=>[p,bytesDigest(readBounded(p,6*1024*1024))])))}),{flag:'wx',mode:0o600});proofs.push(path);return proofs;
 }
}

export {assertIndexedConsumerArchiveSync,assertIndexedConsumerArchive,assertIndexedProducerReceipt} from '../workspace/indexed-consumer-proof.js';

/** Re-read the exact host-frozen author inventory; session metadata alone never
 * nominates historical scope. This proves integrity, not P4 approval. */
export function assertIndexedAuthorArchive(store:Pick<SupervisorStore,'supervision'|'verificationLineage'>,jobId:string,path:string):void{
 const job=store.supervision.job(jobId),context=(expandedAuthorInput(job.input) as {context?:{evolution?:{sourceRefresh?:import('../contracts/p4-source-refresh.js').SourceRefreshControlContext};acceptance?:{materials?:{binding:MaterialVerifierBinding;evidence:{indexed?:PreparedResearchReader}}[]}}}).context;
 ensure(bytesDigest(runtimeCanonical(job.input))===job.inputDigest,'Actual frozen author input changed');
 const actual=assertIndexedConsumerArchiveSync(path,{jobId:job.id,attemptId:job.attemptId,identities:job.identities});
 ensure(actual.proof.owner.inputDigest===job.inputDigest,'Author archive belongs to another frozen input');
 const materials=context?.acceptance?.materials,refresh=context?.evolution?.sourceRefresh;
 ensure(materials?.length&&materials.every(m=>m.evidence.indexed&&researchDigest(m.evidence.indexed)===researchDigest(actual.proof.reader)),'Author actual current source view differs');
 if(refresh){
  ensure(researchDigest(store.verificationLineage.sourceRefreshAuthorization(refresh.generation.authorization.transitionId))===researchDigest(refresh.generation.authorization),'Frozen author refresh authorization differs');
  ensure(actual.proof.grantVersion===3&&actual.proof.stageAuthorityDigest===researchDigest({jobId:job.id,inputDigest:job.inputDigest,refresh:refresh.digest})&&actual.proof.viewSet&&researchDigest(actual.proof.viewSet.views)===researchDigest(indexedRefreshViewEntriesSync(refresh.currentBinding,refresh)),'Author complete original/current frozen inventory differs');
 }else ensure(!actual.proof.viewSet&&!actual.proof.stageAuthorityDigest,'Ordinary author may not gain historical views');
}
