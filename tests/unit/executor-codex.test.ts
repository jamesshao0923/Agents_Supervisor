import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CodexAdapter, ProtocolError, RpcError, UnknownOutcomeError, PROTOCOL_SCHEMA_DIGEST, PROTOCOL_SCHEMA_FILES, calculateProtocolSchemaDigest, checkProtocolCompatibility, normalizeNotification, type JsonObject, type LineTransport, type NormalizedEvent, type RawEvent, type ServerRequest } from '../../packages/executor-codex/index.js';
import { renderReviewedBaseline } from '../../packages/executor-codex/generate-baseline.js';

// These inputs exercise real adapter protocol logic. They do not prove vendor-live behavior.
class ProtocolLines implements LineTransport {
  writes: JsonObject[] = [];
  private lines = new Set<(line: string) => void>();
  private closes = new Set<(reason?: unknown) => void>();
  write(line: string): void { assert.ok(line.endsWith('\n')); this.writes.push(JSON.parse(line) as JsonObject); }
  onLine(callback: (line: string) => void): () => void { this.lines.add(callback); return () => this.lines.delete(callback); }
  onClose(callback: (reason?: unknown) => void): () => void { this.closes.add(callback); return () => this.closes.delete(callback); }
  receive(message: unknown): void { for (const callback of this.lines) callback(JSON.stringify(message)); }
  receiveLine(line: string): void { for (const callback of this.lines) callback(line); }
  close(): void { for (const callback of this.closes) callback('scenario disconnect'); }
  last(): JsonObject { return this.writes.at(-1)!; }
}
function fixture(timeout = 1000, onServerRequest?: (request: ServerRequest) => unknown | Promise<unknown>) {
  const transport = new ProtocolLines(); const raw: RawEvent[] = []; const events: NormalizedEvent[] = [];
  const adapter = new CodexAdapter({ transport, onRawEvent: event => { raw.push(event); }, onEvent: event => { events.push(event); }, requestTimeoutMs: timeout, ...(onServerRequest === undefined ? {} : { onServerRequest }) });
  return { adapter, transport, raw, events };
}
async function initialize(adapter: CodexAdapter, transport: ProtocolLines) {
  const result = adapter.initialize();
  transport.receive({ id: transport.last().id, result: { userAgent: 'vendor agent string', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos', addedVendorField: { retained: true } } });
  await result;
}
const notification = (method: string, params: JsonObject) => ({ method, params });
const usage = { inputTokens: 20, cachedInputTokens: 7, outputTokens: 4, reasoningOutputTokens: 2, totalTokens: 24, cacheWriteInputTokens: 1, futureUsageField: 8 };

test('p2.executor-codex.unit.protocol-baseline-rejects-version-and-schema-drift', () => {
  assert.deepEqual(checkProtocolCompatibility('codex-cli 0.153.4\n', PROTOCOL_SCHEMA_DIGEST), { version: '0.153.4', schemaDigest: PROTOCOL_SCHEMA_DIGEST });
  for (const version of ['0.153.3', '0.153.5', '0.153.4-rc.1', '1.0.0', 'not a version']) assert.throws(() => checkProtocolCompatibility(version, PROTOCOL_SCHEMA_DIGEST), ProtocolError);
  assert.throws(() => checkProtocolCompatibility('0.153.4', 'changed'), /schema/);
  // Schema emitters may write 0.0; JS runtime parses that as 0. Baseline generation
  // must share runtime canonicalization rather than retain Python float spelling.
  const schemas = Object.fromEntries(PROTOCOL_SCHEMA_FILES.map(file => [file, JSON.parse('{"minimum":0.0}') as unknown]));
  const canonicalZero = `{${[...PROTOCOL_SCHEMA_FILES].sort().map(file => `${JSON.stringify(file)}:{"minimum":0}`).join(',')}}`;
  const expectedDigest = createHash('sha256').update(canonicalZero).digest('hex');
  assert.equal(calculateProtocolSchemaDigest(schemas), expectedDigest);
  assert.ok(renderReviewedBaseline('0.153.4', schemas).includes(`PROTOCOL_SCHEMA_DIGEST = "${expectedDigest}"`));
  assert.throws(() => calculateProtocolSchemaDigest({}), /schema/);
});

test('p2.executor-codex.unit.protocol-handshake-model-capabilities-and-request-correlation', async () => {
  const { adapter, transport, raw } = fixture();
  try {
    await assert.rejects(adapter.listModels(), /handshake/);
    await initialize(adapter, transport);
    assert.equal(transport.writes[0]?.method, 'initialize');
    assert.deepEqual(transport.writes[0]?.params, { clientInfo: { name: 'agents_supervisor', title: 'Agents Supervisor', version: '0.0.0' }, capabilities: { experimentalApi: false } });
    assert.deepEqual(transport.writes[1], { method: 'initialized' });
    await assert.rejects(adapter.initialize(), /only once/);
    const first = adapter.listModels(); const firstId = transport.last().id;
    const second = adapter.listModels('next'); const secondId = transport.last().id;
    transport.receive({ id: secondId, result: { data: [{ id: 'legacy', model: 'legacy-model', isDefault: false }], nextCursor: null } });
    transport.receive({ id: firstId, result: { data: [{ id: 'vision', model: 'vision-model', isDefault: true, inputModalities: ['text', 'image', 'future-modality'], futureField: true }], nextCursor: 'next' } });
    assert.deepEqual((await second).data[0]?.inputModalities, []);
    const models = await first;
    assert.deepEqual(models.data[0]?.inputModalities, ['text', 'image', 'future-modality']);
    assert.equal(models.data[0]?.futureField, true);
    assert.equal(models.nextCursor, 'next'); assert.equal(raw.length, 3);
  } finally { adapter.dispose(); }
});

test('p2.executor-codex.unit.protocol-fresh-thread-read-resume-text-image-and-interrupt', async () => {
  const { adapter, transport } = fixture();
  try {
    await initialize(adapter, transport);
    const start = adapter.startThread({ cwd: '/tmp/project', model: 'test-model', sandbox: 'workspace-write', approvalPolicy: 'never', config: { 'features.multi_agent': false } });
    assert.equal(transport.last().method, 'thread/start');
    assert.deepEqual(transport.last().params, { cwd: '/tmp/project', model: 'test-model', sandbox: 'workspace-write', approvalPolicy: 'never', config: { 'features.multi_agent': false } });
    transport.receive({ id: transport.last().id, result: { thread: { id: 'fresh-thread', turns: [], futureThread: 1 } } });
    assert.equal((await start).thread.futureThread, 1);
    const read = adapter.readThread('fresh-thread'); assert.deepEqual(transport.last().params, { threadId: 'fresh-thread', includeTurns: true });
    transport.receive({ id: transport.last().id, result: { thread: { id: 'fresh-thread', turns: [{ id: 'history' }] } } }); await read;
    const resume = adapter.resumeThread('fresh-thread', { cwd: '/tmp/project' }); assert.equal(transport.last().method, 'thread/resume');
    transport.receive({ id: transport.last().id, result: { thread: { id: 'fresh-thread', turns: [] } } }); await resume;
    const input = [{ type: 'text' as const, text: 'Inspect this screenshot' }, { type: 'localImage' as const, path: '/tmp/project/screen.png' }];
    const turn = adapter.startTurn('fresh-thread', input, { effort: 'low' });
    assert.deepEqual(transport.last().params, { threadId: 'fresh-thread', input, effort: 'low' });
    transport.receive({ id: transport.last().id, result: { turn: { id: 'turn', status: 'inProgress', items: [] } } }); await turn;
    const interrupt = adapter.interruptTurn('fresh-thread', 'turn');
    assert.deepEqual(transport.last().params, { threadId: 'fresh-thread', turnId: 'turn' });
    transport.receive({ id: transport.last().id, result: {} }); assert.deepEqual(await interrupt, {});
    await assert.rejects(adapter.startThread({ cwd: 'relative' }), /absolute/);
    await assert.rejects(adapter.startTurn('fresh-thread', []), /requires input/);
    await assert.rejects(adapter.startTurn('fresh-thread', [{ type: 'localImage', path: 'relative.png' }]), /absolute/);
    await assert.rejects(adapter.resumeThread('fresh-thread', { cwd: 'relative' }), /absolute/);
  } finally { adapter.dispose(); }
});

test('p2.executor-codex.unit.protocol-waiting-error-retry-and-terminal-status-classification', () => {
  const waiting = normalizeNotification(notification('thread/status/changed', { threadId: 'thread', status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput', 'futureFlag'] } }), 1);
  assert.equal(waiting.kind, 'waiting'); assert.equal(waiting.waitingOnApproval, true); assert.equal(waiting.waitingOnUserInput, true);
  for (const type of ['idle', 'notLoaded', 'systemError', 'futureState']) {
    const status = normalizeNotification(notification('thread/status/changed', { threadId: 'thread', status: { type } }), 2);
    assert.equal(status.status, type === 'futureState' ? 'unknown' : type);
  }
  for (const willRetry of [true, false]) {
    const error = normalizeNotification(notification('error', { threadId: 'thread', turnId: 'turn', willRetry, error: { message: 'error', futureError: true } }), 3);
    assert.equal(error.kind, 'error'); assert.equal(error.willRetry, willRetry); assert.equal(error.terminal, false);
  }
  for (const status of ['inProgress', 'completed', 'failed', 'interrupted', 'futureStatus']) {
    const turn = normalizeNotification(notification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status, items: [] } }), 4);
    assert.equal(turn.status, status === 'futureStatus' ? 'unknown' : status);
    assert.equal(turn.terminal, ['completed', 'failed', 'interrupted'].includes(status));
  }
  assert.throws(() => normalizeNotification(notification('error', { error: {} }), 1), /willRetry/);
  assert.throws(() => normalizeNotification(notification('thread/status/changed', { status: { type: 'active' } }), 1), /flags/);
});

test('p2.executor-codex.unit.protocol-tokens-diffs-messages-and-unknown-fields-preserved', () => {
  const raw = notification('thread/tokenUsage/updated', { threadId: 'thread', turnId: 'turn', tokenUsage: { total: usage, last: usage, modelContextWindow: 200000, newVendorField: true } });
  const event = normalizeNotification(raw, 5);
  assert.equal(event.raw, raw); assert.equal(event.tokenUsage?.total.inputTokens, 20); assert.equal(event.tokenUsage?.total.totalTokens, 24);
  assert.equal(event.tokenUsage?.total.cachedInputTokens, 7); assert.equal(event.tokenUsage?.last.reasoningOutputTokens, 2); assert.equal(event.tokenUsage?.last.futureUsageField, 8);
  const diff = '--- a/file\n+++ b/file\n+change';
  assert.equal(normalizeNotification(notification('turn/diff/updated', { threadId: 'thread', turnId: 'turn', diff }), 6).diff, diff);
  assert.equal(normalizeNotification(notification('item/agentMessage/delta', { delta: 'partial' }), 7).text, 'partial');
  assert.equal(normalizeNotification(notification('item/completed', { item: { type: 'agentMessage', text: 'whole', unknown: 1 } }), 8).text, 'whole');
  const future = notification('future/notification', { future: { nested: true } }); assert.equal(normalizeNotification(future, 9).raw, future);
  assert.equal(normalizeNotification(future, 9).kind, 'unknown');
  assert.throws(() => normalizeNotification(notification('thread/tokenUsage/updated', { tokenUsage: { last: usage, total: { ...usage, totalTokens: -1 } } }), 1), /token count/);
});

test('p2.executor-codex.unit.protocol-raw-persistence-precedes-reduction-and-retains-order', async () => {
  const transport = new ProtocolLines(); const seen: string[] = []; const events: NormalizedEvent[] = [];
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const adapter = new CodexAdapter({ transport, onRawEvent: async event => { seen.push(`raw:${event.sequence}`); if (event.sequence === 1) await blocked; }, onEvent: event => { seen.push(`event:${event.sequence}`); events.push(event); } });
  try {
    transport.receive(notification('item/agentMessage/delta', { delta: 'first' }));
    transport.receive(notification('item/agentMessage/delta', { delta: 'second' }));
    await Promise.resolve(); assert.deepEqual(seen, ['raw:1']);
    release(); await adapter.drain(); assert.deepEqual(seen, ['raw:1', 'event:1', 'raw:2', 'event:2']);
    assert.deepEqual(events.map(event => event.text), ['first', 'second']);
    // Repeated deltas can be legitimate; absence of vendor event IDs means no content-based dedup.
    transport.receive(notification('item/agentMessage/delta', { delta: 'second' })); await adapter.drain(); assert.equal(events.length, 3);
  } finally { release(); adapter.dispose(); }
  // Explicit batch opt-in: ingress is timestamped before any durable I/O wait.
  const incoming = new ProtocolLines(), batches: RawEvent[][] = [], reduced: NormalizedEvent[] = [];
  let unblock!: () => void; const gate = new Promise<void>(resolve => { unblock = resolve; });
  let flushed = 0;
  const journal = new CodexAdapter({transport: incoming, onRawEvent: () => { throw Error('legacy callback must not run'); },
    rawJournal: {persist: async values => { batches.push([...values]); await gate; }, flush: async () => { flushed++; }},
    onEvent: event => { if (event.kind !== 'disconnected') assert.ok(batches.flat().some(raw => raw.sequence === event.sequence)); reduced.push(event); }});
  try {
    const capturedBefore = Date.now();
    for (let i = 0; i < 600; i++) incoming.receive(notification('item/agentMessage/delta', {threadId:'t',turnId:'u',delta:String(i)}));
    incoming.receive(notification('turn/completed', {threadId:'t',turn:{id:'u',status:'completed',items:[]}}));
    const capturedAfter = Date.now();
    incoming.close();
    await Promise.resolve(); assert.equal(reduced.length, 0);
    unblock(); await journal.drain();
    const raw = batches.flat(); assert.equal(raw.length, 601); assert.ok(batches.every(batch => batch.length <= 256));
    assert.ok(raw.every(event => Date.parse(event.receivedAt) >= capturedBefore && Date.parse(event.receivedAt) <= capturedAfter));
    assert.deepEqual(raw.map(event => event.sequence), Array.from({length:601}, (_,i)=>i+1));
    assert.deepEqual(reduced.filter(event => event.method==='item/agentMessage/delta').map(event=>event.text),Array.from({length:600},(_,i)=>String(i)));
    assert.equal(reduced.filter(event=>event.terminal).length,1); assert.equal(reduced.at(-1)?.kind,'disconnected');
    assert.ok(flushed >= batches.length); await assert.rejects(journal.listModels(), /disconnected/);
    incoming.receive(notification('item/agentMessage/delta',{delta:'after EOF'})); await journal.drain(); assert.equal(batches.flat().length,601);
  } finally {unblock();journal.dispose();}
});

test('p2.executor-codex.unit.protocol-server-requests-explicit-response-or-unsupported-rejection', async () => {
  const unsupported = fixture();
  try {
    unsupported.transport.receive({ id: 'server1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'write' } });
    await unsupported.adapter.drain(); assert.equal(unsupported.events[0]?.waitingOnApproval, true);
    assert.deepEqual(unsupported.transport.last(), { id: 'server1', error: { code: -32601, message: 'Supervisor does not support this request' } });
  } finally { unsupported.adapter.dispose(); }
  const requests: ServerRequest[] = []; const deferred = fixture(1000, request => { requests.push(request); });
  try {
    deferred.transport.receive({ id: 99, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', questions: [] } });
    await deferred.adapter.drain(); assert.equal(deferred.events[0]?.waitingOnUserInput, true); assert.equal(deferred.transport.writes.length, 0);
    assert.equal(requests[0]?.id, 99); deferred.adapter.respond(99, { answers: {} });
    assert.deepEqual(deferred.transport.last(), { id: 99, result: { answers: {} } });
    assert.throws(() => deferred.adapter.respond(99, {}), /already answered/);
  } finally { deferred.adapter.dispose(); }
  const denied = fixture(1000, () => ({ decision: 'decline' }));
  try {
    denied.transport.receive({ id: 'approval', method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 'turn' } });
    await denied.adapter.drain(); assert.deepEqual(denied.transport.last(), { id: 'approval', result: { decision: 'decline' } });
  } finally { denied.adapter.dispose(); }
  let release!: (answer: unknown) => void;
  const answer = new Promise<unknown>(resolve => { release = resolve; });
  const asynchronous = fixture(1000, () => answer);
  try {
    await initialize(asynchronous.adapter, asynchronous.transport);
    asynchronous.transport.receive({ id: 'delayed', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn' } });
    await asynchronous.adapter.drain();
    const interrupted = asynchronous.adapter.interruptTurn('thread', 'turn');
    asynchronous.transport.receive({ id: asynchronous.transport.last().id, result: {} });
    assert.deepEqual(await interrupted, {});
    release({ decision: 'decline' }); await Promise.resolve();
    assert.deepEqual(asynchronous.transport.last(), { id: 'delayed', result: { decision: 'decline' } });
  } finally { release(undefined); asynchronous.adapter.dispose(); }
});

test('p2.executor-codex.unit.protocol-timeout-disconnect-and-late-replies-never-resend', async () => {
  const timed = fixture(15);
  try {
    await initialize(timed.adapter, timed.transport);
    const pending = timed.adapter.startThread({ cwd: '/tmp/project' }); const id = timed.transport.last().id;
    await assert.rejects(pending, error => error instanceof UnknownOutcomeError && error.method === 'thread/start' && error.reason === 'timeout');
    assert.equal(timed.transport.writes.filter(value => value.method === 'thread/start').length, 1);
    timed.transport.receive({ id, result: { thread: { id: 'late', turns: [] } } }); await timed.adapter.drain();
    assert.equal(timed.raw.at(-1)?.message && (timed.raw.at(-1)?.message as JsonObject).id, id);
  } finally { timed.adapter.dispose(); }
  const disconnected = fixture();
  try {
    await initialize(disconnected.adapter, disconnected.transport);
    const read = disconnected.adapter.readThread('thread'); const turn = disconnected.adapter.startTurn('thread', [{ type: 'text', text: 'do work' }]);
    disconnected.transport.close();
    await assert.rejects(read, error => error instanceof UnknownOutcomeError && error.reason === 'disconnected');
    await assert.rejects(turn, error => error instanceof UnknownOutcomeError && error.reason === 'disconnected');
    await disconnected.adapter.drain(); assert.equal(disconnected.events.at(-1)?.kind, 'disconnected');
    await assert.rejects(disconnected.adapter.listModels(), /disconnected/);
    assert.equal(disconnected.transport.writes.filter(value => value.method === 'turn/start').length, 1);
  } finally { disconnected.adapter.dispose(); }
});

test('p2.executor-codex.unit.protocol-rpc-errors-malformed-lines-and-persistence-failure-fail-closed', async () => {
  const rpc = fixture();
  try {
    await initialize(rpc.adapter, rpc.transport);
    const pending = rpc.adapter.listModels();
    rpc.transport.receive({ id: rpc.transport.last().id, error: { code: -32000, message: 'bad model list', extra: true } });
    await assert.rejects(pending, error => error instanceof RpcError && error.rpcError.extra === true);
    const next = rpc.adapter.readThread('thread'); rpc.transport.receiveLine('{malformed');
    await assert.rejects(next, error => error instanceof UnknownOutcomeError && error.reason === 'protocol');
    await rpc.adapter.drain(); assert.equal(rpc.raw.at(-1)?.line, '{malformed'); assert.equal(rpc.events.at(-1)?.kind, 'protocol-error');
  } finally { rpc.adapter.dispose(); }
  const transport = new ProtocolLines(); const events: NormalizedEvent[] = [];
  const adapter = new CodexAdapter({ transport, onRawEvent: () => { throw new Error('disk full'); }, onEvent: event => { events.push(event); } });
  try {
    const pending = adapter.initialize(); transport.receive({ id: transport.last().id, result: {} });
    await assert.rejects(pending, error => error instanceof UnknownOutcomeError && error.reason === 'protocol');
    await adapter.drain(); assert.equal(events.length, 1); assert.equal(events[0]?.kind, 'protocol-error');
    assert.equal(events[0]?.raw.message, 'disk full');
  } finally { adapter.dispose(); }
  for (const mode of ['journal-failure','malformed','capacity'] as const) {
    const lines = new ProtocolLines(), journalEvents:NormalizedEvent[]=[]; let persisted=0;
    const journal=new CodexAdapter({transport:lines,onRawEvent:()=>{throw Error('unexpected legacy');},
      rawJournal:{persist:async values=>{persisted+=values.length;if(mode==='journal-failure')throw Error('second raw journal sync failed');},flush:async()=>{}},
      onEvent:event=>{journalEvents.push(event);}});
    try {
      if(mode==='capacity')lines.receiveLine('x'.repeat(8*1024*1024+1));
      else if(mode==='malformed')lines.receiveLine('{invalid');
      lines.receive(notification('turn/completed',{threadId:'t',turn:{id:'u',status:'completed',items:[]}}));
      await journal.drain();assert.equal(journalEvents.some(event=>event.terminal),false);assert.ok(journalEvents.some(event=>event.kind==='protocol-error'));
      await assert.rejects(journal.listModels(),/disconnected/);if(mode==='capacity')assert.equal(persisted,0);
    }finally{journal.dispose();}
  }
});
