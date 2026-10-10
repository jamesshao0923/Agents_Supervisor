import type { AppliedContractTransition, ProposalBase } from './p4-lineage.js';
import type { ControlDefinitionBinding, ControlEvolutionManifest, FrozenQualificationMatrix, QualificationMatrixInput, SpecimenRef, SpecimenRevision } from './p4-controls.js';
import type { VerificationInstance, VerificationResult } from './p4.js';
import type { Candidate } from '../verification/candidate.js';
import type { DefinitionBundle } from '../verification/records.js';
import type { FrozenControlDefinition, FrozenSpecimen } from '../verification/control-definition.js';

/** Author suggestions. No result, digest, path, revision or permission claims. */
export interface AuthoredControlPlan {
  controlPlan:{controlId:string;kind:'positive-full'|'negative';predecessorKey:string|null}[];
  historyPlan:{specimenKey:string;successorControlId:string|null;retireObligationIds:string[]}[];
  evolutionExplanation:string;
}
export interface ControlAuthorBinding {jobId:string;inputDigest:string;resultDigest:string}
export interface FrozenControlDetector {definition:ControlDefinitionBinding;bundle:DefinitionBundle}
/** Caller supplies actual persisted ancestry. These values grant no authority by themselves. */
export interface ControlBootstrapHistory {
  definitions:FrozenControlDetector[];
  specimens:FrozenSpecimen[];
  manifest:ControlEvolutionManifest|null;
  transitions:AppliedContractTransition[];
}
/** Exact frozen bytes. A negative descriptor is not yet a qualified SpecimenRevision. */
export interface PendingSpecimenDescriptor {
  ref:SpecimenRef;controlId:string;kind:'positive-full'|'negative';
  introducedDefinitionDigest:string;predecessor:SpecimenRef|null;
  scope:SpecimenRevision['scope'];candidate:Candidate;
}
export interface BootstrapPair {
  id:string;specimen:SpecimenRef;definitionDigest:string;instance:VerificationInstance;
  failures:{obligationId:string;expectationDigest:string}[];
}
export interface FrozenControlDraft {
  schemaVersion:1;proposalId:string;base:ProposalBase;
  baseDefinition:ControlDefinitionBinding|null;
  target:FrozenControlDetector;
  transitions:AppliedContractTransition[];
  history:ControlBootstrapHistory;
  authorBinding:ControlAuthorBinding;
  authoredPlan:AuthoredControlPlan;
  descriptors:PendingSpecimenDescriptor[];
  manifest:ControlEvolutionManifest;
  bootstrapPlan:BootstrapPair[];
  digest:string;
}
export interface PrepareControlDraftInput {
  proposalId:string;base:ProposalBase;baseDefinition:ControlDefinitionBinding|null;
  target:FrozenControlDetector;transitions:AppliedContractTransition[];
  history:ControlBootstrapHistory;authoredPlan:AuthoredControlPlan;
  authorBinding:ControlAuthorBinding;
}
export interface BootstrapPairResult {pairId:string;results:VerificationResult[]}
export interface BootstrapEvidence {
  schemaVersion:1;draftDigest:string;reviewJobId:string;environmentDigest:string;
  pairs:BootstrapPairResult[];proofs:Record<string,string>;
  usage:number;usageUnknown:boolean;stopConfirmed:boolean;
  usable:boolean;reasons:string[];digest:string;
}
export interface AssembledControlQualification {
  rules:QualificationMatrixInput;matrix:FrozenQualificationMatrix;
  specimens:FrozenSpecimen[];definitions:FrozenControlDetector[];
  frozen:FrozenControlDefinition;
}
