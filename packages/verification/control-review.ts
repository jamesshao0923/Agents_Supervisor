import { packQualificationReview, QUALIFICATION_REVIEW_INSTRUCTIONS, QUALIFICATION_TABLE_GUIDANCE } from './qualification-review-wire.js';
import {sourceRefreshReviewEvidence} from './source-refresh-controls.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QualificationMatrixInput, FrozenQualificationMatrix, QualificationPairResult, ControlDefinitionBinding } from '../contracts/p4-controls.js';
import type { DefinitionBundle } from './records.js';
import type { FrozenSpecimen } from './control-definition.js';
import { assertFrozenSpecimen, specimenDiff, specimenText, validateControlImplementationHistory } from './control-definition.js';
import { assertDefinition } from './definition.js';
import { assertQualificationMatrix, buildQualificationMatrix, evaluateControlQualification } from './control-rules.js';
import { canonical } from './candidate.js';
import {materialProjectionReviewEvidence} from './material.js';
import type {MaterialObservation} from '../contracts/p4-material.js';
import type {ResearchWorkflowProposal} from '../contracts/p4-research-workflow.js';
import type {TaskContract} from '../contracts/p1.js';
export interface FrozenQualificationReview {
  maintenance?:unknown;
  rules:QualificationMatrixInput;matrix:FrozenQualificationMatrix;pairs:QualificationPairResult[];
  definitions:{definition:ControlDefinitionBinding;bundle:DefinitionBundle}[];
  specimens:FrozenSpecimen[];
  materialObservations?:MaterialObservation[];
  researchWorkflow?:{current:ResearchWorkflowProposal;previous:ResearchWorkflowProposal;contract:TaskContract};
}
/** Complete bounded data for a fresh independent P4 reviewer. This function
 * generates no approval and performs no model call; controller reserves/calls. */
export async function controlQualificationReviewPrompt(input:FrozenQualificationReview,maxBytes=1_000_000,presentation?:'compact-v2'):Promise<string> {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>2_000_000)throw new Error('Invalid qualification review capacity');const matrix=assertQualificationMatrix(input.matrix);if(canonical(buildQualificationMatrix(input.rules))!==canonical(matrix))throw new Error('Independent review matrix differs from frozen rules');validateControlImplementationHistory(input.definitions);
  const implementations:Record<string,Record<string,string>>={};let bytes=0;
  for(const d of input.definitions){await assertDefinition(d.definition.spec,d.bundle,false);const files:Record<string,string>={};for(const file of Object.keys(d.bundle.files)){const text=await readFile(join(d.bundle.directory,file),'utf8');bytes+=Buffer.byteLength(text);if(bytes>maxBytes)throw new Error('Complete detector review exceeds capacity; never truncate');files[file]=text;}implementations[d.definition.definitionDigest]=files;}
  for(const s of input.specimens)await assertFrozenSpecimen(s);const specimenImplementations=await specimenText(input.specimens,maxBytes),diffs=input.specimens.filter(s=>s.revision.predecessor).map(s=>{const previous=input.specimens.find(p=>canonical(p.revision.ref)===canonical(s.revision.predecessor));if(!previous)throw new Error('Independent specimen diff lacks predecessor');return {specimen:s.revision.ref,diff:specimenDiff(previous,s)};});
  const sourceRefreshEvidence=sourceRefreshReviewEvidence({matrix,pairs:input.pairs,observations:input.materialObservations??[]});
  const projections=materialProjectionReviewEvidence(input.pairs,input.materialObservations??[],input);
  const payload={...(sourceRefreshEvidence?{sourceRefreshEvidence}:{}),...(input.researchWorkflow?{researchWorkflow:input.researchWorkflow}:{}),...(projections.length?{materialProjections:projections}:{}),rules:input.rules,matrix,pairs:input.pairs,deterministicQualification:evaluateControlQualification(matrix,input.pairs),implementations,specimenImplementations,diffs,...(input.maintenance?{maintenance:input.maintenance}:{})};
  if(presentation!==undefined&&presentation!=='compact-v2')throw Error('Unknown qualification presentation');
  const complete=canonical(payload);
  if(Buffer.byteLength(QUALIFICATION_REVIEW_INSTRUCTIONS+'\n'+complete)>maxBytes)throw Error('Complete qualification review exceeds capacity; never truncate');
  const prompt=QUALIFICATION_REVIEW_INSTRUCTIONS+(presentation?QUALIFICATION_TABLE_GUIDANCE:'')+'\n'+(presentation?canonical(packQualificationReview(payload)):complete);
  if(Buffer.byteLength(prompt)>maxBytes)throw new Error('Complete qualification review exceeds capacity; split review, never truncate');return prompt;
}
