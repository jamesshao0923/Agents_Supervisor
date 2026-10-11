import {join} from 'node:path';
import type {SupervisorStore} from '../persistence/store.js';
import type {SourceRefreshGenerationProof} from '../contracts/p8-source-refresh.js';
import type {MaterialsReceipt} from '../contracts/p8-research-runtime.js';
import {assertMaterialsReceipt,assertMaterialsStepReceipt,assertTrue,readBounded,bytesDigest} from '../workspace/research-runtime-files.js';
import {assertSourceRefreshConfiguration} from './source-refresh-intent.js';
import {researchDigest} from '../workspace/research-materials.js';
/** Derive from actual immutable lineage and actual confirmed material receipts.
 * No caller generation, verdict, arbitrary receipt or current report is accepted.
 * Always blocked for P4 publication until a separately reviewed adapted protocol. */
export function readSourceRefreshGeneration(store:SupervisorStore,dataRoot:string,input:{transitionId:string;previousOperationId:string;currentOperationId:string}):SourceRefreshGenerationProof {
 const authorization=store.verificationLineage.sourceRefreshAuthorization(input.transitionId),transition=store.verificationLineage.transition(input.transitionId);
 const previous=store.runtime.getOperation(input.previousOperationId),current=store.runtime.getOperation(input.currentOperationId);
 const oldRuntime=store.runtime.get(previous.runtimeId),runtime=store.runtime.get(current.runtimeId),oldRun=store.runtime.inspect(oldRuntime.id).run,run=store.runtime.inspect(runtime.id).run;
 assertTrue(oldRuntime.projectId===authorization.projectId&&runtime.projectId===authorization.projectId&&oldRuntime.runId===authorization.previousRunId&&runtime.runId===authorization.currentRunId,'Refresh acquisition belongs to another Run');
 assertTrue(previous.contractVersion===transition.fromContract.version&&current.contractVersion===transition.toContract.version&&researchDigest(run.contract)===transition.to.contractDigest,'Refresh acquisition contract boundary changed');
 assertTrue(store.runtime.currentOperations(runtime.id).some(o=>o.id===current.id)&&!runtime.cancelled&&!runtime.paused&&!['cancelled','succeeded','blocked'].includes(run.status),'Refresh current acquisition is stale or boundary closed');
 assertTrue(previous.step.kind==='materials'&&current.step.kind==='materials'&&previous.step.id===current.step.id&&previous.id!==current.id&&previous.state==='confirmed'&&current.state==='confirmed','Two actual confirmed same-input material operations required');
 assertTrue(researchDigest(previous.step.inputs)===researchDigest(current.step.inputs)&&researchDigest(previous.step.limits)===researchDigest(current.step.limits),'Refresh changes source identity order or acquisition limits');
 const session=store.goals.inspect(transition.sessionId).session;
 assertTrue(session.research&&researchDigest(session.research)===authorization.researchConfigurationDigest&&researchDigest(current.step.inputs)===researchDigest(session.research.inputs)&&researchDigest(current.step.limits)===researchDigest(session.research.materialLimits),'Refresh does not use authorized original configuration');
 assertSourceRefreshConfiguration(session.research!,store.runtime.operations(oldRuntime.id),previous.contractVersion);assertSourceRefreshConfiguration(session.research!,store.runtime.operations(runtime.id),current.contractVersion);
 for(const [operation,value]of [[previous,oldRun],[current,run]] as const){const attempt=value.attempts.find(a=>a.id===operation.attemptId);assertTrue(attempt?.status==='succeeded'&&attempt.settled&&attempt.actual===0&&value.operations.find(o=>o.attemptId===attempt.id)?.status==='confirmed'&&value.leases.filter(l=>l.attemptId===attempt.id).every(l=>l.released),'Refresh acquisition stop/accounting unresolved');}
 assertTrue(oldRun.attempts.every(a=>a.settled&&a.status!=='running')&&oldRun.operations.every(o=>o.status==='confirmed')&&oldRun.leases.every(l=>l.released),'Refresh predecessor accounting and effects unresolved');
 assertTrue(run.attempts.every(a=>a.settled&&a.status!=='running')&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released),'Refresh proof waits for actual quiet accounting and effects');
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
