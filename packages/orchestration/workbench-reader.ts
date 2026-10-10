import {realpath,stat} from 'node:fs/promises';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
import {runtimeCanonical} from '../persistence/runtime.js';
import type {SupervisorStore} from '../persistence/store.js';
import {parseWorkbenchRead,type WorkbenchSnapshot,type WorkbenchParent} from '../contracts/p8-workbench.js';
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
/** Metadata observation only. No initialization, dispatch, result promotion or FS proof authority. */
export async function readWorkbench(store:SupervisorStore,input:unknown):Promise<WorkbenchSnapshot>{
 const action=parseWorkbenchRead(input),path=await realpath(action.projectPath);if(!(await stat(path)).isDirectory())throw Error('Workbench project must be an existing directory');
 return store.supervision.transaction(()=>{
  const parents:WorkbenchParent[]=[],all=store.scheduler.list();
  for(const runtime of store.runtime.list().filter(r=>r.workspace===path)){
   const {run}=store.runtime.inspect(runtime.id),contractDigest=createHash('sha256').update(runtimeCanonical(run.contract)).digest('hex');
   const parent:WorkbenchParent={runtimeId:runtime.id,projectId:run.projectId,runId:run.id,contractVersion:run.contract.version,budget:run.budget,scheduler:null,results:null,issues:[]};
   const matching=all.filter(s=>s.plan.runtimeId===runtime.id&&s.plan.projectId===run.projectId&&s.plan.runId===run.id);
   if(matching.length>1)parent.issues.push('Multiple scheduler records require reconciliation');
   else if(matching.length===1){try{const record=store.scheduler.get(matching[0]!.id);if(record.plan.contractVersion!==run.contract.version||record.plan.contractDigest!==contractDigest)throw Error('Scheduler belongs to an older contract');parent.scheduler={record,claims:store.scheduler.claims(record.id),operations:store.scheduler.operations(record.id)};}catch(e){parent.issues.push('Scheduler observation unavailable: '+message(e));}}
   try{const ledger=store.taskResults.inspect({projectId:run.projectId,runId:run.id});parent.results={revision:ledger.revision,heads:ledger.heads.map(head=>{const version=ledger.versions.find(v=>runtimeCanonical(v.ref)===runtimeCanonical(head.ref));if(!version)throw Error('Result head has no immutable version');return {ref:head.ref,state:version.state,attemptId:version.manifest.attemptId,generation:version.manifest.generation,currentContract:version.manifest.contractVersion===run.contract.version&&version.manifest.contractDigest===contractDigest,publicationEligibility:'unchecked' as const};})};}catch(e){parent.issues.push('Result observation unavailable: '+message(e));}
   parents.push(parent);
  }
  const snapshot:WorkbenchSnapshot={schemaVersion:1,project:{path,name:basename(path)||path},observedAt:new Date().toISOString(),parents,issues:[]};
  if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')>512000)throw Error('Workbench metadata exceeds bounded response capacity');return snapshot;
 });
}
