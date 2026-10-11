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
  schemaVersion: 1; protocol: 'indexed-material-v1'; authority: 'material-integrity-only';
  owner: ResearchReaderOwner; viewDigest: string; sequence: number;
  stage: 'prepared' | 'write-attempt' | 'written' | 'observed' | 'aborted' | 'closed';
  rpcId: string | number | null; callId: string | null; itemId: string | null;
  threadId: string | null; turnId: string | null; eventSequence: number | null; requestDigest: string | null;
  request: ResearchReadRequest | null; response: ResearchToolResponse | null;
  responseDigest: string | null; detail: string; digest: string;
}
