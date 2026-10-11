import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexReasonerAdapter, prepareReasonerTurn, ReasonerError, type ReasonerInput } from '../../packages/orchestration/reasoner.js';
import { parseReasonerOutput, validateReasonerSchema, ReasonerSchemaError } from '../../packages/orchestration/reasoner-schema.js';
import { createReasonerEventState, finalizeReasonerUsage, reduceReasonerEvent } from '../../packages/orchestration/reasoner-events.js';
import { normalizeNotification, type JsonObject, type NormalizedEvent } from '../../packages/executor-codex/index.js';

const proposalSchema = {
  type: 'object', additionalProperties: false, required: ['action', 'questions', 'contractVersion'],
  properties: {
    action: { type: 'string', enum: ['clarify', 'propose'] },
    questions: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 8, uniqueItems: true },
    contractVersion: { type: ['integer', 'null'], minimum: 1 },
  },
};
const proposal = { action: 'clarify', questions: ['Which platform must be delivered?'], contractVersion: null };
const event = (method: string, params: JsonObject): NormalizedEvent => normalizeNotification({ method, params }, 1);
const tokens = (totalTokens: number): NormalizedEvent => event('thread/tokenUsage/updated', { threadId: 'thread', tokenUsage: { total: { inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens }, last: { inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens } } });

test('p5.reasoner.unit.structured-proposal-parses-and-schema-is-detached', () => {
  const validated = validateReasonerSchema(proposalSchema);
  assert.deepEqual(validated, proposalSchema);
  assert.deepEqual(parseReasonerOutput(JSON.stringify(proposal), validated), proposal);
  (validated.properties as Record<string, unknown>).questions = false;
  assert.deepEqual(parseReasonerOutput(JSON.stringify(proposal), proposalSchema), proposal);
  assert.throws(() => parseReasonerOutput(JSON.stringify(proposal), validated), /prohibited/);
});

test('p5.reasoner.unit.final-json-rejects-extra-fields-missing-constraints-and-prose', () => {
  for (const value of [{ ...proposal, succeeded: true }, { action: 'clarify', questions: [] }, { ...proposal, action: 'complete' }, { ...proposal, contractVersion: 0 }, { ...proposal, contractVersion: 1.5 }, { ...proposal, questions: [''] }]) assert.throws(() => parseReasonerOutput(JSON.stringify(value), proposalSchema), ReasonerSchemaError);
  for (const text of ['', '```json\n{}\n```', 'Here is the proposal: {}', '{incomplete']) assert.throws(() => parseReasonerOutput(text, proposalSchema), ReasonerSchemaError);
});

test('p5.reasoner.unit.schema-rejects-unsupported-and-malformed-constraints-before-inference', () => {
  for (const schema of [
    { type: 'object', $ref: '#/$defs/plan' }, { type: 'string', pattern: '.*' }, { type: 'arbitrary' },
    { type: 'integer', minimum: NaN }, { type: 'array', minItems: -1 }, { type: 'string', minLength: 3, maxLength: 1 },
    { type: 'object', required: ['absent'] }, { type: 'object', required: ['name', 'name'], properties: { name: { type: 'string' } } },
    { anyOf: [] }, { type: 'array', uniqueItems: 'true' }, { enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] },
  ]) assert.throws(() => validateReasonerSchema(schema as Record<string, unknown>), ReasonerSchemaError);
});

test('p5.reasoner.unit.nested-schema-unions-numeric-bounds-and-canonical-uniqueness', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['items', 'label', 'kind'], properties: {
    items: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'object', additionalProperties: { type: 'integer', minimum: 0, exclusiveMaximum: 5 } } },
    label: { type: 'string', minLength: 1, maxLength: 1 },
    kind: { oneOf: [{ const: 'ready' }, { const: 'clarify' }] },
  } };
  assert.deepEqual(parseReasonerOutput('{"items":[{"a":1,"b":2}],"label":"😀","kind":"ready"}', schema), { items: [{ a: 1, b: 2 }], label: '😀', kind: 'ready' });
  for (const text of ['{"items":[{"a":5}],"label":"a","kind":"ready"}', '{"items":[{"a":1,"b":2},{"b":2,"a":1}],"label":"a","kind":"ready"}', '{"items":[],"label":"a","kind":"ready"}', '{"items":[{}],"label":"ab","kind":"ready"}', '{"items":[{}],"label":"a","kind":"complete"}']) assert.throws(() => parseReasonerOutput(text, schema), ReasonerSchemaError);
  assert.equal(parseReasonerOutput('2', { allOf: [{ type: 'integer', minimum: 1 }, { type: 'number', maximum: 3 }] }), 2);
  assert.throws(() => parseReasonerOutput('2', { oneOf: [{ type: 'integer' }, { type: 'number' }] }), /branch count/);
  assert.equal(parseReasonerOutput('null', { anyOf: [{ type: 'null' }, { type: 'string' }] }), null);
});

test('p5.reasoner.unit.untrusted-schema-and-output-reject-accessors-prototypes-and-unsafe-keys', () => {
  let reads = 0;
  const accessor = { ...proposalSchema };
  Object.defineProperty(accessor, 'description', { enumerable: true, get() { reads++; return 'unsafe'; } });
  assert.throws(() => validateReasonerSchema(accessor), /accessors/); assert.equal(reads, 0);
  assert.throws(() => validateReasonerSchema(Object.assign(Object.create({ inherited: true }) as object, proposalSchema) as Record<string, unknown>), /plain object/);
  for (const text of ['{"__proto__":{"succeeded":true}}', '{"constructor":"unsafe"}', '{"prototype":"unsafe"}']) assert.throws(() => parseReasonerOutput(text, { type: 'object', additionalProperties: true }), /unsafe object key/);
  const sparse = { type: 'string', enum: new Array(1) };
  assert.throws(() => validateReasonerSchema(sparse), /sparse/);
  const cyclic: Record<string, unknown> = { type: 'object' }; cyclic.properties = { itself: cyclic };
  assert.throws(() => validateReasonerSchema(cyclic), /cyclic/);
});

test('p5.reasoner.unit.context-and-output-capacity-is-bounded-without-truncation', () => {
  assert.throws(() => validateReasonerSchema({ type: 'string', description: 'x'.repeat(256 * 1024) }), /byte limit/);
  assert.throws(() => parseReasonerOutput(JSON.stringify('x'.repeat(1024 * 1024)), { type: 'string' }), /oversized/);
  let nested = '0'; for (let i = 0; i < 70; i++) nested = `[${nested}]`;
  assert.throws(() => parseReasonerOutput(nested, { type: 'array', items: true }), /complexity/);
});

test('p5.reasoner.unit.event-identities-are-isolated-and-cannot-cross-threads-or-turns', () => {
  const state = createReasonerEventState();
  reduceReasonerEvent(state, event('turn/started', { threadId: 'thread', turn: { id: 'turn', status: 'inProgress', items: [] } }));
  for (const params of [{ threadId: 'other-thread', turnId: 'turn', delta: '{}' }, { threadId: 'thread', turnId: 'other-turn', delta: '{}' }]) assert.throws(() => reduceReasonerEvent(state, event('item/agentMessage/delta', params)), /another/);
  assert.equal(state.threadId, 'thread'); assert.equal(state.turnId, 'turn'); assert.equal(state.usage, null);
});

test('p5.reasoner.unit.usage-preserves-unknown-zero-and-monotonic-cumulative-tokens', () => {
  const state = createReasonerEventState(); assert.equal(state.usage, null);
  assert.equal(reduceReasonerEvent(state, tokens(0)).usageChanged, true); assert.equal(state.usage, 0);
  assert.equal(reduceReasonerEvent(state, tokens(20)).usageChanged, true);
  assert.equal(reduceReasonerEvent(state, tokens(20)).usageChanged, false);
  assert.throws(() => reduceReasonerEvent(state, tokens(19)), /regressed/); assert.equal(state.usage, 20);
});

test('p5.reasoner.unit.partial-usage-remains-observed-until-authoritative-terminal-accounting', () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const state = createReasonerEventState();
    assert.equal(finalizeReasonerUsage(state), null);
    reduceReasonerEvent(state, tokens(20));
    assert.equal(state.usage, 20); assert.equal(finalizeReasonerUsage(state), null);
    assert.throws(() => reduceReasonerEvent(state, { sequence: 2, method: 'transport/closed', kind: 'disconnected', raw: {} }), /before authoritative/);
    assert.equal(state.usage, 20); assert.equal(finalizeReasonerUsage(state), null);
    reduceReasonerEvent(state, event('turn/completed', { threadId: 'thread', turn: { id: 'turn', status, items: [] } }));
    assert.equal(finalizeReasonerUsage(state), 20);
  }
  const zero = createReasonerEventState();
  reduceReasonerEvent(zero, tokens(0));
  assert.equal(finalizeReasonerUsage(zero), null);
  reduceReasonerEvent(zero, event('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } }));
  assert.equal(finalizeReasonerUsage(zero), 0);
});

test('p5.reasoner.unit.durable-turn-intent-precedes-send-and-cancellation-remains-conservative', async () => {
  const result = { modelStarted: false };
  let release!: () => void;
  const durable = new Promise<void>(resolve => { release = resolve; });
  let cancelled = false; let eligibleCalls = 0;
  const preparing = prepareReasonerTurn({ onTurnIntent: () => durable }, result, () => { eligibleCalls++; if (cancelled) throw new Error('cancelled before send'); });
  assert.equal(result.modelStarted, false); assert.equal(eligibleCalls, 1);
  cancelled = true; release();
  await assert.rejects(preparing, /cancelled before send/);
  assert.equal(result.modelStarted, true); assert.equal(eligibleCalls, 2);
  const neverStarted = { modelStarted: false }; let intents = 0;
  await assert.rejects(prepareReasonerTurn({ onTurnIntent: () => { intents++; } }, neverStarted, () => { throw new Error('already ineligible'); }), /already ineligible/);
  assert.equal(intents, 0); assert.equal(neverStarted.modelStarted, false);
  const eligibleResult = { modelStarted: false };
  await prepareReasonerTurn({ onTurnIntent: async () => { assert.equal(eligibleResult.modelStarted, false); } }, eligibleResult, () => {});
  assert.equal(eligibleResult.modelStarted, true);
});

test('p5.reasoner.unit.reasoning-role-rejects-tools-approvals-input-and-unknown-actions', () => {
  for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'collabAgentSpawn', 'futureTool']) for (const method of ['item/started', 'item/completed']) {
    const state = createReasonerEventState();
    assert.throws(() => reduceReasonerEvent(state, event(method, { threadId: 'thread', item: { type } })), /prohibited or unknown action/);
    assert.equal(state.threadId, null);
  }
  const request = normalizeNotification({ id: 'request', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn' } }, 1);
  assert.throws(() => reduceReasonerEvent(createReasonerEventState(), request), /cannot request/);
  assert.throws(() => reduceReasonerEvent(createReasonerEventState(), event('thread/status/changed', { threadId: 'thread', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } })), /cannot request/);
});

test('p5.reasoner.unit.only-authoritative-terminal-event-completes-and-deltas-are-not-final-output', () => {
  const state = createReasonerEventState();
  assert.equal(reduceReasonerEvent(state, event('item/agentMessage/delta', { threadId: 'thread', delta: '{"action":' })).finished, false);
  assert.equal(reduceReasonerEvent(state, event('thread/status/changed', { threadId: 'thread', status: { type: 'idle' } })).finished, false);
  assert.equal(reduceReasonerEvent(state, event('error', { threadId: 'thread', willRetry: true, error: { message: 'retrying' } })).finished, false);
  assert.equal(state.completedMessages.length, 0); assert.equal(state.usage, null);
  assert.throws(() => reduceReasonerEvent(state, { sequence: 2, method: 'transport/closed', kind: 'disconnected', raw: {} }), /before authoritative/);
  reduceReasonerEvent(state, event('item/completed', { threadId: 'thread', item: { type: 'agentMessage', text: JSON.stringify(proposal) } }));
  assert.equal(state.completedMessages.at(-1), JSON.stringify(proposal));
  assert.equal(reduceReasonerEvent(state, event('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } })).finished, true);
  assert.equal(state.terminalStatus, 'completed'); assert.equal(state.usage, null);
  assert.throws(() => reduceReasonerEvent(state, event('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'failed', items: [] } })), /conflicts/);
  const future = createReasonerEventState();
  assert.equal(reduceReasonerEvent(future, event('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'futureStatus', items: [] } })).finished, false);
});

test('p5.reasoner.unit.invalid-or-cancelled-request-never-starts-model-and-preserves-unknown-usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'supervisor-reasoner-guard-'));
  let intents = 0;
  try {
    const controller = new AbortController(); controller.abort();
    const request: ReasonerInput = { id: 'preflight', cwd: directory, logDir: join(directory, 'invalid'), prompt: 'Propose only', outputSchema: proposalSchema, model: 'must-not-start', effort: 'low', timeoutMs: 1000, onIntent: () => { intents++; } };
    const adapter = new CodexReasonerAdapter();
    for (const [label, update] of [['invalid', { outputSchema: { type: 'object', $ref: '#/unimplemented' } }], ['cancelled', { signal: controller.signal }], ['oversized', { prompt: 'x'.repeat(2 * 1024 * 1024 + 1) }], ['expired-author-deadline', { absoluteDeadlineMs: Date.now() - 1 }], ['invalid-author-deadline', { absoluteDeadlineMs: Number.NaN }]] as const) {
      const logDir = join(directory, label); await mkdir(logDir);
      await assert.rejects(adapter.request({ ...request, ...update, logDir }), error => error instanceof ReasonerError && error.result.modelStarted === false && error.result.usage === null && error.result.stopConfirmed === true && error.result.value === null);
    }
    assert.equal(intents, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
