import type {MaterialRef, ResearchEvidenceContext} from './p8-research.js';
import type {MaterialEntry} from './p8-materials.js';
import type {ProcessIdentity} from '../process-control/index.js';

/** Integrity primitives only. A consumer must derive its grant from its actual
 * frozen job/operation. Caller-supplied IDs or roles grant no Run/P4 authority. */
export interface ResearchReaderLimits {
  pageChars: number; maxRangeChars: number; maxResponseChars: number;
  maxSearchResults: number; maxQueryChars: number;
}
export interface IndexedResearchView {
  schemaVersion: 1; protocol: 'indexed-material-v1'; authority: 'material-integrity-only';
  material: MaterialRef; contextDigest: string; contractDigest: string;
  role: 'current' | 'historical'; allowedMaterialIds: string[];
  limits: ResearchReaderLimits;
  sources: {materialId: string; status: MaterialEntry['status']; representation: MaterialEntry['representation'];
    rawDigest: string | null; textDigest: string | null; utf16Length: number | null;
    pages: {id: string; start: number; end: number; digest: string}[]}[];
  digest: string;
}
export interface PreparedResearchReader {
  schemaVersion: 1; protocol: 'indexed-material-v1'; path: string;
  view: IndexedResearchView; context: ResearchEvidenceContext; digest: string;
}
export type ResearchReadRequest =
  | {type: 'range'; materialId: string; start: number; end: number}
  | {type: 'search'; materialId: string; query: string; maxResults: number; contextChars: number};
export interface ResearchReadResult {
  schemaVersion: 1; authority: 'material-integrity-only'; viewDigest: string;
  request: ResearchReadRequest; rawDigest: string; textDigest: string;
  coordinate: 'utf16-code-units'; sourceLength: number;
  ranges: {start: number; end: number; text: string; digest: string}[];
  matchCount: number | null; truncated: boolean; digest: string;
}
export interface ResearchReaderOwner {
  jobId: string; attemptId: string; inputDigest: string; processIdentity: ProcessIdentity;
}
export interface ResearchToolResponse {contentItems: {type: 'inputText'; text: string}[]; success: boolean}
export interface ResearchReaderAudit {
  schemaVersion: 1; protocol: 'indexed-material-v1' | 'indexed-material-views-v1'; authority: 'material-integrity-only';
  inventoryDigest?: string; viewId?: string | null;
  owner: ResearchReaderOwner; viewDigest: string; sequence: number;
  stage: 'prepared' | 'write-attempt' | 'written' | 'observed' | 'aborted' | 'closed';
  rpcId: string | number | null; callId: string | null; itemId: string | null;
  threadId: string | null; turnId: string | null; eventSequence: number | null; requestDigest: string | null;
  request: ResearchReadRequest | null; response: ResearchToolResponse | null;
  responseDigest: string | null; detail: string; digest: string;
}

/** Explicit opt-in inventory. Integrity metadata is not a sourceRefresh or P4
 * authorization: consumers must derive each reference from their actual stage. */
export type IndexedResearchContextReference =
  | {role: 'current'; bindingDigest: string}
  | {role: 'historical'; epochDigest: string};
export interface IndexedResearchViewEntry {
  viewId: string; reader: PreparedResearchReader; reference: IndexedResearchContextReference;
}
export interface PreparedResearchViewSet {
  schemaVersion: 1; protocol: 'indexed-material-views-v1'; authority: 'material-integrity-only';
  path: string; views: IndexedResearchViewEntry[]; digest: string;
}
export interface ResearchViewReadRequest {viewId: string; request: ResearchReadRequest}
export interface ResearchViewReadResult {
  schemaVersion: 1; authority: 'material-integrity-only'; inventoryDigest: string;
  viewId: string; result: ResearchReadResult; digest: string;
}
