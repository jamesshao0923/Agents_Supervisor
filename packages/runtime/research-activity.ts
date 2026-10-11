import {publishResearchRoundReports,researchReportContents,type ResearchRoundPublicationHooks} from './research-round-publication.js';
import {inspectProcess,type ProcessIdentity} from '../process-control/index.js';
import {mkdir,readFile,writeFile,lstat,realpath,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {SupervisorStore} from '../persistence/store.js';
import type {RuntimeOperation} from '../contracts/p3.js';
import type {ExecutionRecord} from '../contracts/p2.js';
import type {MaterialsReceipt,ResearchExecutionPackage,ResearchCompletionReceipt} from '../contracts/p8-research-runtime.js';
import {MaterialIntake} from '../workspace/material-intake.js';
import {captureResearchEvidence,researchDigest} from '../workspace/research-materials.js';
import {researchProposalSchema,validateResearchProposal} from '../orchestration/research-proposal.js';
import {bytesDigest,exclusiveJSON,privateDirectory,readBounded,assertTrue,assertResearchInput,reportPath,researchExecutionPrompt,researchCompletionEvents} from '../workspace/research-runtime-files.js';

export {researchExecutionPrompt} from '../workspace/research-runtime-files.js';
/** Activity called by the existing worker. No model/runner/reservation of its own. */
export class ResearchRuntimeActivity {
 private readonly intake:MaterialIntake;
 constructor(private readonly store:SupervisorStore,private readonly dataRoot:string,private readonly roundHooks:ResearchRoundPublicationHooks={}){this.intake=new MaterialIntake(dataRoot);}
 async acquire(operation:RuntimeOperation,owner:string):Promise<void> {
  assertTrue(operation.step.kind==='materials','Materials step required');const op=this.store.runtime.beginMaterials(operation.id,owner),controller=new AbortController();
  const timer=setInterval(()=>{try{const runtime=this.store.runtime.get(op.runtimeId),current=this.store.runtime.getOperation(op.id);if(runtime.cancelled||current.owner!==owner)controller.abort(Error('Materials cancelled or worker superseded'));}catch(error){controller.abort(error);}},50);
  try {
   const index=await this.intake.acquire({commandId:op.id+':materials',inputs:operation.step.inputs,limits:operation.step.limits,signal:controller.signal});
   const body={schemaVersion:1 as const,operationId:op.id,attemptId:op.attemptId,contractVersion:op.contractVersion,requestDigest:researchDigest({operationId:op.id,contractVersion:op.contractVersion,step:op.step}),material:{directory:index.directory,generation:index.generation,indexDigest:index.indexDigest,inputDigest:index.inputDigest},index};const receipt:MaterialsReceipt={...body,digest:researchDigest(body)};
   const dir=await privateDirectory(this.dataRoot,'materials-receipts',op.id);await exclusiveJSON(join(dir,'receipt.json'),receipt);
   const cancelled=this.store.runtime.get(op.runtimeId).cancelled||index.disposition==='cancelled';const outcome=cancelled?'cancelled':index.disposition==='deadline'?'failed':'confirmed';
   this.store.runtime.report(op.id,owner,{messageId:op.id+':materials:'+receipt.digest,outcome,result:{kind:'materials',receipt},...(outcome==='confirmed'?{}:{error:'Material acquisition '+index.disposition})});
  } catch(error){this.store.runtime.report(op.id,owner,{messageId:op.id+':materials-unknown:'+bytesDigest(String(error)),outcome:'unknown',result:{error:String(error)},error:'Materials archive unknown; retained without overwrite: '+String(error)});}
  finally{clearInterval(timer);}
 }
 async recover(operation:RuntimeOperation,owner:string):Promise<void> {
  // Adoption is called only after the existing worker guardian establishes prior ownership absent.
  const dir=await privateDirectory(this.dataRoot,'materials-receipts',operation.id);try{const receipt=JSON.parse(readBounded(join(dir,'receipt.json')).toString('utf8')) as MaterialsReceipt;
   const outcome=this.store.runtime.get(operation.runtimeId).cancelled||receipt.index.disposition==='cancelled'?'cancelled':receipt.index.disposition==='completed'?'confirmed':'failed';this.store.runtime.report(operation.id,owner,{messageId:operation.id+':materials:'+receipt.digest,outcome,result:{kind:'materials',receipt}});
  }catch(error){this.store.runtime.report(operation.id,owner,{messageId:operation.id+':materials-recovery:'+bytesDigest(String(error)),outcome:'unknown',result:{error:String(error)},error:'Materials recovery retains unknown archive: '+String(error)});}
 }
 async prepare(operationId:string,owner:string):Promise<void> {
  const op=this.store.runtime.getOperation(operationId);if(op.step.kind!=='codex'||!op.step.research)return;
  if(op.result!==null){this.store.runtime.verifyResearchInputs(op.id);return;}
  const binding=op.step.research,runtime=this.store.runtime.get(op.runtimeId),source=this.store.runtime.currentOperations(runtime.id).find(item=>item.step.id===binding.acquisitionStepId);
  assertTrue(source?.state==='confirmed'&&source.step.kind==='materials','Research needs actual completed materials step');const receipt=(source.result as {kind:string;receipt:MaterialsReceipt}).receipt;
  const context=await captureResearchEvidence({intake:this.intake,material:receipt.material,contract:this.store.runtime.inspect(runtime.id).run.contract,requirements:binding.requirements,limits:binding.limits});
  const outputSchema=researchProposalSchema(context),prompt=researchExecutionPrompt(op.step.prompt,context),body={schemaVersion:1 as const,operationId:op.id,acquisitionOperationId:source.id,contractVersion:op.contractVersion,context,outputSchema,prompt,reportDirectory:binding.reportDirectory};const input:ResearchExecutionPackage={...body,digest:researchDigest(body)};
  const directory=await privateDirectory(this.dataRoot,'research-inputs',op.id),path=join(directory,'input.json');await exclusiveJSON(path,input);this.store.runtime.setResearchInput(op.id,owner,{kind:'research-input',path,digest:input.digest,package:input});
 }
 async materialize(record:ExecutionRecord):Promise<ResearchCompletionReceipt> {
  record=this.store.executionGet(record.id);assertTrue(record.identity&&(await inspectProcess(record.identity as ProcessIdentity)).status==='stopped','Research writer physical stop is unresolved');const completionEvents=researchCompletionEvents(record,after=>this.store.executionEvents(record.id,after));
  assertTrue(record.runtimeBinding&&record.threadId&&record.turnId&&record.usageStatus==='reported'&&record.usage!==null&&!record.cancelRequested,'Research completion needs actual known same-turn accounting');const op=this.store.runtime.getOperation(record.runtimeBinding.operationId),runtime=this.store.runtime.get(op.runtimeId);assertTrue(!runtime.cancelled&&!runtime.paused,'Research completion cannot publish while paused/cancelled');
  const input=this.store.runtime.researchInput(op.id);assertTrue(input,'Research input missing');assertResearchInput(input,op.id,op.contractVersion,this.dataRoot);
  const draft=await validateResearchProposal({intake:this.intake,context:input.package.context,output:record.message});
  this.store.runtime.verifyResearchInputs(op.id);assertTrue(!this.store.runtime.get(runtime.id).cancelled&&!this.store.runtime.get(runtime.id).paused,'Research boundary changed during validation');
  const directory=reportPath(runtime.workspace,input.package.reportDirectory);
  const contents=researchReportContents(draft),proposal=contents['report.json']!,markdown=contents['report.md']!;
  const files={'report.json':bytesDigest(proposal),'report.md':bytesDigest(markdown)},body={schemaVersion:1 as const,executionId:record.id,operationId:op.id,inputDigest:input.digest,threadId:record.threadId,turnId:record.turnId,rawOutputDigest:bytesDigest(record.message),completionEvents,draft,files},completion:ResearchCompletionReceipt={...body,digest:researchDigest(body)};
  const archive=await privateDirectory(this.dataRoot,'research-completions',record.id);await exclusiveJSON(join(archive,'receipt.json'),completion);
  const reports=join(archive,'reports');await mkdir(reports,{recursive:true,mode:0o700});assertTrue(!(await lstat(reports)).isSymbolicLink()&&await realpath(reports)===reports,'Research report archive alias');
  for(const [name,content]of [['report.json',proposal],['report.md',markdown]] as const){const path=join(reports,name);try{await writeFile(path,content,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;assertTrue(bytesDigest(readBounded(path))===files[name],'Partial/conflicting immutable report archive retained');}}
  const round=await publishResearchRoundReports(this.store,this.dataRoot,record,completion,{'report.json':proposal,'report.md':markdown},this.roundHooks);
  if(!round){await mkdir(directory,{recursive:true,mode:0o700});assertTrue(!(await lstat(directory)).isSymbolicLink()&&await realpath(directory)===directory,'Report directory alias');assertTrue((await readdir(directory)).every(name=>['report.json','report.md'].includes(name)),'Unowned report files retained; no partial overwrite');}
  assertTrue((await readdir(reports)).sort().join(',')==='report.json,report.md','Unowned immutable report archive entries');
  if(!round)for(const [name,content]of [['report.json',proposal],['report.md',markdown]] as const){const path=join(directory,name);try{await writeFile(path,content,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;assertTrue(!(await lstat(path)).isSymbolicLink()&&(await readFile(path,'utf8'))===content,'Conflicting or partial report retained');}}
  this.store.runtime.verifyResearchInputs(op.id);const latest=this.store.executionGet(record.id),current=this.store.runtime.get(runtime.id);assertTrue(!current.cancelled&&!current.paused&&!latest.cancelRequested&&researchDigest({message:latest.message,usage:latest.usage,threadId:latest.threadId,turnId:latest.turnId,terminalStatus:latest.terminalStatus})===researchDigest({message:record.message,usage:record.usage,threadId:record.threadId,turnId:record.turnId,terminalStatus:record.terminalStatus}),'Research boundary changed before completion publication');const checked=researchCompletionEvents(latest,after=>this.store.executionEvents(record.id,after));assertTrue(checked.messageSeq===completionEvents.messageSeq&&checked.terminalSeq===completionEvents.terminalSeq,'Research completed event boundary changed');for(const [name,hash]of Object.entries(files))assertTrue(bytesDigest(readBounded(join(directory,name)))===hash,'Research report changed during materialization');return completion;
 }
}
