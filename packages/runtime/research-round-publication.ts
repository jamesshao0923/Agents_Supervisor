import {readActivatingSourceRefreshGeneration} from '../verification/source-refresh-binding.js';
import {mkdir,rename,lstat,realpath,readdir,writeFile} from 'node:fs/promises';
import {join,dirname,sep} from 'node:path';
import type {SupervisorStore} from '../persistence/store.js';
import type {ExecutionRecord} from '../contracts/p2.js';
import type {Run} from '../contracts/p1.js';
import type {ValidatedResearchDraft} from '../contracts/p8-research.js';
import type {ResearchCompletionReceipt} from '../contracts/p8-research-runtime.js';
import {currentVerificationCases} from '../verification/rules.js';
import {readMaterialBindingSync} from '../verification/material.js';
import {assertResearchProjectionCompatibility,validateResearchProjectionDraftSync} from '../verification/research-projection.js';
import {readResearchGoalAppendProof} from '../verification/research-goal-binding.js';
import {inspectProcess,type ProcessIdentity} from '../process-control/index.js';
import {researchDigest} from '../workspace/research-materials.js';
import {readBounded,bytesDigest,assertTrue,exclusiveJSON,reportPath,researchCompletionEvents} from '../workspace/research-runtime-files.js';

export function researchReportContents(draft:ValidatedResearchDraft):Record<string,string> {
 return {
  'report.json':JSON.stringify(draft.proposal,null,2)+'\n',
  'report.md':['# Research draft','',draft.proposal.claims.map(claim=>'## '+claim.id+'\n'+claim.text
   +'\nSources: '+claim.supportCitationIds.join(', ')+'\nLimitations: '+claim.limitations.join('; ')).join('\n\n'),
   '','## Complete material coverage',...draft.coverage.map(entry=>`- ${entry.id}: ${entry.status}${entry.error?' — '+entry.error:''}`),
   '','This report is a model interpretation. Independent P4 verification and delivery remain required.',''].join('\n')
 };
}
async function exists(path:string):Promise<boolean> {
 try {await lstat(path);return true;}
 catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
async function exactDirectory(path:string,files:Record<string,string>):Promise<void> {
 const stat=await lstat(path);
 assertTrue(stat.isDirectory()&&!stat.isSymbolicLink()&&await realpath(path)===path,'Research round directory alias');
 assertTrue((await readdir(path)).sort().join('\0')===Object.keys(files).sort().join('\0'),
  'Research round partial/unowned files retained');
 for(const [name,hash]of Object.entries(files))
  assertTrue(bytesDigest(readBounded(join(path,name)))===hash,'Research round report ownership changed');
}
/** Fault hooks create only interruption; they cannot assert successful state. */
export interface ResearchRoundPublicationHooks {
 afterPreserve?:()=>Promise<void>;
 afterActivate?:()=>Promise<void>;
}
/** Same-source actual authorized new Goal round only. Filesystem activation is
 * integrity evidence; final P4 ALL-OF INSERT/seal still grants delivery authority.
 * Crash recovery reads exact intent/stage/backup/target, never a caller flag. */
export async function publishResearchRoundReports(
 store:SupervisorStore,dataRoot:string,supplied:ExecutionRecord,
 completion:ResearchCompletionReceipt,contents:Record<string,string>,
 hooks:ResearchRoundPublicationHooks={}
):Promise<boolean> {
 const record=store.executionGet(supplied.id);
 assertTrue(record.runtimeBinding,'Research round needs actual runtime execution');
 const op=store.runtime.getOperation(record.runtimeBinding.operationId),runtime=store.runtime.get(op.runtimeId);
 const session=store.goals.list().find(s=>s.id===runtime.runId&&s.runtimeId===runtime.id&&s.projectId===runtime.projectId);
 if(!session?.continuation)return false;
 const lineage=store.verificationLineage.resolveRun(runtime.projectId,runtime.runId);
 assertTrue(lineage.predecessorDeliveryId===session.continuation.predecessorDeliveryId
  &&lineage.predecessorRunId===session.continuation.predecessorRunId,
  'Research round is not linked to its actual delivered predecessor');
 const delivery=store.verification.get('delivery',session.continuation.predecessorDeliveryId);
 store.researchWorkflow.assertCommittedDelivery(delivery);
 const plan=store.verification.get('plan',delivery.planId),previous=store.verification.get('proposal',plan.proposalId);
 assertTrue(previous.id===lineage.predecessorProposalId&&delivery.runId===lineage.predecessorRunId
  &&delivery.projectId===runtime.projectId&&previous.runtimeId!==runtime.id,
  'Research round predecessor scope changed');
 const input=store.runtime.researchInput(op.id);
 assertTrue(input,'Actual current research input missing');
 const target=reportPath(runtime.workspace,input.package.reportDirectory);
 const cases=currentVerificationCases(previous.spec).filter(c=>(c.status??'active')==='active'
  &&c.verifier.kind==='material'&&c.verifier.claimFile===input.package.reportDirectory+'/report.json');
 const bindings=new Map(cases.map(c=>{
  assertTrue(c.verifier.kind==='material','Original material detector missing');
  return [researchDigest(c.verifier.binding),c.verifier.binding] as const;
 }));
 assertTrue(bindings.size===1,'One exact delivered predecessor producer required');
 const binding=[...bindings.values()][0]!,before=readMaterialBindingSync(binding);
 const oldOp=store.runtime.getOperation(binding.operationId),oldRuntime=store.runtime.get(oldOp.runtimeId);
 const oldRecord=store.executionGet(binding.executionId),oldRun=store.runtime.inspect(oldRuntime.id).run;
 assertTrue(oldRuntime.workspace===runtime.workspace&&oldRuntime.runId===delivery.runId&&oldOp.executionId===oldRecord.id&&oldOp.state==='confirmed'
  &&oldRecord.state==='completed'&&!oldRecord.error&&oldRecord.stopConfirmed
  &&oldRecord.usageStatus==='reported'&&oldRecord.usage!==null
  &&oldRecord.runtimeBinding?.operationId===oldOp.id
  &&oldRun.attempts.some(a=>a.id===oldRecord.attemptId&&a.settled&&a.actual===oldRecord.usage!.totalTokens)
  &&oldRun.operations.filter(o=>o.attemptId===oldRecord.attemptId).every(o=>o.status==='confirmed')
  &&before.completion.rawOutputDigest===bytesDigest(oldRecord.message)
  &&before.completion.threadId===oldRecord.threadId&&before.completion.turnId===oldRecord.turnId,
  'Delivered predecessor producer actual ledger/turn is unresolved');
 // The sealed old candidate is immutable. A legitimate new round changes the
 // workspace slot; that must not invalidate old proof or recovery ownership.
 const oldCandidate=reportPath(plan.candidate.tree,before.input.reportDirectory);
 await exactDirectory(oldCandidate,before.completion.files);
 const currentBinding={schemaVersion:1 as const,operationId:op.id,executionId:record.id,
  inputPath:input.path,inputDigest:input.digest,contextDigest:input.package.context.digest,
  completionPath:join(dataRoot,'research-completions',bytesDigest(record.id),'receipt.json'),completionDigest:completion.digest};
 const actual=readMaterialBindingSync(currentBinding);
 const proposalBase=store.verificationLineage.captureBase(runtime.projectId,runtime.runId),refreshTransitions=proposalBase.transitionIds.map(id=>store.verificationLineage.transition(id)).filter(t=>t.sourceRefresh);
 let refresh:import('../contracts/p8-source-refresh.js').SourceRefreshGenerationProof|undefined;
 let goalAppend:ReturnType<typeof readResearchGoalAppendProof>=null;let basisDigest:string;
 if(refreshTransitions.length){
  assertTrue(refreshTransitions.length===1&&proposalBase.transitionIds.length===1&&refreshTransitions[0]!.changes.length===0&&proposalBase.baseProposalId===previous.id,'Refresh report activation requires exact same-input delivered predecessor');
  refresh=await readActivatingSourceRefreshGeneration(store,dataRoot,{transitionId:refreshTransitions[0]!.id,previousOperationId:before.input.acquisitionOperationId,currentOperationId:input.package.acquisitionOperationId},record.id);
  assertTrue(refresh.entries.filter(e=>e.selected).every(e=>e.state!=='unknown')
   &&(refresh.state==='current'||refresh.state==='changed')&&researchDigest(before.input.context.requirements)===researchDigest(input.package.context.requirements)&&researchDigest(before.input.context.limits)===researchDigest(input.package.context.limits),'Refresh source observation or original questions/conditions incomplete');
  basisDigest=refresh.digest;
 }else{
  goalAppend=readResearchGoalAppendProof(dataRoot,binding,currentBinding,before.input.context,input.package.context);
  basisDigest=assertResearchProjectionCompatibility(before.input.context,input.package.context,goalAppend);
 }
 const draft=validateResearchProjectionDraftSync(input.package.context,record.message,dataRoot);
 assertTrue(researchDigest(actual.completion)===researchDigest(completion)
  &&researchDigest(completion.draft)===researchDigest(draft)
  &&researchDigest(contents)===researchDigest(researchReportContents(draft))
  &&Object.entries(contents).every(([name,text])=>bytesDigest(text)===completion.files[name]),
  'Round publication requires actual complete generated report receipt');
 const overlap=(path:string)=>path===runtime.workspace||path.startsWith(runtime.workspace+sep)||runtime.workspace.startsWith(path+sep);
 const boundary=async()=>{
  const latest=store.executionGet(record.id),current=store.runtime.get(runtime.id),run=store.runtime.inspect(runtime.id).run;
  store.runtime.verifyResearchInputs(op.id);
  assertTrue(!current.cancelled&&!current.paused&&!latest.cancelRequested
   &&latest.usageStatus==='reported'&&latest.usage!==null&&latest.terminalStatus==='completed'
   &&latest.threadId===completion.threadId&&latest.turnId===completion.turnId
   &&bytesDigest(latest.message)===completion.rawOutputDigest,
   'Research round actual completion/cancel/pause boundary changed');
  const events=researchCompletionEvents(latest,after=>store.executionEvents(record.id,after));
  assertTrue(researchDigest(events)===researchDigest(completion.completionEvents),'Research round completed event evidence changed');
  const attempt=run.attempts.find(a=>a.id===record.attemptId);
  assertTrue(attempt&&attempt.reservation>=latest.usage.totalTokens
   &&run.attempts.filter(a=>a.id!==record.attemptId).every(a=>a.settled&&a.status!=='running')
   &&run.operations.filter(o=>o.attemptId!==record.attemptId).every(o=>o.status==='confirmed')
   &&run.leases.filter(l=>l.attemptId!==record.attemptId).every(l=>l.released),
   'Unknown prior accounting/effects/resources or current reservation overrun');
  assertTrue(!store.conversations.hasPendingForRun(run.projectId,run.id),'New user intent prevents round report activation');
  const ledgers=new Map<string,Run>();
  const executions=store.executionList().filter(e=>overlap(e.workspace));
  const jobs=store.verification.list('job').filter(j=>overlap(j.workspace));
  for(const e of executions){
   if(e.id!==record.id){
    const row=store.query({type:'run',projectId:e.projectId,runId:e.runId});
    const ledger=row as Run;
    ledgers.set(e.projectId+'\0'+e.runId,ledger);
    assertTrue(['completed','failed','cancelled','interrupted'].includes(e.state)&&e.stopConfirmed
     &&e.usageStatus==='reported'&&e.usage!==null
     &&ledger.attempts.some(a=>a.id===e.attemptId&&a.settled&&a.actual===e.usage!.totalTokens)
     &&ledger.operations.filter(o=>o.attemptId===e.attemptId).every(o=>o.status==='confirmed')
     &&ledger.leases.filter(l=>l.attemptId===e.attemptId).every(l=>l.released),
     'Overlapping writer accounting/effects/stop unresolved');
   }
   assertTrue(e.identity&&(await inspectProcess(e.identity as ProcessIdentity)).status==='stopped',
    'Overlapping writer physical stop unresolved');
  }
  for(const job of jobs){
   const ledger=store.query({type:'run',projectId:job.projectId,runId:job.runId}) as Run;
   ledgers.set(job.projectId+'\0'+job.runId,ledger);
   assertTrue(ledger.attempts.some(a=>a.id===job.attemptId&&a.settled&&a.actual===job.usage)
    &&ledger.operations.filter(o=>o.attemptId===job.attemptId).every(o=>o.status==='confirmed')
    &&ledger.leases.filter(l=>l.attemptId===job.attemptId).every(l=>l.released),
    'Overlapping verification accounting/effects/resources unresolved');
   assertTrue(job.status==='finished'&&job.stopConfirmed&&!job.usageUnknown,'Overlapping verification still unresolved');
   for(const identity of job.identities)assertTrue((await inspectProcess(identity)).status==='stopped','Overlapping verification physical stop unresolved');
  }
  // Re-read synchronous fences after process inspection awaited.
  const fresh=store.runtime.get(runtime.id),execution=store.executionGet(record.id);
  assertTrue(!fresh.cancelled&&!fresh.paused&&!execution.cancelRequested
   &&researchDigest(store.executionList().filter(e=>overlap(e.workspace)))===researchDigest(executions)
   &&researchDigest(store.verification.list('job').filter(j=>overlap(j.workspace)))===researchDigest(jobs),
   'Research writer boundary changed while checking physical stop');
  assertTrue(researchDigest(store.runtime.inspect(runtime.id).run)===researchDigest(run),
   'Current Run accounting changed during report activation');
  for(const ledger of ledgers.values())assertTrue(researchDigest(store.query({type:'run',projectId:ledger.projectId,runId:ledger.id}))===researchDigest(ledger),
   'Overlapping ledger changed during physical stop inspection');
 };
 await boundary();
 const privateRoot=join(runtime.workspace,'.supervisor'),base=join(privateRoot,'research-rounds'),directory=join(base,bytesDigest(op.id));
 for(const path of [privateRoot,base,directory]){
  await mkdir(path,{recursive:true,mode:0o700});
  assertTrue(!(await lstat(path)).isSymbolicLink()&&await realpath(path)===path,'Research round private directory alias');
 }
 const stage=join(directory,'new'),backup=join(directory,'previous');
 const intent={schemaVersion:1,authority:'filesystem-integrity-only',rule:refresh?'delivered-explicit-source-refresh-v1':'delivered-same-source-round-v1',...(refresh?{refresh}:{}),
  operationId:op.id,executionId:record.id,runtimeId:runtime.id,runId:runtime.runId,
  predecessorDeliveryId:delivery.id,predecessorProposalId:previous.id,predecessorBinding:binding,
  inputDigest:input.digest,completionDigest:completion.digest,sourceBasisDigest:basisDigest,goalAppend,
  previousFiles:before.completion.files,newFiles:completion.files,target};
 await exclusiveJSON(join(directory,'intent.json'),intent);
 const archive=join(dirname(binding.completionPath),'reports');
 if(await exists(archive))await exactDirectory(archive,before.completion.files);
 if(!await exists(stage)&&!await exists(backup)){
  await exactDirectory(target,before.completion.files);
  await mkdir(stage,{mode:0o700});
  for(const [name,text]of Object.entries(contents))await writeFile(join(stage,name),text,{flag:'wx',mode:0o600});
 }
 if(await exists(stage))await exactDirectory(stage,completion.files);
 await boundary();
 if(await exists(target)){
  if(await exists(backup)){
   await exactDirectory(backup,before.completion.files);
   await exactDirectory(target,completion.files);
  }else{
   await exactDirectory(target,before.completion.files);
   assertTrue(await exists(stage),'Missing complete new round staging');
   await rename(target,backup);
   await hooks.afterPreserve?.();
  }
 }else{
  assertTrue(await exists(backup),'Missing predecessor backup; unknown state retained');
  await exactDirectory(backup,before.completion.files);
 }
 await boundary();
 if(!await exists(target)){
  await exactDirectory(stage,completion.files);
  assertTrue(await realpath(dirname(target))===dirname(target),'Report target parent alias');
  await rename(stage,target);
  await hooks.afterActivate?.();
 }
 await exactDirectory(target,completion.files);
 await exactDirectory(backup,before.completion.files);
 await boundary();
 await exclusiveJSON(join(directory,'activated.json'),intent);
 return true;
}
