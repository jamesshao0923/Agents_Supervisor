import type { ConcernBoundaryDecision, ConcernBoundaryFacts } from '../contracts/p6-concerns.js';

/** No branch authorizes repair, standard changes, model replay or delivery. */
export function decideConcernBoundary(f: ConcernBoundaryFacts): ConcernBoundaryDecision {
  if (!f.sameContract) return { action: 'invalidate', reason: 'contract-changed' };
  if (f.cancelled) return { action: 'invalidate', reason: 'cancelled' };
  if (f.delivered) return { action: 'invalidate', reason: 'already-delivered' };
  if (f.clockBehind) return { action: 'wait', reason: 'Concern clock moved backwards' };
  if (f.expired) return { action: 'wait', reason: 'Supervision duration exhausted' };
  if (f.paused) return { action: 'wait', reason: 'Supervision is paused' };
  if (f.pendingFollowup) return { action: 'wait', reason: 'Pending user follow-up' };
  if (!f.allSettled || !f.physicalStop) return { action: 'wait', reason: 'Execution or inspection stop/usage remains unresolved' };
  if (!f.executionComplete) return { action: 'wait', reason: 'Original execution has not completed' };
  if (f.unacknowledgedIntent) return { action: 'wait', reason: 'Existing supervision effect awaits its receipt' };
  if (f.phase !== 'executing') return { action: 'wait', reason: 'Continue the existing acceptance effect; do not dispatch another' };
  return { action: 'require-full-acceptance' };
}
