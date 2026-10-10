import type { RuntimeStep } from './p3.js';

/** A planned future verification allocation, not a running attempt or extra authorization. */
export interface FutureVerificationAllocation {
  allocationId: string;
  contractVersion: number;
  amount: number;
}

export interface RuntimeRepairBoundary {
  commandId: string;
  runtimeId: string;
  expectedContractVersion: number;
  /** The authoritative domain Run revision, not the runtime projection revision. */
  expectedRevision: number;
  reason: string;
}

export interface RuntimeAppendRepair extends RuntimeRepairBoundary {
  steps: Extract<RuntimeStep, { kind: 'codex' }>[];
  failureJobId: string;
  failedObligationIds: string[];
}

export interface RuntimeRetryFailure extends RuntimeRepairBoundary {
  operationId: string;
  replacement: Extract<RuntimeStep, { kind: 'codex' }>;
}

export interface RuntimeFutureVerification extends RuntimeRepairBoundary {
  allocationId: string;
  /** Zero explicitly releases the named allocation; all ordinary quiet-boundary gates apply. */
  amount: number;
}
