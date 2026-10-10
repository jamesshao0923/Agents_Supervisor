import { createHash } from 'node:crypto';

export const HEALTH_INTERVAL_MS = 15_000;
export const INSPECTION_INTERVAL_MS = 300_000;
export type MonitorLifecycle = 'active' | 'paused' | 'terminal';
export interface InspectionIntent {
  id: string;
  window: number;
  evidenceCursor: string;
  signals: string[];
  anomalyDue: boolean;
}
/** Persist this state with the inspection intent before invoking the reasoner. */
export interface MonitorState {
  startedAtMs: number;
  lastObservedAtMs: number;
  lastHealthAtMs: number;
  lastHandledWindow: number;
  lastCheckedEvidenceCursor: string;
  pendingSignals: string[];
  pendingAnomaly: boolean;
  deferredWindow: number | null;
  inFlight: InspectionIntent | null;
}
export interface MonitorInput {
  nowMs: number;
  lifecycle: MonitorLifecycle;
  evidenceCursor: string;
  signals?: string[];
  anomalyDue?: boolean;
  healthIntervalMs?: number;
}
export interface MonitorDecision {
  state: MonitorState;
  healthScan: boolean;
  inspection: 'inspect' | 'merged' | 'skip' | 'wait' | 'disabled';
  window: number | null;
  missedWindows: number;
  intent: InspectionIntent | null;
}

function integer(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label}`);
}
function text(value: string, label: string, allowEmpty = false): void {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`Invalid ${label}`);
}
function bool(value: boolean, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`);
}
function strings(values: string[], label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`Invalid ${label}`);
  for (const value of values) text(value, label);
  return [...new Set(values)].sort();
}
function validateMonitorState(state: MonitorState): void {
  for (const key of ['startedAtMs', 'lastObservedAtMs', 'lastHealthAtMs', 'lastHandledWindow'] as const) integer(state[key], key);
  if (state.lastObservedAtMs < state.startedAtMs || state.lastHealthAtMs < state.startedAtMs || state.lastHealthAtMs > state.lastObservedAtMs) throw new Error('Invalid monitor chronology');
  if (state.lastHandledWindow > Math.floor((state.lastObservedAtMs - state.startedAtMs) / INSPECTION_INTERVAL_MS)) throw new Error('Invalid handled window');
  text(state.lastCheckedEvidenceCursor, 'checked evidence cursor', true);
  strings(state.pendingSignals, 'pending signal'); bool(state.pendingAnomaly, 'pending anomaly');
  if (state.deferredWindow !== null) {
    integer(state.deferredWindow, 'deferred window', 1);
    if (state.deferredWindow > state.lastHandledWindow) throw new Error('Invalid deferred window');
  }
  if (state.inFlight !== null) {
    text(state.inFlight.id, 'inspection id'); integer(state.inFlight.window, 'inspection window', 1);
    text(state.inFlight.evidenceCursor, 'inspection evidence cursor', true);
    strings(state.inFlight.signals, 'inspection signal'); bool(state.inFlight.anomalyDue, 'inspection anomaly');
    if (state.inFlight.window > state.lastHandledWindow || (state.deferredWindow !== null && state.deferredWindow <= state.inFlight.window)) throw new Error('Invalid inspection chronology');
  }
}

export function createMonitorState(startedAtMs: number, evidenceCursor = ''): MonitorState {
  integer(startedAtMs, 'monitor start'); text(evidenceCursor, 'evidence cursor', true);
  return { startedAtMs, lastObservedAtMs: startedAtMs, lastHealthAtMs: startedAtMs, lastHandledWindow: 0,
    lastCheckedEvidenceCursor: evidenceCursor, pendingSignals: [], pendingAnomaly: false, deferredWindow: null, inFlight: null };
}

/** Event facts are supplied by the controller; this function never infers a hung process from quiet logs. */
export function decideMonitoring(previous: MonitorState, input: MonitorInput): MonitorDecision {
  validateMonitorState(previous); integer(input.nowMs, 'monitor time'); text(input.evidenceCursor, 'evidence cursor', true);
  if (!['active', 'paused', 'terminal'].includes(input.lifecycle)) throw new Error('Invalid monitor lifecycle');
  if (input.nowMs < previous.lastObservedAtMs) throw new Error('Monitor time moved backwards');
  const interval = input.healthIntervalMs ?? HEALTH_INTERVAL_MS;
  integer(interval, 'health interval');
  if (interval < 10_000 || interval > 15_000) throw new Error('Health interval must be 10–15 seconds');
  const signals = strings(input.signals ?? [], 'monitor signal'); bool(input.anomalyDue ?? false, 'anomaly due');
  const state = structuredClone(previous);
  state.lastObservedAtMs = input.nowMs;
  const decision: MonitorDecision = { state, healthScan: false, inspection: 'disabled', window: null, missedWindows: 0, intent: null };
  // Pausing dispatch must not erase one-shot facts received while inactive.
  // Keep them for the next permitted window, without running health/model work.
  state.pendingSignals = strings([...state.pendingSignals, ...signals], 'pending signal');
  state.pendingAnomaly ||= input.anomalyDue ?? false;
  if (input.lifecycle !== 'active') return decision;
  decision.healthScan = input.nowMs - state.lastHealthAtMs >= interval;
  if (decision.healthScan) state.lastHealthAtMs = input.nowMs;
  const currentWindow = Math.floor((input.nowMs - state.startedAtMs) / INSPECTION_INTERVAL_MS);
  const newWindow = currentWindow > state.lastHandledWindow;
  decision.missedWindows = newWindow ? currentWindow - state.lastHandledWindow - 1 : 0;
  if (newWindow) state.lastHandledWindow = currentWindow;
  if (state.inFlight) {
    if (newWindow) state.deferredWindow = currentWindow;
    decision.inspection = newWindow ? 'merged' : 'wait';
    decision.window = newWindow ? currentWindow : null;
    return decision;
  }
  const window = newWindow ? currentWindow : state.deferredWindow;
  if (window === null || window === 0) { decision.inspection = 'wait'; return decision; }
  state.deferredWindow = null;
  decision.window = window;
  if (input.evidenceCursor === state.lastCheckedEvidenceCursor && !state.pendingAnomaly && state.pendingSignals.length === 0) {
    decision.inspection = 'skip'; return decision;
  }
  const intent: InspectionIntent = { id: `inspection-${state.startedAtMs}-${window}`, window,
    evidenceCursor: input.evidenceCursor, signals: state.pendingSignals, anomalyDue: state.pendingAnomaly };
  state.inFlight = structuredClone(intent);
  state.pendingSignals = []; state.pendingAnomaly = false;
  decision.inspection = 'inspect'; decision.intent = intent;
  return decision;
}

/** Only successful inspection advances the evidence cursor; a failure remains due in the next window. */
export function completeInspection(previous: MonitorState, inspectionId: string, succeeded: boolean): MonitorState {
  validateMonitorState(previous); text(inspectionId, 'inspection id'); bool(succeeded, 'inspection success');
  if (previous.inFlight?.id !== inspectionId) throw new Error('Inspection completion does not match durable intent');
  const state = structuredClone(previous), intent = state.inFlight!;
  if (succeeded) state.lastCheckedEvidenceCursor = intent.evidenceCursor;
  else {
    state.pendingSignals = strings([...state.pendingSignals, ...intent.signals, 'inspection-failed'], 'pending signal');
    state.pendingAnomaly ||= intent.anomalyDue;
  }
  state.inFlight = null;
  return state;
}

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
/** Rank and input capacity must come from reviewed capability configuration, not model names. */
export interface ModelCapability {
  id: string;
  available: boolean;
  qualityRank: number;
  supportedEfforts: ReasoningEffort[];
  inputCapacityTokens?: number;
}
export interface ModelSelection { model: string; effort: ReasoningEffort }
export interface ModelRouteInput {
  capabilities: ModelCapability[];
  complexity: 'simple' | 'complex';
  purpose: 'inspection' | 'execution' | 'diagnosis';
  requiredEffort?: ReasoningEffort;
  minimumQualityRank?: number;
  current?: ModelSelection;
  capabilityGapEvidence?: string[];
  context?: { requiredTokens: number; mitigated: boolean };
  safeBoundary: boolean;
  budgetAllowed: boolean;
}
export interface ModelRouteDecision {
  action: 'select' | 'defer' | 'context-action' | 'blocked' | 'stop';
  selection: ModelSelection | null;
  reason: string;
  considered: { model: string; eligible: boolean; reason: string }[];
}
function effortRank(effort: ReasoningEffort): number {
  const rank = REASONING_EFFORTS.indexOf(effort);
  if (rank === -1) throw new Error('Invalid reasoning effort');
  return rank;
}

export function routeModel(input: ModelRouteInput): ModelRouteDecision {
  if (!Array.isArray(input.capabilities) || !['simple', 'complex'].includes(input.complexity) || !['inspection', 'execution', 'diagnosis'].includes(input.purpose)) throw new Error('Invalid model routing input');
  bool(input.safeBoundary, 'safe boundary'); bool(input.budgetAllowed, 'budget eligibility');
  const seen = new Set<string>();
  for (const model of input.capabilities) {
    text(model.id, 'model id'); bool(model.available, 'model availability'); integer(model.qualityRank, 'quality rank');
    if (seen.has(model.id)) throw new Error('Duplicate model capability'); seen.add(model.id);
    if (!Array.isArray(model.supportedEfforts) || model.supportedEfforts.length === 0 || new Set(model.supportedEfforts).size !== model.supportedEfforts.length) throw new Error('Invalid supported efforts');
    model.supportedEfforts.forEach(effortRank);
    if (model.inputCapacityTokens !== undefined) integer(model.inputCapacityTokens, 'input capacity', 1);
  }
  if (input.current) { text(input.current.model, 'current model'); effortRank(input.current.effort); }
  const gaps = strings(input.capabilityGapEvidence ?? [], 'capability gap evidence');
  const required = input.requiredEffort ?? (input.complexity === 'complex' ? 'high' : 'low');
  const requiredRank = effortRank(required), minimum = input.minimumQualityRank ?? 0;
  integer(minimum, 'minimum quality rank');
  if (input.context) { integer(input.context.requiredTokens, 'required context', 1); bool(input.context.mitigated, 'context mitigation'); }
  const current = input.capabilities.find(model => model.id === input.current?.model);
  const result: ModelRouteDecision = { action: 'blocked', selection: null, reason: '', considered: [] };
  if (!input.budgetAllowed) return { ...result, action: 'stop', reason: 'shared-budget-unavailable' };
  if (gaps.length && (!input.current || !current)) return { ...result, reason: 'upgrade-baseline-unavailable' };
  if (input.context && !input.context.mitigated && (current?.inputCapacityTokens === undefined || input.context.requiredTokens > current.inputCapacityTokens)) {
    return { ...result, action: 'context-action', reason: 'filter-memory-split-or-rebuild-context-first' };
  }
  const candidates: { capability: ModelCapability; effort: ReasoningEffort }[] = [];
  for (const model of [...input.capabilities].sort((a, b) => a.id.localeCompare(b.id))) {
    const effort = [...model.supportedEfforts].sort((a, b) => effortRank(a) - effortRank(b)).find(value => effortRank(value) >= requiredRank);
    const reason = !model.available ? 'not-available'
      : model.qualityRank < minimum ? 'below-required-quality'
      : gaps.length && model.qualityRank <= current!.qualityRank ? 'not-a-quality-upgrade'
      : effort === undefined ? 'required-effort-unsupported'
      : input.context && model.inputCapacityTokens === undefined ? 'context-capacity-unknown'
      : input.context && input.context.requiredTokens > model.inputCapacityTokens! ? 'context-capacity-insufficient'
      : 'eligible';
    result.considered.push({ model: model.id, eligible: reason === 'eligible', reason });
    if (reason === 'eligible') candidates.push({ capability: model, effort: effort! });
  }
  const best = candidates.sort((a, b) => (input.complexity === 'complex' || gaps.length ? b.capability.qualityRank - a.capability.qualityRank : a.capability.qualityRank - b.capability.qualityRank) || a.capability.id.localeCompare(b.capability.id))[0];
  if (!best) {
    result.reason = gaps.length ? 'no-available-quality-upgrade' : 'no-capability-meets-requirements';
    return result;
  }
  result.selection = { model: best.capability.id, effort: best.effort };
  if (!input.safeBoundary && (!input.current || input.current.model !== result.selection.model || input.current.effort !== result.selection.effort)) {
    result.action = 'defer'; result.reason = 'change-requires-safe-boundary'; return result;
  }
  result.action = 'select'; result.reason = gaps.length ? 'evidenced-capability-gap' : input.complexity === 'complex' ? 'complex-task-quality-first' : 'fastest-sufficient-capability';
  return result;
}

export interface ProgressObservation {
  failureFingerprints: string[];
  passedRequiredCriteria: string[];
  verification: { criterionId: string; outcome: 'passed' | 'failed' | 'unknown'; evidenceDigest: string }[];
  artifacts: { path: string; digest: string }[];
}
/** Log growth, loop counters and model self-reports are intentionally absent. */
export function progressFingerprint(observation: ProgressObservation): string {
  const failures = strings(observation.failureFingerprints, 'failure fingerprint');
  const passed = strings(observation.passedRequiredCriteria, 'passed criterion');
  if (!Array.isArray(observation.verification) || !Array.isArray(observation.artifacts)) throw new Error('Invalid progress observation');
  const criterionIds = new Set<string>(), paths = new Set<string>();
  const verification = observation.verification.map(item => {
    text(item.criterionId, 'verification criterion'); text(item.evidenceDigest, 'verification digest');
    if (!['passed', 'failed', 'unknown'].includes(item.outcome) || criterionIds.has(item.criterionId)) throw new Error('Invalid or duplicate verification criterion');
    criterionIds.add(item.criterionId);
    return { criterionId: item.criterionId, outcome: item.outcome, evidenceDigest: item.evidenceDigest };
  }).sort((a, b) => a.criterionId.localeCompare(b.criterionId));
  const artifacts = observation.artifacts.map(item => {
    text(item.path, 'artifact path'); text(item.digest, 'artifact digest');
    if (paths.has(item.path)) throw new Error('Duplicate artifact path'); paths.add(item.path);
    return { path: item.path, digest: item.digest };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify({ failures, passed, verification, artifacts })).digest('hex');
}
export interface NoProgressState { fingerprint: string | null; consecutiveSame: number; rounds: number }
export interface NoProgressPolicy { diagnoseAfter: number; blockAfter: number }
export interface NoProgressDecision { state: NoProgressState; changed: boolean; diagnosisDue: boolean; exhausted: boolean }
export function createNoProgressState(): NoProgressState { return { fingerprint: null, consecutiveSame: 0, rounds: 0 }; }
export function updateNoProgress(previous: NoProgressState, observation: ProgressObservation, policy: NoProgressPolicy = { diagnoseAfter: 2, blockAfter: 4 }): NoProgressDecision {
  integer(previous.consecutiveSame, 'unchanged count'); integer(previous.rounds, 'round count');
  if ((previous.fingerprint === null) !== (previous.rounds === 0) || previous.consecutiveSame > previous.rounds || (previous.rounds > 0 && previous.consecutiveSame === 0)) throw new Error('Invalid no-progress state');
  if (previous.fingerprint !== null && !/^[a-f0-9]{64}$/.test(previous.fingerprint)) throw new Error('Invalid progress fingerprint');
  integer(policy.diagnoseAfter, 'diagnosis threshold', 2); integer(policy.blockAfter, 'no-progress limit', policy.diagnoseAfter + 1);
  const fingerprint = progressFingerprint(observation), changed = fingerprint !== previous.fingerprint;
  const state = { fingerprint, consecutiveSame: changed ? 1 : previous.consecutiveSame + 1, rounds: previous.rounds + 1 };
  integer(state.rounds, 'round count');
  return { state, changed, diagnosisDue: state.consecutiveSame >= policy.diagnoseAfter && state.consecutiveSame < policy.blockAfter, exhausted: state.consecutiveSame >= policy.blockAfter };
}

export interface LoopCompletionEvidence {
  requiredCriteria: { id: string; status: 'passed' | 'failed' | 'unknown'; evidenceCurrent: boolean }[];
  integrationPassed: boolean;
  usabilityPassed: boolean;
  sideEffectsResolved: boolean;
  writersEndedOrIsolated: boolean;
}
export interface LoopDecisionInput {
  cancelled: boolean;
  paused: boolean;
  completion: LoopCompletionEvidence;
  budget: { used: number; limit: number; attempts: number; maxAttempts: number; elapsedMs: number; maxElapsedMs: number; stopMode: 'strict' | 'soft' };
  noProgressExhausted: boolean;
  diagnosisDue: boolean;
  missingInputs: string[];
  runnableWork: boolean;
  inFlightWork: boolean;
  retryOrExternalEventPending: boolean;
  repairableGap: boolean;
}
export interface LoopDecision {
  action: 'complete' | 'continue' | 'diagnose' | 'blocked' | 'stop' | 'pause' | 'wait';
  reason: string;
  stopNewDispatch: boolean;
  terminateInFlight: boolean;
}
export function decideLoop(input: LoopDecisionInput): LoopDecision {
  for (const key of ['cancelled', 'paused', 'noProgressExhausted', 'diagnosisDue', 'runnableWork', 'inFlightWork', 'retryOrExternalEventPending', 'repairableGap'] as const) bool(input[key], key);
  const completion = input.completion;
  if (!Array.isArray(completion.requiredCriteria) || completion.requiredCriteria.length === 0) throw new Error('Required criteria must be nonempty');
  const seen = new Set<string>();
  for (const criterion of completion.requiredCriteria) {
    text(criterion.id, 'criterion id'); bool(criterion.evidenceCurrent, 'current evidence');
    if (seen.has(criterion.id) || !['passed', 'failed', 'unknown'].includes(criterion.status)) throw new Error('Invalid or duplicate completion criterion');
    seen.add(criterion.id);
  }
  for (const key of ['integrationPassed', 'usabilityPassed', 'sideEffectsResolved', 'writersEndedOrIsolated'] as const) bool(completion[key], key);
  const budget = input.budget;
  for (const key of ['used', 'attempts', 'elapsedMs'] as const) integer(budget[key], key);
  for (const key of ['limit', 'maxAttempts', 'maxElapsedMs'] as const) integer(budget[key], key, 1);
  if (!['strict', 'soft'].includes(budget.stopMode)) throw new Error('Invalid budget stop mode');
  const missing = strings(input.missingInputs, 'missing input');
  const result = (action: LoopDecision['action'], reason: string, terminateInFlight = false): LoopDecision => ({ action, reason, stopNewDispatch: !['continue', 'diagnose'].includes(action), terminateInFlight });
  if (input.cancelled) return result('stop', 'user-cancelled', true);
  if (input.paused) return result('pause', 'user-paused');
  const complete = completion.requiredCriteria.every(item => item.status === 'passed' && item.evidenceCurrent)
    && completion.integrationPassed && completion.usabilityPassed && completion.sideEffectsResolved && completion.writersEndedOrIsolated;
  if (complete) return result('complete', 'current-independent-evidence-complete');
  if (budget.used >= budget.limit || budget.attempts >= budget.maxAttempts || budget.elapsedMs >= budget.maxElapsedMs) {
    const reason = budget.used >= budget.limit ? 'shared-budget-limit' : budget.attempts >= budget.maxAttempts ? 'attempt-limit' : 'elapsed-time-limit';
    return result('stop', reason, budget.stopMode === 'strict');
  }
  if (input.inFlightWork) return result('wait', 'managed-work-in-flight');
  if (input.runnableWork && input.repairableGap && !input.noProgressExhausted) return result(input.diagnosisDue ? 'diagnose' : 'continue', input.diagnosisDue ? 'repeated-failure-needs-strategy' : 'repairable-gap');
  if (input.retryOrExternalEventPending) return result('wait', 'bounded-retry-or-external-event-pending');
  if (input.noProgressExhausted) return result('blocked', 'bounded-no-progress-limit');
  if (missing.length) return result('blocked', 'required-input-unavailable');
  return result('blocked', input.repairableGap ? 'no-legal-runnable-work' : 'unrepairable-required-gap');
}
