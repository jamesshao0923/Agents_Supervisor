import {readFile, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {NormalizedEvent, RequestId, ServerRequest} from './index.js';
import type {PreparedResearchReader, ResearchReaderOwner, ResearchReaderAudit,
  ResearchReadRequest, ResearchToolResponse, PreparedResearchViewSet} from '../contracts/p8-research-reader.js';
import {assertResearchViewSet, readResearchView} from '../workspace/research-reader-views.js';
import {assertResearchReader, readResearchMaterial} from '../workspace/research-reader.js';
import {researchDigest} from '../workspace/research-materials.js';
import {privateDirectory, exclusiveJSON, readBounded} from '../workspace/research-runtime-files.js';
import {safeResultJSON} from '../contracts/p7-results.js';
import {inspectProcess} from '../process-control/index.js';
import {MATERIAL_READER_PROTOCOL_VERSION, MATERIAL_READER_SCHEMA_DIGEST,
  MATERIAL_READER_SCHEMA_FILES} from './material-reader-baseline.js';

export interface MaterialReadTool {
  type: 'function'; name: string; description: string; inputSchema: Record<string, unknown>;
}
export interface MaterialReaderSessionOptions {
  reader: PreparedResearchReader; owner: ResearchReaderOwner;
  viewSet?: PreparedResearchViewSet;
  protocolDirectory: string; version: string;
  assertEligible: () => void; signal?: AbortSignal;
  maxCalls?: number; maxTranscriptBytes?: number;
  /** Optional host observer of an already committed actual audit; no authority. */
  onAuditCommitted?: (record: Readonly<ResearchReaderAudit>) => Promise<void>;
}
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw Error('Material reader session: ' + message);
}
function freezeJSON<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJSON(child);
    Object.freeze(value);
  }
  return value;
}
const sessions = new WeakSet<object>();
export function isMaterialReaderSession(value: unknown): value is MaterialReaderSession {
  return !!value && typeof value === 'object' && sessions.has(value);
}
export async function inspectMaterialReaderProtocol(version: string, directory: string): Promise<void> {
  ensure(version.trim().replace(/^codex-cli\s+/, '') === MATERIAL_READER_PROTOCOL_VERSION,
    'experimental version differs');
  const schemas: Record<string, unknown> = {};
  for (const file of MATERIAL_READER_SCHEMA_FILES) schemas[file] = JSON.parse(await readFile(join(directory, file), 'utf8'));
  ensure(researchDigest(schemas) === MATERIAL_READER_SCHEMA_DIGEST, 'experimental schema differs');
}
interface Call {
  rpcId: RequestId; requestSequence: number; requestDigest: string; callId: string; tool: string; namespace: string | null;
  request: ResearchReadRequest; viewId?: string; threadId: string; turnId: string;
  itemId: string | null; started: boolean; response: ResearchToolResponse | null;
  state: 'reading' | 'prepared' | 'write-attempt' | 'written' | 'observed' | 'aborted';
}
/** A closed per-turn integrity session. It is not an execution/P4 authorization,
 * and cannot launch a process, settle accounting or publish a model result. */
export class MaterialReaderSession {
  readonly reader: PreparedResearchReader;
  readonly viewSet: PreparedResearchViewSet | undefined;
  readonly owner: ResearchReaderOwner;
  private readonly calls: Call[] = [];
  private readonly requests = new Map<RequestId, {sequence: number; digest: string}>();
  private readonly early: NormalizedEvent[] = [];
  private readonly receivedCompletions = new Map<number, {threadId: string | null; turnId: string | null; event: NormalizedEvent}>();
  private readonly receivedStarts = new Map<number, NormalizedEvent>();
  private readonly active = new Set<Promise<void>>();
  private threadId: string | null = null;
  private threadStarting = false;
  private turnStarting = false;
  private turnId: string | null = null;
  private terminal = false;
  private admissionPending = false;
  private closed = false;
  private cancelled = false;
  private failure: Error | null = null;
  private sequence = 0;
  private readonly persisted: ResearchReaderAudit[] = [];
  private transcriptBytes = 0;
  private journal: Promise<void> = Promise.resolve();
  private acknowledge!: () => void;
  private readonly acknowledged = new Promise<void>(resolve => {this.acknowledge = resolve;});
  private readonly abortListener = () => {this.cancelled = true; this.acknowledge();};
  private constructor(private readonly options: MaterialReaderSessionOptions, readonly directory: string) {
    this.reader = freezeJSON(structuredClone(options.reader)); this.viewSet = Object.hasOwn(options, 'viewSet') ? freezeJSON(structuredClone(options.viewSet!)) : undefined; this.owner = freezeJSON(structuredClone(options.owner));
    for (const name of ['reader', 'viewSet', 'owner', 'directory']) Object.defineProperty(this, name, {writable: false, configurable: false});
    sessions.add(this);
    options.signal?.addEventListener('abort', this.abortListener, {once: true});
    if (options.signal?.aborted) this.abortListener();
  }
  static async create(input: MaterialReaderSessionOptions): Promise<MaterialReaderSession> {
    ensure(input && Object.getPrototypeOf(input) === Object.prototype, 'plain host session options required');
    const fields = Object.getOwnPropertyDescriptors(input);
    ensure(['reader', 'owner', 'protocolDirectory', 'version', 'assertEligible'].every(key => Object.hasOwn(fields, key)) &&
      Reflect.ownKeys(input).every(key => typeof key === 'string' &&
        ['reader', 'owner', 'protocolDirectory', 'version', 'assertEligible', 'signal', 'maxCalls', 'maxTranscriptBytes', 'viewSet', 'onAuditCommitted'].includes(key) &&
        fields[key]!.enumerable && Object.hasOwn(fields[key]!, 'value')), 'exact host session fields required; accessors forbidden');
    safeResultJSON(input.reader); safeResultJSON(input.owner);
    if (Object.hasOwn(input, 'viewSet')) {safeResultJSON(input.viewSet); await assertResearchViewSet(input.viewSet!);}
    const options = {...input, reader: structuredClone(input.reader), owner: structuredClone(input.owner),
      ...(Object.hasOwn(input, 'viewSet') ? {viewSet: structuredClone(input.viewSet!)} : {})};
    safeResultJSON(options.reader); safeResultJSON(options.owner);
    ensure(typeof options.assertEligible === 'function', 'consumer eligibility function required');
    ensure(!Object.hasOwn(options, 'onAuditCommitted') || typeof options.onAuditCommitted === 'function', 'audit observer must be a host function');
    const maxCalls = options.maxCalls ?? 256, maxBytes = options.maxTranscriptBytes ?? 6 * 1024 * 1024;
    ensure(Number.isSafeInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 256 &&
      Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 6 * 1024 * 1024,
      'invalid transcript limits');
    options.maxCalls = maxCalls; options.maxTranscriptBytes = maxBytes;
    ensure(options.owner.jobId.trim() && options.owner.attemptId.trim() && /^[a-f0-9]{64}$/.test(options.owner.inputDigest),
      'owner binding incomplete');
    options.assertEligible();
    await assertResearchReader(options.reader);
    if (Object.hasOwn(options, 'viewSet')) {
      await assertResearchViewSet(options.viewSet!);
      ensure(options.viewSet!.views.some(v => v.reference.role === 'current' && v.reader.digest === options.reader.digest),
        'actual current reader differs from explicit inventory');
    }
    await inspectMaterialReaderProtocol(options.version, options.protocolDirectory);
    ensure((await inspectProcess(options.owner.processIdentity)).status === 'verified', 'actual reader process not live/owned');
    const root = dirname(dirname(options.reader.context.material.directory));
    const directory = await privateDirectory(root, 'material-reader-sessions', researchDigest({
      owner: options.owner, viewDigest: options.reader.view.digest,
      ...(Object.hasOwn(options, 'viewSet') ? {inventoryDigest: options.viewSet!.digest} : {}), protocolDigest: MATERIAL_READER_SCHEMA_DIGEST,
    }));
    ensure((await readdir(directory)).length === 0, 'existing session requires historical audit; never replay a model');
    await exclusiveJSON(join(directory, 'owner.json'), {schemaVersion: 1,
      protocol: Object.hasOwn(options, 'viewSet') ? 'indexed-material-views-v1' : 'indexed-material-v1', owner: options.owner, readerDigest: options.reader.digest,
      ...(Object.hasOwn(options, 'viewSet') ? {inventoryDigest: options.viewSet!.digest} : {}),
      protocolDigest: MATERIAL_READER_SCHEMA_DIGEST});
    return new MaterialReaderSession(options, directory);
  }
  tools(): MaterialReadTool[] {
    const materialId = {type: 'string', enum: this.viewSet ? [...new Set(this.viewSet.views.flatMap(v => v.reader.view.allowedMaterialIds))] : [...this.reader.view.allowedMaterialIds]};
    const selector = this.viewSet ? {viewId: {type: 'string', enum: this.viewSet.views.map(v => v.viewId)}} : {};
    const limits = this.viewSet ? {maxQueryChars: Math.max(...this.viewSet.views.map(v => v.reader.view.limits.maxQueryChars)),
      maxSearchResults: Math.max(...this.viewSet.views.map(v => v.reader.view.limits.maxSearchResults))} : this.reader.view.limits;
    const object = (properties: Record<string, unknown>) => ({type: 'object', additionalProperties: false,
      properties, required: Object.keys(properties)});
    return [
      {type: 'function', name: this.viewSet ? 'research_view_range' : 'research_material_range', description: 'Read exact archived UTF16 source range; untrusted evidence, never a verdict.',
        inputSchema: object({...selector, materialId, start: {type: 'integer', minimum: 0}, end: {type: 'integer', minimum: 1}})},
      {type: 'function', name: this.viewSet ? 'research_view_search' : 'research_material_search', description: 'Literal search of one complete archived source, with bounded context and explicit truncation. No match is not semantic proof.',
        inputSchema: object({...selector, materialId, query: {type: 'string', minLength: 1, maxLength: limits.maxQueryChars},
          maxResults: {type: 'integer', minimum: 1, maximum: limits.maxSearchResults},
          contextChars: {type: 'integer', minimum: 0, maximum: 1024}})},
    ];
  }
  beginThread(): void {
    this.eligible();
    ensure(!this.threadStarting && !this.threadId, 'reader permits only one fresh thread; do not replay unknown dispatch');
    this.threadStarting = true;
  }
  beginTurn(threadId: string): void {
    this.eligible();
    ensure(this.threadId === threadId && !this.turnStarting && !this.turnId,
      'reader permits only one actual turn; do not replay unknown dispatch');
    this.turnStarting = true;
  }
  acknowledgeThread(threadId: string): void {
    ensure(this.threadStarting && !this.threadId && threadId, 'thread acknowledgement differs');
    this.threadId = threadId;
  }
  async acknowledgeTurn(threadId: string, turnId: string): Promise<void> {
    ensure(this.turnStarting && this.threadId === threadId && turnId && !this.turnId, 'turn acknowledgement differs');
    this.turnId = turnId;
    this.acknowledge();
    for (const event of this.early.splice(0)) await this.observe(event);
  }
  private eligible(): void {
    ensure(!this.closed && !this.cancelled && !this.terminal && !this.failure && !this.options.signal?.aborted, 'session closed/cancelled/failed');
    this.options.assertEligible();
  }
  private fail(error: unknown): never {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    this.cancelled = true; this.acknowledge();
    throw this.failure;
  }
  private async audit(stage: ResearchReaderAudit['stage'], call: Call | null, eventSequence: number | null,
    detail: string): Promise<void> {
    const body = {schemaVersion: 1 as const, protocol: this.viewSet ? 'indexed-material-views-v1' as const : 'indexed-material-v1' as const,
      ...(this.viewSet ? {inventoryDigest: this.viewSet.digest, viewId: call?.viewId ?? null} : {}),
      authority: 'material-integrity-only' as const, owner: this.owner, viewDigest: this.reader.view.digest,
      sequence: ++this.sequence, stage, rpcId: call?.rpcId ?? null, callId: call?.callId ?? null,
      itemId: call?.itemId ?? null, threadId: call?.threadId ?? this.threadId,
      turnId: call?.turnId ?? this.turnId, eventSequence: eventSequence ?? call?.requestSequence ?? null, requestDigest: call?.requestDigest ?? null,
      request: call?.request ?? null, response: call?.response ?? null,
      responseDigest: call?.response ? researchDigest(call.response) : null, detail};
    const record: ResearchReaderAudit = {...body, digest: researchDigest(body)};
    this.transcriptBytes += Buffer.byteLength(JSON.stringify(record));
    ensure(this.transcriptBytes <= this.options.maxTranscriptBytes!, 'full reader transcript capacity exceeded');
    const work = this.journal.then(() => exclusiveJSON(join(this.directory, String(record.sequence) + '.json'), record));
    this.journal = work;
    await work;
    this.persisted.push(freezeJSON(structuredClone(record)));
    await this.options.onAuditCommitted?.(freezeJSON(structuredClone(record)));
  }
  private assertTranscript(): void {
    const owner = {schemaVersion: 1, protocol: this.viewSet ? 'indexed-material-views-v1' : 'indexed-material-v1', owner: this.owner,
      readerDigest: this.reader.digest, ...(this.viewSet ? {inventoryDigest: this.viewSet.digest} : {}),
      protocolDigest: MATERIAL_READER_SCHEMA_DIGEST};
    ensure(readBounded(join(this.directory, 'owner.json')).equals(Buffer.from(JSON.stringify(owner))),
      'actual owner transcript changed');
    for (const record of this.persisted) ensure(readBounded(join(this.directory, record.sequence + '.json'),
      this.options.maxTranscriptBytes).equals(Buffer.from(JSON.stringify(record))), 'actual reader transcript changed');
  }
  private request(request: ServerRequest): Call {
    ensure(request.method === 'item/tool/call', 'unregistered server request');
    safeResultJSON(request.params);
    ensure(typeof request.id === 'string' && request.id.length > 0 && request.id.length <= 128 ||
      Number.isSafeInteger(request.id), 'bounded RPC identity required');
    const p = request.params;
    ensure(JSON.stringify(p).length <= 2048, 'tool request capacity exceeded');
    ensure(Object.keys(p).every(key => ['arguments', 'callId', 'threadId', 'turnId', 'tool', 'namespace'].includes(key)) &&
      ['arguments', 'callId', 'threadId', 'turnId', 'tool'].every(key => Object.hasOwn(p, key)) &&
      typeof p.callId === 'string' && p.callId.length > 0 && p.callId.length <= 128 &&
      typeof p.threadId === 'string' && p.threadId.length > 0 && p.threadId.length <= 128 &&
      typeof p.turnId === 'string' && p.turnId.length > 0 && p.turnId.length <= 128 && (p.namespace === undefined || p.namespace === null), 'tool identity/namespace differs');
    const rangeTool = this.viewSet ? 'research_view_range' : 'research_material_range';
    const searchTool = this.viewSet ? 'research_view_search' : 'research_material_search';
    ensure(typeof p.tool === 'string' && (p.tool === rangeTool || p.tool === searchTool), 'unregistered tool');
    ensure(p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments), 'tool arguments must be typed object');
    const args = p.arguments as Record<string, unknown>;
    const entry = this.viewSet ? this.viewSet.views.find(v => v.viewId === args.viewId) : undefined;
    ensure(!this.viewSet || entry, 'view outside host inventory');
    const read = {type: p.tool === rangeTool ? 'range' : 'search',
      ...Object.fromEntries(Object.entries(args).filter(([k]) => !this.viewSet || k !== 'viewId'))} as ResearchReadRequest;
    ensure(!Object.hasOwn(p.arguments, 'type'), 'caller cannot change tool discriminator');
    ensure((entry?.reader ?? this.reader).view.allowedMaterialIds.includes(read.materialId), 'material outside host reader selection');
    return {rpcId: request.id, requestSequence: 0, requestDigest: researchDigest(request.raw), callId: p.callId, tool: p.tool, namespace: null, request: read, ...(entry ? {viewId: entry.viewId} : {}),
      threadId: p.threadId, turnId: p.turnId, itemId: null, started: false, response: null, state: 'reading'};
  }
  assertPreparedResponse(id: RequestId, response: unknown): void {
    this.eligible();
    const calls = this.calls.filter(call => call.rpcId === id && call.state === 'write-attempt');
    ensure(calls.length === 1 && calls[0]!.response && researchDigest(response) === researchDigest(calls[0]!.response),
      'outbound reply is not the exact durable prepared response');
  }
  async handle(request: ServerRequest, respond: (id: RequestId, response: ResearchToolResponse) => void): Promise<void> {
    // Capture only work that existed before this handler; never await self.
    const previous = [...this.active];
    const work = this.serve(request, respond, previous).catch(error => this.fail(error));
    this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => {});
    return work;
  }
  private completionPrefix(call: Call, before: number): boolean {
    if (!call.response || !['write-attempt', 'written'].includes(call.state)) return false;
    const matches = (event: NormalizedEvent): boolean => {
      const item = (event.raw.params as Record<string, unknown>).item as Record<string, unknown>;
      return event.threadId === call.threadId && event.turnId === call.turnId && item?.type === 'dynamicToolCall' &&
        typeof item.id === 'string' && (!call.itemId || call.itemId === item.id) &&
        !this.calls.some(prior => prior.state === 'observed' && prior.itemId === item.id) &&
        item.tool === call.tool && (item.namespace ?? null) === call.namespace &&
        researchDigest(item.arguments) === researchDigest({...Object.fromEntries(Object.entries(call.request).filter(([key]) => key !== 'type')),
          ...(call.viewId ? {viewId: call.viewId} : {})});
    };
    return [...this.receivedCompletions].some(([sequence, prior]) => {
      const event = prior.event, item = (event.raw.params as Record<string, unknown>).item as Record<string, unknown>;
      return sequence > call.requestSequence && sequence < before && matches(event) &&
        item.status === 'completed' && item.success === true && researchDigest(item.contentItems) === researchDigest(call.response!.contentItems) &&
        [...this.receivedStarts].some(([start, value]) => start > call.requestSequence && start < sequence && matches(value) &&
          ((value.raw.params as Record<string, unknown>).item as Record<string, unknown>).id === item.id);
    });
  }
  private async serve(request: ServerRequest, respond: (id: RequestId, response: ResearchToolResponse) => void, previous: Promise<void>[]): Promise<void> {
    this.eligible();
    ensure(!this.admissionPending, 'concurrent request during prior-call admission');
    const call = this.request(request);
    const observed = this.requests.get(call.rpcId);
    ensure(observed && observed.digest === researchDigest(request.raw) &&
      researchDigest(request.raw.params) === researchDigest(request.params) && request.raw.id === request.id &&
      request.raw.method === request.method, 'request is not the exact observed server event');
    call.requestSequence = observed.sequence;
    const unfinished = this.calls.filter(prior => prior.state !== 'observed');
    if (previous.length && unfinished.length && this.threadId === call.threadId && this.turnId === call.turnId &&
      unfinished.every(prior => this.completionPrefix(prior, call.requestSequence))) {
      // Reserve admission synchronously: later requests cannot borrow the same
      // completed prefix while this request has not yet entered calls.
      this.admissionPending = true;
      try {await Promise.all(previous); this.eligible();}
      finally {this.admissionPending = false;}
    }
    ensure(this.calls.length < this.options.maxCalls! &&
      !this.calls.some(c => c.callId === call.callId || c.rpcId === call.rpcId ||
        c.tool === call.tool && c.namespace === call.namespace && c.viewId === call.viewId && researchDigest(c.request) === researchDigest(call.request)) &&
      !this.calls.some(c => c.state !== 'observed'), 'duplicate/ambiguous/concurrent tool request');
    this.calls.push(call);
    await this.acknowledged;
    this.eligible();
    ensure(call.threadId === this.threadId && call.turnId === this.turnId, 'request belongs to another actual turn');
    ensure((await inspectProcess(this.owner.processIdentity)).status === 'verified', 'actual reader process ownership lost');
    const result = this.viewSet ? await readResearchView(this.viewSet, {viewId: call.viewId!, request: call.request}) :
      await readResearchMaterial(this.reader, call.request);
    this.eligible();
    call.response = {contentItems: [{type: 'inputText', text: JSON.stringify(result)}], success: true};
    call.state = 'prepared'; await this.audit('prepared', call, null, 'Exact host response prepared; delivery not claimed');
    this.eligible();
    call.state = 'write-attempt'; await this.audit('write-attempt', call, null, 'Outbound intent durable; delivery remains unobserved');
    this.eligible();
    respond(call.rpcId, call.response); // synchronous transport write; a throw is not completion
    await this.audit('written', call, null, 'Transport write returned; provider receipt remains unobserved');
    call.state = 'written';
    for (const event of this.early.splice(0)) await this.observe(event);
  }
  async observe(event: NormalizedEvent): Promise<void> {
    try {
      safeResultJSON(event);
      if (event.kind === 'server-request') {
        this.eligible();
        const call = this.request({id: event.requestId!, method: event.method,
          params: event.raw.params as Record<string, unknown>, raw: event.raw});
        ensure(Number.isSafeInteger(event.sequence) && event.sequence > 0 &&
          !this.requests.has(call.rpcId) && this.requests.size < this.options.maxCalls!, 'duplicate/excessive actual server event');
        this.requests.set(call.rpcId, {sequence: event.sequence, digest: researchDigest(event.raw)});
        return;
      }
      if (event.kind === 'turn-status' && event.terminal) {
        ensure(event.threadId === this.threadId && event.turnId === this.turnId, 'terminal belongs to another actual turn');
        const params = event.raw.params as Record<string, unknown>;
        const turn = params.turn as Record<string, unknown>;
        ensure(event.status === 'completed' && turn && turn.error == null, 'reader terminal is failed/cancelled/unknown');
        // The ordered transport has already received a completion for this turn.
        // Its existing serve work may still be writing/replaying durable audit.
        // Drain only that existing work; missing/future events never cause a wait.
        if (this.threadId && this.turnId && this.active.size && this.calls.some(call => call.state !== 'observed') &&
          [...this.receivedCompletions].some(([sequence, prior]) => sequence < event.sequence &&
            prior.threadId === this.threadId && prior.turnId === this.turnId)) await this.drain();
        this.terminal = true; this.acknowledge();
        ensure(this.calls.every(call => call.state === 'observed'), 'terminal outran unresolved reader response');
        return;
      }
      if (event.method !== 'item/started' && event.method !== 'item/completed') return;
      const params = event.raw.params as Record<string, unknown>, item = params.item as Record<string, unknown>;
      ensure(item && typeof item.type === 'string', 'missing actual item');
      if (['userMessage', 'reasoning', 'agentMessage', 'contextCompaction'].includes(item.type)) return;
      ensure(item.type === 'dynamicToolCall', 'external tool/command forbidden');
      this.eligible();
      if (event.method === 'item/completed' && !this.receivedCompletions.has(event.sequence)) {
        ensure(this.receivedCompletions.size < this.options.maxCalls!, 'completion event capacity exceeded');
        this.receivedCompletions.set(event.sequence, {threadId: event.threadId ?? null, turnId: event.turnId ?? null, event: freezeJSON(structuredClone(event))});
      }
      if (event.method === 'item/started' && !this.receivedStarts.has(event.sequence)) {
        ensure(this.receivedStarts.size < this.options.maxCalls!, 'started event capacity exceeded');
        this.receivedStarts.set(event.sequence, freezeJSON(structuredClone(event)));
      }
      if (!this.threadId || !this.turnId || !this.calls.some(c => c.state === 'written')) {
        ensure(this.early.length < 4, 'early tool buffer exceeded'); this.early.push(structuredClone(event)); return;
      }
      ensure(event.threadId === this.threadId && event.turnId === this.turnId && typeof item.id === 'string',
        'item belongs to another actual turn');
      ensure(!this.calls.some(call => call.state === 'observed' && call.itemId === item.id), 'previous item cannot bind another request');
      const matches = this.calls.filter(call => (call.itemId === item.id || call.itemId === null) &&
        call.state === 'written' && call.tool === item.tool && (item.namespace ?? null) === call.namespace &&
        researchDigest(item.arguments) === researchDigest({...Object.fromEntries(Object.entries(call.request).filter(([key]) => key !== 'type')),
          ...(call.viewId ? {viewId: call.viewId} : {})}));
      ensure(matches.length === 1, 'missing/ambiguous request to item correlation');
      const call = matches[0]!;
      if (event.method === 'item/started') {
        ensure(!call.started && call.itemId === null, 'duplicate started tool item');
        call.itemId = item.id; call.started = true;
      } else {
        ensure(call.started && call.itemId === item.id && item.status === 'completed' && item.success === true &&
          researchDigest(item.contentItems) === researchDigest(call.response!.contentItems), 'actual completion differs from exact host response');
        await this.audit('observed', call, event.sequence, 'Matching completed tool item observed; not a semantic verdict');
        call.state = 'observed';
      }
    } catch (error) {this.fail(error);}
  }
  async cancel(detail = 'Consumer cancelled reader'): Promise<void> {
    this.cancelled = true; this.acknowledge();
    await this.drain(false);
    for (const call of this.calls.filter(c => c.state !== 'observed')) {
      call.state = 'aborted'; await this.audit('aborted', call, null, detail);
    }
    this.options.signal?.removeEventListener('abort', this.abortListener);
  }
  async drain(throwFailure = true): Promise<void> {
    await Promise.allSettled([...this.active]); await this.journal;
    if (throwFailure && this.failure) throw this.failure;
  }
  async finish(): Promise<void> {
    ensure(!this.closed && this.terminal && !this.cancelled && !this.failure, 'actual clean terminal required');
    await this.drain();
    this.assertTranscript();
    ensure(this.calls.every(c => c.state === 'observed') && !this.early.length, 'unresolved tool evidence');
    await this.audit('closed', null, null, 'Actual tool lifecycle closed; no Run/P4 authority granted');
    this.assertTranscript();
    this.closed = true;
    this.options.signal?.removeEventListener('abort', this.abortListener);
  }
}
