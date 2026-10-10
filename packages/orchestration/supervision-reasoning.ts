import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SupervisionJob } from '../contracts/p6-supervision.js';
import type { SupervisorStore } from '../persistence/store.js';
import { runtimeCanonical } from '../persistence/runtime.js';
import { futureVerificationFloor,futureExecutionFloor } from '../domain/index.js';
import { inspectProcess, terminateProcess } from '../process-control/index.js';
import type { ProcessIdentity } from '../process-control/index.js';
import { CodexReasonerAdapter, ReasonerError, parseReasonerOutput, validateReasonerSchema } from './reasoner.js';
import type { SupervisorReasoner, ReasonerResult } from './reasoner.js';

/** Context is frozen data, never an authorization or an executable instruction. */
export interface FrozenSupervisionReasoningInput {
  prompt: string;
  outputSchema: Record<string, unknown>;
  context: unknown;
}
export class SupervisionReasoningError extends Error {
  override name = 'SupervisionReasoningError';
  constructor(message: string, readonly job: SupervisionJob, options?: ErrorOptions) { super(message, options); }
}
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function ensure(value: unknown, text: string): asserts value { if (!value) throw new Error(text); }
/** Validate before serialization: JSON.stringify alone silently drops unsafe data. */
function safeJSON(value: unknown, depth = 0, seen = new Set<object>(), count = { value: 0 }): void {
  ensure(depth <= 64 && ++count.value <= 100000, 'Supervision JSON exceeds structural capacity');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { ensure(Number.isFinite(value), 'Nonfinite supervision JSON number'); return; }
  ensure(typeof value === 'object', 'Supervision input must be safe JSON');
  ensure(!seen.has(value), 'Cyclic supervision JSON'); seen.add(value);
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null || Array.isArray(value), 'Invalid supervision JSON prototype');
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    ensure(typeof key === 'string', 'Symbol supervision JSON key');
    if (Array.isArray(value) && key === 'length') continue;
    ensure(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe supervision JSON key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    ensure(descriptor.enumerable && 'value' in descriptor, 'Hidden or accessor supervision JSON property');
    if (Array.isArray(value)) ensure(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length, 'Invalid JSON array property');
    safeJSON(descriptor.value, depth + 1, seen, count);
  }
  if (Array.isArray(value)) ensure(keys.length === value.length + 1, 'Sparse supervision JSON array');
  seen.delete(value);
}
function frozenInput(job: SupervisionJob, capacity: number): FrozenSupervisionReasoningInput {
  safeJSON(job.input);
  const text = runtimeCanonical(job.input);
  ensure(text.length + 6000 <= capacity && text.length <= 200000, 'Supervision input exceeds capacity');
  ensure(hash(text) === job.inputDigest, 'Supervision frozen input digest changed');
  ensure(job.input !== null && typeof job.input === 'object' && !Array.isArray(job.input), 'Invalid frozen supervision input');
  const input = job.input as Record<string, unknown>;
  ensure(Object.keys(input).length === 3 && ['prompt', 'outputSchema', 'context'].every(key => Object.hasOwn(input, key)), 'Frozen supervision input requires prompt, outputSchema and context only');
  ensure(typeof input.prompt === 'string' && input.prompt.trim().length > 0, 'Empty supervision prompt');
  ensure(input.outputSchema !== null && typeof input.outputSchema === 'object' && !Array.isArray(input.outputSchema), 'Invalid supervision output schema');
  return { prompt: input.prompt, outputSchema: validateReasonerSchema(input.outputSchema as Record<string, unknown>), context: structuredClone(input.context) };
}
interface Pending { controller: AbortController; promise: Promise<SupervisionJob> }

/** Owns transport and accounting only. The controller owns reservations and business review. */
export class SupervisionReasoningRunner {
  private readonly pending = new Map<string, Pending>();
  private closing = false;
  private recovery: Promise<void> | undefined;
  constructor(private readonly store: SupervisorStore, private readonly dataDir: string, private readonly reasoner: SupervisorReasoner = new CodexReasonerAdapter()) {}

  private directory(id: string): string { return join(resolve(this.dataDir), 'supervision-reasoning', hash(id)); }
  private async prepareDirectory(id: string): Promise<string> {
    const data = await realpath(resolve(this.dataDir)), base = join(data, 'supervision-reasoning');
    await mkdir(base, { recursive: true, mode: 0o700 });
    ensure(!(await lstat(base)).isSymbolicLink() && await realpath(base) === base, 'Supervision log root is not a trusted directory');
    const directory = join(base, hash(id));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    ensure(!(await lstat(directory)).isSymbolicLink() && await realpath(directory) === directory, 'Supervision log directory is not a trusted directory');
    return directory;
  }
  private boundary(job: SupervisionJob, dispatch = false): void {
    ensure(!this.closing, 'Supervision reasoning runner is closing');
    this.store.supervision.assertEligible(job.loopId);
    const loop = this.store.supervision.get(job.loopId), runtime = this.store.runtime.get(job.runtimeId), run = this.store.runtime.inspect(job.runtimeId).run;
    ensure(loop.runtimeId === job.runtimeId && loop.projectId === job.projectId && loop.runId === job.runId && loop.contractVersion === job.contractVersion && loop.contractDigest === job.contractDigest, 'Supervision job boundary changed');
    ensure(!runtime.paused && !runtime.cancelled, 'Supervision runtime is paused or cancelled');
    frozenInput(job, loop.limits.maxContextChars);
    const attempt = run.attempts.find(a => a.id === job.attemptId), operation = run.operations.find(o => o.id === job.id);
    ensure(attempt?.purpose === 'reasoning' && attempt.nodeId === '@supervisor' && attempt.contractVersion === job.contractVersion && attempt.reservation === job.config.reservation && job.attemptId === job.id, 'Supervision reservation binding changed');
    ensure(operation?.attemptId === job.attemptId, 'Missing supervision operation binding');
    ensure(run.attempts.every(a => a.id === job.attemptId || a.settled && a.status !== 'running') && run.operations.every(o => o.id === job.id || o.status === 'confirmed') && run.leases.every(l => l.released), 'Supervision execution boundary is not quiescent');
    if (job.status === 'running') ensure(attempt.status === 'running' && !attempt.settled && operation.status === 'pending', 'Supervision attempt is not dispatchable');
    else ensure(attempt.settled && attempt.status === 'succeeded' && attempt.actual === job.usage && operation.status === 'confirmed', 'Supervision result lacks settled successful ledger');
    const reserve = run.attempts.filter(a => !a.settled).reduce((sum, a) => sum + a.reservation, 0);
    const legacy = Math.max(0, run.budget.verificationReserve - run.attempts.filter(a => a.purpose === 'verification' && a.contractVersion === run.contract.version).reduce((sum, a) => sum + (a.settled ? a.actual! : a.reservation), 0));
    const protection = Math.max(legacy, futureVerificationFloor(run))+futureExecutionFloor(run);
    ensure(Number.isSafeInteger(run.budget.spent + reserve + protection) && run.budget.spent + reserve + protection <= run.budget.limit, 'Supervision budget is exhausted');
    const conversation = this.store.conversations.forRun(job.projectId, job.runId);
    if (conversation) ensure(this.store.conversations.budget(conversation.id).available >= protection, 'Conversation supervision budget is exhausted');
    ensure(job.observedUsage <= job.config.reservation && (!dispatch || job.observedUsage < job.config.reservation), 'Supervision reserved model usage exhausted');
    this.store.verification.assertNoVerificationWriter(runtime.workspace);
    ensure(!this.store.executionList().some(execution => (!['completed', 'cancelled', 'failed', 'interrupted'].includes(execution.state) || !execution.stopConfirmed) && overlap(execution.workspace, runtime.workspace)), 'Workspace has active execution');
  }
  private async writersStopped(job: SupervisionJob): Promise<void> {
    const workspace = this.store.runtime.get(job.runtimeId).workspace;
    for (const execution of this.store.executionList().filter(record => overlap(record.workspace, workspace))) {
      if (execution.identity) ensure((await inspectProcess(execution.identity as ProcessIdentity)).status === 'stopped', 'Execution writer has not actually stopped');
    }
    for (const verification of this.store.verification.list('job').filter(record => overlap(record.workspace, workspace))) {
      for (const identity of verification.identities) ensure((await inspectProcess(identity)).status === 'stopped', 'Verification writer has not actually stopped');
    }
  }
  /** Missing identities never become a fabricated stop confirmation. */
  private async stopped(job: SupervisionJob, terminate: boolean): Promise<boolean> {
    let complete = job.intents.length === job.identities.length;
    const seen = new Set<string>();
    for (const identity of job.identities) {
      const intent = job.intents.find(item => item.operationId === identity.operationId && item.ownerToken === identity.ownerToken);
      if (!intent || seen.has(identity.operationId)) { complete = false; continue; }
      seen.add(identity.operationId);
      try {
        const inspection = await inspectProcess(identity);
        if (inspection.status !== 'stopped') {
          if (terminate && inspection.status === 'verified') complete = (await terminateProcess(identity)).stopped && complete;
          else complete = false;
        }
      } catch { complete = false; }
    }
    if (new Set(job.intents.map(intent => intent.operationId)).size !== job.intents.length) complete = false;
    return complete;
  }
  private async proofs(job: SupervisionJob, files: string[]): Promise<Record<string, string>> {
    ensure(files.length > 0 && files.length <= 512 && new Set(files).size === files.length, 'Missing or invalid supervision proof files');
    const directory = await realpath(this.directory(job.id));
    const data = await realpath(resolve(this.dataDir));
    ensure(directory === join(data, 'supervision-reasoning', hash(job.id)), 'Supervision proof directory escaped its data root');
    const proofs: Record<string, string> = {};
    let bytes = 0;
    for (const path of files) {
      ensure(isAbsolute(path), 'Supervision proof path must be absolute');
      const metadata = await lstat(path), actual = await realpath(path), suffix = relative(directory, actual);
      ensure(metadata.isFile() && !metadata.isSymbolicLink() && suffix !== '' && !suffix.startsWith('..' + sep) && suffix !== '..' && !isAbsolute(suffix), 'Supervision proof escaped its log directory');
      bytes += metadata.size; ensure(bytes <= 64 * 1024 * 1024, 'Supervision proof exceeds capacity');
      proofs[path] = hash(await readFile(path));
    }
    return proofs;
  }
  private async usable(job: SupervisionJob): Promise<SupervisionJob> {
    try {
      ensure(job.status === 'finished' && !job.error && job.result !== null && job.usage !== null && job.stopConfirmed && job.modelStarted && job.identities.length > 0, 'Supervision job has no applicable result');
      const completion = { usage: job.usage, stopConfirmed: job.stopConfirmed, error: job.error, proofs: job.proofs, threadId: job.threadId, result: job.result };
      ensure(hash(runtimeCanonical(completion)) === job.completionDigest, 'Supervision completion digest changed');
      this.boundary(job);
      const input = frozenInput(job, this.store.supervision.get(job.loopId).limits.maxContextChars);
      safeJSON(job.result); parseReasonerOutput(JSON.stringify(job.result), input.outputSchema);
      ensure(job.usage >= job.observedUsage && job.usage <= job.config.reservation, 'Invalid supervision result accounting');
      const actual = await this.proofs(job, Object.keys(job.proofs));
      ensure(runtimeCanonical(actual) === runtimeCanonical(job.proofs), 'Supervision proof digest changed');
      ensure(await this.stopped(job, false), 'Supervision process has not actually stopped');
      await this.writersStopped(job);
      this.boundary(this.store.supervision.job(job.id));
      return this.store.supervision.job(job.id);
    } catch (error) { throw new SupervisionReasoningError(message(error), this.store.supervision.job(job.id), { cause: error }); }
  }
  run(jobId: string): Promise<SupervisionJob> {
    ensure(this.store.supervision.job(jobId).purpose !== 'inspection', 'Inspection requires its dedicated read-only runner');
    const existing = this.pending.get(jobId); if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      if (this.recovery) await this.recovery;
      const job = this.store.supervision.job(jobId);
      if (job.status === 'finished') return this.usable(job);
      return this.execute(job, controller);
    }).finally(() => { this.pending.delete(jobId); });
    this.pending.set(jobId, { controller, promise }); return promise;
  }
  private async execute(initial: SupervisionJob, controller: AbortController): Promise<SupervisionJob> {
    let result: ReasonerResult | undefined, failure: string | null = null, proofs: Record<string, string> = {};
    const original = runtimeCanonical({ input: initial.input, inputDigest: initial.inputDigest, config: initial.config, contractVersion: initial.contractVersion, contractDigest: initial.contractDigest });
    const current = (): SupervisionJob => {
      const job = this.store.supervision.job(initial.id);
      ensure(runtimeCanonical({ input: job.input, inputDigest: job.inputDigest, config: job.config, contractVersion: job.contractVersion, contractDigest: job.contractDigest }) === original, 'Supervision immutable job changed');
      ensure(!controller.signal.aborted, 'Supervision reasoning cancelled'); this.boundary(job); return job;
    };
    try {
      const job = current();
      // Persisted process or turn intent belongs to recovery, never a second request.
      ensure(!job.modelStarted && job.intents.length === 0 && job.identities.length === 0, 'Interrupted supervision job needs recovery without replay');
      const input = frozenInput(job, this.store.supervision.get(job.loopId).limits.maxContextChars);
      await this.writersStopped(job); current();
      const cwd = await realpath(this.store.runtime.get(job.runtimeId).workspace), logDir = await this.prepareDirectory(job.id);
      current();
      result = await this.reasoner.request({ id: job.id, cwd, logDir, prompt: input.prompt, outputSchema: input.outputSchema, model: job.config.model, effort: job.config.effort, timeoutMs: job.config.timeoutMs, signal: controller.signal,
        assertEligible: () => { current(); },
        onIntent: intent => { const value = current(); this.boundary(value, true); ensure(!value.intents.some(item => item.operationId === intent.operationId), 'Duplicate supervision process intent'); ensure(intent.cwd === cwd && intent.operationId.startsWith(job.id + '-'), 'Unbound supervision process intent'); this.store.supervision.observeJob(job.id, { intents: [...value.intents, intent] }); current(); },
        onIdentity: identity => { const value = this.store.supervision.job(job.id); ensure(value.intents.some(intent => intent.operationId === identity.operationId && intent.ownerToken === identity.ownerToken) && !value.identities.some(item => item.operationId === identity.operationId), 'Unbound supervision process identity'); this.store.supervision.observeJob(job.id, { identities: [...value.identities, identity] }); current(); },
        onTurnIntent: () => { const value = current(); this.boundary(value, true); ensure(!value.modelStarted, 'Supervision turn intent already recorded'); this.store.supervision.observeJob(job.id, { modelStarted: true }); current(); },
        onUsage: usage => { ensure(Number.isSafeInteger(usage) && usage >= 0, 'Invalid observed supervision usage'); this.store.supervision.observeJob(job.id, { observedUsage: usage }); current(); }
      });
      const observed = this.store.supervision.job(job.id);
      ensure(result.modelStarted && observed.modelStarted && observed.identities.length > 0, 'Supervision result lacks durable model and process intent');
      ensure(result.stopConfirmed && await this.stopped(observed, false), 'Supervision result lacks actual stopped process');
      ensure(result.usage !== null && Number.isSafeInteger(result.usage) && result.usage >= observed.observedUsage && result.usage <= observed.config.reservation, 'Supervision usage is unknown, underreported or over reservation');
      ensure(result.value !== null, 'Empty supervision model result'); safeJSON(result.value); result.value = parseReasonerOutput(JSON.stringify(result.value), input.outputSchema);
      proofs = await this.proofs(observed, result.proofFiles); await this.writersStopped(observed); current();
    } catch (error) { if (error instanceof ReasonerError) result = error.result; failure = message(error); }
    let latest = this.store.supervision.job(initial.id);
    // A transport reporting start without its callback cannot erase uncertain cost.
    if (result?.modelStarted && !latest.modelStarted) latest = this.store.supervision.observeJob(latest.id, { modelStarted: true });
    if (!failure) { try { current(); } catch (error) { failure = message(error); } }
    const stopConfirmed = await this.stopped(latest, failure !== null);
    if (!stopConfirmed) failure ??= 'Supervision process stop remains unknown';
    let usage: number | null = result?.usage ?? (latest.modelStarted || !stopConfirmed ? null : 0);
    if (latest.modelStarted && result && !result.modelStarted) { usage = null; failure ??= 'Transport model-start evidence contradicts durable turn intent'; }
    if (usage !== null && (!Number.isSafeInteger(usage) || usage < 0)) { usage = null; failure ??= 'Invalid final supervision usage'; }
    if (failure && result?.proofFiles.length) { try { proofs = await this.proofs(latest, result.proofFiles); } catch { /* Invalid proofs never authorize application; accounting remains durable. */ } }
    // Process/proof awaits may cross pause, cancel or close; recheck immediately before the synchronous settlement.
    if (!failure) { try { current(); } catch (error) { failure = message(error); } }
    const finished = this.store.supervision.finishJob(latest.id, { usage, stopConfirmed, error: failure, proofs, threadId: result?.threadId ?? null, result: failure ? null : result!.value });
    return this.usable(finished);
  }
  initialize(): Promise<void> {
    if (this.recovery) return this.recovery;
    ensure(this.pending.size === 0, 'Cannot recover locally running supervision jobs');
    this.recovery = (async () => {
      for (const loop of this.store.supervision.list()) for (const job of this.store.supervision.jobs(loop.id)) {
        if (job.purpose === 'inspection') continue;
        if (job.status !== 'running') { if (!job.stopConfirmed) await this.stopped(job, true); continue; }
        const stopConfirmed = await this.stopped(job, true);
        this.store.supervision.finishJob(job.id, { usage: !job.modelStarted && stopConfirmed ? 0 : null, stopConfirmed, error: 'Interrupted supervision reasoning recovered without replay', proofs: {}, threadId: null, result: null });
      }
    })();
    return this.recovery;
  }
  async cancel(jobId: string): Promise<SupervisionJob> {
    ensure(this.store.supervision.job(jobId).purpose !== 'inspection', 'Inspection cancellation belongs to its dedicated runner');
    const pending = this.pending.get(jobId); pending?.controller.abort();
    const job = this.store.supervision.job(jobId);
    if (job.status === 'running') {
      const stopConfirmed = await this.stopped(job, true);
      if (!pending) this.store.supervision.finishJob(jobId, { usage: !job.modelStarted && stopConfirmed ? 0 : null, stopConfirmed, error: 'Supervision reasoning cancelled', proofs: {}, threadId: null, result: null });
    }
    if (pending) { try { await pending.promise; } catch { /* run exposes the failure; cancel returns the durable status. */ } }
    return this.store.supervision.job(jobId);
  }
  async close(): Promise<void> {
    this.closing = true;
    const ids = new Set(this.pending.keys());
    for (const loop of this.store.supervision.list()) for (const job of this.store.supervision.jobs(loop.id)) if (job.purpose !== 'inspection' && job.status === 'running') ids.add(job.id);
    await Promise.all([...ids].map(id => this.cancel(id)));
    if (this.recovery) await this.recovery;
  }
}
function overlap(a: string, b: string): boolean { return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); }
