import type {ResearchProofPlan,ResearchWorkflowProposal,ResearchWorkflowEvolution} from '../contracts/p4-research-workflow.js';
import type {VerificationSpec} from '../contracts/p4.js';
import type {ProposalBase,AppliedContractTransition} from '../contracts/p4-lineage.js';
import type {TaskContract} from '../contracts/p1.js';
import {safeControlJSON} from '../contracts/p4-controls.js';
import {currentVerificationCases} from './rules.js';
import {canonical,digest} from './candidate.js';
import {readMaterialBindingSync} from './material.js';
import {readResearchGoalAppendProof} from './research-goal-binding.js';
import {assertResearchProjectionCompatibility} from './research-projection.js';
function ensure(value:unknown,message:string):asserts value {
 if(!value)throw Error('Research evolution: '+message);
}
/** Host derivation only. Actual proposal/draft/transition repositories remain the
 * authority; this does not issue approval or accept a semantic interpretation. */
export function prepareResearchWorkflowEvolution(input:{
 previous:ResearchWorkflowProposal;previousSpec:VerificationSpec;
 currentPlan:ResearchProofPlan;currentSpec:VerificationSpec;currentContract:TaskContract;
 base:ProposalBase;transitions:AppliedContractTransition[];
}):ResearchWorkflowEvolution {
 safeControlJSON(input);
 const frozen=structuredClone(input),{previous,currentPlan,base}=frozen;
 ensure(base.baseProposalId===previous.proposalId&&base.baseDefinitionDigest
  &&base.target.contractDigest===currentPlan.contractDigest
  &&canonical(base.transitionIds)===canonical(frozen.transitions.map(t=>t.id)),
  'exact applied predecessor/current base missing');
 ensure(frozen.transitions.every(t=>t.changes.every(c=>c.kind==='add')),
  'modified/retired questions require another lossless protocol; unsupported');
 for(const old of previous.proofPlan.originalChecks){
  const matching=currentPlan.originalChecks.filter(c=>c.criterionId===old.criterionId&&c.checkIndex===old.checkIndex);
  ensure(matching.length===1&&canonical(matching[0])===canonical(old),
   'original check or its ALL-OF artifact/host mapping changed');
 }
 const oldCases=currentVerificationCases(frozen.previousSpec).filter(c=>(c.status??'active')==='active'&&c.verifier.kind==='material');
 const currentCases=currentVerificationCases(frozen.currentSpec).filter(c=>(c.status??'active')==='active'&&c.verifier.kind==='material');
 ensure(oldCases.length>0&&currentCases.length>0,'native material basis missing');
 const bases=new Map<string,ResearchWorkflowEvolution['bases'][number]>();
 for(const old of oldCases){
  if(old.verifier.kind!=='material')continue;
  const oldVerifier=old.verifier;
  const matches=currentCases.filter(c=>c.verifier.kind==='material'&&c.verifier.claimFile===oldVerifier.claimFile);
  const bindings=new Map(matches.map(c=>{ensure(c.verifier.kind==='material','material basis changed');return [canonical(c.verifier.binding),c.verifier.binding] as const;}));
  ensure(bindings.size===1,'one exact current producer per prior report required');
  const current=[...bindings.values()][0]!,before=readMaterialBindingSync(old.verifier.binding),after=readMaterialBindingSync(current);
  ensure(canonical(after.input.context.contract)===canonical(frozen.currentContract),
   'current material input belongs to another admitted contract');
  ensure(before.input.context.contractDigest===previous.proofPlan.contractDigest,
   'prior material input differs from frozen predecessor scope');
  const sourceBasisDigest=assertResearchProjectionCompatibility(before.input.context,after.input.context,
   readResearchGoalAppendProof(current.inputPath.slice(0,current.inputPath.lastIndexOf('/research-inputs/')),old.verifier.binding,current,before.input.context,after.input.context));
  bases.set(canonical(old.verifier.binding),{previous:old.verifier.binding,current,sourceBasisDigest});
 }
 const body={schemaVersion:1 as const,rule:'append-same-source-lossless-v1' as const,
  predecessorProposalId:previous.proposalId,predecessorProofPlanDigest:previous.proofPlan.digest,
  lineageId:base.lineageId,transitionIds:base.transitionIds,bases:[...bases.values()]};
 return {...body,digest:digest(canonical(body))};
}
