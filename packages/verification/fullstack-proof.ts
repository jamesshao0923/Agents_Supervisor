import {selectInstances} from './rules.js';
import type {VerificationSpec} from '../contracts/p4.js';
import {lstat,readFile} from 'node:fs/promises';
import {dirname,join,relative,isAbsolute} from 'node:path';
import type {FullstackVerifier} from '../contracts/p4-fullstack.js';
import type {VerificationJob} from './records.js';
import type {FullstackEvidence} from './fullstack-verifier.js';
import {canonical,digest,assertCandidate,type Candidate} from './candidate.js';
import {inspectProcess} from '../process-control/index.js';
const eq=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function requireFact(v:unknown,m:string):asserts v{if(!v)throw Error('Fullstack evidence: '+m);}
/** Revalidates original job facts. Never provides a verdict or authorizes delivery. */
export async function assertFullstackRecord(job:VerificationJob,record:FullstackEvidence,verifier:FullstackVerifier,requireComplete:boolean):Promise<void>{
 requireFact(record.verifierDigest===digest(canonical(verifier)),'declaration digest changed');
 requireFact(record.stopped&&!record.error,'scenario did not stop cleanly');
 const root=dirname(record.factsPath),readProof=async(path:string)=>{const rel=relative(root,path);requireFact(rel!== '..'&&!rel.startsWith('../')&&!isAbsolute(rel),'proof escapes scenario');const st=await lstat(path);requireFact(st.isFile()&&!st.isSymbolicLink(),'proof is not a regular file');const bytes=await readFile(path);requireFact(job.proofs[path]===digest(bytes),'proof missing or bytes changed');return bytes;};
 requireFact(new Set(record.proofFiles).size===record.proofFiles.length&&record.proofFiles.includes(record.factsPath),'duplicate or missing facts proof');
 for(const path of record.proofFiles)await readProof(path);
 requireFact(eq(JSON.parse((await readProof(record.factsPath)).toString()),record),'frozen scenario facts differ');
 const service=JSON.parse((await readProof(join(root,'service','facts.json'))).toString());
 requireFact(service.schemaVersion===1&&service.candidateDigest===record.candidateDigest&&service.entry===record.entry&&record.entry===verifier.entry&&eq(service.processes,record.processes),'host candidate/process facts differ');
 requireFact(record.processes.length===1+record.steps.filter(s=>s.kind==='restart').length,'missing restart generation');
 for(const [i,p]of record.processes.entries()){
  requireFact(p.generation===i+1&&p.identity&&p.result&&p.result.stopped&&p.result.stop.status==='stopped'&&p.result.stop.stopped&&eq(p.result.identity,p.identity),'unresolved process generation');
  requireFact(job.identities.some(v=>eq(v,p.identity))&&job.intents.some(v=>v.operationId===p.identity!.operationId&&v.ownerToken===p.identity!.ownerToken&&v.cwd===record.candidateTree&&v.args.includes(join(record.candidateTree,record.entry))),'process is not bound to original job');
  requireFact(job.fullstackProcessResults?.some(v=>eq(v,p.result)),'actual stop receipt missing');
  requireFact((await inspectProcess(p.identity)).status==='stopped','application still active');
 }
 requireFact(record.steps.length>0&&record.steps.length<=verifier.steps.length,'invalid step count');
 requireFact(eq(service.requests,record.steps.flatMap(s=>s.response?[s.response]:[])),'HTTP observations differ');
 const allImages:string[]=[];
 for(const [i,step]of record.steps.entries()){
  const declared=verifier.steps[i]!;requireFact(step.id===declared.id&&step.kind===declared.kind,'step differs from frozen order');
  if(declared.kind==='request'){
   const response=step.response;requireFact(response&&response.sha256===digest(response.body),'response digest changed');
   requireFact(eq(response.request,{method:declared.method,path:declared.path,...(declared.bodyJson===null?{}:{body:JSON.parse(declared.bodyJson)})}),'request differs from declaration');
   let actual:unknown=response.body;try{if(declared.expectedBody.kind==='json')actual=JSON.parse(response.body);}catch{actual=Symbol('non-json');}
   const passed=response.status===declared.expectedStatus&&(declared.expectedBody.kind==='text'?actual===declared.expectedBody.value:typeof actual!=='symbol'&&eq(actual,JSON.parse(declared.expectedBody.value)));
   requireFact(step.passed===passed,'request verdict differs from raw response');
  }else if(declared.kind==='restart')requireFact(step.passed,'restart incomplete');
  else{
   const ui=step.ui;requireFact(ui&&ui.stopped&&ui.executionStatus==='executed','UI execution missing');
   requireFact(ui.steps.length===declared.verifier.steps.length&&ui.steps.every((s,j)=>s.index===j&&eq(s.step,declared.verifier.steps[j])),'UI trace differs from declaration');
   requireFact(step.passed===ui.steps.every(s=>s.verdict==='passed'),'UI deterministic verdict changed');
   allImages.push(...ui.screenshots);for(const p of ui.proofFiles)requireFact(record.proofFiles.includes(p),'UI proof omitted');
  }
  if(!step.passed)requireFact(i===record.steps.length-1,'continued after failed step');
 }
 requireFact(eq(record.images,allImages)&&record.images.length<=5,'images are not complete');
 if(requireComplete)requireFact(record.steps.length===verifier.steps.length&&record.steps.every(s=>s.passed),'incomplete scenario cannot pass');
}

export async function assertFullstackJob(job:VerificationJob,spec:VerificationSpec,candidates:Candidate[]):Promise<void>{
 const instances=selectInstances(spec,{mode:'final'}).instances;
 for(const result of [...job.results,...job.controls.flatMap(c=>c.results)]){
  const instance=instances.find(i=>i.id===result.instanceId),definition=spec.cases.find(c=>c.id===instance?.caseId&&c.revision===instance.revision);
  if(definition?.verifier.kind!=='fullstack')continue;
  const records=(job.fullstackEvidence??[]).filter(r=>r.instanceId===result.instanceId&&result.proofFiles?.includes(r.factsPath));requireFact(records.length===1,'missing exact fullstack result');const record=records[0]!;
  const candidate=candidates.find(c=>c.digest===record.candidateDigest);requireFact(candidate,'result belongs to another candidate');await assertCandidate({...candidate,tree:record.candidateTree},false);
  await assertFullstackRecord(job,record,definition.verifier,result.checks.some(c=>c.verdict==='passed'));
 }
}
