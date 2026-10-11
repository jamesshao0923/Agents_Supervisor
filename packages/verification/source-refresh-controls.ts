import type {DatabaseSync} from 'node:sqlite';
import type {SourceRefreshControlContext,HistoricalMaterialEpoch} from '../contracts/p4-source-refresh.js';
import type {ControlBootstrapHistory} from '../contracts/p4-control-draft.js';
import type {ProposalBase} from '../contracts/p4-lineage.js';
import type {MaterialVerifierBinding,MaterialObservation} from '../contracts/p4-material.js';
import type {Proposal,VerificationJob} from './records.js';
import {GoalRepository} from '../persistence/goals.js';
import {RuntimeRepository} from '../persistence/runtime.js';
import {VerificationLineageRepository} from '../persistence/verification-lineage.js';
import {readSourceRefreshGeneration,readArchivedSourceRefreshGeneration,readQualificationSourceRefreshGeneration} from './source-refresh-binding.js';
import {readMaterialBindingSync} from './material.js';
import {readBounded,bytesDigest,assertTrue} from '../workspace/research-runtime-files.js';
import {researchDigest} from '../workspace/research-materials.js';
import {currentVerificationCases} from './rules.js';
import type {VerificationSpec} from '../contracts/p4.js';
const eq=(a:unknown,b:unknown)=>researchDigest(a)===researchDigest(b);
const record=<T>(db:DatabaseSync,kind:string,id:string):T=>{const r=db.prepare('SELECT record FROM verification_records WHERE kind=? AND id=?').get(kind,id);assertTrue(r,'Refresh original verification record missing');return JSON.parse(String(r.record)) as T;};
function materialBinding(spec:VerificationSpec):MaterialVerifierBinding {
 const values=currentVerificationCases(spec).filter(c=>(c.status??'active')==='active'&&c.verifier.kind==='material').map(c=>{assertTrue(c.verifier.kind==='material','Native refresh binding required');return c.verifier.binding;});
 assertTrue(values.length&&values.every(v=>eq(v,values[0])),'Refresh requires one exact native producer binding');return values[0]!;
}
function materialsOperation(db:DatabaseSync,binding:MaterialVerifierBinding):string {
 const input=readMaterialBindingSync(binding).input;
 // Frozen producer input already records the actual materials operation receipt.
 return input.acquisitionOperationId;
}
/** Rebuild old epoch only from an exact published detector review's immutable
 * actual proof inventory and material observation. No wall-clock substitution. */
export function assertHistoricalMaterialEpoch(epoch:HistoricalMaterialEpoch):void {
 const {digest,...body}=epoch;assertTrue(epoch.role==='historical'&&researchDigest(body)===digest,'Historical material epoch digest changed');
 for(const [path,hash]of Object.entries(epoch.originalProofs))assertTrue(bytesDigest(readBounded(path))===hash,'Historical actual proof bytes changed');
 assertTrue(epoch.originalProofs[epoch.originalObservation.proofPath]===epoch.originalObservation.proofDigest&&epoch.originalProofs[epoch.modelEventsPath],'Historical observation lacks original immutable model proof');
 const payload=JSON.parse(readBounded(epoch.originalObservation.proofPath).toString('utf8')),actual=readMaterialBindingSync(epoch.binding);
 assertTrue(!epoch.originalObservation.historical&&!epoch.originalObservation.projection&&!payload.basisProjection&&eq(epoch.originalObservation.binding,epoch.binding)&&eq(payload.binding,epoch.binding)&&eq(payload.context,actual.input.context)&&eq(payload.completion,actual.completion),'Historical context is not the actual original complete binding');
 const events=readBounded(epoch.modelEventsPath).toString('utf8').trim().split('\n').map(l=>JSON.parse(l));
 const completed=events.filter(e=>e.kind==='codex-event'&&e.value?.method==='turn/completed'&&e.value?.raw?.params?.turn?.status==='completed');
 assertTrue(completed.length===1&&completed[0].at===epoch.observedAt&&Number.isFinite(Date.parse(epoch.observedAt)),'Historical epoch is not fixed by the original completed model turn');
 assertTrue(events.some(e=>{if(e.kind!=='review-input'||typeof e.value?.prompt!=='string')return false;try{const reviewed=JSON.parse(e.value.prompt.slice(e.value.prompt.indexOf('\n')+1));return Object.keys(payload).every(k=>eq(reviewed[k],payload[k]));}catch{return false;}}),'Historical model did not inspect the complete original source payload');
 const acquired=Date.parse(actual.input.context.index.acquiredAt),observed=Date.parse(epoch.observedAt);
 assertTrue(epoch.originalObservation.sourceAcquiredAt===actual.input.context.index.acquiredAt&&observed>=acquired&&actual.input.context.requirements.every(r=>observed-acquired<=r.maxSourceAgeMs),'Historical original freshness basis cannot be proven');
 assertTrue(epoch.originalObservation.maxAgeMs===Math.min(...actual.input.context.requirements.map(r=>r.maxSourceAgeMs)),'Historical original material age policy changed');
}
/** Actual DB/FS derivation; neither the author nor renderer provides this data.
 * Repositories must derive this same value again at insert/publication/reopen. */
export function captureSourceRefreshControlContext(db:DatabaseSync,dataRoot:string,base:ProposalBase,currentSpec:VerificationSpec,history:ControlBootstrapHistory,actualProposalId?:string):SourceRefreshControlContext|null {
 const lineage=new VerificationLineageRepository(db),transitions=base.transitionIds.map(id=>lineage.transition(id));
 const refresh=transitions.filter(t=>t.sourceRefresh);if(!refresh.length)return null;
 assertTrue(refresh.length===1&&transitions.length===1&&refresh[0]!.changes.length===0&&base.baseProposalId,'Refresh qualification requires one explicit unchanged-scope delivered continuation');
 const previous=record<Proposal>(db,'proposal',base.baseProposalId!),t=refresh[0]!;
 assertTrue(previous.status==='published'&&previous.reviewId&&previous.contractDigest===t.from.contractDigest&&previous.projectId===t.from.projectId&&previous.runId===t.from.runId,'Refresh predecessor definition differs from actual transition');
 // Must originate from a genuine sealed delivery, not just an unsealed plan.
 const deliveries=db.prepare("SELECT record FROM verification_records WHERE kind='delivery'").all().map(r=>JSON.parse(String(r.record)) as {id:string;jobId:string;projectId:string;runId:string;researchProofPlanDigest?:string});
 assertTrue(deliveries.some(d=>d.projectId===previous.projectId&&d.runId===previous.runId&&d.researchProofPlanDigest&&record<VerificationJob>(db,'job',d.jobId).proposalId===previous.id),'Refresh requires the exact already-delivered native predecessor');
 const previousBinding=materialBinding(previous.spec),currentBinding=materialBinding(currentSpec);
 const store={verificationLineage:lineage,runtime:new RuntimeRepository(db,dataRoot),goals:new GoalRepository(db,dataRoot)};
 const args={transitionId:t.id,previousOperationId:materialsOperation(db,previousBinding),currentOperationId:materialsOperation(db,currentBinding)},currentRun=new RuntimeRepository(db,dataRoot).inspect(new RuntimeRepository(db,dataRoot).getOperation(currentBinding.operationId).runtimeId).run;const sealed=deliveries.find(d=>d.projectId===base.target.projectId&&d.runId===base.target.runId);const generation=currentRun.status==='succeeded'?(assertTrue(sealed,'Archived refresh has no actual delivery'),readArchivedSourceRefreshGeneration(db,dataRoot,args,(sealed as {id:string}).id)):actualProposalId?readQualificationSourceRefreshGeneration(db,dataRoot,args,actualProposalId):readSourceRefreshGeneration(store as Parameters<typeof readSourceRefreshGeneration>[0],dataRoot,args);
 assertTrue((generation.state==='current'||generation.state==='changed')
  &&generation.entries.filter(e=>e.selected).every(e=>e.state!=='unknown'),
  'Refresh qualification needs actual complete known selected acquisition');
 const historicalEpochs:HistoricalMaterialEpoch[]=[];
 for(const specimen of history.specimens)for(const witness of specimen.revision.witnesses){
  const def=history.definitions.find(d=>d.definition.definitionDigest===witness.definitionDigest)!;
  const c=def.definition.spec.cases.find(c=>c.id===witness.instance.caseId&&c.revision===witness.instance.revision);if(c?.verifier.kind!=='material')continue;
  const candidates=db.prepare("SELECT record FROM verification_records WHERE kind='proposal'").all().map(r=>JSON.parse(String(r.record)) as Proposal).filter(p=>p.status==='published'&&p.bundle.digest===witness.definitionDigest&&p.reviewId);
  assertTrue(candidates.length===1,'Historical material detector has ambiguous published authority');const p=candidates[0]!,job=record<VerificationJob>(db,'job',p.reviewId!);
  assertTrue(job.approved&&job.stopConfirmed&&!job.usageUnknown&&job.usage>0&&job.usage<=job.config.reservation,'Historical material authority stop/accounting unresolved');
  const proofPaths=witness.result.proofFiles??[],observations=(job.materials??[]).filter(o=>proofPaths.includes(o.proofPath)&&eq(o.binding,c.verifier.kind==='material'?c.verifier.binding:null));
  assertTrue(observations.length===1,'Historical material witness lacks exact original observation');const observation=observations[0]!;
  const eventPaths=proofPaths.filter(path=>path.endsWith('/model/events.jsonl'));
  assertTrue(eventPaths.length===1&&proofPaths.every(path=>witness.proofs[path]===job.proofs[path]),'Historical witness/model inventory differs from actual review');
  const events=readBounded(eventPaths[0]!).toString('utf8').trim().split('\n').map(l=>JSON.parse(l)),completed=events.filter(e=>e.kind==='codex-event'&&e.value?.method==='turn/completed'&&e.value?.raw?.params?.turn?.status==='completed');
  assertTrue(completed.length===1&&typeof completed[0].at==='string'&&Number.isFinite(Date.parse(completed[0].at)),'Historical original completed turn time missing; old formats cannot authorize refresh');
  const body={role:'historical' as const,binding:c.verifier.binding,originalJobId:job.id,originalProposalId:p.id,originalProofs:Object.fromEntries(proofPaths.map(path=>[path,job.proofs[path]!])),originalObservation:observation,modelEventsPath:eventPaths[0]!,observedAt:completed[0].at as string,specimen:specimen.revision.ref,witnessId:witness.id};const epoch={...body,digest:researchDigest(body)};assertHistoricalMaterialEpoch(epoch);historicalEpochs.push(epoch);
 }
 assertTrue(historicalEpochs.length>0,'Refresh missing immutable historical material witnesses');
 const body={rule:'same-input-refresh-v1' as const,generation,previousBinding,currentBinding,historicalEpochs};return {...body,digest:researchDigest(body)};
}
/** Every actual native-material proof has exactly one host row/observation role.
 * Current or bootstrap artifacts can never borrow an old epoch exemption. */
export function sourceRefreshReviewEvidence(input:{matrix:import('../contracts/p4-controls.js').FrozenQualificationMatrix;pairs:import('../contracts/p4-controls.js').QualificationPairResult[];observations:MaterialObservation[]}):unknown|null {
 if(!input.matrix.sourceRefresh){assertTrue(input.observations.every(o=>!o.historical),'Historical source role requires a frozen refresh matrix');return null;}
 const inventory=input.pairs.flatMap(pair=>pair.results.flatMap(result=>(result.proofFiles??[]).filter(path=>path.endsWith('/actual-materials.json')).map(path=>({rowId:pair.rowId,path}))));
 const rows=inventory.map(item=>{
  const row=input.matrix.rows.find(row=>row.id===item.rowId);assertTrue(row?.context,'Actual refresh native row context missing');
  const observations=input.observations.filter(o=>o.proofPath===item.path);assertTrue(observations.length===1,'Actual refresh material observation inventory missing/duplicate');const observation=observations[0]!;
  assertTrue(bytesDigest(readBounded(item.path))===observation.proofDigest,'Actual refresh material proof bytes changed');
  const actual=JSON.parse(readBounded(item.path).toString('utf8'));
  if(row.context.role==='historical'){
   assertHistoricalMaterialEpoch(row.context.epoch);assertTrue(eq(observation.historical,row.context.epoch)&&eq(observation.binding,row.context.epoch.binding),'Historical actual pair does not use the frozen original epoch');
   assertTrue(eq(actual,JSON.parse(readBounded(row.context.epoch.originalObservation.proofPath).toString('utf8'))),'Historical pair changed the original specimen/source payload');
  }else assertTrue(!observation.historical&&eq(observation.binding,input.matrix.sourceRefresh!.context.currentBinding),'Current pair cannot use a historical source exemption');
  return {rowId:row.id,context:row.context,observation,actual};
 });
 const context=input.matrix.sourceRefresh.context;
 return {context,adaptations:input.matrix.sourceRefresh.adaptations,previous:readMaterialBindingSync(context.previousBinding).input.context,current:readMaterialBindingSync(context.currentBinding).input.context,rows};
}
