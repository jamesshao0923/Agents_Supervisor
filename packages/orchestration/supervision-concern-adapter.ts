import type { ConcernState } from '../contracts/p6-concerns.js';
import { SupervisionConcernRepository } from '../persistence/supervision-concerns.js';

export type ConcernDirective =
  | { action: 'none'; records: ConcernState[] }
  | { action: 'wait'; reason: string; records: ConcernState[] }
  | { action: 'require-full-acceptance'; records: ConcernState[]; inspectionJobIds: string[] };

/** Compose this with the existing main controller; it has no timer or model runner.
 * A directive is a constraint on that controller's existing author/review/final
 * verification path, never permission to replay an unacknowledged effect. */
export class SupervisionConcernAdapter {
  constructor(private readonly repository: SupervisionConcernRepository) {}
  async prepare(loopId: string): Promise<ConcernDirective> {
    const records = this.repository.list(loopId).map(row => this.repository.reconcile(row.consumption.id));
    const blocker = this.repository.inspectionBlocker(loopId); if (blocker) return { action: 'wait', reason: blocker, records };
    const pending = records.filter(row => !row.binding && !row.invalidation);
    const candidates = this.repository.candidates(loopId);
    const jobIds = [...pending.map(row => row.consumption.inspectionJobId), ...candidates];
    if (!jobIds.length) return { action: 'none', records };
    // All observations must be auditable. Missing or corrupt evidence blocks;
    // it is never discarded to manufacture a no-concern result.
    for (const jobId of jobIds) {
      const decision = await this.repository.assess(jobId);
      if (decision.action === 'invalidate') { if (candidates.includes(jobId)) this.repository.discard(jobId); continue; }
      if (decision.action === 'wait') return { action: 'wait', reason: decision.reason, records };
      if (candidates.includes(jobId)) records.push(await this.repository.consume({ commandId: 'consume:' + jobId, jobId }));
    }
    const active = records.filter(row => !row.binding && !row.invalidation);
    if (!active.length) return { action: 'none', records };
    // No second model call is scheduled here: the ordinary loop chooses the
    // original full acceptance path and owns reservation, intents and recovery.
    return { action: 'require-full-acceptance', records, inspectionJobIds: active.map(row => row.consumption.inspectionJobId) };
  }
  bindVerification(loopId: string, jobId: string): ConcernState[] {
    return this.repository.transaction(() => this.repository.list(loopId).map(row => this.repository.reconcile(row.consumption.id)).filter(row => !row.invalidation && !row.binding).map(row => this.repository.bindVerification(row.consumption.id, jobId)));
  }
}
