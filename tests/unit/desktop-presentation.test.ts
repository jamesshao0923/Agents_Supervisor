import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionEvent } from '../../packages/contracts/p2.js';
import type { RuntimeEvent, RuntimeOperation, RuntimeRecord } from '../../packages/contracts/p3.js';
import { buildTimeline, describeRuntimeEvent, describeVerificationProblem } from '../../apps/desktop/presentation.js';
import { normalizeNotification } from '../../packages/executor-codex/index.js';

const timestamp = '2026-10-10T08:00:00.000Z';
function execution(seq: number, payload: unknown, kind = 'codex-event'): ExecutionEvent {
  return { seq, executionId: 'execution', receivedAt: timestamp, kind, payload };
}

test('desktop timeline folds protocol fragments while retaining failures waiting and authoritative messages', () => {
  const codex = (seq: number, method: string, params: unknown) => execution(seq, normalizeNotification({ method, params }, seq));
  const usage = (totalTokens: number) => ({ inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens });
  const events = [
    execution(1, { line: 'raw protocol duplicate' }, 'codex-raw'),
    codex(2, 'item/agentMessage/delta', { itemId: 'answer', delta: 'part one' }),
    codex(3, 'item/agentMessage/delta', { itemId: 'answer', delta: 'part two' }),
    codex(4, 'item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final', text: 'The actual complete result' } }),
    codex(5, 'thread/tokenUsage/updated', { turnId: 'turn', tokenUsage: { total: usage(5), last: usage(5) } }),
    codex(6, 'error', { error: { message: 'retryable failure' }, willRetry: true }),
    codex(7, 'thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } }),
    codex(8, 'item/completed', { item: { type: 'commandExecution', command: 'node check.mjs', status: 'failed', exitCode: 1 } }),
    codex(9, 'thread/tokenUsage/updated', { turnId: 'turn', tokenUsage: { total: usage(9), last: usage(4) } }),
    codex(10, 'turn/completed', { turn: { id: 'turn', status: 'completed' } }),
  ];
  const original = structuredClone(events), timeline = buildTimeline([], events);
  assert.deepEqual(events, original, 'Presentation must not rewrite the underlying evidence');
  assert.deepEqual(timeline.entries.map(item => item.event.seq), [10, 9, 8, 7, 6, 4]);
  assert.equal(timeline.folded, 4);
  assert.equal(timeline.entries.find(item => item.event.seq === 4)?.description, 'The actual complete result');
  assert.equal(timeline.entries.find(item => item.event.seq === 8)?.tone, 'error');
  assert.match(timeline.entries.find(item => item.event.seq === 8)!.description, /退出码 1/);
  assert.equal(timeline.entries.find(item => item.event.seq === 6)?.tone, 'error');
  assert.match(timeline.entries.find(item => item.event.seq === 7)!.title, /等待审批/);
  assert.match(timeline.entries[0]!.description, /仍需.*独立验收/);
  const streaming = buildTimeline([], events.slice(0, 3));
  assert.equal(streaming.entries.length, 1);
  assert.match(streaming.entries[0]!.title, /正在输出/);
  assert.doesNotMatch(streaming.entries[0]!.description, /part (one|two)/, 'A fragment cannot be presented as the complete reply');
  for (const item of [{ type: 'commandExecution', command: 'node check.mjs', status: 'declined' }, { type: 'fileChange', changes: [{ path: 'index.ts' }], status: 'declined' }]) {
    const rejected = buildTimeline([], [codex(1, 'item/completed', { item })]).entries[0]!;
    assert.equal(rejected.tone, 'warning');
    assert.match(rejected.title, /被拒绝/);
    assert.doesNotMatch(rejected.title, /已记录|已结束/);
  }
});

test('desktop runtime summaries distinguish step completion failure and unknown from delivery', () => {
  const runtime: RuntimeRecord = {
    id: 'runtime', engine: 'local-v1', workflowVersion: 1, projectionVersion: 1, projectId: 'project', runId: 'run',
    workspace: '/project', workspaceKind: 'project', definition: { type: 'submit', commandId: 'submit', goal: 'Check a real result', tokenLimit: 100, verificationReserve: 20, steps: [{ id: 'ready', kind: 'input', prompt: 'Provide input' }] },
    cursor: 1, phase: 'awaiting-verification', paused: false, cancelled: false, createdAt: timestamp, updatedAt: timestamp, error: null, inputs: {}, checkpointId: null,
  };
  const operation: RuntimeOperation = { id: 'operation', runtimeId: runtime.id, stepIndex: 0, step: runtime.definition.steps[0]!, attemptId: 'attempt', contractVersion: 1, owner: null, state: 'confirmed', executionId: null, result: null, error: null };
  const event: RuntimeEvent = { seq: 1, runtimeId: runtime.id, kind: 'reported', createdAt: timestamp, payload: { operationId: operation.id, report: { outcome: 'confirmed', result: {} } } };
  const completed = describeRuntimeEvent(event, runtime, [operation]);
  assert.match(completed.description, /第 1 步/);
  assert.match(completed.description, /需要独立验收/);
  assert.doesNotMatch(completed.description, /验收通过|已交付/);
  for (const [outcome, tone] of [['failed', 'error'], ['unknown', 'warning'], ['cancelled', 'warning']] as const) {
    const result = describeRuntimeEvent({ ...event, payload: { operationId: operation.id, report: { outcome } } }, runtime, [operation]);
    assert.equal(result.tone, tone);
    assert.doesNotMatch(result.description, /推进到下一步|验收通过|已交付/);
  }
});

test('desktop invalidation guidance preserves uncertainty without exposing raw diagnostics in the overview', () => {
  const raw = 'Error: Verifier review or execution environment changed';
  const environment = describeVerificationProblem(raw);
  assert.match(environment.title, /环境.*变化/);
  assert.match(environment.description, /无法.*有效/);
  assert.match(environment.next, /重新.*验收/);
  assert.doesNotMatch(JSON.stringify(environment), /Error:|Verifier|模型变了|某个配置/);
  assert.match(describeVerificationProblem('Error: Current workspace differs from the verified candidate').title, /文件.*不一致/);
  const unknown = describeVerificationProblem('future-error-code');
  assert.match(unknown.description, /未能确认/);
  assert.doesNotMatch(unknown.title, /环境已变化|文件与已验收/);
});

test('P6-DESKTOP-HISTORY-U01 history integrity current files and unknown observation scopes remain distinct', async () => {
  const { describeDeliveryAssessment } = await import('../../apps/desktop/presentation.js');
  const { unavailableDeliveryAssessment } = await import('../../packages/verification/delivery-status.js');
  const value = unavailableDeliveryAssessment({id:'history',jobId:'job',planId:'plan',runtimeId:'runtime',projectId:'project',runId:'run',candidateDigest:'a'.repeat(64),definitionDigest:'b'.repeat(64),createdAt:timestamp,path:'/private/evidence/delivery.json'}, timestamp, {code:'history-unavailable',area:'history',message:'Explicit display fixture'});
  assert.match(describeDeliveryAssessment(value).title, /待核对/);
  value.historicalEvidenceIntact=true; value.workspaceMatches=true; value.isActiveRound=true; value.issues=[];
  const unknown=describeDeliveryAssessment(value);assert.equal(unknown.error,false);assert.equal(unknown.notes.length,3);assert.match(unknown.notes.join(' '),/环境.*标准.*时效/);
  value.environmentMatches=false;value.headMatches=true;value.sourceFreshness={state:'not-applicable',earliestExpiresAt:null,remoteChecked:false};
  assert.match(describeDeliveryAssessment(value).detail,/环境、标准或来源时效已有变化/);assert.equal(describeDeliveryAssessment(value).error,false);
  value.workspaceMatches=false;assert.match(describeDeliveryAssessment(value).title,/当前文件已有变化/);
  value.isActiveRound=false;assert.match(describeDeliveryAssessment(value).title,/上一轮/);
  value.historicalEvidenceIntact=false;assert.equal(describeDeliveryAssessment(value).error,true);assert.match(describeDeliveryAssessment(value).title,/核对未通过/);
});
