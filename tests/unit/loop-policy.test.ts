import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMonitorState, decideMonitoring, completeInspection, routeModel, progressFingerprint,
  createNoProgressState, updateNoProgress, decideLoop, HEALTH_INTERVAL_MS, INSPECTION_INTERVAL_MS,
  type ModelCapability, type ModelRouteInput, type ProgressObservation, type LoopDecisionInput,
} from '../../packages/orchestration/loop-policy.js';

const capabilities: ModelCapability[] = [
  { id: 'quick', available: true, qualityRank: 1, supportedEfforts: ['low', 'medium'], inputCapacityTokens: 10_000 },
  { id: 'strong', available: true, qualityRank: 3, supportedEfforts: ['medium', 'high', 'xhigh'], inputCapacityTokens: 30_000 },
  { id: 'unavailable', available: false, qualityRank: 9, supportedEfforts: ['high', 'ultra'], inputCapacityTokens: 90_000 },
];
function route(override: Partial<ModelRouteInput> = {}): ModelRouteInput {
  return { capabilities, complexity: 'simple', purpose: 'inspection', safeBoundary: true, budgetAllowed: true, ...override };
}
function observation(override: Partial<ProgressObservation> = {}): ProgressObservation {
  return { failureFingerprints: ['compiler:TS2322'], passedRequiredCriteria: ['login'],
    verification: [{ criterionId: 'price', outcome: 'failed', evidenceDigest: 'fixed-candidate-evidence' }],
    artifacts: [{ path: 'src/price.ts', digest: 'candidate-a' }], ...override };
}
function loop(override: Partial<LoopDecisionInput> = {}): LoopDecisionInput {
  return { cancelled: false, paused: false,
    completion: { requiredCriteria: [{ id: 'price', status: 'failed', evidenceCurrent: true }], integrationPassed: true,
      usabilityPassed: true, sideEffectsResolved: true, writersEndedOrIsolated: true },
    budget: { used: 10, limit: 100, attempts: 1, maxAttempts: 5, elapsedMs: 100, maxElapsedMs: 10_000, stopMode: 'strict' },
    noProgressExhausted: false, diagnosisDue: false, missingInputs: [], runnableWork: true, inFlightWork: false,
    retryOrExternalEventPending: false, repairableGap: true, ...override };
}

test('P6-POL-U01 health scans use real supplied times at default15s and configured10s without catch-up bursts', () => {
  const initial = createMonitorState(1_000);
  assert.equal(HEALTH_INTERVAL_MS, 15_000); assert.equal(INSPECTION_INTERVAL_MS, 300_000);
  assert.equal(decideMonitoring(initial, { nowMs: 15_999, lifecycle: 'active', evidenceCursor: '' }).healthScan, false);
  const atDefault = decideMonitoring(initial, { nowMs: 16_000, lifecycle: 'active', evidenceCursor: '' });
  assert.equal(atDefault.healthScan, true); assert.equal(atDefault.state.lastHealthAtMs, 16_000);
  const afterDelay = decideMonitoring(atDefault.state, { nowMs: 90_000, lifecycle: 'active', evidenceCursor: '' });
  assert.equal(afterDelay.healthScan, true); assert.equal(afterDelay.state.lastHealthAtMs, 90_000);
  assert.equal(decideMonitoring(afterDelay.state, { nowMs: 90_001, lifecycle: 'active', evidenceCursor: '' }).healthScan, false);
  assert.equal(decideMonitoring(initial, { nowMs: 11_000, lifecycle: 'active', evidenceCursor: '', healthIntervalMs: 10_000 }).healthScan, true);
  assert.equal(initial.lastHealthAtMs, 1_000, 'decisions cannot mutate the persisted source');
  // The legacy 15-second policy still explains the original two-gate miss.
  let old=createMonitorState(0);const legacy=[];
  for(const nowMs of [15003,30002,45004]){const next=decideMonitoring(old,{nowMs,lifecycle:'active',evidenceCursor:''});legacy.push(next.healthScan);old=next.state;}
  assert.deepEqual(legacy,[true,false,true]);
  let current=createMonitorState(0);const observed=[];
  for(let nowMs=2000;nowMs<=60000;nowMs+=2000){const next=decideMonitoring(current,{nowMs,lifecycle:'active',evidenceCursor:'',healthIntervalMs:10000});if(next.healthScan)observed.push(next.state.lastHealthAtMs);current=next.state;}
  assert.deepEqual(observed,[10000,20000,30000,40000,50000,60000]);
  let jittered=createMonitorState(0);for(const nowMs of [15003,30002,45004]){const next=decideMonitoring(jittered,{nowMs,lifecycle:'active',evidenceCursor:'',healthIntervalMs:10000});assert.equal(next.healthScan,true);jittered=next.state;}

});

test('P6-POL-U02 changed evidence waits for its five-minute window and unchanged evidence skips the next window', () => {
  const initial = createMonitorState(0, 'baseline');
  assert.equal(decideMonitoring(initial, { nowMs: 299_999, lifecycle: 'active', evidenceCursor: 'changed' }).inspection, 'wait');
  const first = decideMonitoring(initial, { nowMs: 300_000, lifecycle: 'active', evidenceCursor: 'changed' });
  assert.equal(first.inspection, 'inspect'); assert.equal(first.intent?.window, 1);
  const settled = completeInspection(first.state, first.intent!.id, true);
  assert.equal(settled.lastCheckedEvidenceCursor, 'changed');
  assert.equal(decideMonitoring(settled, { nowMs: 300_001, lifecycle: 'active', evidenceCursor: 'new-change' }).inspection, 'wait');
  const skipped = decideMonitoring(settled, { nowMs: 600_000, lifecycle: 'active', evidenceCursor: 'changed' });
  assert.equal(skipped.inspection, 'skip'); assert.equal(skipped.intent, null);
  const third = decideMonitoring(skipped.state, { nowMs: 900_000, lifecycle: 'active', evidenceCursor: 'changed-again' });
  assert.equal(third.inspection, 'inspect'); assert.equal(third.intent?.window, 3);
});

test('P6-POL-U03 due anomaly and related signals inspect unchanged evidence while ordinary empty windows skip', () => {
  const initial = createMonitorState(0, 'same');
  assert.equal(decideMonitoring(initial, { nowMs: 300_000, lifecycle: 'active', evidenceCursor: 'same' }).inspection, 'skip');
  const anomaly = decideMonitoring(initial, { nowMs: 300_000, lifecycle: 'active', evidenceCursor: 'same', anomalyDue: true });
  assert.equal(anomaly.inspection, 'inspect'); assert.equal(anomaly.intent?.anomalyDue, true);
  const signal = decideMonitoring(initial, { nowMs: 10, lifecycle: 'active', evidenceCursor: 'same', signals: ['scope-diff', 'scope-diff'] });
  const due = decideMonitoring(signal.state, { nowMs: 300_000, lifecycle: 'active', evidenceCursor: 'same' });
  assert.deepEqual(due.intent?.signals, ['scope-diff']);
});

test('P6-POL-U04 long inspection coalesces multiple windows and pending changes with zero overlapping dispatch', () => {
  const first = decideMonitoring(createMonitorState(0), { nowMs: 300_000, lifecycle: 'active', evidenceCursor: 'a', signals: ['initial'] });
  const merged = decideMonitoring(first.state, { nowMs: 600_000, lifecycle: 'active', evidenceCursor: 'b', signals: ['scope', 'scope'] });
  assert.equal(merged.inspection, 'merged'); assert.equal(merged.intent, null); assert.equal(merged.state.inFlight?.id, first.intent?.id);
  const later = decideMonitoring(merged.state, { nowMs: 1_500_000, lifecycle: 'active', evidenceCursor: 'c', signals: ['artifact'] });
  assert.equal(later.inspection, 'merged'); assert.equal(later.missedWindows, 2); assert.equal(later.state.deferredWindow, 5);
  const repeated = decideMonitoring(later.state, { nowMs: 1_500_001, lifecycle: 'active', evidenceCursor: 'c' });
  assert.equal(repeated.inspection, 'wait');
  const settled = completeInspection(repeated.state, first.intent!.id, true);
  const next = decideMonitoring(settled, { nowMs: 1_500_002, lifecycle: 'active', evidenceCursor: 'c' });
  assert.equal(next.inspection, 'inspect'); assert.equal(next.intent?.window, 5); assert.equal(next.intent?.evidenceCursor, 'c');
  assert.deepEqual(next.intent?.signals, ['artifact', 'scope']);
  const final = completeInspection(next.state, next.intent!.id, true);
  assert.equal(decideMonitoring(final, { nowMs: 1_500_003, lifecycle: 'active', evidenceCursor: 'c' }).inspection, 'wait');
});

test('P6-POL-U05 sleep recovery merges missed windows into one inspection rather than replaying timers', () => {
  const resumed = decideMonitoring(createMonitorState(0), { nowMs: 1_800_000, lifecycle: 'active', evidenceCursor: 'after-sleep' });
  assert.equal(resumed.inspection, 'inspect'); assert.equal(resumed.intent?.window, 6); assert.equal(resumed.missedWindows, 5);
  const settled = completeInspection(resumed.state, resumed.intent!.id, true);
  assert.equal(decideMonitoring(settled, { nowMs: 1_800_001, lifecycle: 'active', evidenceCursor: 'after-sleep' }).inspection, 'wait');
});

test('P6-POL-U06 paused and terminal runs make no health or model calls and resuming coalesces overdue windows', () => {
  const initial = createMonitorState(0, 'a');
  for (const lifecycle of ['paused', 'terminal'] as const) {
    const disabled = decideMonitoring(initial, { nowMs: 900_000, lifecycle, evidenceCursor: 'a', signals: ['scope-diff'], anomalyDue: true });
    assert.equal(disabled.healthScan, false); assert.equal(disabled.inspection, 'disabled'); assert.equal(disabled.intent, null);
    assert.equal(disabled.state.lastHandledWindow, 0); assert.equal(disabled.state.lastHealthAtMs, 0);
    assert.deepEqual(disabled.state.pendingSignals, ['scope-diff']); assert.equal(disabled.state.pendingAnomaly, true);
    const resumed = decideMonitoring(disabled.state, { nowMs: 900_001, lifecycle: 'active', evidenceCursor: 'a' });
    assert.equal(resumed.intent?.window, 3); assert.equal(resumed.missedWindows, 2);
    assert.deepEqual(resumed.intent?.signals, ['scope-diff']); assert.equal(resumed.intent?.anomalyDue, true);
  }
});

test('P6-POL-U07 failed inspection retains evidence and retries next window while stale completion is rejected', () => {
  const first = decideMonitoring(createMonitorState(0, 'a'), { nowMs: 300_000, lifecycle: 'active', evidenceCursor: 'b' });
  assert.throws(() => completeInspection(first.state, 'other-intent', true), /durable intent/);
  const failed = completeInspection(first.state, first.intent!.id, false);
  assert.equal(failed.lastCheckedEvidenceCursor, 'a'); assert.deepEqual(failed.pendingSignals, ['inspection-failed']);
  assert.equal(decideMonitoring(failed, { nowMs: 300_001, lifecycle: 'active', evidenceCursor: 'b' }).inspection, 'wait');
  const retry = decideMonitoring(failed, { nowMs: 600_000, lifecycle: 'active', evidenceCursor: 'b' });
  assert.equal(retry.inspection, 'inspect'); assert.notEqual(retry.intent?.id, first.intent?.id);
  assert.throws(() => completeInspection(failed, first.intent!.id, true), /durable intent/);
});

test('P6-POL-U08 monitor rejects invalid intervals backward time and corrupted durable chronology', () => {
  const initial = createMonitorState(20);
  for (const healthIntervalMs of [9_999, 15_001, NaN, 10_000.5]) assert.throws(() => decideMonitoring(initial, { nowMs: 30, lifecycle: 'active', evidenceCursor: '', healthIntervalMs }));
  assert.throws(() => decideMonitoring(initial, { nowMs: 19, lifecycle: 'active', evidenceCursor: '' }), /backwards/);
  assert.throws(() => decideMonitoring({ ...initial, lastHandledWindow: 1 }, { nowMs: 30, lifecycle: 'active', evidenceCursor: '' }), /window/);
  assert.throws(() => decideMonitoring(initial, { nowMs: 30, lifecycle: 'active', evidenceCursor: '', signals: [''] }), /signal/);
  assert.throws(() => createMonitorState(Number.MAX_SAFE_INTEGER + 1));
});

test('P6-POL-U09 simple inspections select fastest sufficient model and complex tasks directly select strong available capability', () => {
  const simple = routeModel(route()); assert.equal(simple.action, 'select'); assert.deepEqual(simple.selection, { model: 'quick', effort: 'low' });
  const complex = routeModel(route({ complexity: 'complex' }));
  assert.equal(complex.action, 'select'); assert.deepEqual(complex.selection, { model: 'strong', effort: 'high' });
  assert.equal(complex.considered.find(item => item.model === 'unavailable')?.reason, 'not-available');
  const minimum = routeModel(route({ minimumQualityRank: 2 })); assert.equal(minimum.selection?.model, 'strong');
});

test('P6-POL-U10 one evidenced capability failure upgrades once and missing upgrade path stays blocked', () => {
  const upgraded = routeModel(route({ current: { model: 'quick', effort: 'low' }, capabilityGapEvidence: ['independent verifier: cross-module assumptions unsupported'] }));
  assert.equal(upgraded.reason, 'evidenced-capability-gap'); assert.equal(upgraded.selection?.model, 'strong');
  const blocked = routeModel(route({ current: { model: 'strong', effort: 'high' }, capabilityGapEvidence: ['same deficiency'] }));
  assert.equal(blocked.action, 'blocked'); assert.equal(blocked.selection, null); assert.equal(blocked.reason, 'no-available-quality-upgrade');
  assert.equal(routeModel(route({ capabilityGapEvidence: ['deficiency'] })).reason, 'upgrade-baseline-unavailable');
});

test('P6-POL-U11 route chooses supported depth without degrading requested effort or upgrading exploration', () => {
  const depth = routeModel(route({ requiredEffort: 'xhigh' })); assert.deepEqual(depth.selection, { model: 'strong', effort: 'xhigh' });
  const unavailableDepth = routeModel(route({ requiredEffort: 'ultra' })); assert.equal(unavailableDepth.action, 'blocked');
  const nextSupported = routeModel(route({ capabilities: [{ id: 'only', available: true, qualityRank: 1, supportedEfforts: ['medium', 'xhigh'] }], requiredEffort: 'high' }));
  assert.equal(nextSupported.selection?.effort, 'xhigh');
  assert.throws(() => routeModel(route({ capabilities: [{ ...capabilities[0]!, supportedEfforts: ['low', 'low'] }] })), /efforts/);
  assert.throws(() => routeModel(route({ capabilities: [capabilities[0]!, capabilities[0]!] })), /Duplicate/);
});

test('P6-POL-U12 context pressure requires mitigation before any model upgrade and unknown capacity stays explicit', () => {
  const pressure = routeModel(route({ current: { model: 'quick', effort: 'low' }, context: { requiredTokens: 15_000, mitigated: false } }));
  assert.equal(pressure.action, 'context-action'); assert.equal(pressure.selection, null);
  const mitigated = routeModel(route({ current: { model: 'quick', effort: 'low' }, context: { requiredTokens: 15_000, mitigated: true } }));
  assert.equal(mitigated.selection?.model, 'strong');
  const tooLarge = routeModel(route({ context: { requiredTokens: 100_000, mitigated: true } })); assert.equal(tooLarge.action, 'blocked');
  const unknown = routeModel(route({ capabilities: [{ id: 'unknown', available: true, qualityRank: 5, supportedEfforts: ['high'] }], context: { requiredTokens: 10, mitigated: true } }));
  assert.equal(unknown.action, 'blocked'); assert.equal(unknown.considered[0]?.reason, 'context-capacity-unknown');
});

test('P6-POL-U13 routing defers model and effort changes until safe boundary and respects shared budget', () => {
  const upgrade = routeModel(route({ safeBoundary: false, current: { model: 'quick', effort: 'low' }, complexity: 'complex' })); assert.equal(upgrade.action, 'defer');
  const depth = routeModel(route({ safeBoundary: false, current: { model: 'strong', effort: 'medium' }, requiredEffort: 'high' })); assert.equal(depth.action, 'defer');
  assert.equal(routeModel(route({ safeBoundary: false, current: { model: 'quick', effort: 'low' } })).action, 'select');
  assert.equal(routeModel(route({ budgetAllowed: false })).action, 'stop');
  assert.equal(routeModel(route({ budgetAllowed: false })).selection, null);
});

test('P6-POL-U14 progress fingerprint is order invariant and tracks failures criteria verification and actual artifacts', () => {
  const original = observation({ failureFingerprints: ['z', 'a'], passedRequiredCriteria: ['b', 'a'], artifacts: [{ path: 'a', digest: '1' }, { path: 'b', digest: '2' }] });
  const same = observation({ ...original, failureFingerprints: ['a', 'z', 'a'], passedRequiredCriteria: ['a', 'b'], artifacts: [...original.artifacts].reverse() });
  assert.equal(progressFingerprint(original), progressFingerprint(same));
  for (const changed of [observation({ failureFingerprints: ['different'] }), observation({ passedRequiredCriteria: [] }), observation({ verification: [{ criterionId: 'price', outcome: 'passed', evidenceDigest: 'new' }] }), observation({ artifacts: [{ path: 'src/price.ts', digest: 'repaired' }] })]) assert.notEqual(progressFingerprint(observation()), progressFingerprint(changed));
  assert.throws(() => progressFingerprint(observation({ artifacts: [{ path: 'x', digest: 'a' }, { path: 'x', digest: 'b' }] })), /Duplicate/);
});

test('P6-POL-U15 repeated observable failure triggers diagnosis then bounded blockage and real evidence change resets only streak', () => {
  let state = createNoProgressState();
  const first = updateNoProgress(state, observation()); state = first.state;
  assert.equal(first.diagnosisDue, false); assert.equal(first.state.consecutiveSame, 1);
  const second = updateNoProgress(state, observation()); state = second.state;
  assert.equal(second.diagnosisDue, true); assert.equal(second.changed, false);
  state = updateNoProgress(state, observation()).state;
  const fourth = updateNoProgress(state, observation()); assert.equal(fourth.exhausted, true); assert.equal(fourth.diagnosisDue, false);
  const repaired = updateNoProgress(fourth.state, observation({ artifacts: [{ path: 'src/price.ts', digest: 'repaired' }] }));
  assert.equal(repaired.state.rounds, 5); assert.equal(repaired.state.consecutiveSame, 1); assert.equal(repaired.exhausted, false);
  assert.throws(() => updateNoProgress(createNoProgressState(), observation(), { diagnoseAfter: 2, blockAfter: 2 }), /limit/);
});

test('P6-POL-U16 serialized policy states preserve inspection coalescing and no-progress history across session replacement', () => {
  const first = decideMonitoring(createMonitorState(0), { nowMs: 300_000, lifecycle: 'active', evidenceCursor: 'a' });
  const restored = JSON.parse(JSON.stringify(first.state));
  assert.equal(decideMonitoring(restored, { nowMs: 600_000, lifecycle: 'active', evidenceCursor: 'b' }).inspection, 'merged');
  const state = updateNoProgress(updateNoProgress(createNoProgressState(), observation()).state, observation()).state;
  const resumed = updateNoProgress(JSON.parse(JSON.stringify(state)), observation());
  assert.equal(resumed.state.consecutiveSame, 3); assert.equal(resumed.state.rounds, 3); assert.equal(resumed.diagnosisDue, true);
});

test('P6-POL-U17 executor success cannot complete failed unknown stale or missing independent completion evidence', () => {
  const complete = loop(); complete.completion.requiredCriteria[0]!.status = 'passed';
  assert.equal(decideLoop(complete).action, 'complete');
  for (const status of ['failed', 'unknown'] as const) {
    const incomplete = structuredClone(complete); incomplete.completion.requiredCriteria[0]!.status = status;
    assert.notEqual(decideLoop(incomplete).action, 'complete');
  }
  const stale = structuredClone(complete); stale.completion.requiredCriteria[0]!.evidenceCurrent = false;
  assert.notEqual(decideLoop(stale).action, 'complete');
  for (const key of ['integrationPassed', 'usabilityPassed', 'sideEffectsResolved', 'writersEndedOrIsolated'] as const) {
    const incomplete = structuredClone(complete); incomplete.completion[key] = false;
    assert.notEqual(decideLoop(incomplete).action, 'complete');
  }
  assert.throws(() => decideLoop({ ...complete, completion: { ...complete.completion, requiredCriteria: [] } }), /nonempty/);
});

test('P6-POL-U18 verified completion survives exhausted limits but user cancellation and pause prevent late success', () => {
  const complete = loop(); complete.completion.requiredCriteria[0]!.status = 'passed'; complete.budget.used = complete.budget.limit;
  assert.equal(decideLoop(complete).action, 'complete');
  assert.deepEqual(decideLoop({ ...complete, cancelled: true }), { action: 'stop', reason: 'user-cancelled', stopNewDispatch: true, terminateInFlight: true });
  assert.equal(decideLoop({ ...complete, paused: true }).action, 'pause');
});

test('P6-POL-U19 budget attempt and elapsed limits stop new dispatch and strict mode terminates in-flight work', () => {
  for (const [field, value, reason] of [['used', 100, 'shared-budget-limit'], ['attempts', 5, 'attempt-limit'], ['elapsedMs', 10_000, 'elapsed-time-limit']] as const) {
    const input = loop({ inFlightWork: true }); input.budget[field] = value;
    const decision = decideLoop(input); assert.equal(decision.action, 'stop'); assert.equal(decision.reason, reason);
    assert.equal(decision.stopNewDispatch, true); assert.equal(decision.terminateInFlight, true);
    input.budget.stopMode = 'soft'; assert.equal(decideLoop(input).terminateInFlight, false);
  }
});

test('P6-POL-U20 loop continues repair diagnoses repeated failures waits in-flight and never completes an empty runnable queue', () => {
  assert.equal(decideLoop(loop()).action, 'continue');
  assert.equal(decideLoop(loop({ diagnosisDue: true })).action, 'diagnose');
  assert.equal(decideLoop(loop({ inFlightWork: true, noProgressExhausted: true })).action, 'wait');
  assert.equal(decideLoop(loop({ runnableWork: false, retryOrExternalEventPending: true })).action, 'wait');
  assert.equal(decideLoop(loop({ runnableWork: false, missingInputs: ['required secret'] })).reason, 'required-input-unavailable');
  assert.equal(decideLoop(loop({ noProgressExhausted: true })).reason, 'bounded-no-progress-limit');
  assert.equal(decideLoop(loop({ runnableWork: false })).reason, 'no-legal-runnable-work');
  assert.equal(decideLoop(loop({ repairableGap: false })).reason, 'unrepairable-required-gap');
});

test('P6-POL-U21 policy input rejects unsafe budgets contradictory streaks and duplicate acceptance identities', () => {
  const input = loop(); input.budget.limit = NaN;
  assert.throws(() => decideLoop(input), /limit/);
  const duplicate = loop(); duplicate.completion.requiredCriteria.push(duplicate.completion.requiredCriteria[0]!);
  assert.throws(() => decideLoop(duplicate), /duplicate/);
  assert.throws(() => updateNoProgress({ fingerprint: null, rounds: 2, consecutiveSame: 2 }, observation()), /state/);
  assert.throws(() => routeModel(route({ minimumQualityRank: -1 })), /quality/);
});
