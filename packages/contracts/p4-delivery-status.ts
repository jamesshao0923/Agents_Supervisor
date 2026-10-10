import type { Delivery } from '../verification/records.js';

/** Read-only observations. None of these fields authorizes publication or delivery. */
export type DeliveryIssueCode =
  | 'history-record-missing' | 'history-unavailable' | 'history-binding-invalid'
  | 'history-accounting-invalid' | 'history-selection-invalid' | 'history-evidence-invalid'
  | 'history-file-missing' | 'history-file-changed' | 'history-file-unsafe'
  | 'history-capacity-exceeded' | 'history-format-unsupported'
  | 'workspace-busy' | 'workspace-unknown' | 'workspace-missing' | 'workspace-differs'
  | 'workspace-observation-changed' | 'scope-unresolved' | 'historical-round'
  | 'head-changed' | 'environment-changed' | 'environment-unknown'
  | 'sources-expired' | 'sources-time-unknown';
export interface DeliveryIssue {
  code: DeliveryIssueCode;
  area: 'history' | 'workspace' | 'scope' | 'environment' | 'sources';
  message: string;
}
export interface DeliveryAssessment {
  delivery: Delivery;
  checkedAt: string;
  historicalEvidenceIntact: boolean | null;
  workspaceMatches: boolean | null;
  isActiveRound: boolean | null;
  round: { conversationId: string; ordinal: number; activeRunId: string } | null;
  headMatches: boolean | null;
  environmentMatches: boolean | null;
  sourceFreshness: {
    state: 'not-applicable' | 'within-recorded-window' | 'expired' | 'unknown';
    earliestExpiresAt: string | null;
    remoteChecked: false;
  };
  issues: DeliveryIssue[];
}
