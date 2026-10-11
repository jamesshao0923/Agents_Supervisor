import type { QualificationMatrixInput, FrozenQualificationMatrix, QualificationPairResult, QualificationResult, ControlDefinitionBinding } from '../contracts/p4-controls.js';
import type { DefinitionBundle } from './records.js';
import type { FrozenSpecimen } from './control-definition.js';
import { assertFrozenSpecimen, qualificationProofs, validateControlImplementationHistory } from './control-definition.js';
import { assertDefinition } from './definition.js';
import { assertQualificationMatrix, buildQualificationMatrix, evaluateControlQualification } from './control-rules.js';
import { canonical } from './candidate.js';
import { executeInstances } from './engine.js';
import type { EngineContext } from './engine.js';
import { evaluateVerification, selectInstances } from './rules.js';
import { inspectProcess } from '../process-control/index.js';
export interface QualificationExecution {
  matrixDigest:string;pairs:QualificationPairResult[];evaluation:QualificationResult;
  proofs:Record<string,string>;stopConfirmed:boolean;
}
function ensure(value:unknown,text:string):asserts value{if(!value)throw new Error(text);}
/** Runs frozen pairs through the actual P4 engines. No new model endpoint or
 * budget ledger: UI/source model reviews consume context.job's real reservation. */
export async function executeQualification(context:EngineContext,input:{matrix:FrozenQualificationMatrix;rules:QualificationMatrixInput;definitions:{definition:ControlDefinitionBinding;bundle:DefinitionBundle}[];specimens:FrozenSpecimen[]}):Promise<QualificationExecution> {
  const matrix=assertQualificationMatrix(input.matrix);ensure(canonical(buildQualificationMatrix(input.rules))===canonical(matrix),'Qualification matrix differs from authoritative frozen rules');validateControlImplementationHistory(input.definitions);
  ensure(!context.signal.aborted,'Qualification cancelled');ensure(!context.job.controls.some(c=>c.id.startsWith('qualification:')),'Qualification already observed; automatic same-job replay prohibited');const definitions=new Map(input.definitions.map(d=>[d.definition.definitionDigest,d]));ensure(definitions.size===input.definitions.length,'Duplicate qualification detector binding');const pairs:QualificationPairResult[]=[];
  for(const s of input.specimens){const introduced=definitions.get(s.revision.introducedDefinitionDigest);ensure(introduced?.bundle.controls.some(c=>c.id===s.revision.controlId&&c.candidate.digest===s.candidate.digest),'Specimen differs from its introduced control bytes');}
  for(const e of input.rules.manifest.entries.filter(e=>e.disposition==='current')){const s=input.specimens.find(s=>canonical(s.revision.ref)===canonical(e.specimen));const target=definitions.get(matrix.targetDefinitionDigest);ensure(s&&target?.bundle.controls.some(c=>c.id===s.revision.controlId&&c.candidate.digest===s.candidate.digest),'Current specimen differs from declared current control');}
  for(const row of matrix.rows){context.eligible();ensure(!context.signal.aborted,'Qualification cancelled');const specimen=input.specimens.find(s=>canonical(s.revision.ref)===canonical(row.specimen)),definition=definitions.get(row.definitionDigest);ensure(specimen&&definition,'Missing frozen qualification pair binding');ensure(canonical(specimen.revision)===canonical(input.rules.specimens.find(s=>canonical(s.ref)===canonical(row.specimen))),'Qualification specimen metadata changed');ensure(definition.bundle.digest===row.definitionDigest,'Qualification detector bundle changed');await assertFrozenSpecimen(specimen);await assertDefinition(definition.definition.spec,definition.bundle,false);context.eligible();ensure(!context.signal.aborted,'Qualification cancelled');const results=await executeInstances(context,definition.definition.spec,definition.bundle,specimen.candidate,[row.instance],'qualification/'+row.id,row.context?.role==='historical'?{historicalMaterialEpoch:row.context.epoch}:row.definitionDigest!==matrix.targetDefinitionDigest&&specimen.revision.introducedDefinitionDigest===matrix.targetDefinitionDigest?{materialProjectionTarget:input.rules.target.spec}:{});const pair={rowId:row.id,results};pairs.push(pair);const evaluated=evaluateControlQualification(matrix,[pair]).rows.find(r=>r.rowId===row.id)!;context.job.controls.push({id:'qualification:'+row.id,passed:evaluated.qualified,results});context.save();await assertFrozenSpecimen(specimen);context.eligible();if(!evaluated.qualified&&row.role==='current'&&specimen.revision.kind==='positive-full')break;}
  const evaluation=evaluateControlQualification(matrix,pairs);
  // New complete positive controls must pass the existing full final evaluator,
  // not merely a subset matrix or an author-supplied qualification boolean.
  for(const entry of input.rules.manifest.entries.filter(e=>e.disposition==='current')){const specimen=input.rules.specimens.find(s=>canonical(s.ref)===canonical(entry.specimen))!;if(specimen.kind!=='positive-full')continue;const rows=matrix.rows.filter(r=>r.role==='current'&&canonical(r.specimen)===canonical(specimen.ref));const results=rows.flatMap(row=>pairs.find(p=>p.rowId===row.id)?.results??[]);const final=evaluateVerification(input.rules.target.spec,selectInstances(input.rules.target.spec,{mode:'final'}),results);if(!final.complete){evaluation.qualified=false;evaluation.reasons.push('Complete positive failed full final selection: '+final.reasons.join('; '));}}
  let stopConfirmed=true;for(const identity of context.job.identities)if((await inspectProcess(identity)).status!=='stopped')stopConfirmed=false;
  const proofFiles=[...new Set(pairs.flatMap(pair=>pair.results.flatMap(result=>result.proofFiles??[])))];const proofs=proofFiles.length?await qualificationProofs(proofFiles,context.output):{};
  if(!stopConfirmed||context.job.usageUnknown||context.job.usage>context.job.config.reservation){evaluation.qualified=false;evaluation.reasons.push('Qualification process stop or actual shared model accounting unresolved');}
  context.eligible();ensure(!context.signal.aborted,'Qualification cancelled');return {matrixDigest:matrix.digest,pairs,evaluation,proofs,stopConfirmed};
}
