import type {ExplorationTier} from './p7-scheduler.js';
import type {ScheduledPlan, ScheduledRecord} from './p7-dispatch.js';
import type {ResearchEvidenceContext} from './p8-research.js';
/** Execution decomposition only. Never changes questions, source identities or checks. */
export interface ResearchGroupDeclaration {
  id: string;
  purpose: string;
  materialIds: string[];
  criterionIds: string[];
  reservation: number;
}
export interface ResearchGroupsRequest {
  commandId: string;
  runtimeId: string;
  expectedRunRevision: number;
  groups: ResearchGroupDeclaration[];
  maxActive: number;
  tier: ExplorationTier;
}
/** Metadata cannot authorize a normal scheduled P2 turn. The structured bridge
 * must separately verify this binding before it can ever dispatch a model. */
export interface ResearchGroupTaskBinding {
  schemaVersion: 1;
  registrationId: string;
  groupId: string;
  inputDigest: string;
}
export interface ResearchGroupInput {
  schemaVersion: 1 | 2;
  indexed?: import('./p8-research-reader.js').PreparedResearchReader;
  authority: 'untrusted-group-extraction-only';
  registrationId: string;
  group: ResearchGroupDeclaration;
  materialReceiptDigest: string;
  context: ResearchEvidenceContext;
  sources: {materialId: string; text: string | null; status: string}[];
  digest: string;
}
export interface ResearchGroupsPrepared {
  schemaVersion: 1;
  registrationId: string;
  materialOperationId: string;
  materialReceiptDigest: string;
  analysisOperationId: string;
  analysisAttemptId: string;
  inputs: {groupId: string; path: string; digest: string; workspace: string}[];
  plan: ScheduledPlan;
  digest: string;
}
export interface ResearchGroupsRecord {
  schemaVersion: 1;
  id: string;
  runtimeId: string;
  projectId: string;
  runId: string;
  contractVersion: number;
  contractDigest: string;
  definitionDigest: string;
  acquisitionStepId: string;
  analysisStepId: string;
  groups: ResearchGroupDeclaration[];
  maxActive: number;
  tier: ExplorationTier;
  registeredAtMs: number;
  deadlineMs: number;
  configurationDigest: string;
  state: 'waiting-materials' | 'prepared' | 'installed' | 'blocked' | 'retired';
  blockedReason?: string;
  retirement?: {commandId: string; previousContractVersion: number; previousContractDigest: string;
    contractVersion: number; contractDigest: string; runRevision: number};
  prepared: ResearchGroupsPrepared | null;
  schedulerId: string | null;
}
export interface ResearchGroupsInstalled {
  registration: ResearchGroupsRecord;
  scheduler: ScheduledRecord;
}
