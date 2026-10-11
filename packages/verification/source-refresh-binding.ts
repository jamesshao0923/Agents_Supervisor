import {inspectProcess,type ProcessIdentity} from '../process-control/index.js';
import type {DatabaseSync} from 'node:sqlite';
import {RuntimeRepository} from '../persistence/runtime.js';
import {GoalRepository} from '../persistence/goals.js';
import {VerificationLineageRepository} from '../persistence/verification-lineage.js';
import {join} from 'node:path';
import type {SupervisorStore} from '../persistence/store.js';
import type {SourceRefreshGenerationProof} from '../contracts/p8-source-refresh.js';
import type {MaterialsReceipt} from '../contracts/p8-research-runtime.js';
import {assertMaterialsReceipt,assertMaterialsStepReceipt,assertTrue,readBounded,bytesDigest} from '../workspace/research-runtime-files.js';
import {assertSourceRefreshConfiguration} from './source-refresh-intent.js';
import {researchDigest} from '../workspace/research-materials.js';
/** Derive from actual immutable lineage and actual confirmed material receipts.
 * No caller generation, verdict, arbitrary receipt or current report is accepted.
 * Acquisition integrity alone grants no P4 publication authority; a complete
 * independently reviewed adapted qualification is separately required. */
export function readSourceRefreshGeneration(store:SupervisorStore,dataRoot:string,input:{transitionId:string;previousOperationId:string;currentOperationId:string}):SourceRefreshGenerationProof{return readGeneration(store,dataRoot,input,false);}
function readGeneration(store:SupervisorStore,dataRoot:string,input:{transitionId:string;previousOperationId:string;currentOperationId:string},sealedArchive:boolean,activatingProducerId?:string):SourceRefreshGenerationProof {
 const authorization=store.verificationLineage.sourceRefreshAuthorization(input.transitionId),transition=store.verificationLineage.transition(input.transitionId);
 const previous=store.runtime.getOperation(input.previousOperationId),current=store.runtime.getOperation(input.currentOperationId);
 const oldRuntime=store.runtime.get(previous.runtimeId),runtime=store.runtime.get(current.runtimeId),oldRun=store.runtime.inspect(oldRuntime.id).run,run=store.runtime.inspect(runtime.id).run;
 assertTrue(oldRuntime.projectId===authorization.projectId&&runtime.projectId===authorization.projectId&&oldRuntime.runId===authorization.previousRunId&&runtime.runId===authorization.currentRunId,'Refresh acquisition belongs to another Run');
 assertTrue(previous.contractVersion===transition.fromContract.version&&current.contractVersion===transition.toContract.version&&researchDigest(run.contract)===transition.to.contractDigest,'Refresh acquisition contract boundary changed');
 assertTrue(store.runtime.currentOperations(runtime.id).some(o=>o.id===current.id)&&!runtime.cancelled&&!runtime.paused&&(!['cancelled','succeeded','blocked'].includes(run.status)||sealedArchive&&run.status==='succeeded'),'Refresh current acquisition is stale or boundary closed');
 assertTrue(previous.step.kind==='materials'&&current.step.kind==='materials'&&previous.step.id===current.step.id&&previous.id!==current.id&&previous.state==='confirmed'&&current.state==='confirmed','Two actual confirmed same-input material operations required');
 assertTrue(researchDigest(previous.step.inputs)===researchDigest(current.step.inputs)&&researchDigest(previous.step.limits)===researchDigest(current.step.limits),'Refresh changes source identity order or acquisition limits');
 const session=store.goals.inspect(transition.sessionId).session;
 assertTrue(session.research&&researchDigest(session.research)===authorization.researchConfigurationDigest&&researchDigest(current.step.inputs)===researchDigest(session.research.inputs)&&researchDigest(current.step.limits)===researchDigest(session.research.materialLimits),'Refresh does not use authorized original configuration');
 assertSourceRefreshConfiguration(session.research!,store.runtime.operations(oldRuntime.id),previous.contractVersion);assertSourceRefreshConfiguration(session.research!,store.runtime.operations(runtime.id),current.contractVersion);
 for(const [operation,value]of [[previous,oldRun],[current,run]] as const){const attempt=value.attempts.find(a=>a.id===operation.attemptId);assertTrue(attempt?.status==='succeeded'&&attempt.settled&&attempt.actual===0&&value.operations.find(o=>o.attemptId===attempt.id)?.status==='confirmed'&&value.leases.filter(l=>l.attemptId===attempt.id).every(l=>l.released),'Refresh acquisition stop/accounting unresolved');}
 assertTrue(oldRun.attempts.every(a=>a.settled&&a.status!=='running')&&oldRun.operations.every(o=>o.status==='confirmed')&&oldRun.leases.every(l=>l.released),'Refresh predecessor accounting and effects unresolved');
 assertTrue(run.attempts.filter(a=>a.id!==activatingProducerId).every(a=>a.settled&&a.status!=='running')&&run.operations.filter(o=>o.attemptId!==activatingProducerId).every(o=>o.status==='confirmed')&&run.leases.filter(l=>l.attemptId!==activatingProducerId).every(l=>l.released),'Refresh proof waits for actual quiet accounting and effects');
 const receipt=(op:typeof current):MaterialsReceipt=>{const result=op.result as {kind?:string;receipt?:MaterialsReceipt};assertTrue(result?.kind==='materials'&&result.receipt,'Actual material receipt missing');assertMaterialsReceipt(result.receipt,op.id,op.attemptId,op.contractVersion,dataRoot);assertMaterialsStepReceipt(result.receipt,op);const original=JSON.parse(readBounded(join(dataRoot,'materials-receipts',bytesDigest(op.id),'receipt.json')).toString('utf8'));assertTrue(researchDigest(original)===researchDigest(result.receipt),'Material receipt differs from actual archived operation receipt');return result.receipt;};
 const before=receipt(previous),after=receipt(current);
 assertTrue(before.index.generation!==after.index.generation&&before.index.indexDigest!==after.index.indexDigest&&Date.parse(after.index.acquiredAt)>=Date.parse(before.index.acquiredAt),'Refresh must produce a genuinely new archived generation');
 const entries=before.index.entries.map((old,i)=>{const fresh=after.index.entries[i];assertTrue(fresh&&old.id===fresh.id&&researchDigest(old.input)===researchDigest(fresh.input),'Refresh complete original input inventory changed');
 const selected=authorization.intent.materialIds.includes(old.id);
 const usable=before.index.disposition==='completed'&&after.index.disposition==='completed'&&old.status==='success'&&fresh.status==='success'&&old.raw?.complete&&fresh.raw?.complete&&old.text?.complete&&fresh.text?.complete&&old.finalURL===fresh.finalURL;
 // Archive paths/acquiredAt vary naturally between generations; compare the actual content/representation basis only.
 const basis=(entry:typeof old)=>({input:entry.input,status:entry.status,requestedURL:entry.requestedURL,finalURL:entry.finalURL,origin:entry.origin,contentType:entry.contentType,representation:entry.representation,raw:entry.raw?{sha256:entry.raw.sha256,size:entry.raw.size,complete:entry.raw.complete}:null,text:entry.text?{sha256:entry.text.sha256,size:entry.text.size,complete:entry.text.complete}:null,limitations:entry.limitations,error:entry.error});
 assertTrue(selected||usable&&researchDigest(basis(old))===researchDigest(basis(fresh)),'Unselected refresh input basis changed or unknown: '+old.id);
 return {id:old.id,selected,state:!usable?'unknown' as const:old.raw!.sha256===fresh.raw!.sha256&&old.text!.sha256===fresh.text!.sha256?'current' as const:'changed' as const,oldRawDigest:old.raw?.sha256??null,newRawDigest:fresh.raw?.sha256??null,oldTextDigest:old.text?.sha256??null,newTextDigest:fresh.text?.sha256??null};});
 assertTrue(before.index.entries.length===after.index.entries.length,'Refresh silently drops input entries');
 const body={schemaVersion:1 as const,authority:'acquisition-integrity-only' as const,authorization,previousOperationId:previous.id,currentOperationId:current.id,previousReceiptDigest:before.digest,currentReceiptDigest:after.digest,previousGeneration:before.index.generation,currentGeneration:after.index.generation,previousIndexDigest:before.index.indexDigest,currentIndexDigest:after.index.indexDigest,entries,state:entries.some(e=>e.state==='unknown')?'unknown' as const:entries.some(e=>e.state==='changed')?'changed' as const:'current' as const,publication:'blocked-until-adapted-p4' as const};
 return {...body,digest:researchDigest(body)};
}

/** Integrity reread for the sole actual running verification job of an already
 * frozen refresh proposal. No caller flag, result, usage or receipt is accepted;
 * publication/settlement still uses the ordinary independent lifecycle guards. */
export function readQualificationSourceRefreshGeneration(db:DatabaseSync,dataRoot:string,input:{transitionId:string;previousOperationId:string;currentOperationId:string},proposalId:string):SourceRefreshGenerationProof {
 const get=<T>(kind:string,id:string):T=>{const row=db.prepare('SELECT record FROM verification_records WHERE kind=? AND id=?').get(kind,id);assertTrue(row,'Refresh verification binding missing');return JSON.parse(String(row.record)) as T;};
 const proposal=get<import('./records.js').Proposal>('proposal',proposalId),runtime=new RuntimeRepository(db,dataRoot),op=runtime.getOperation(input.currentOperationId),r=runtime.get(op.runtimeId),run=runtime.inspect(r.id).run;
 assertTrue(proposal.runtimeId===r.id&&proposal.runId===run.id&&proposal.projectId===r.projectId&&proposal.contractDigest===researchDigest(run.contract)&&proposal.controlDraftDigest,'Refresh integrity reread is not a frozen current proposal');
 const active=run.attempts.filter(a=>a.status==='running'||!a.settled);
 if(!active.length)return readGeneration({runtime,goals:new GoalRepository(db,dataRoot),verificationLineage:new VerificationLineageRepository(db)} as SupervisorStore,dataRoot,input,false);
 const stored=db.prepare('SELECT record FROM verification_control_drafts WHERE proposal_id=?').get(proposal.id);assertTrue(stored,'Refresh proposal has no actual frozen draft');const draft=JSON.parse(String(stored.record)).draft;
 assertTrue(draft.sourceRefresh?.generation?.currentOperationId===op.id&&draft.sourceRefresh.generation.previousOperationId===input.previousOperationId&&draft.sourceRefresh.generation.authorization.transitionId===input.transitionId&&draft.digest===proposal.controlDraftDigest,'Refresh integrity reread differs from frozen acquisition');
 assertTrue(active.length===1,'Refresh integrity waits for unrelated active or unknown accounts');const attempt=active[0]!;
 const jobs=db.prepare("SELECT record FROM verification_records WHERE kind='job'").all().map(row=>JSON.parse(String(row.record)) as import('./records.js').VerificationJob).filter(j=>j.attemptId===attempt.id);
 assertTrue(jobs.length===1,'Refresh integrity lacks exact actual verification job');const job=jobs[0]!;
 assertTrue(job.status==='running'&&attempt.status==='running'&&!attempt.settled&&attempt.purpose==='verification'&&job.id===attempt.id&&job.proposalId===proposal.id&&job.runtimeId===r.id&&job.runId===run.id&&job.projectId===r.projectId&&job.workspace===r.workspace&&attempt.contractVersion===run.contract.version&&attempt.reservation===job.config.reservation&&job.usage<=attempt.reservation,'Refresh active account is not this exact bounded verification');
 assertTrue(job.kind==='review'&&job.planId===null||job.kind==='verification'&&job.planId!==null&&get<import('./records.js').FrozenPlan>('plan',job.planId).proposalId===proposal.id,'Refresh verification plan binding changed');
 assertTrue(run.leases.filter(l=>!l.released&&l.attemptId===attempt.id).every(l=>l.resource==='verification:'+r.workspace),'Refresh active verification lease differs');
 return readGeneration({runtime,goals:new GoalRepository(db,dataRoot),verificationLineage:new VerificationLineageRepository(db)} as SupervisorStore,dataRoot,input,false,attempt.id);
}

/** Exact archived-delivery IDs only; never relaxes the ordinary current getter.
 * This read proves integrity on reopen, not current semantic or delivery authority. */
export function readArchivedSourceRefreshGeneration(db:DatabaseSync,dataRoot:string,input:{transitionId:string;previousOperationId:string;currentOperationId:string},deliveryId:string):SourceRefreshGenerationProof {
 const get=<T>(kind:string,id:string):T=>{const row=db.prepare('SELECT record FROM verification_records WHERE kind=? AND id=?').get(kind,id);assertTrue(row,'Archived refresh verification record missing');return JSON.parse(String(row.record)) as T;};
 const delivery=get<import('./records.js').Delivery>('delivery',deliveryId),job=get<import('./records.js').VerificationJob>('job',delivery.jobId),plan=get<import('./records.js').FrozenPlan>('plan',job.planId!);
 const row=db.prepare('SELECT record FROM research_delivery_seals WHERE delivery_id=?').get(delivery.id);assertTrue(row,'Archived refresh requires actual native sealed delivery');const seal=JSON.parse(String(row.record)) as import('../contracts/p4-research-workflow.js').ResearchDeliverySeal;const {digest,...body}=seal;
 assertTrue(researchDigest(body)===digest&&seal.deliveryId===delivery.id&&seal.combined.complete&&seal.binding.jobId===job.id&&seal.binding.planId===plan.id&&seal.binding.proposalId===plan.proposalId&&seal.binding.runId===delivery.runId&&seal.binding.projectId===delivery.projectId&&seal.binding.contractDigest===plan.contractDigest&&job.approved&&job.stopConfirmed&&!job.usageUnknown&&job.usage<=job.config.reservation&&job.kind==='verification'&&plan.selection.mode==='final','Archived refresh delivery seal is incomplete or inconsistent');
 const runtime=new RuntimeRepository(db,dataRoot),current=runtime.getOperation(input.currentOperationId),runtimeRecord=runtime.get(current.runtimeId),lineage=new VerificationLineageRepository(db);
 assertTrue(runtimeRecord.projectId===delivery.projectId&&runtimeRecord.runId===delivery.runId&&lineage.headForRun(delivery.projectId,delivery.runId)?.proposalId===plan.proposalId,'Archived refresh is not the exact current sealed scope');
 return readGeneration({runtime,goals:new GoalRepository(db,dataRoot),verificationLineage:lineage} as SupervisorStore,dataRoot,input,true);
}

/** Bound host activation before P2 finalization: actual completed-turn producer,
 * known bounded usage and physical OS stop, with every OTHER account quiet.
 * Does not settle the producer or grant report/P4 acceptance. */
export async function readActivatingSourceRefreshGeneration(store:SupervisorStore,dataRoot:string,input:{transitionId:string;previousOperationId:string;currentOperationId:string},actualProducerId:string):Promise<SourceRefreshGenerationProof>{
 const execution=store.executionGet(actualProducerId),current=store.runtime.getOperation(input.currentOperationId),producer=execution.runtimeBinding?store.runtime.getOperation(execution.runtimeBinding.operationId):null;
 assertTrue(producer&&producer.runtimeId===current.runtimeId&&producer.step.kind==='codex'&&producer.step.research&&producer.executionId===execution.id&&producer.attemptId===execution.id&&producer.state==='started'&&execution.terminalStatus==='completed'&&!execution.cancelRequested&&execution.usageStatus==='reported'&&execution.usage&&execution.identity,'Refresh activation lacks actual completed bounded producer');
 const run=store.runtime.inspect(producer.runtimeId).run,attempt=run.attempts.find(a=>a.id===execution.id);
 assertTrue(attempt?.status==='running'&&!attempt.settled&&execution.usage!.totalTokens<=attempt.reservation&&run.operations.filter(o=>o.attemptId===attempt.id).every(o=>o.status==='pending'),'Refresh activation producer accounting/effect boundary changed');
 assertTrue((await inspectProcess(execution.identity as ProcessIdentity)).status==='stopped','Refresh activation producer is not physically stopped');
 const actual=store.executionGet(actualProducerId);assertTrue(researchDigest(actual)===researchDigest(execution),'Refresh activation producer changed while checking OS stop');
 return readGeneration(store,dataRoot,input,false,execution.id);
}
