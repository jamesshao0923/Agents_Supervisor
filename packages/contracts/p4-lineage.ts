import type { TaskContract } from './p1.js';

/** Digest uses verificationCanonical, never a project-wide version counter. */
export interface ContractRef { projectId:string; runId:string; contractDigest:string }
export interface CriterionChangeSource { messageId:string; quote:string }
export interface AuthorizedCriterionChange {
  kind:'add'|'modify'|'retire'; criterionId:string;
  beforeDigest:string|null; afterDigest:string|null;
  sources:CriterionChangeSource[];
}
/** A persisted authorization receipt, not authority supplied by an acceptance author. */
export interface AppliedContractTransition {
  id:string; lineageId:string; from:ContractRef; to:ContractRef;
  fromContract:TaskContract; toContract:TaskContract;
  conversationId:string; sessionId:string; reasoningJobId:string;
  messageId:string; messageSequence:number; processingAttempt:number;
  relatedMessageIds:string[]; changes:AuthorizedCriterionChange[];
  review:{approved:true; changes:{criterionId:string;kind:AuthorizedCriterionChange['kind'];authorized:true;reasons:string[]}[];
    proposalDigest:string; sourceDigest:string};
  proofs:Record<string,string>;
}
export interface AcceptanceLineage {
  id:string; projectId:string; rootRunId:string; conversationId:string|null;
}
export interface RunAcceptanceBinding {
  projectId:string; runId:string; lineageId:string;
  predecessorRunId:string|null; predecessorDeliveryId:string|null; predecessorProposalId:string|null;
}
export interface BoundHead {
  lineageId:string; revision:number; proposalId:string; catalogVersion:number; contract:ContractRef;
}
export interface ProposalBase {
  lineageId:string; expectedHeadRevision:number; baseProposalId:string|null;
  baseDefinitionDigest:string|null; target:ContractRef;
  /** All applied transitions from the exact base contract to target, in order. */
  transitionIds:string[];
}
export interface ProposalAcceptanceBinding {
  proposalId:string; proposalDigest:string; base:ProposalBase; definitionFormat:'legacy-v1'|'qualified-v2';
}
export interface LineageBindingIssue {
  id:string; projectId:string; runId:string|null; proposalId:string|null;
  reasonCode:string; reason:string;
}
export interface LegacyLineageMigration {
  bindings:RunAcceptanceBinding[]; proposalBindings:ProposalAcceptanceBinding[];
  heads:BoundHead[]; issues:LineageBindingIssue[];
}
