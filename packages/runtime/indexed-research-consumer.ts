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
 private constructor(key:symbol,readonly reader:PreparedResearchReader,readonly jobId:string,readonly attemptId:string,readonly inputDigest:string,private readonly boundary:()=>void,private readonly identityBound:(identity:ProcessIdentity)=>void,readonly callRoot?:string){ensure(key===grantKey,'Host factory required; caller cannot construct a grant');this.reader=freeze(structuredClone(reader));for(const name of ['reader','jobId','attemptId','inputDigest','boundary','identityBound','callRoot'])Object.defineProperty(this,name,{writable:false,configurable:false});grants.add(this);}
 static async execution(store:SupervisorStore,id:string):Promise<IndexedResearchConsumer|null>{
  const record=store.executionGet(id);if(!record.runtimeBinding)return null;
  const op=store.runtime.getOperation(record.runtimeBinding.operationId),input=store.runtime.researchInput(op.id);
  if(!input?.package.indexed)return null;
  ensure(input.package.schemaVersion===2&&!input.package.groups,'Only explicit single-analysis indexed package supported');
  const digest=input.digest,reader=structuredClone(input.package.indexed);
  const boundary=()=>{const e=store.executionGet(id),o=store.runtime.getOperation(op.id),r=store.runtime.get(o.runtimeId),run=store.runtime.inspect(r.id).run;
   ensure(e.runtimeBinding?.operationId===o.id&&e.runtimeBinding.owner===o.owner&&o.executionId===id&&e.runId===run.id&&e.projectId===run.projectId&&o.contractVersion===run.contract.version&&!r.cancelled&&!r.paused&&!e.cancelRequested&&['starting','running','waiting'].includes(e.state),'Execution scope no longer dispatchable');
   const actual=store.runtime.researchInput(o.id);ensure(actual?.digest===digest&&actual.package.indexed&&researchDigest(actual.package.indexed)===researchDigest(reader),'Actual frozen research grant changed');store.runtime.verifyResearchInputs(o.id);
   ensure(reader.view.role==='current'&&researchDigest(reader.view.allowedMaterialIds)===researchDigest(actual.package.context.index.inputs.map(i=>i.id)),'Exact source grant changed');
  };boundary();await assertResearchReader(reader);boundary();return new IndexedResearchConsumer(grantKey,reader,id,id,digest,boundary,identity=>{ensure(researchDigest(store.executionGet(id).identity)===researchDigest(identity),'Actual execution identity differs');});
 }
 static async supervision(store:SupervisorStore,id:string):Promise<IndexedResearchConsumer|null>{
  const job=store.supervision.job(id),context=(job.input as {context?:{acceptance?:{materials?:{binding:MaterialVerifierBinding;evidence:{indexed?:PreparedResearchReader}}[]}}}).context;
  const materials=context?.acceptance?.materials,selected=materials?.filter(m=>m.evidence.indexed);
  if(!selected?.length)return null;
  ensure(selected.length===materials!.length&&new Set(selected.map(m=>m.evidence.indexed!.digest)).size===1,'Multiple/mixed source contexts require separate reviewed protocol');
  const reader=structuredClone(selected[0]!.evidence.indexed!),binding=structuredClone(selected[0]!.binding),digest=job.inputDigest;
  const actual=await readMaterialBinding(binding);ensure(actual.input.schemaVersion===2&&actual.input.indexed&&researchDigest(actual.input.indexed)===researchDigest(reader),'Author view is not the actual frozen producer');
  ensure(reader.view.role==='current'&&researchDigest(reader.view.allowedMaterialIds)===researchDigest(actual.input.context.index.inputs.map(i=>i.id)),'Author requires all original input identities');
  const boundary=()=>{const j=store.supervision.job(id),run=store.runtime.inspect(j.runtimeId).run,r=store.runtime.get(j.runtimeId);
   ensure(j.status==='running'&&j.inputDigest===digest&&j.contractVersion===run.contract.version&&!r.paused&&!r.cancelled&&!store.supervision.get(j.loopId).stopped,'Author job scope expired');
   ensure(binding.operationId===store.runtime.currentOperations(r.id).find(o=>o.id===binding.operationId)?.id,'Producer is not current');
  };boundary();await assertResearchReader(reader);return new IndexedResearchConsumer(grantKey,reader,id,job.attemptId,digest,boundary,identity=>{ensure(store.supervision.job(id).identities.some(i=>researchDigest(i)===researchDigest(identity)),'Actual author identity differs');});
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
 async start(identity:ProcessIdentity,protocolDirectory:string,version:string,assertEligible:()=>void,signal?:AbortSignal):Promise<MaterialReaderSession>{
  ensure(grants.has(this)&&!this.#session,'Actual fresh host grant required');this.boundary();this.identityBound(identity);
  this.#session=await MaterialReaderSession.create({reader:this.reader,owner:{jobId:this.jobId,attemptId:this.attemptId,inputDigest:this.inputDigest,processIdentity:identity},protocolDirectory,version,assertEligible:()=>{this.boundary();this.identityBound(identity);assertEligible();},...(signal?{signal}:{})});return this.#session;
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
  const path=join(target,'binding.json');await writeFile(path,JSON.stringify({schemaVersion:1,authority:'material-integrity-only',...(this.callRoot?{grantVersion:2,callRoot:this.callRoot}:{}),owner:{jobId:this.jobId,attemptId:this.attemptId,inputDigest:this.inputDigest},reader:this.reader,originalDirectory:this.#session.directory,files:Object.fromEntries(await Promise.all(proofs.map(async p=>[p,bytesDigest(readBounded(p,6*1024*1024))])))}),{flag:'wx',mode:0o600});proofs.push(path);return proofs;
 }
}

/** Reopening validates copies and the actual original journal; no semantic authority. */
export function assertIndexedConsumerArchiveSync(path:string,expected:{jobId:string;attemptId:string;identities:ProcessIdentity[];inputDigest?:string;readerDigest?:string},requireClosed=true) {
 const proof=JSON.parse(readBounded(path,1024*1024).toString('utf8')) as {schemaVersion:number;authority:string;grantVersion?:number;callRoot?:string;owner:{jobId:string;attemptId:string;inputDigest:string};reader:PreparedResearchReader;originalDirectory:string;files:Record<string,string>};
 ensure(expected.inputDigest===undefined||proof.owner.inputDigest===expected.inputDigest,'Reader actual frozen input differs');
 ensure(expected.readerDigest===undefined||proof.reader.digest===expected.readerDigest,'Reader actual frozen view differs');
 ensure(proof.schemaVersion===1&&proof.authority==='material-integrity-only'&&proof.owner.jobId===expected.jobId&&proof.owner.attemptId===expected.attemptId,'Reader archive owner changed');
 const {digest:readerDigest,...readerBody}=proof.reader;ensure(researchDigest(readerBody)===readerDigest&&researchDigest(JSON.parse(readBounded(proof.reader.path).toString('utf8')))===researchDigest(proof.reader),'Frozen reader file changed');
 assertMaterialIndex(proof.reader.context.index);let bytes=0;const records:import('../contracts/p8-research-reader.js').ResearchReaderAudit[]=[];
 const originalOwner=JSON.parse(readBounded(join(proof.originalDirectory,'owner.json')).toString('utf8')) as {owner:import('../contracts/p8-research-reader.js').ResearchReaderOwner;readerDigest:string;protocolDigest:string;schemaVersion:number;protocol:string};
 ensure(originalOwner.schemaVersion===1&&originalOwner.protocol==='indexed-material-v1'&&originalOwner.protocolDigest===MATERIAL_READER_SCHEMA_DIGEST&&originalOwner.readerDigest===proof.reader.digest&&originalOwner.owner.jobId===expected.jobId&&originalOwner.owner.attemptId===expected.attemptId&&originalOwner.owner.inputDigest===proof.owner.inputDigest&&expected.identities.some(i=>researchDigest(i)===researchDigest(originalOwner.owner.processIdentity)),'Reader actual process ownership differs');
 const root=proof.reader.context.material.directory.substring(0,proof.reader.context.material.directory.lastIndexOf('/material-intake/'));
 ensure(proof.originalDirectory===join(root,'material-reader-sessions',bytesDigest(researchDigest({owner:originalOwner.owner,viewDigest:proof.reader.view.digest,protocolDigest:originalOwner.protocolDigest}))),'Reader journal path is not derived from actual owner');
 for(const [copy,sha]of Object.entries(proof.files)){
  ensure(copy===join(dirname(path),basename(copy))&&(basename(copy)==='owner.json'||/^\d+\.json$/.test(basename(copy))),'Reader copy escaped proof directory');const value=readBounded(copy,6*1024*1024);bytes+=value.length;ensure(bytes<=6*1024*1024&&bytesDigest(value)===sha,'Reader audit changed or exceeded capacity');
  const name=copy.slice(copy.lastIndexOf('/')+1);ensure(bytesDigest(readBounded(join(proof.originalDirectory,name),6*1024*1024))===sha,'Original reader journal differs from copied proof');if(name!=='owner.json')records.push(JSON.parse(value.toString('utf8')));
 }
 records.sort((a,b)=>a.sequence-b.sequence);for(let i=0;i<records.length;i++){const r=records[i]!,{digest,...body}=r;ensure(r.sequence===i+1&&researchDigest(body)===digest&&researchDigest(r.owner)===researchDigest(originalOwner.owner)&&r.viewDigest===proof.reader.view.digest,'Reader journal binding/order changed');}
 if(requireClosed)ensure(records.at(-1)?.stage==='closed'&&!records.some(r=>r.stage==='aborted'),'Incomplete reader cannot support applicable result');
 ensure(readdirSync(dirname(path)).filter(name=>name!=='binding.json').sort().join('|')===Object.keys(proof.files).map(name=>basename(name)).sort().join('|'),'Copied reader inventory changed');
 ensure(readdirSync(proof.originalDirectory).sort().join('|')===['owner.json',...records.map(r=>r.sequence+'.json')].sort().join('|'),'Original reader inventory changed');
 return {proof,records};
}
export async function assertIndexedConsumerArchive(path:string,expected:{jobId:string;attemptId:string;identities:ProcessIdentity[];inputDigest?:string;readerDigest?:string},requireClosed=true){
 const actual=assertIndexedConsumerArchiveSync(path,expected,requireClosed);await assertResearchReader(actual.proof.reader);return actual;
}

/** Exact receipt inventory; neither a payload label nor an empty proof list is a grant. */
export async function assertIndexedProducerReceipt(path:string,proofs:Record<string,string>,expected:{jobId:string;attemptId:string;identity:ProcessIdentity;inputDigest:string;readerDigest:string}) {
 ensure(Object.keys(proofs).length>0&&Object.keys(proofs).filter(p=>p.endsWith('/indexed-reader/binding.json')).length===1&&proofs[path],'Actual complete producer reader binding required');
 const actual=await assertIndexedConsumerArchive(path,{jobId:expected.jobId,attemptId:expected.attemptId,identities:[expected.identity],inputDigest:expected.inputDigest,readerDigest:expected.readerDigest});
 const inventory={...actual.proof.files,[path]:bytesDigest(readBounded(path))};
 ensure(researchDigest(proofs)===researchDigest(inventory),'Producer reader receipt inventory differs');
 for(const [p,sha]of Object.entries(inventory))ensure(bytesDigest(readBounded(p,6*1024*1024))===sha,'Producer reader receipt bytes changed');
 return actual;
}
