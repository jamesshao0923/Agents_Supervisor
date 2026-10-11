import {assertResearchReader} from '../workspace/research-reader.js';
import {assertHistoricalMaterialEpoch} from './source-refresh-controls.js';
import type {HistoricalMaterialEpoch} from '../contracts/p4-source-refresh.js';
import {join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import type {SupervisorStore} from '../persistence/store.js';
import type {MaterialVerifier,MaterialVerifierBinding,MaterialObservation} from '../contracts/p4-material.js';
import type {ResearchExecutionPackage,ResearchCompletionReceipt} from '../contracts/p8-research-runtime.js';
import {MaterialIntake} from '../workspace/material-intake.js';
import {assertResearchEvidenceSnapshot,researchDigest,projectResearchEvidence} from '../workspace/research-materials.js';
import {validateResearchProposal} from '../orchestration/research-proposal.js';
import {readBounded,bytesDigest,assertTrue,assertMaterialIndex,reportPath} from '../workspace/research-runtime-files.js';
import {inspectProcess,type ProcessIdentity} from '../process-control/index.js';
import {relativeFile} from './candidate.js';
import type {VerificationSpec, VerificationInstance} from '../contracts/p4.js';
import {parseMaterialVerifier} from '../contracts/p4-material.js';
import {safeResultJSON} from '../contracts/p7-results.js';
import {currentVerificationCases} from './rules.js';
import {validateCurrentResearchProjection,projectCurrentResearchReport,validateResearchProjectionDraftSync} from './research-projection.js';
import {readResearchGoalAppendProof} from './research-goal-binding.js';
const dataRootOf=(binding:MaterialVerifierBinding)=>{const suffix='/research-inputs/';const at=binding.inputPath.lastIndexOf(suffix);assertTrue(at>0,'Material input root missing');return binding.inputPath.slice(0,at);};
export function readMaterialBindingSync(binding:MaterialVerifierBinding):{input:ResearchExecutionPackage;completion:ResearchCompletionReceipt;intake:MaterialIntake}{
 safeResultJSON(binding);
 const input=JSON.parse(readBounded(binding.inputPath).toString('utf8')) as ResearchExecutionPackage;
 const completion=JSON.parse(readBounded(binding.completionPath).toString('utf8')) as ResearchCompletionReceipt;
 const {digest:inputDigest,...inputBody}=input,{digest:completionDigest,...completionBody}=completion;
 assertTrue(input.operationId===binding.operationId&&inputDigest===binding.inputDigest
  &&researchDigest(inputBody)===inputDigest&&input.context.digest===binding.contextDigest,'Native material input binding changed');
 assertTrue(completion.operationId===binding.operationId&&completion.executionId===binding.executionId
  &&completion.inputDigest===binding.inputDigest&&completionDigest===binding.completionDigest
  &&researchDigest(completionBody)===completionDigest,'Native material completion binding changed');
 const root=dataRootOf(binding);
 assertTrue(binding.inputPath===join(root,'research-inputs',bytesDigest(binding.operationId),'input.json')
  &&binding.completionPath===join(root,'research-completions',bytesDigest(binding.executionId),'receipt.json'),
  'Material receipt path does not match actual operation/execution');
 assertMaterialIndex(input.context.index,root);
 assertTrue(researchDigest(projectResearchEvidence(input.context.contract,input.context.requirements,input.context.limits,input.context.index))
  ===researchDigest(input.context),'Material actual context changed');
 return {input,completion,intake:new MaterialIntake(root)};
}
export async function readMaterialBinding(binding:MaterialVerifierBinding):Promise<{input:ResearchExecutionPackage;completion:ResearchCompletionReceipt;intake:MaterialIntake}>{
 const actual=readMaterialBindingSync(binding);
 await assertResearchEvidenceSnapshot(actual.intake,actual.input.context);
 if(actual.input.indexed){assertTrue(actual.input.schemaVersion===2,'Indexed input requires explicit version');await assertResearchReader(actual.input.indexed);}else assertTrue(actual.input.schemaVersion===1,'Legacy input representation mismatch');
 return actual;
}
/** Host-only capture from actual current Run/operation, known cost and physical stop. */
export async function captureMaterialBinding(store:SupervisorStore,dataRoot:string,operationId:string):Promise<MaterialVerifierBinding> {
 const op=store.runtime.getOperation(operationId),runtime=store.runtime.get(op.runtimeId),run=store.runtime.inspect(runtime.id).run,input=store.runtime.researchInput(op.id);
 assertTrue(op.state==='confirmed'&&op.step.kind==='codex'&&op.step.research&&input&&op.executionId,'Actual completed research activity required');const e=store.executionGet(op.executionId);
 assertTrue(e.runtimeBinding?.operationId===op.id&&e.runtimeBinding.runId===run.id&&op.contractVersion===run.contract.version&&e.state==='completed'&&!e.error&&e.stopConfirmed&&e.usageStatus==='reported'&&e.usage!==null,'Native material binding requires actual successful stopped same-Run execution');
 const attempt=run.attempts.find(a=>a.id===e.id);assertTrue(attempt?.settled&&attempt.actual===e.usage.totalTokens&&run.operations.find(item=>item.attemptId===e.id)?.status==='confirmed','Research ledger not exactly settled');
 if(e.identity)assertTrue((await inspectProcess(e.identity as ProcessIdentity)).status==='stopped','Actual research writer is still active');
 const completionPath=join(dataRoot,'research-completions',bytesDigest(e.id),'receipt.json'),completion=JSON.parse(readBounded(completionPath).toString('utf8')) as ResearchCompletionReceipt;
 const binding:MaterialVerifierBinding={schemaVersion:1,operationId:op.id,executionId:e.id,inputPath:input!.path,inputDigest:input!.digest,completionPath,completionDigest:completion.digest,contextDigest:input!.package.context.digest};
 const actual=await readMaterialBinding(binding);assertTrue(actual.completion.rawOutputDigest===bytesDigest(e.message)&&actual.completion.threadId===e.threadId&&actual.completion.turnId===e.turnId,'Research completion was not derived from the actual turn');
 for(const [name,hash]of Object.entries(actual.completion.files))assertTrue(bytesDigest(readBounded(join(runtime.workspace,input!.package.reportDirectory,name)))===hash,'Research report changed after materialization');return binding;
}
export async function assertMaterialSpecBindings(store:SupervisorStore,dataRoot:string,runtimeId:string,verifiers:MaterialVerifier[]):Promise<void>{for(const verifier of verifiers){const op=store.runtime.getOperation(verifier.binding.operationId);assertTrue(op.runtimeId===runtimeId,'Material verifier belongs to another Run');const actual=await captureMaterialBinding(store,dataRoot,op.id);assertTrue(researchDigest(actual)===researchDigest(verifier.binding),'Material verifier binding was not captured by this host');assertTrue(verifier.claimFile===store.runtime.researchInput(op.id)!.package.reportDirectory+'/report.json','Material verifier changes authoritative report target');}}
/** Select solely from the actual frozen current definition. No model view or
 * candidate-supplied binding can authorize a historical basis adaptation. */
export function currentMaterialProjectionBinding(
 previous:MaterialVerifier, historical:VerificationSpec,
 instance:VerificationInstance, current:VerificationSpec
):MaterialVerifierBinding {
 const criterionIds=instance.obligationIds.map(id=>{
  const obligation=historical.obligations.find(o=>o.id===id);
  assertTrue(obligation,'Historical obligation missing');
  return obligation.criterionId;
 });
 const matches=currentVerificationCases(current).filter(c=>(c.status??'active')==='active'
  &&c.verifier.kind==='material'&&c.verifier.claimFile===previous.claimFile
  &&c.obligationIds.some(id=>current.obligations.some(o=>o.id===id&&criterionIds.includes(o.criterionId))));
 const bindings=new Map(matches.map(c=>{
  const verifier=parseMaterialVerifier(c.verifier);
  return [researchDigest(verifier.binding),verifier.binding] as const;
 }));
 assertTrue(bindings.size===1,'Historical material projection needs one exact current frozen basis');
 return structuredClone([...bindings.values()][0]!);
}

export async function acquireMaterialEvidence(
 verifier:MaterialVerifier, tree:string, output:string, signal:AbortSignal,
 currentBinding?:MaterialVerifierBinding,historical?:HistoricalMaterialEpoch
){
 // Freeze host configuration and exact candidate bytes before any archive await.
 const frozenVerifier=parseMaterialVerifier(verifier);
 if(currentBinding)safeResultJSON(currentBinding);
 const targetBinding=currentBinding?structuredClone(currentBinding):undefined;
 signal.throwIfAborted();
 const claimBytes=readBounded(await relativeFile(tree,frozenVerifier.claimFile));
 const claim=claimBytes.toString('utf8');if(historical){assertHistoricalMaterialEpoch(historical);assertTrue(!currentBinding&&researchDigest(historical.binding)===researchDigest(frozenVerifier.binding),'Historical epoch cannot adapt current context');const original=JSON.parse(readBounded(historical.originalObservation.proofPath).toString('utf8'));assertTrue(original.proposed?.proposal&&researchDigest(original.proposed.proposal)===researchDigest(JSON.parse(claim)), 'Historical replay must use original specimen claim');}
 const {input,completion,intake}=await readMaterialBinding(frozenVerifier.binding);
 let proposed;
 let basisProjection;
 if(targetBinding&&researchDigest(targetBinding)!==researchDigest(frozenVerifier.binding)){
  assertTrue(dataRootOf(targetBinding)===dataRootOf(frozenVerifier.binding),
   'Historical projection cannot import another host data root');
  const current=await readMaterialBinding(targetBinding);
  const currentReport=await validateResearchProposal({intake:current.intake,context:current.input.context,output:claim});
  const projection=await validateCurrentResearchProjection(intake,{
   previous:input.context,current:current.input.context,report:currentReport.proposal,
   goalAppend:readResearchGoalAppendProof(dataRootOf(targetBinding),frozenVerifier.binding,targetBinding,input.context,current.input.context)
  });
  proposed=await validateResearchProposal({intake,context:input.context,output:projection.report});
  basisProjection={currentBinding:targetBinding,currentContext:current.input.context,
   currentCompletion:current.completion,currentReport:currentReport.proposal,currentClaim:claim,currentClaimDigest:bytesDigest(claimBytes),projection};
 }else{
  proposed=await validateResearchProposal({intake,context:input.context,output:claim});
 }
 // All source bytes and the unchanged entire current report remain available.
 // A deterministic projection never supplies a semantic verdict.
 if(input.indexed){assertTrue(!historical&&!basisProjection,'Indexed historical/projection review requires separate multi-view protocol');await assertResearchReader(input.indexed);}
 const sources=input.indexed?undefined:input.context.sources.map(source=>({materialId:source.materialId,
  rawDigest:source.rawDigest,textDigest:source.textDigest,
  text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readBounded(source.textPath,input.context.index.limits.maxItemBytes))}));
 const payload={schemaVersion:input.indexed?2:1,binding:frozenVerifier.binding,context:input.context,completion,proposed,sources,...(input.indexed?{representation:'indexed-material-v1',indexed:input.indexed}:{}),
  ...(basisProjection?{basisProjection}:{})};
 assertTrue(JSON.stringify(payload).length<=200000,'Native material review exceeds capacity without truncation');
 signal.throwIfAborted();
 await mkdir(output,{recursive:true});
 const proofPath=join(output,'actual-materials.json');
 await writeFile(proofPath,JSON.stringify(payload),{flag:'wx',mode:0o600});
 const observation:MaterialObservation={...(historical?{historical}:{}),schemaVersion:1,binding:structuredClone(frozenVerifier.binding),
  observedAt:new Date().toISOString(),sourceAcquiredAt:input.context.index.acquiredAt,
  maxAgeMs:Math.min(...input.context.requirements.map(r=>r.maxSourceAgeMs)),
  coverage:{completeness:input.context.index.completeness,disposition:input.context.index.disposition},
  proofPath,proofDigest:bytesDigest(readBounded(proofPath)),
  ...(basisProjection?{projection:{rule:'lossless-prior-questions-v1' as const,
   currentBinding:basisProjection.currentBinding,currentClaimDigest:basisProjection.currentClaimDigest,
   projectionDigest:basisProjection.projection.digest}}:{})};
 signal.throwIfAborted();
 return {payload,observation,proofFiles:[proofPath]};
}

/** Rebuild from both actual archives and the entire original current report.
 * Hashing a caller-written projection is never sufficient. */
export function assertMaterialProjectionSync(observation:MaterialObservation):MaterialObservation|null{
 const payload=JSON.parse(readBounded(observation.proofPath).toString('utf8'));
 if(!observation.projection){
  assertTrue(!Object.hasOwn(payload,'basisProjection'),'Material projection observation missing');
  return null;
 }
 const metadata=observation.projection;
 safeResultJSON(metadata);
 assertTrue(metadata.rule==='lossless-prior-questions-v1','Unknown projection rule');
 const basis=payload.basisProjection;
 assertTrue(basis&&researchDigest(metadata.currentBinding)===researchDigest(basis.currentBinding)
  &&metadata.currentClaimDigest===basis.currentClaimDigest
  &&metadata.projectionDigest===basis.projection?.digest
  &&typeof basis.currentClaim==='string'&&bytesDigest(basis.currentClaim)===metadata.currentClaimDigest
  &&researchDigest(JSON.parse(basis.currentClaim))===researchDigest(basis.currentReport),'Material projection metadata or original report bytes changed');
 assertTrue(dataRootOf(metadata.currentBinding)===dataRootOf(observation.binding),'Projection host root changed');
 const previous=readMaterialBindingSync(observation.binding),current=readMaterialBindingSync(metadata.currentBinding);
 assertTrue(researchDigest(payload.binding)===researchDigest(observation.binding)
  &&researchDigest(payload.context)===researchDigest(previous.input.context)
  &&researchDigest(payload.completion)===researchDigest(previous.completion)
  &&researchDigest(basis.currentContext)===researchDigest(current.input.context)
  &&researchDigest(basis.currentCompletion)===researchDigest(current.completion),'Projection actual receipts changed');
 const sources=previous.input.context.sources.map(source=>({materialId:source.materialId,rawDigest:source.rawDigest,textDigest:source.textDigest,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readBounded(source.textPath,previous.input.context.index.limits.maxItemBytes))}));
 assertTrue(researchDigest(payload.sources)===researchDigest(sources),'Projection displayed source bytes changed');
 validateResearchProjectionDraftSync(current.input.context,basis.currentReport,dataRootOf(metadata.currentBinding));
 const derived=projectCurrentResearchReport({previous:previous.input.context,current:current.input.context,report:basis.currentReport,
  goalAppend:readResearchGoalAppendProof(dataRootOf(metadata.currentBinding),observation.binding,metadata.currentBinding,previous.input.context,current.input.context)});
 assertTrue(researchDigest(basis.projection)===researchDigest(derived)
  &&researchDigest(payload.proposed)===researchDigest(validateResearchProjectionDraftSync(previous.input.context,derived.report,dataRootOf(observation.binding))),'Projection differs from unchanged current report');
 return {...observation,binding:metadata.currentBinding,sourceAcquiredAt:current.input.context.index.acquiredAt,
  maxAgeMs:Math.min(...current.input.context.requirements.map(r=>r.maxSourceAgeMs)),
  coverage:{completeness:current.input.context.index.completeness,disposition:current.input.context.index.disposition}};
}
export async function assertMaterialsCurrent(observations:MaterialObservation[],refresh=false,signal?:AbortSignal):Promise<void>{
 const checked=new Set<string>();for(const observation of observations){signal?.throwIfAborted();assertTrue(bytesDigest(readBounded(observation.proofPath))===observation.proofDigest,'Native material proof changed');if(observation.historical){assertHistoricalMaterialEpoch(observation.historical);assertTrue(!observation.projection&&researchDigest(observation.binding)===researchDigest(observation.historical.binding),'Historical material role changed');const original=JSON.parse(readBounded(observation.historical.originalObservation.proofPath).toString('utf8')),actual=JSON.parse(readBounded(observation.proofPath).toString('utf8'));assertTrue(researchDigest(actual)===researchDigest(original),'Historical replay differs from actual original material payload');continue;}const currentProjection=assertMaterialProjectionSync(observation);if(currentProjection){const {input:currentInput}=await readMaterialBinding(currentProjection.binding);for(const requirement of currentInput.context.requirements)assertTrue(Date.now()-Date.parse(currentInput.context.index.acquiredAt)<=requirement.maxSourceAgeMs,'Current projected material evidence expired');}const {input,intake}=await readMaterialBinding(observation.binding);assertTrue(observation.sourceAcquiredAt===input.context.index.acquiredAt&&observation.maxAgeMs===Math.min(...input.context.requirements.map(r=>r.maxSourceAgeMs))&&researchDigest(observation.coverage)===researchDigest({completeness:input.context.index.completeness,disposition:input.context.index.disposition}),'Material observation timing or coverage changed');for(const requirement of input.context.requirements)assertTrue(Date.now()-Date.parse(input.context.index.acquiredAt)<=requirement.maxSourceAgeMs,'Material evidence expired');if(refresh&&!checked.has(input.context.material.indexDigest)){const actual=await intake.refresh(input.context.material.directory,input.context.index.inputs,signal);if(actual.state!=='current'){const newer=await intake.inspect(actual.directory);assertTrue(newer.disposition==='completed'&&newer.inputs.length===input.context.index.inputs.length&&input.context.index.entries.every((old,i)=>{const fresh=newer.entries[i];return fresh&&researchDigest(fresh.input)===researchDigest(old.input)&&old.raw?.complete&&fresh.raw?.complete&&fresh.raw.sha256===old.raw.sha256&&fresh.finalURL===old.finalURL&&(old.status==='success'&&fresh.status==='success'||old.status==='unsupported'&&fresh.status==='unsupported');}),'Material source currentness is '+actual.state+'; original snapshots retained');}checked.add(input.context.material.indexDigest);}signal?.throwIfAborted();}
}

/** Complete actual projection payloads for the same paid independent reviewer.
 * The persisted actual job observations and pair proof inventory must agree. */
export function materialProjectionReviewEvidence(
 pairs:import('../contracts/p4-controls.js').QualificationPairResult[],
 observations:MaterialObservation[],
 bindings:{matrix:import('../contracts/p4-controls.js').FrozenQualificationMatrix;
  specimens:import('./control-definition.js').FrozenSpecimen[];
  definitions:import('../contracts/p4-control-draft.js').FrozenControlDetector[]}
):{proofPath:string;proofDigest:string;observation:MaterialObservation;actual:unknown}[]{
 const paths=[...new Set(pairs.flatMap(pair=>pair.results.flatMap(result=>result.proofFiles??[])))];
 const evidence=[];
 for(const proofPath of paths.filter(path=>path.endsWith('/actual-materials.json'))){
  const bytes=readBounded(proofPath),actual=JSON.parse(bytes.toString('utf8'));
  if(!Object.hasOwn(actual,'basisProjection'))continue;
  const matches=observations.filter(o=>o.proofPath===proofPath);
  assertTrue(matches.length===1&&matches[0]!.proofDigest===bytesDigest(bytes),
   'Qualification projection missing exact actual job observation');
  const observation=matches[0]!;
  assertTrue(observation.projection&&assertMaterialProjectionSync(observation),
   'Qualification projection missing actual integrity proof');
  const pair=pairs.find(p=>p.results.some(r=>r.proofFiles?.includes(proofPath)));
  const row=bindings.matrix.rows.find(r=>r.id===pair?.rowId);
  const specimen=bindings.specimens.find(s=>researchDigest(s.revision.ref)===researchDigest(row?.specimen??null));
  const old=bindings.definitions.find(d=>d.definition.definitionDigest===row?.definitionDigest);
  const target=bindings.definitions.find(d=>d.definition.definitionDigest===bindings.matrix.targetDefinitionDigest);
  assertTrue(row&&specimen&&old&&target
   &&row.definitionDigest!==bindings.matrix.targetDefinitionDigest
   &&specimen.revision.introducedDefinitionDigest===bindings.matrix.targetDefinitionDigest,
   'Projection must belong to exact historical detector/current successor row');
  assertMaterialProjectionCandidate(observation,specimen.candidate,old.definition.spec,row.instance,target.definition.spec);
  evidence.push({proofPath,proofDigest:observation.proofDigest,observation:structuredClone(observation),actual});
 }
 return evidence;
}

/** Binds the derived subview to the SAME actual current frozen specimen bytes
 * and original/current detector definitions. It cannot validate an attached view. */
export function assertMaterialProjectionCandidate(
 observation:MaterialObservation,candidate:import('./candidate.js').Candidate,
 historical:VerificationSpec,instance:VerificationInstance,current:VerificationSpec
):void {
 if(!observation.projection)return;
 const oldCase=historical.cases.find(c=>c.id===instance.caseId&&c.revision===instance.revision);
 assertTrue(oldCase?.verifier.kind==='material'
  &&researchDigest(oldCase.verifier.binding)===researchDigest(observation.binding),
  'Projection changed original frozen detector binding');
 const expected=currentMaterialProjectionBinding(oldCase.verifier,historical,instance,current);
 assertTrue(researchDigest(expected)===researchDigest(observation.projection.currentBinding),
  'Projection changed current frozen detector binding');
 const actual=readMaterialBindingSync(expected);
 const claimPath=join(reportPath(candidate.tree,actual.input.reportDirectory),'report.json');
 assertTrue(oldCase.verifier.claimFile===actual.input.reportDirectory+'/report.json'
  &&bytesDigest(readBounded(claimPath))===observation.projection.currentClaimDigest,
  'Projection is not derived from same current frozen specimen bytes');
 assertMaterialProjectionSync(observation);
}
