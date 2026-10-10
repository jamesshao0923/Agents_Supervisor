import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ExecutionRecord, ModelCapability } from '../../packages/contracts/p2.js';
import type { RuntimeRecord } from '../../packages/contracts/p3.js';
import type { GoalSession } from '../../packages/contracts/p5.js';
import { goalPhaseLabels, goalSessionId, mergeGoalSessions, taskViews, taskModelOptions, preferredTaskModel, goalCanAnswer, goalCanRestore } from '../../apps/desktop/presentation.js';

import { createDraftRun } from '../../packages/domain/index.js';

const createdAt = '2026-10-10T10:00:00.000Z';
function session(id: string, workspace = '/project'): GoalSession {
  return { id, projectId: 'project', workspace, workspaceKind: 'project', revision: 1, goal: 'Describe the required result', phase: 'clarifying', messages: [{ id: 'input', role: 'user', text: 'Describe the required result', createdAt }], jobs: [], proposal: null, runtimeId: null, error: null, createdAt, updatedAt: createdAt, config: { model: 'model', effort: 'high', reservation: 100, timeoutMs: 1000 }, maxContextChars: 60000 };
}
function runtime(): RuntimeRecord {
  return { id: 'runtime', engine: 'local-v1', workflowVersion: 1, projectionVersion: 1, projectId: 'project', runId: 'run', workspace: '/project', workspaceKind: 'project', definition: { type: 'submit', commandId: 'submit', goal: 'Execute the admitted plan', tokenLimit: 1000, verificationReserve: 100, steps: [{ id: 'step', kind: 'input', prompt: 'Provide input' }] }, cursor: 0, phase: 'waiting-input', paused: false, cancelled: false, createdAt, updatedAt: createdAt, error: null, inputs: {}, checkpointId: null };
}
function execution(): ExecutionRecord {
  return { id: 'legacy', commandId: 'legacy', projectId: 'project', runId: 'legacy-run', attemptId: 'legacy-attempt', workspace: '/legacy', workspaceKind: 'project', prompt: 'Existing legacy task', model: 'model', effort: 'high', images: [], state: 'completed', createdAt, updatedAt: createdAt, deadline: createdAt, timeoutMs: 1000, tokenLimit: 1000, reservation: 100, verificationReserve: 100, identity: null, pid: null, threadId: null, turnId: null, lastEventSeq: 0, message: 'Actual existing response', diff: '', error: null, usage: null, usageStatus: 'unknown', stopConfirmed: true, cancelRequested: false, artifactId: null, protocolVersion: null, schemaDigest: null };
}

test('desktop goal projection groups requirements by workspace without duplicating admitted runtime or removing legacy tasks', () => {
  const awaiting = session('goal-new'), admitted = { ...session('goal-bound'), phase: 'admitted' as const, runtimeId: 'runtime' };
  const managed = { ...session('goal-managed', '/managed'), workspaceKind: 'managed' as const, phase: 'thinking' as const };
  const original = structuredClone([awaiting, admitted, managed]);
  const view = taskViews([runtime()], [execution()], [awaiting, admitted, managed]);
  assert.deepEqual(new Set(view.map(task => task.id)), new Set(['runtime', 'legacy', 'goal-new', 'goal-managed']));
  assert.deepEqual(view.filter(task => task.workspace === '/project').map(task => task.id).sort(), ['goal-new', 'runtime']);
  assert.equal(view.find(task => task.id === 'goal-managed')!.workspaceKind, 'managed');
  assert.equal(view.find(task => task.id === 'goal-new')!.session, awaiting);
  assert.equal(view.find(task => task.id === 'legacy')!.message, 'Actual existing response');
  assert.deepEqual([awaiting, admitted, managed], original, 'Presentation must preserve durable evidence');
  const phases = Object.values(goalPhaseLabels).join(' ');
  assert.doesNotMatch(phases, /已交付|验收通过|执行完成/);
  assert.match(goalPhaseLabels.ready, /待开始执行/);
});

test('desktop goal revision merge rejects late snapshots and retains admitted runtime linkage across restore', () => {
  const initial = session('goal');
  const admitted = { ...initial, revision: 3, phase: 'admitted' as const, runtimeId: 'runtime' };
  const merged = mergeGoalSessions([admitted], [{ ...initial, revision: 2, phase: 'ready' }]);
  assert.equal(merged[0], admitted);
  const restored = { ...admitted, revision: 4, phase: 'thinking' as const };
  const restoring = mergeGoalSessions(merged, [restored]);
  assert.equal(restoring[0]!.runtimeId, 'runtime');
  assert.equal(restoring[0]!.phase, 'thinking');
  assert.equal(taskViews([runtime()], [], restoring).length, 1, 'Restore must not create another execution card');
  const independent = session('other-goal', '/other');
  assert.equal(mergeGoalSessions(restoring, [independent]).length, 2, 'Another project must not overwrite the session');
  assert.equal(initial.revision, 1);
  assert.equal(goalCanAnswer(initial), true);
  assert.equal(goalCanAnswer({ ...initial, phase: 'ready' }), true);
  assert.equal(goalCanAnswer(admitted), false);
  const run = createDraftRun({ id: 'goal', projectId: 'project', goal: 'Continue', budget: { unit: 'token', limit: 1000, verificationReserve: 100 } });
  const quiet = { ...runtime(), phase: 'awaiting-verification' as const };
  assert.equal(goalCanRestore(admitted, run, quiet), true);
  for (const status of ['succeeded', 'cancelled'] as const) assert.equal(goalCanRestore(admitted, { ...run, status }, quiet), false, 'Terminal delivery cannot expose a restore action rejected by the backend');
  assert.equal(goalCanRestore(restored, run, quiet), false);
  assert.equal(goalCanRestore(admitted, run, { ...quiet, phase: 'running' }), false);
});

test('desktop pending start identity matches durable command hashing without issuing a second request', async () => {
  const commandId = 'desktop-transport-retry';
  const expected = 'goal-' + createHash('sha256').update(commandId).digest('hex').slice(0, 24);
  assert.equal(await goalSessionId(commandId), expected);
  assert.equal(await goalSessionId(commandId), expected);
  assert.notEqual(await goalSessionId(commandId + '-new'), expected);
});

test('desktop model policy preserves requested identities and real capabilities without advertising unavailable models', () => {
  const ids = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol'];
  const available: ModelCapability[] = ['gpt-5.6-luna', ...ids.slice().reverse()].map(id => ({ id, label: 'provider label', inputModalities: ['text'], reasoningEfforts: ['low', 'high'], defaultEffort: 'high' }));
  const original = structuredClone(available), options = taskModelOptions(available);
  assert.deepEqual(options.map(item => item.id), ids);
  assert.deepEqual(options.map(item => item.label), ['6 Astra', '6.1 Sol', '6 Luna', '5.6 Sol']);
  for (const option of options) assert.equal(option.capability, available.find(item => item.id === option.id));
  assert.deepEqual(available, original);
  const partial = taskModelOptions(available.filter(item => ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna'].includes(item.id)));
  assert.equal(partial.find(item => item.id === preferredTaskModel)?.capability, null, 'Missing preferred model must require selection, not silent substitution');
  assert.equal(partial.find(item => item.id === 'gpt-6-luna')?.capability, null, '5.6 Luna is not 6 Luna');
  assert.ok(taskModelOptions([]).every(item => item.capability === null));
});
