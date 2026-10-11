import type { ResearchProposal, ResearchEvidenceContext } from './p8-research.js';

export interface ResearchGoalAppendProof {
  schemaVersion:1;
  authority:'actual-applied-receipts-integrity-only';
  previousGoalDigest:string;currentGoalDigest:string;
  previousContractDigest:string;currentContractDigest:string;
  lineageId:string;predecessorDeliveryId:string;
  previousRunId:string;currentRunId:string;
  transitionIds:string[];
  appendedMessages:{id:string;sequence:number;text:string}[];
  digest:string;
}

/** Deterministic integrity evidence, never semantic approval or Run permission. */
export interface ResearchProjection {
  schemaVersion: 1;
  rule: 'lossless-prior-questions-v1';
  authority: 'projection-integrity-only';
  previousGoalDigest:string;
  currentGoalDigest:string;
  goalAppend:ResearchGoalAppendProof|null;
  previousContextDigest: string;
  currentContextDigest: string;
  currentReportDigest: string;
  projectedReportDigest: string;
  sourceBasisDigest: string;
  retainedQuestionIds: string[];
  retainedClaimIds: string[];
  report: ResearchProposal;
  digest: string;
}

export interface ResearchProjectionInput {
  previous: ResearchEvidenceContext;
  current: ResearchEvidenceContext;
  report: ResearchProposal;
  goalAppend?:ResearchGoalAppendProof|null;
}
