import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ConcernConsumption, ConcernState, ConcernVerificationBinding, ConcernInvalidation, ConcernBoundaryFacts, ConcernBoundaryDecision, ConcernDiscard } from '../contracts/p6-concerns.js';
import { INSPECTION_RESULT_SCHEMA, parseInspectionResult, safeMonitorJSON, type FrozenInspectionInput } from '../contracts/p6-monitor.js';
import type { SupervisionJob } from '../contracts/p6-supervision.js';
import type { ExecutionRecord } from '../contracts/p2.js';
import { SupervisionRepository } from './supervision.js';
import { SupervisionMonitorRepository } from './supervision-monitor.js';
import { RuntimeRepository, runtimeCanonical as canonical } from './runtime.js';
import { ConversationRepository } from './conversations.js';
import { VerificationRepository } from './verification.js';
import { inspectProcess, type ProcessIdentity } from '../process-control/index.js';
import { selectInstances } from '../verification/rules.js';
import { canonical as verificationCanonical } from '../verification/candidate.js';
import { decideConcernBoundary } from '../orchestration/supervision-concern-policy.js';

export const SUPERVISION_CONCERN_MIGRATION_SQL = `
CREATE TABLE supervision_concerns(id TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE,request TEXT NOT NULL CHECK(json_valid(request)),loop_id TEXT NOT NULL REFERENCES supervision_loops(id),inspection_job_id TEXT NOT NULL UNIQUE REFERENCES supervision_jobs(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE supervision_concern_discards(inspection_job_id TEXT PRIMARY KEY REFERENCES supervision_jobs(id),loop_id TEXT NOT NULL REFERENCES supervision_loops(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE supervision_concern_bindings(consumption_id TEXT PRIMARY KEY REFERENCES supervision_concerns(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE supervision_concern_invalidations(consumption_id TEXT PRIMARY KEY REFERENCES supervision_concerns(id),record TEXT NOT NULL CHECK(json_valid(record)));
${['supervision_concerns','supervision_concern_bindings','supervision_concern_invalidations','supervision_concern_discards'].map(table => `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable concern evidence'); END; CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable concern evidence'); END;`).join('\n')}
`;
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const hash = (v: unknown) => sha(canonical(v));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function ensure(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function identifier(v: string) { ensure(typeof v === 'string' && v.trim() && v.length <= 200 && !v.includes('\0'), 'Invalid concern identifier'); }
const overlap = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

/** Only durable observation consumption. It owns no model transport or repair authority. */
export class SupervisionConcernRepository {
  private readonly supervision: SupervisionRepository;
  private readonly runtime: RuntimeRepository;
  private readonly verification: VerificationRepository;
  constructor(private readonly db: DatabaseSync, private readonly dataDir: string) {
    this.supervision = new SupervisionRepository(db); this.runtime = new RuntimeRepository(db); this.verification = new VerificationRepository(db);
  }
  transaction<T>(body: () => T): T { return this.supervision.transaction(body); }
  list(loopId: string): ConcernState[] {
    this.supervision.get(loopId);
    return this.db.prepare('SELECT id FROM supervision_concerns WHERE loop_id=? ORDER BY rowid').all(loopId).map(row => this.get(String(row.id)));
  }
  get(id: string): ConcernState {
    const row = this.db.prepare('SELECT record FROM supervision_concerns WHERE id=?').get(id); ensure(row, 'Unknown concern consumption');
    const binding = this.db.prepare('SELECT record FROM supervision_concern_bindings WHERE consumption_id=?').get(id);
    const invalidation = this.db.prepare('SELECT record FROM supervision_concern_invalidations WHERE consumption_id=?').get(id);
    return { consumption: JSON.parse(String(row.record)) as ConcernConsumption, binding: binding ? JSON.parse(String(binding.record)) as ConcernVerificationBinding : null, invalidation: invalidation ? JSON.parse(String(invalidation.record)) as ConcernInvalidation : null };
  }
  /** Only actual applied inspections with a typed request; no log text classification. */
  candidates(loopId: string): string[] {
    const consumed = new Set([...this.list(loopId).map(row => row.consumption.inspectionJobId), ...this.discards(loopId).map(row => row.inspectionJobId)]);
    return new SupervisionMonitorRepository(this.db).events(loopId).filter(e => e.kind === 'disposition' && e.record.disposition === 'applied' && e.jobId && !consumed.has(e.jobId)).map(e => e.jobId!).filter(id => {
      const job = this.supervision.job(id), input = job.input as FrozenInspectionInput;
      return parseInspectionResult(job.result, input.context.snapshot.evidence.map(e => e.id)).recommendation === 'request-diagnosis-at-safe-boundary';
    });
  }
  discards(loopId: string): ConcernDiscard[] {
    this.supervision.get(loopId); return this.db.prepare('SELECT record FROM supervision_concern_discards WHERE loop_id=? ORDER BY rowid').all(loopId).map(row => JSON.parse(String(row.record)) as ConcernDiscard);
  }
  discard(jobId: string): ConcernDiscard { return this.transaction(() => {
    const job = this.supervision.job(jobId), prior = this.discards(job.loopId).find(row => row.inspectionJobId === jobId); if (prior) return prior;
    ensure(this.candidates(job.loopId).includes(jobId), 'Only an applied unconsumed request may be invalidated');
    const decision = decideConcernBoundary(this.facts(job.loopId, job.contractDigest)); ensure(decision.action === 'invalidate', 'Concern is not stale or cancelled');
    const record: ConcernDiscard = { inspectionJobId: jobId, loopId: job.loopId, contractDigest: job.contractDigest, reason: decision.reason, recordedAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO supervision_concern_discards(inspection_job_id,loop_id,record) VALUES (?,?,?)').run(jobId, job.loopId, canonical(record)); return record;
  }); }
  inspectionBlocker(loopId: string): string | null {
    return this.supervision.jobs(loopId).some(j => j.purpose === 'inspection' && j.status === 'finished' && (!j.stopConfirmed || j.usage === null)) ? 'Inspection stop or usage remains unresolved; no model replay' : null;
  }
  private executions(loopId: string): ExecutionRecord[] {
    const workspace = this.runtime.get(this.supervision.get(loopId).runtimeId).workspace;
    return this.db.prepare('SELECT record FROM executions').all().map(row => JSON.parse(String(row.record)) as ExecutionRecord).filter(e => overlap(e.workspace, workspace));
  }
  private identities(loopId: string): ProcessIdentity[] {
    const loop = this.supervision.get(loopId), workspace = this.runtime.get(loop.runtimeId).workspace;
    return [...this.executions(loopId).flatMap(e => e.identity ? [e.identity as ProcessIdentity] : []), ...this.supervision.jobs(loopId).flatMap(j => j.identities), ...this.verification.list('job').filter(j => overlap(j.workspace, workspace)).flatMap(j => j.identities)];
  }
  facts(loopId: string, contractDigest: string, physicalStop = false): ConcernBoundaryFacts {
    const loop = this.supervision.get(loopId), { runtime, run } = this.runtime.inspect(loop.runtimeId), executions = this.executions(loopId);
    const jobs = this.supervision.jobs(loopId), verification = this.verification.list('job').filter(j => overlap(j.workspace, runtime.workspace));
    const now = Date.now(), last = new SupervisionMonitorRepository(this.db).envelope(loopId)?.state.lastObservedAtMs ?? Date.parse(loop.createdAt);
    return { sameContract: hash(run.contract) === contractDigest && loop.contractDigest === contractDigest,
      cancelled: loop.stopped || runtime.cancelled || run.status === 'cancelled', delivered: run.status === 'succeeded', paused: loop.paused || runtime.paused || run.status === 'paused',
      pendingFollowup: new ConversationRepository(this.db).hasPendingForRun(loop.projectId, loop.runId), expired: now - Date.parse(loop.createdAt) >= loop.limits.maxDurationMs, clockBehind: now < last,
      executionComplete: runtime.phase === 'awaiting-verification' && run.nodes.every(n => !n.required || n.status === 'succeeded'),
      allSettled: run.attempts.every(a => a.settled && a.status !== 'running') && run.operations.every(o => o.status === 'confirmed') && run.leases.every(l => l.released)
        && executions.every(e => ['completed','failed','cancelled','interrupted'].includes(e.state) && e.stopConfirmed && e.usageStatus === 'reported' && e.usage !== null)
        && jobs.every(j => j.status === 'finished' && j.stopConfirmed && j.usage !== null)
        && verification.every(j => j.status === 'finished' && j.stopConfirmed && !j.usageUnknown)
        && !new SupervisionMonitorRepository(this.db).envelope(loopId)?.activeJobId,
      physicalStop, phase: loop.phase, unacknowledgedIntent: !!loop.intent && loop.intent.completedAt === null };
  }
  /** Recheck real files under the private inspection root, including each owned process proof. */
  private proofs(job: SupervisionJob): void {
    const root = join(realpathSync(this.dataDir), 'supervision-inspection', 'logs', sha(job.id)), entries = Object.entries(job.proofs); let bytes = 0;
    ensure(entries.length > 0 && entries.length <= 512 && realpathSync(root) === root, 'Missing or unsafe concern proof root');
    const processProofs: { intent?: unknown; identity?: unknown; result?: { stopped?: boolean; status?: string; members?: unknown[]; stop?: { status?: string; stopped?: boolean; members?: unknown[] } } }[] = [];
    for (const [path, digest] of entries) {
      const info = lstatSync(path), actual = realpathSync(path), suffix = relative(root, actual);
      ensure(isAbsolute(path) && path === actual && info.isFile() && !info.isSymbolicLink() && suffix !== '' && suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix), 'Concern proof escaped private root');
      bytes += info.size; ensure(bytes <= 64 * 1024 * 1024, 'Concern proof exceeds capacity'); const buffer = readFileSync(path);
      ensure(sha(buffer) === digest, 'Concern proof digest changed'); if (path.endsWith('.process.json')) processProofs.push(JSON.parse(buffer.toString()));
    }
    ensure(job.identities.length > 0 && job.identities.length === job.intents.length && new Set(job.identities.map(i => i.operationId)).size === job.identities.length, 'Concern process history is incomplete');
    for (const identity of job.identities) {
      const intent = job.intents.find(i => i.operationId === identity.operationId && i.ownerToken === identity.ownerToken);
      const proofs = processProofs.filter(p => same(p.identity, identity) && same(p.intent, intent));
      ensure(intent && proofs.length === 1, 'Concern lacks exact owned process evidence');
      const result = proofs[0]!.result, stop = result?.stop ?? result;
      ensure(result?.stopped && stop?.status === 'stopped' && stop.members?.length === 0, 'Concern process stop is not proven');
    }
  }
  private audit(jobId: string) {
    const job = this.supervision.job(jobId), loop = this.supervision.get(job.loopId), { run } = this.runtime.inspect(job.runtimeId);
    ensure(job.purpose === 'inspection' && job.status === 'finished' && job.modelStarted && job.stopConfirmed && !job.error && Number.isSafeInteger(job.usage) && job.usage! > 0 && job.usage! >= job.observedUsage && job.usage! <= job.config.reservation, 'Concern requires successful known inspection accounting');
    ensure(job.runtimeId === loop.runtimeId && job.projectId === loop.projectId && job.runId === loop.runId, 'Foreign concern inspection');
    safeMonitorJSON(job.input); ensure(hash(job.input) === job.inputDigest, 'Concern input digest changed');
    const input = job.input as FrozenInspectionInput, { binding, snapshot } = input.context;
    ensure(same(input.outputSchema, INSPECTION_RESULT_SCHEMA) && binding.schemaVersion === 1 && binding.loopId === loop.id && binding.runtimeId === job.runtimeId && binding.projectId === job.projectId && binding.runId === job.runId && binding.contractVersion === job.contractVersion && binding.contractDigest === job.contractDigest && snapshot.contract.version === job.contractVersion && hash(snapshot.contract) === job.contractDigest && snapshot.runtime.id === job.runtimeId && hash(snapshot) === binding.snapshotDigest, 'Concern frozen contract/snapshot binding changed');
    const completion = { usage: job.usage, stopConfirmed: job.stopConfirmed, error: job.error, proofs: job.proofs, threadId: job.threadId, result: job.result };
    ensure(hash(completion) === job.completionDigest, 'Concern completion digest changed');
    const dispositions = new SupervisionMonitorRepository(this.db).events(loop.id).filter(e => e.jobId === jobId && e.kind === 'disposition');
    ensure(dispositions.length === 1 && dispositions[0]!.record.disposition === 'applied' && dispositions[0]!.window === binding.window, 'Concern lacks its original applied disposition');
    const attempt = run.attempts.find(a => a.id === job.attemptId), op = run.operations.find(o => o.id === job.id);
    ensure(job.attemptId === job.id && attempt?.purpose === 'inspection' && attempt.status === 'succeeded' && attempt.settled && attempt.actual === job.usage && attempt.reservation === job.config.reservation && attempt.contractVersion === job.contractVersion && op?.attemptId === job.id && op.status === 'confirmed', 'Concern actual inspection ledger is not settled');
    for (const evidence of snapshot.evidence) {
      const ref = evidence.reference; let value: unknown;
      if (ref.kind === 'runtime-event') {
        const row = this.db.prepare('SELECT kind,payload,created_at FROM runtime_events WHERE runtime_id=? AND seq=?').get(job.runtimeId, ref.seq); ensure(row, 'Concern runtime evidence is missing');
        value = { kind: row.kind, payload: JSON.parse(String(row.payload)), createdAt: row.created_at };
      } else {
        const execution = this.db.prepare('SELECT record FROM executions WHERE id=?').get(ref.executionId); ensure(execution, 'Concern execution is missing');
        const e = JSON.parse(String(execution.record)) as ExecutionRecord; ensure(e.projectId === job.projectId && e.runId === job.runId, 'Foreign concern evidence');
        const row = this.db.prepare('SELECT kind,payload,received_at FROM execution_events WHERE execution_id=? AND seq=?').get(ref.executionId, ref.seq); ensure(row, 'Concern execution evidence is missing');
        value = { kind: row.kind, payload: JSON.parse(String(row.payload)), receivedAt: row.received_at };
      }
      ensure(evidence.id === ref.kind + ':' + ('executionId' in ref ? ref.executionId + ':' : '') + ref.seq && hash(value) === evidence.digest && same(value, evidence.value), 'Concern evidence differs from original durable event');
    }
    const originals = snapshot.runtime.operations.filter(o => ['claimed','started'].includes(o.state));
    ensure(originals.length === 1 && originals[0]!.executionId, 'Concern original writer is ambiguous');
    const original = originals[0]!, frozen = snapshot.executions.find(e => e.id === original.executionId);
    const operation = this.runtime.operations(job.runtimeId).find(o => o.id === original.id);
    const row = this.db.prepare('SELECT record FROM executions WHERE id=?').get(original.executionId!); ensure(row, 'Concern original writer receipt is missing');
    const execution = JSON.parse(String(row.record)) as ExecutionRecord;
    ensure(frozen?.identity && operation?.step.kind === 'codex' && operation.executionId === execution.id && operation.attemptId === original.attemptId && operation.contractVersion === job.contractVersion && execution.runtimeBinding?.operationId === original.id && execution.runtimeBinding.runtimeId === job.runtimeId && execution.projectId === job.projectId && execution.runId === job.runId && execution.attemptId === original.attemptId && same(execution.identity, frozen.identity), 'Concern original writer binding changed');
    const originalAttempt = run.attempts.find(a => a.id === original.attemptId);
    ensure(execution.stopConfirmed && execution.usageStatus === 'reported' && execution.usage !== null && ['completed','failed','cancelled','interrupted'].includes(execution.state) && originalAttempt?.purpose === 'execution' && originalAttempt.contractVersion === job.contractVersion && originalAttempt.settled && originalAttempt.status !== 'running' && originalAttempt.actual === execution.usage.totalTokens && run.operations.filter(o => o.attemptId === original.attemptId).every(o => o.status === 'confirmed') && run.leases.every(l => l.attemptId !== original.attemptId || l.released), 'Concern original writer stop/accounting is unresolved');
    const observation = parseInspectionResult(job.result, snapshot.evidence.map(e => e.id));
    ensure(observation.recommendation === 'request-diagnosis-at-safe-boundary', 'Inspection has no evidence-bound concern request');
    this.proofs(job);
    return { job, observation, dispositionSeq: dispositions[0]!.seq, evidenceDigest: hash(snapshot.evidence) };
  }
  async assess(jobId: string): Promise<ConcernBoundaryDecision> {
    ensure(!this.db.isTransaction, 'Concern physical audit cannot hold a caller transaction');
    const job = this.supervision.job(jobId), first = decideConcernBoundary(this.facts(job.loopId, job.contractDigest, true));
    if (first.action !== 'require-full-acceptance') return first;
    const audit = this.audit(jobId), identities = this.identities(job.loopId);
    for (const identity of identities) if ((await inspectProcess(identity)).status !== 'stopped') return { action: 'wait', reason: 'Concern requires actual stopped processes' };
    return this.transaction(() => {
      ensure(hash(audit) === hash(this.audit(jobId)) && hash(identities) === hash(this.identities(job.loopId)), 'Concern boundary changed during physical audit');
      return decideConcernBoundary(this.facts(job.loopId, job.contractDigest, true));
    });
  }
  /** Async OS checks never run inside a caller's transaction; final reads/insert are one immediate transaction. */
  async consume(input: { commandId: string; jobId: string }): Promise<ConcernState> {
    identifier(input.commandId); identifier(input.jobId); ensure(!this.db.isTransaction, 'Concern physical audit cannot hold a caller transaction');
    const replay = this.db.prepare('SELECT id,request FROM supervision_concerns WHERE command_id=?').get(input.commandId);
    if (replay) { ensure(replay.request === canonical(input), 'Conflicting concern commandId'); return this.get(String(replay.id)); }
    const audit = this.audit(input.jobId), identities = this.identities(audit.job.loopId), before = hash(identities);
    for (const identity of identities) ensure((await inspectProcess(identity)).status === 'stopped', 'Concern requires actual stopped processes');
    return this.transaction(() => {
      const replay = this.db.prepare('SELECT id,request FROM supervision_concerns WHERE command_id=?').get(input.commandId);
      if (replay) { ensure(replay.request === canonical(input), 'Conflicting concern commandId'); return this.get(String(replay.id)); }
      ensure(!this.db.prepare('SELECT id FROM supervision_concerns WHERE inspection_job_id=?').get(input.jobId), 'Concern was already consumed under another command');
      const current = this.audit(input.jobId); ensure(hash(current) === hash(audit) && hash(this.identities(current.job.loopId)) === before, 'Concern boundary changed during physical audit');
      const facts = this.facts(current.job.loopId, current.job.contractDigest, true), decision = decideConcernBoundary(facts);
      ensure(decision.action === 'require-full-acceptance', decision.action === 'wait' ? decision.reason : 'Concern is no longer applicable: ' + (decision.action === 'invalidate' ? decision.reason : 'unknown'));
      const { runtime, run } = this.runtime.inspect(current.job.runtimeId);
      const record: ConcernConsumption = { schemaVersion: 1, id: 'concern-' + sha(input.commandId).slice(0, 24), commandId: input.commandId, loopId: current.job.loopId, runtimeId: current.job.runtimeId, projectId: current.job.projectId, runId: current.job.runId, inspectionJobId: current.job.id, dispositionSeq: current.dispositionSeq, contractVersion: current.job.contractVersion, contractDigest: current.job.contractDigest, inputDigest: current.job.inputDigest, completionDigest: current.job.completionDigest!, evidenceDigest: current.evidenceDigest, boundaryDigest: hash({ runtime, run }), preparedAt: new Date().toISOString(), action: 'require-full-acceptance', observation: current.observation };
      this.db.prepare('INSERT INTO supervision_concerns(id,command_id,request,loop_id,inspection_job_id,record) VALUES (?,?,?,?,?,?)').run(record.id, input.commandId, canonical(input), record.loopId, input.jobId, canonical(record)); return this.get(record.id);
    });
  }
  /** Audit-only invalidation: no domain contract or historical inspection is rewritten. */
  reconcile(id: string): ConcernState { return this.transaction(() => {
    const state = this.get(id); if (state.invalidation || state.binding) return state;
    const facts = this.facts(state.consumption.loopId, state.consumption.contractDigest), decision = decideConcernBoundary(facts);
    if (decision.action === 'invalidate') {
      const record: ConcernInvalidation = { consumptionId: id, reason: decision.reason, recordedAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO supervision_concern_invalidations(consumption_id,record) VALUES (?,?)').run(id, canonical(record));
    }
    return this.get(id);
  }); }
  /** Receipt acknowledgement only. A running job stays running; this never says passed or deliverable. */
  bindVerification(id: string, jobId: string): ConcernState { return this.transaction(() => {
    const state = this.reconcile(id), c = state.consumption; ensure(!state.invalidation, 'Concern is invalidated');
    if (state.binding) { ensure(state.binding.verificationJobId === jobId, 'Concern already binds another verification'); return state; }
    const original = this.audit(c.inspectionJobId);
    ensure(original.dispositionSeq === c.dispositionSeq && original.job.inputDigest === c.inputDigest && original.job.completionDigest === c.completionDigest && original.evidenceDigest === c.evidenceDigest && same(original.observation, c.observation), 'Concern evidence changed before acknowledgement');
    const job = this.verification.get('job', jobId), plan = this.verification.get('plan', job.planId!), proposal = this.verification.get('proposal', plan.proposalId), { run } = this.runtime.inspect(c.runtimeId);
    ensure(job.kind === 'verification' && job.runtimeId === c.runtimeId && job.projectId === c.projectId && job.runId === c.runId && job.planId === plan.id && job.proposalId === proposal.id && plan.runtimeId === c.runtimeId && plan.projectId === c.projectId && plan.runId === c.runId && proposal.projectId === c.projectId && proposal.runId === c.runId, 'Foreign concern verification receipt');
    ensure(hash(run.contract) === c.contractDigest && plan.contractDigest === sha(verificationCanonical(run.contract)) && proposal.contractDigest === plan.contractDigest && proposal.status === 'published', 'Concern verification contract changed');
    ensure(plan.selection.mode === 'final' && plan.selection.completeScope && same(plan.selection, selectInstances(proposal.spec, { mode: 'final' })), 'Concern requires the original full verification scope');
    ensure(Date.parse(plan.createdAt) >= Date.parse(c.preparedAt) && Date.parse(job.startedAt) >= Date.parse(plan.createdAt), 'Concern cannot reuse a pre-consumption verification');
    const attempt = run.attempts.find(a => a.id === job.attemptId);
    ensure(attempt?.purpose === 'verification' && attempt.contractVersion === c.contractVersion && attempt.reservation === job.config.reservation && job.environmentDigest === plan.environmentDigest && plan.definitionDigest === proposal.bundle.digest, 'Concern verification lacks actual original budget/plan binding');
    const request = job.request as { type?: unknown; planId?: unknown; commandId?: unknown };
    ensure(request.type === 'run' && request.planId === plan.id && typeof request.commandId === 'string', 'Concern verification request is not durable');
    const receipt = this.verification.receipt(request.commandId, request) as { id?: string } | undefined; ensure(receipt?.id === job.id, 'Concern verification has no exact dispatch receipt');
    const binding: ConcernVerificationBinding = { consumptionId: id, verificationJobId: job.id, planId: plan.id, proposalId: proposal.id, planDigest: hash(plan), requestDigest: hash(job.request), boundAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO supervision_concern_bindings(consumption_id,record) VALUES (?,?)').run(id, canonical(binding)); return this.get(id);
  }); }
}
