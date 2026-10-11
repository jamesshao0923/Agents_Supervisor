import {isMaterialReaderSession, type MaterialReaderSession} from './material-reader-session.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { PROTOCOL_SCHEMA_DIGEST, PROTOCOL_SCHEMA_FILES, PROTOCOL_VERSION } from './baseline.js';

export { PROTOCOL_SCHEMA_DIGEST, PROTOCOL_SCHEMA_FILES, PROTOCOL_VERSION } from './baseline.js';
export type JsonObject = Record<string, unknown>;
export type RequestId = string | number;
export interface LineTransport {
  /** The adapter writes complete JSON lines, including the trailing newline. */
  write(line: string): void;
  onLine(callback: (line: string) => void): () => void;
  onClose(callback: (reason?: unknown) => void): () => void;
}
export interface RawEvent { sequence: number; receivedAt: string; line: string; message: unknown }
export interface TokenBreakdown extends JsonObject {
  inputTokens: number; cachedInputTokens: number; outputTokens: number;
  reasoningOutputTokens: number; totalTokens: number;
}
export interface NormalizedEvent {
  sequence: number; method: string;
  kind: 'thread-status' | 'turn-status' | 'waiting' | 'error' | 'token-usage' | 'diff' | 'message' | 'item' | 'unknown' | 'server-request' | 'protocol-error' | 'disconnected';
  raw: JsonObject;
  threadId?: string; turnId?: string; status?: string; terminal?: boolean;
  waitingOnApproval?: boolean; waitingOnUserInput?: boolean; willRetry?: boolean;
  tokenUsage?: { total: TokenBreakdown; last: TokenBreakdown; modelContextWindow?: number | null };
  diff?: string; text?: string; requestId?: RequestId;
}
export interface ServerRequest { id: RequestId; method: string; params: JsonObject; raw: JsonObject }
export interface AdapterOptions {
  transport: LineTransport;
  /** Must durably preserve the raw line. Reduction starts only after this resolves. */
  onRawEvent(event: RawEvent): void | Promise<void>;
  onEvent(event: NormalizedEvent): void | Promise<void>;
  /** Return a result to reply immediately; undefined explicitly defers to respond(). */
  onServerRequest?(request: ServerRequest): unknown | Promise<unknown>;
  requestTimeoutMs?: number;
  /** Host-bound integrity reader only; ordinary adapters remain non-experimental. */
  materialReader?: MaterialReaderSession;
}
export interface ModelCapability extends JsonObject {
  id: string; model: string; inputModalities: string[]; isDefault: boolean;
}
export interface ModelList extends JsonObject { data: ModelCapability[]; nextCursor?: string | null }
export interface ThreadRecord extends JsonObject { id: string; turns: JsonObject[] }
export interface ThreadResult extends JsonObject { thread: ThreadRecord }
export interface TurnRecord extends JsonObject { id: string; status: string; items: unknown[] }
export interface TurnResult extends JsonObject { turn: TurnRecord }
export type UserInput = { type: 'text'; text: string; text_elements?: unknown[] } | { type: 'localImage'; path: string; detail?: 'auto' | 'original' | 'high' | 'low' | null };
export interface ThreadOptions {
  cwd: string; model?: string; modelProvider?: string; approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  config?: JsonObject; ephemeral?: boolean; developerInstructions?: string;
}
export interface TurnOptions { model?: string; effort?: string; cwd?: string; outputSchema?: unknown; serviceTier?: string }

export class ProtocolError extends Error { override name = 'ProtocolError'; }
export class RpcError extends Error {
  override name = 'RpcError';
  constructor(readonly method: string, readonly requestId: RequestId, readonly rpcError: JsonObject) {
    super(typeof rpcError.message === 'string' ? rpcError.message : `RPC ${method} failed`);
  }
}
export class UnknownOutcomeError extends Error {
  override name = 'UnknownOutcomeError';
  constructor(readonly method: string, readonly requestId: RequestId, readonly reason: 'timeout' | 'disconnected' | 'transport-write' | 'protocol' | 'disposed') {
    super(`${method} request ${requestId} has unknown outcome (${reason}); do not resend without reconciliation`);
  }
}
function object(value: unknown, label = 'object'): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProtocolError(`Expected ${label}`);
  return value as JsonObject;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ProtocolError(`Expected ${label}`);
  return value;
}
function requestId(value: unknown): value is RequestId { return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function calculateProtocolSchemaDigest(schemas: JsonObject): string {
  for (const file of PROTOCOL_SCHEMA_FILES) object(schemas[file], `schema ${file}`);
  const selected = Object.fromEntries(PROTOCOL_SCHEMA_FILES.map(file => [file, schemas[file]]));
  return createHash('sha256').update(canonical(selected)).digest('hex');
}
/** Conservative compatibility gate: changed vendor schemas require an explicit baseline review. */
export function checkProtocolCompatibility(version: string, schemaDigest: string): { version: string; schemaDigest: string } {
  const parsed = /^(?:codex-cli\s+)?(\d+\.\d+\.\d+)$/.exec(version.trim())?.[1];
  if (parsed !== PROTOCOL_VERSION) throw new ProtocolError(`Unsupported Codex version ${version}; expected ${PROTOCOL_VERSION}`);
  if (schemaDigest !== PROTOCOL_SCHEMA_DIGEST) throw new ProtocolError('Codex app-server schema differs from reviewed baseline');
  return { version: parsed, schemaDigest };
}
/** Read only: callers generate schemas through their managed command runner before connecting. */
export async function inspectProtocol(version: string, schemaDirectory: string): Promise<{ version: string; schemaDigest: string }> {
  const schemas: JsonObject = {};
  for (const file of PROTOCOL_SCHEMA_FILES) schemas[file] = JSON.parse(await readFile(join(schemaDirectory, file), 'utf8')) as unknown;
  return checkProtocolCompatibility(version, calculateProtocolSchemaDigest(schemas));
}
function tokens(value: unknown): TokenBreakdown {
  const data = object(value, 'token breakdown');
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']) {
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0) throw new ProtocolError(`Invalid token count ${key}`);
  }
  // Cached input is a subset of input; never add it to input or infer billed cost.
  return data as TokenBreakdown;
}
/** Pure protocol reduction. Inputs here are unit scenarios, never vendor-live evidence. */
export function normalizeNotification(message: JsonObject, sequence: number): NormalizedEvent {
  const method = string(message.method, 'method');
  const params = object(message.params ?? {}, 'notification params');
  const event: NormalizedEvent = { sequence, method, kind: 'unknown', raw: message };
  if (typeof params.threadId === 'string') event.threadId = params.threadId;
  if (typeof params.turnId === 'string') event.turnId = params.turnId;
  if (requestId(message.id)) {
    event.requestId = message.id;
    event.kind = 'server-request';
    event.waitingOnApproval = /requestApproval|Approval$/.test(method);
    event.waitingOnUserInput = /requestUserInput|elicitation\/request/.test(method);
    if (event.waitingOnApproval || event.waitingOnUserInput) event.kind = 'waiting';
    return event;
  }
  if (method === 'thread/status/changed') {
    const status = object(params.status, 'thread status');
    const type = string(status.type, 'thread status type');
    event.kind = 'thread-status';
    event.status = ['notLoaded', 'idle', 'systemError', 'active'].includes(type) ? type : 'unknown';
    if (type === 'active') {
      if (!Array.isArray(status.activeFlags) || status.activeFlags.some(flag => typeof flag !== 'string')) throw new ProtocolError('Invalid thread active flags');
      event.waitingOnApproval = status.activeFlags.includes('waitingOnApproval');
      event.waitingOnUserInput = status.activeFlags.includes('waitingOnUserInput');
      if (event.waitingOnApproval || event.waitingOnUserInput) event.kind = 'waiting';
    }
  } else if (method === 'turn/started' || method === 'turn/completed') {
    const turn = object(params.turn, 'turn');
    event.turnId = string(turn.id, 'turn id');
    const status = string(turn.status, 'turn status');
    event.kind = 'turn-status';
    event.status = ['inProgress', 'completed', 'interrupted', 'failed'].includes(status) ? status : 'unknown';
    event.terminal = ['completed', 'interrupted', 'failed'].includes(status);
  } else if (method === 'error') {
    object(params.error, 'turn error');
    if (typeof params.willRetry !== 'boolean') throw new ProtocolError('Error notification missing willRetry');
    event.kind = 'error'; event.willRetry = params.willRetry; event.terminal = false;
    // willRetry:false is diagnostic, not a substitute for authoritative turn/completed.
  } else if (method === 'thread/tokenUsage/updated') {
    const usage = object(params.tokenUsage, 'token usage');
    event.kind = 'token-usage';
    event.tokenUsage = { total: tokens(usage.total), last: tokens(usage.last) };
    if (usage.modelContextWindow !== undefined) {
      if (usage.modelContextWindow !== null && (!Number.isSafeInteger(usage.modelContextWindow) || (usage.modelContextWindow as number) < 0)) throw new ProtocolError('Invalid context window');
      event.tokenUsage.modelContextWindow = usage.modelContextWindow as number | null;
    }
  } else if (method === 'turn/diff/updated') {
    if (typeof params.diff !== 'string') throw new ProtocolError('Invalid turn diff');
    event.kind = 'diff'; event.diff = params.diff;
  } else if (method === 'item/agentMessage/delta') {
    if (typeof params.delta !== 'string') throw new ProtocolError('Invalid message delta');
    event.kind = 'message'; event.text = params.delta;
  } else if (method === 'item/started' || method === 'item/completed') {
    const item = object(params.item, 'item'); event.kind = 'item';
    if (item.type === 'agentMessage' && typeof item.text === 'string') { event.kind = 'message'; event.text = item.text; }
  }
  return event;
}

interface Pending { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
export class CodexAdapter {
  private nextId = 0;
  private sequence = 0;
  private readonly pending = new Map<RequestId, Pending>();
  private readonly serverRequests = new Map<RequestId, ServerRequest>();
  private queue: Promise<void> = Promise.resolve();
  private connected = true;
  private initialized = false;
  private initializing = false;
  private readonly unsubscribe: (() => void)[];
  private readonly timeoutMs: number;
  private readonly readerHandlers = new Set<Promise<void>>();
  private readonly materialReader: MaterialReaderSession | undefined;
  constructor(private readonly options: AdapterOptions) {
    this.materialReader = options.materialReader;
    if (this.materialReader && !isMaterialReaderSession(this.materialReader)) throw new ProtocolError('Actual host reader session required');
    if (this.materialReader && options.onServerRequest) throw new ProtocolError('Reader cannot combine arbitrary server callbacks');
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) throw new ProtocolError('Invalid request timeout');
    this.unsubscribe = [options.transport.onLine(line => {
      this.queue = this.queue.then(() => this.receive(line)).catch(error => this.failProtocol(error));
    }), options.transport.onClose(reason => {
      this.disconnect('disconnected');
      this.queue = this.queue.then(async () => { await this.options.onEvent({ sequence: ++this.sequence, method: 'transport/closed', kind: 'disconnected', raw: { reason: String(reason ?? 'closed') } }); }).catch(() => {});
    })];
  }
  private send(value: JsonObject): void {
    if (!this.connected) throw new ProtocolError('Codex transport is disconnected');
    this.options.transport.write(`${JSON.stringify(value)}\n`);
  }
  private request(method: string, params: JsonObject): Promise<unknown> {
    if (!this.connected) return Promise.reject(new ProtocolError('Codex transport is disconnected'));
    if (method !== 'initialize' && !this.initialized) return Promise.reject(new ProtocolError('Initialize handshake is required'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new UnknownOutcomeError(method, id, 'timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new UnknownOutcomeError(method, id, 'transport-write')); }
    });
  }
  async initialize(): Promise<JsonObject> {
    if (this.initialized || this.initializing) throw new ProtocolError('Initialize can be called only once per connection');
    this.initializing = true;
    const result = object(await this.request('initialize', { clientInfo: { name: 'agents_supervisor', title: 'Agents Supervisor', version: '0.0.0' }, capabilities: { experimentalApi: !!this.materialReader } }), 'initialize result');
    for (const key of ['userAgent', 'codexHome', 'platformFamily', 'platformOs']) string(result[key], `initialize ${key}`);
    this.send({ method: 'initialized' });
    this.initialized = true;
    return result;
  }
  async listModels(cursor?: string): Promise<ModelList> {
    const result = object(await this.request('model/list', cursor === undefined ? {} : { cursor }), 'model list');
    if (!Array.isArray(result.data)) throw new ProtocolError('Model list missing data');
    const data = result.data.map(value => {
      const model = object(value, 'model'); string(model.id, 'model id'); string(model.model, 'model name');
      if (typeof model.isDefault !== 'boolean') throw new ProtocolError('Invalid model default');
      // A missing advertised field is unknown, never an assertion of image capability.
      const modalities = model.inputModalities ?? [];
      if (!Array.isArray(modalities) || modalities.some(modality => typeof modality !== 'string')) throw new ProtocolError('Invalid model modalities');
      return { ...model, inputModalities: modalities } as ModelCapability;
    });
    if (result.nextCursor !== undefined && result.nextCursor !== null && typeof result.nextCursor !== 'string') throw new ProtocolError('Invalid model cursor');
    return { ...result, data } as ModelList;
  }
  async startThread(options: ThreadOptions): Promise<ThreadResult> {
    if (!isAbsolute(options.cwd)) throw new ProtocolError('Thread cwd must be absolute');
    if (this.materialReader && Object.hasOwn(options, 'dynamicTools')) throw new ProtocolError('Tool registration belongs to host reader');
    const reader = this.materialReader;
    if (reader && (options.sandbox !== 'read-only' || options.approvalPolicy !== 'never')) {
      throw new ProtocolError('Indexed material tools require read-only/never');
    }
    reader?.beginThread();
    const result = this.threadResult(await this.request('thread/start', { ...options,
      ...(reader ? {dynamicTools: reader.tools(), config: {...options.config,
        'features.apps': false, 'features.plugins': false, 'features.multi_agent': false, web_search: 'disabled'}} : {}),
    }));
    reader?.acknowledgeThread(result.thread.id);
    return result;
  }
  async readThread(threadId: string, includeTurns = true): Promise<ThreadResult> {
    return this.threadResult(await this.request('thread/read', { threadId: string(threadId, 'thread id'), includeTurns }));
  }
  async resumeThread(threadId: string, options: Partial<ThreadOptions> = {}): Promise<ThreadResult> {
    if (this.materialReader) throw new ProtocolError('Indexed reader sessions cannot resume an old model');
    if (options.cwd !== undefined && !isAbsolute(options.cwd)) throw new ProtocolError('Thread cwd must be absolute');
    return this.threadResult(await this.request('thread/resume', { ...options, threadId: string(threadId, 'thread id') }));
  }
  private threadResult(value: unknown): ThreadResult {
    const result = object(value, 'thread response'); const thread = object(result.thread, 'thread');
    string(thread.id, 'thread id');
    if (!Array.isArray(thread.turns)) throw new ProtocolError('Thread missing turns');
    return result as ThreadResult;
  }
  async startTurn(threadId: string, input: UserInput[], options: TurnOptions = {}): Promise<TurnResult> {
    if (!Array.isArray(input) || input.length === 0) throw new ProtocolError('Turn requires input');
    for (const part of input) {
      if (part.type === 'text') string(part.text, 'input text');
      else if (part.type === 'localImage') { if (!isAbsolute(string(part.path, 'image path'))) throw new ProtocolError('Image path must be absolute'); }
      else throw new ProtocolError('Unsupported input type');
    }
    this.materialReader?.beginTurn(threadId);
    const result = object(await this.request('turn/start', { ...options, threadId: string(threadId, 'thread id'), input }), 'turn response');
    const turn = object(result.turn, 'turn'); string(turn.id, 'turn id'); string(turn.status, 'turn status');
    if (!Array.isArray(turn.items)) throw new ProtocolError('Turn missing items');
    if (this.materialReader) await this.materialReader.acknowledgeTurn(threadId, turn.id as string);
    return result as TurnResult;
  }
  async interruptTurn(threadId: string, turnId: string): Promise<JsonObject> {
    // Acknowledgement means accepted request, not proof that the turn/process stopped.
    return object(await this.request('turn/interrupt', { threadId: string(threadId, 'thread id'), turnId: string(turnId, 'turn id') }), 'interrupt response');
  }
  respond(id: RequestId, result: unknown): void {
    if (!this.serverRequests.has(id)) throw new ProtocolError('Unknown or already answered server request');
    this.materialReader?.assertPreparedResponse(id, result);
    this.send({ id, result }); this.serverRequests.delete(id);
  }
  rejectServerRequest(id: RequestId, message = 'Supervisor does not support this request'): void {
    if (this.materialReader) throw new ProtocolError('Scoped reader replies require their exact durable response lifecycle');
    if (!this.serverRequests.has(id)) throw new ProtocolError('Unknown or already answered server request');
    this.send({ id, error: { code: -32601, message } }); this.serverRequests.delete(id);
  }
  /** Wait for received lines already queued; does not wait for future server activity. */
  async drain(): Promise<void> {
    await this.queue;
    if (this.materialReader) {
      await Promise.allSettled([...this.readerHandlers]);
      await this.queue;
      await this.materialReader.drain();
    }
  }
  dispose(): void {
    if (this.materialReader) void this.materialReader.cancel('Adapter disposed').catch(() => {});
    this.disconnect('disposed'); for (const unsubscribe of this.unsubscribe) unsubscribe(); }
  private disconnect(reason: 'disconnected' | 'protocol' | 'disposed'): void {
    this.connected = false;
    for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new UnknownOutcomeError(entry.method, id, reason)); }
    this.pending.clear(); this.serverRequests.clear();
  }
  private async failProtocol(error: unknown): Promise<void> {
    this.disconnect('protocol');
    try { await this.options.onEvent({ sequence: ++this.sequence, method: 'protocol/error', kind: 'protocol-error', raw: { message: error instanceof Error ? error.message : String(error) } }); } catch { /* Already fail-closed. */ }
  }
  private async receive(line: string): Promise<void> {
    let message: unknown;
    try { message = JSON.parse(line) as unknown; } catch { message = null; }
    const sequence = ++this.sequence;
    await this.options.onRawEvent({ sequence, receivedAt: new Date().toISOString(), line, message });
    if (!this.connected) return; // Preserve late input, but never revive a failed connection.
    if (message === null) throw new ProtocolError('Invalid JSON line from Codex');
    const data = object(message, 'RPC message');
    if (typeof data.method === 'string') {
      const event = normalizeNotification(data, sequence);
      if (this.materialReader) await this.materialReader.observe(event);
      await this.options.onEvent(event);
      if (requestId(data.id)) {
        const request: ServerRequest = { id: data.id, method: data.method, params: object(data.params ?? {}), raw: data };
        if (this.serverRequests.has(data.id)) throw new ProtocolError('Duplicate active server request id');
        this.serverRequests.set(data.id, request);
        if (this.materialReader) {
          const work = this.materialReader.handle(request, (id, response) => this.respond(id, response));
          this.readerHandlers.add(work);
          void work.catch(error => this.failProtocol(error)).finally(() => this.readerHandlers.delete(work));
        } else if (this.options.onServerRequest === undefined) this.rejectServerRequest(data.id);
        else {
          // A deferred approval must not block inbound turn status or interrupt replies.
          const result = this.options.onServerRequest(request);
          if (result instanceof Promise) {
            void result.then(answer => {
              if (answer !== undefined && this.connected && this.serverRequests.has(request.id)) this.respond(request.id, answer);
            }).catch(error => this.failProtocol(error));
          } else if (result !== undefined && this.serverRequests.has(data.id)) this.respond(data.id, result);
        }
      }
      return;
    }
    if (!requestId(data.id) || (('result' in data) === ('error' in data))) throw new ProtocolError('Invalid RPC response envelope');
    const pending = this.pending.get(data.id);
    if (pending === undefined) return; // Timed out / duplicate replies remain raw evidence and cannot revive requests.
    const rpcError = 'error' in data ? object(data.error, 'RPC error') : undefined;
    clearTimeout(pending.timer); this.pending.delete(data.id);
    if (rpcError !== undefined) pending.reject(new RpcError(pending.method, data.id, rpcError));
    else pending.resolve(data.result);
  }
}
