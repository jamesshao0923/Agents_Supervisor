import type { ReasonerConfig } from './p5.js';
import type { ProcessIdentity, ProcessIntent } from '../process-control/index.js';

export type SupervisionPhase = 'executing' | 'authoring' | 'reviewing' | 'publishing' | 'freezing' | 'verifying' | 'diagnosing' | 'repairing' | 'delivering' | 'blocked' | 'complete';
export interface SupervisionLimits { maxRepairs:number; maxReasoningCalls:number; maxDurationMs:number; maxContextChars:number }
export interface SupervisionIntent {
  id:string; commandId:string; kind:'propose'|'review'|'publish'|'freeze'|'verify'|'deliver'|'repair'|'retry';
  contractVersion:number; input:unknown; inputDigest:string; preparedAt:string; receipt:unknown|null; completedAt:string|null;
}
export interface SupervisionRecord {
  id:string;runtimeId:string;projectId:string;runId:string;contractVersion:number;contractDigest:string;
  revision:number;phase:SupervisionPhase;paused:boolean;stopped:boolean;reason:string|null;
  config:ReasonerConfig;limits:SupervisionLimits;createdAt:string;updatedAt:string;
  repairCount:number;reasoningCount:number;intent:SupervisionIntent|null;
  references:{proposalId?:string;reviewId?:string;planId?:string;verificationJobId?:string;authorJobId?:string;diagnosisJobId?:string};
  /** Controller validates the versioned pure-policy snapshot before use. */
  monitor:unknown;
  /** Missing on legacy loops; selected explicitly for new staged command authoring. */
  authoringProtocol?:'acceptance-stages-v1';
}
export interface SupervisionJob {
  id:string;loopId:string;runtimeId:string;projectId:string;runId:string;contractVersion:number;contractDigest:string;
  purpose:'acceptance-authoring'|'diagnosis'|'inspection';status:'running'|'finished';attemptId:string;
  config:ReasonerConfig;input:unknown;inputDigest:string;startedAt:string;finishedAt:string|null;
  intents:ProcessIntent[];identities:ProcessIdentity[];modelStarted:boolean;observedUsage:number;
  reportedUsage?:number|null;completionDigest?:string;usage:number|null;stopConfirmed:boolean;error:string|null;proofs:Record<string,string>;threadId:string|null;result:unknown|null;
}
