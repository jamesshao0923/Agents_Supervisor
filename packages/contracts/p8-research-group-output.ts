import type {CitationRequest, BoundCitation} from './p8-research.js';
import type {ResultRef} from './p7-results.js';
/** Model interpretation only, never an answer/acceptance/P4 verdict. */
export interface ResearchGroupProposal {
  schemaVersion: 1;
  inputDigest: string;
  citations: CitationRequest[];
  materials: {materialId: string; summary: string | null; citationIds: string[]; unresolved: string[]}[];
  extractions: {id: string; criterionIds: string[]; kind: 'fact' | 'inference' | 'hypothesis';
    text: string; supportCitationIds: string[]; limitations: string[]}[];
  relationships: {materialIds: string[]; extractionIds: string[]; description: string}[];
  gaps: {criterionId: string; materialIds: string[]; reason: string}[];
}
export interface ValidatedResearchGroup {
  authority: 'untrusted-group-extraction-only';
  inputDigest: string;
  proposal: ResearchGroupProposal;
  citations: BoundCitation[];
  digest: string;
}
export interface ResearchGroupCompletion {
  schemaVersion: 1;
  executionId: string;
  claimId: string;
  inputDigest: string;
  threadId: string;
  turnId: string;
  rawOutputDigest: string;
  eventPrefixSeq: number;
  completionEvents: {messageSeq: number; terminalSeq: number; evidenceDigest: string};
  draft: ValidatedResearchGroup;
  files: Record<string, string>;
  digest: string;
}
export interface ResearchGroupsAggregate {
  schemaVersion: 1;
  registrationId: string;
  schedulerId: string;
  contractDigest: string;
  materialReceiptDigest: string;
  groups: {groupId: string; inputDigest: string; ref: ResultRef;
    completionDigest: string; draft: ValidatedResearchGroup}[];
  authority: 'untrusted-group-extraction-only';
  digest: string;
}
