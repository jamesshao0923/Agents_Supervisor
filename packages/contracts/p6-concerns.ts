import type { InspectionResult } from './p6-monitor.js';

/** A durable request for the existing full acceptance pipeline, never a verdict. */
export interface ConcernConsumption {
  schemaVersion: 1;
  id: string; commandId: string; loopId: string; runtimeId: string; projectId: string; runId: string;
  inspectionJobId: string; dispositionSeq: number; contractVersion: number; contractDigest: string;
  inputDigest: string; completionDigest: string; evidenceDigest: string; boundaryDigest: string;
  preparedAt: string; action: 'require-full-acceptance'; observation: InspectionResult;
}
export interface ConcernVerificationBinding {
  consumptionId: string; verificationJobId: string; planId: string; proposalId: string;
  planDigest: string; requestDigest: string; boundAt: string;
}
export interface ConcernInvalidation {
  consumptionId: string; reason: 'contract-changed' | 'cancelled' | 'already-delivered'; recordedAt: string;
}
export interface ConcernState {
  consumption: ConcernConsumption; binding: ConcernVerificationBinding | null; invalidation: ConcernInvalidation | null;
}
export type ConcernBoundaryDecision =
  | { action: 'invalidate'; reason: ConcernInvalidation['reason'] }
  | { action: 'wait'; reason: string }
  | { action: 'require-full-acceptance' };
/** Pure facts are derived from repositories by the adapter, never accepted via IPC. */
export interface ConcernBoundaryFacts {
  sameContract: boolean; cancelled: boolean; delivered: boolean; paused: boolean; pendingFollowup: boolean;
  expired: boolean; clockBehind: boolean; executionComplete: boolean; allSettled: boolean; physicalStop: boolean;
  phase: string; unacknowledgedIntent: boolean;
}

export interface ConcernDiscard { inspectionJobId: string; loopId: string; contractDigest: string; reason: ConcernInvalidation['reason']; recordedAt: string }
