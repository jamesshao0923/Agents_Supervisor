import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFile, readFile, readdir, mkdir, cp} from 'node:fs/promises';
import {join, basename} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {researchReaderFixture} from '../helpers/research-reader-fixture.js';
import {spawnManagedProcess, inspectProcess, type ManagedProcess} from '../../packages/process-control/index.js';
import {CodexAdapter, normalizeNotification, type LineTransport, type AdapterOptions, type JsonObject, type RawEvent, type NormalizedEvent} from '../../packages/executor-codex/index.js';
import {MaterialReaderSession, inspectMaterialReaderProtocol} from '../../packages/executor-codex/material-reader-session.js';
import {researchDigest} from '../../packages/workspace/research-materials.js';
import type {ResearchReaderAudit} from '../../packages/contracts/p8-research-reader.js';

// Real managed Node stdin/stdout + actual archive/schema/identity/audit files.
// JSON server events are explicit synthetic transport input; no Codex model is run.
async function fixture(t: TestContext, mode = 'normal', maxTranscriptBytes?: number) {
  const f = await researchReaderFixture(t), schemas = join(f.root, 'schemas');
  const version = execFileSync('codex', ['--version'], {encoding: 'utf8', timeout: 15000}).trim();
  execFileSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', schemas], {timeout: 15000, stdio: 'pipe'});
  const script = join(f.root, 'protocol.cjs'), log = join(f.root, 'actual-lines.jsonl');
  await writeFile(script, `
const fs=require('node:fs'),mode=${JSON.stringify(mode)},log=${JSON.stringify(log)};
const args={materialId:'one',start:0,end:2};
const send=x=>{fs.appendFileSync(log,JSON.stringify({direction:'out',at:Date.now(),value:x})+'\\n');console.log(JSON.stringify(x))};
const item=(status,contentItems=null,success=null)=>({id:'actual-item-not-call-id',type:'dynamicToolCall',tool:'research_material_range',arguments:args,namespace:null,status,contentItems,success,durationMs:null});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({direction:'in',at:Date.now(),value:m})+'\\n');
 if(m.id===undefined)return;
 if(m.method==='initialize')return send({id:m.id,result:{userAgent:'synthetic-managed-node',codexHome:'fixture',platformFamily:'unix',platformOs:'test'}});
 if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'actual-thread',turns:[]}}});
 if(m.method==='turn/start'){
  if(mode==='command'){send({id:m.id,result:{turn:{id:'actual-turn',status:'inProgress',items:[]}}});setTimeout(()=>send({method:'item/started',params:{threadId:'actual-thread',turnId:'actual-turn',item:{id:'forbidden',type:'commandExecution',command:'never actually executed'}}}),30);return;}
  send({id:900,method:'item/tool/call',params:{callId:'actual-call',threadId:mode==='cross'?'other-thread':'actual-thread',turnId:'actual-turn',tool:'research_material_range',arguments:args,namespace:mode==='namespace'?'unregistered':null}});
  if(mode==='duplicate')send({id:901,method:'item/tool/call',params:{callId:'other-call',threadId:'actual-thread',turnId:'actual-turn',tool:'research_material_range',arguments:args,namespace:null}});
  if(mode==='normal'||mode==='badcompletion'||mode==='missingobserved'||mode==='repeat'||mode==='failedterminal')send({method:'item/started',params:{threadId:'actual-thread',turnId:'actual-turn',item:item('inProgress')}});
  if(mode==='noack')return;
  setTimeout(()=>{send({id:m.id,result:{turn:{id:'actual-turn',status:'inProgress',items:[]}}});if(mode==='terminal')send({method:'turn/completed',params:{threadId:'actual-thread',turn:{id:'actual-turn',status:'completed',items:[],error:null}}});},40);return;
 }
 if(m.id===900&&m.result){
  if(mode!=='missingobserved')send({method:'item/completed',params:{threadId:'actual-thread',turnId:'actual-turn',item:item('completed',mode==='badcompletion'?[{type:'inputText',text:'forged result'}]:m.result.contentItems,true)}});
  if(mode==='repeat'){send({id:901,method:'item/tool/call',params:{callId:'repeat-call',threadId:'actual-thread',turnId:'actual-turn',tool:'research_material_range',arguments:args,namespace:null}});return;}
  send({method:'turn/completed',params:{threadId:'actual-thread',turn:{id:'actual-turn',status:mode==='failedterminal'?'failed':'completed',items:[],error:mode==='failedterminal'?{message:'Actual synthetic terminal failure'}:null}}});return;
 }
});`);
  const processReceipt: {intent?: unknown; identity?: unknown} = {};
  const child = await spawnManagedProcess({operationId: 'indexed-reader-' + mode, command: process.execPath,
    args: [script], cwd: f.root, timeoutMs: 20000, onBeforeSpawn: intent => {processReceipt.intent = intent;},
    onIdentity: identity => {processReceipt.identity = identity;}});
  if (process.env.SUPERVISOR_EVIDENCE_DIR) f.addCleanup(async () => {
    // Runs after the real managed stop, before the original fixture removes its root.
    await writeFile(join(f.root, 'actual-cleanup.json'), JSON.stringify({mode, identity: child.identity,
      processReceipt, completion: await child.completion, inspection: await inspectProcess(child.identity)}, null, 2));
    await mkdir(process.env.SUPERVISOR_EVIDENCE_DIR!, {recursive: true});
    await cp(f.root, join(process.env.SUPERVISOR_EVIDENCE_DIR!, basename(f.root)), {recursive: true, errorOnExist: true, force: false});
  });
  f.addCleanup(async () => {const result = await child.terminate(); assert.equal(result.stopped, true);});
  const lines = createInterface({input: child.stdout}), writes: JsonObject[] = [], raw: RawEvent[] = [], events: NormalizedEvent[] = [];
  let terminalRaw: (() => void) | undefined;
  let auditDelayed = false;
  let afterWrite: ((line: JsonObject) => void) | undefined;
  const transport: LineTransport = {
    write(line) {const value = JSON.parse(line) as JsonObject; writes.push(value); child.writeLine(line.trimEnd()); afterWrite?.(value);},
    onLine(callback) {lines.on('line', callback); return () => {lines.off('line', callback);};},
    onClose(callback) {const closed = () => callback('actual managed stdout closed'); lines.on('close', closed); return () => {lines.off('close', closed);};},
  };
  let eligible = true;
  const options = {reader: f.reader, owner: {jobId: 'fixture-job', attemptId: 'fixture-attempt',
    inputDigest: researchDigest({originalInput: f.context.digest}), processIdentity: child.identity},
    protocolDirectory: schemas, version, ...(maxTranscriptBytes ? {maxTranscriptBytes} : {}), assertEligible() {assert.ok(eligible, 'Actual consumer eligibility revoked');}};
  const session = await MaterialReaderSession.create(options);
  const adapterOptions: AdapterOptions = {transport, materialReader: session, requestTimeoutMs: 2000,
    onRawEvent: event => {raw.push(event); if (event.line.includes('turn/completed')) terminalRaw?.();}, onEvent: event => {events.push(event);}};
  const adapter = new CodexAdapter(adapterOptions);
  f.addCleanup(async () => {adapter.dispose(); await session.cancel().catch(() => {}); lines.close();});
  async function start() {await adapter.initialize(); await adapter.startThread({cwd: f.root, sandbox: 'read-only', approvalPolicy: 'never'});
    return adapter.startTurn('actual-thread', [{type: 'text', text: 'Explicit synthetic protocol fixture, not semantic approval.'}]);}
  return {...f, child, log, processReceipt, options, session, adapter, writes, raw, events, start,
    delayWrittenAudit() {
      // Scheduling injection only: the real written file and real Node output
      // remain unchanged. Hold this existing audit await until terminal raw is
      // actually received, so the completion replay is deterministically pending.
      const gate = new Promise<void>(resolve => {terminalRaw = () => {setTimeout(resolve, 25);};});
      type Audit = (stage: ResearchReaderAudit['stage'], call: unknown, sequence: number | null, detail: string) => Promise<void>;
      const internal = session as unknown as {audit: Audit};
      const actualAudit = internal.audit.bind(session);
      internal.audit = async (...args) => {await actualAudit(...args); if (args[0] === 'written') {auditDelayed = true; await gate;}};
    }, auditDelayed() {return auditDelayed;},
    clearCallerScope() {delete adapterOptions.materialReader;}, revoke() {eligible = false;}, setAfterWrite(callback: (line: JsonObject) => void) {afterWrite = callback;}};
}
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), 'Actual protocol event did not arrive within bounded observation');
}
async function audits(directory: string): Promise<ResearchReaderAudit[]> {
  const files = (await readdir(directory)).filter(name => /^\d+\.json$/.test(name)).sort((a,b) => parseInt(a)-parseInt(b));
  return Promise.all(files.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as ResearchReaderAudit));
}

test('P8-READER-I01 actual Node early tool request waits real acknowledgements and exact independent item completion before closing', async t => {
  const f = await fixture(t); f.clearCallerScope(); await f.start();
  await waitFor(() => f.events.some(event => event.kind === 'turn-status' && event.terminal));
  await f.adapter.drain(); await f.session.finish();
  assert.ok(f.processReceipt.intent && f.processReceipt.identity);
  assert.equal((await inspectProcess(f.child.identity)).status, 'verified');
  assert.equal((f.writes[0]!.params as JsonObject).capabilities && ((f.writes[0]!.params as JsonObject).capabilities as JsonObject).experimentalApi, true);
  const thread = f.writes.find(value => value.method === 'thread/start')!.params as JsonObject;
  assert.deepEqual((thread.dynamicTools as JsonObject[]).map(tool => tool.name), ['research_material_range', 'research_material_search']);
  assert.equal(thread.sandbox, 'read-only'); assert.equal(thread.approvalPolicy, 'never');
  const records = await audits(f.session.directory);
  assert.deepEqual(records.map(record => record.stage), ['prepared', 'write-attempt', 'written', 'observed', 'closed']);
  assert.equal(records[0]!.eventSequence, f.events.find(event => event.kind === 'server-request')!.sequence);
  assert.equal(records[0]!.requestDigest, researchDigest(f.events.find(event => event.kind === 'server-request')!.raw));
  assert.equal(records[3]!.callId, 'actual-call'); assert.equal(records[3]!.itemId, 'actual-item-not-call-id');
  for (const record of records) {const {digest, ...body} = record; assert.equal(digest, researchDigest(body)); assert.deepEqual(record.owner, f.options.owner);}
  const lines = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {direction:string;value:JsonObject});
  const ack = lines.findIndex(line => line.direction === 'out' && (line.value.result as JsonObject | undefined)?.turn);
  const response = lines.findIndex(line => line.direction === 'in' && line.value.id === 900 && line.value.result);
  assert.ok(ack >= 0 && response > ack, 'No response before actual turn ack');
  const result = JSON.parse(records[0]!.response!.contentItems[0]!.text);
  assert.equal(result.ranges[0].text, f.text.slice(0, 2)); assert.equal(result.authority, 'material-integrity-only');
  await assert.rejects(MaterialReaderSession.create(f.options), /never replay/);
  await assert.rejects(f.session.finish(), /clean terminal/);
  const count = f.writes.length;
  await assert.rejects(f.adapter.startTurn('actual-thread', [{type: 'text', text: 'Forbidden second model turn'}]), /closed/);
  assert.equal(f.writes.length, count, 'Second turn must reject before any dispatch');
});

test('P8-READER-I02 actual Node cross-thread and duplicate same-args requests reject without arbitrary correlation or replies', async t => {
  for (const mode of ['cross', 'duplicate', 'namespace', 'repeat']) {
    const f = await fixture(t, mode); await f.start().catch(() => {});
    await waitFor(() => f.events.some(event => event.kind === 'protocol-error'));
    await assert.rejects(f.adapter.drain()); await assert.rejects(f.session.finish());
    assert.equal(f.writes.filter(line => [900,901].includes(Number(line.id)) && line.result).length, mode === 'repeat' ? 1 : 0);
    assert.equal(f.writes.filter(line => line.id === 901 && line.result).length, 0, 'Sequential identical args cannot select an old item arbitrarily');
  }
});

test('P8-READER-I03 actual Node command items and changed completed response cannot qualify the registered reader turn', async t => {
  for (const mode of ['command', 'badcompletion']) {
    const f = await fixture(t, mode); await f.start().catch(() => {});
    await waitFor(() => f.events.some(event => event.kind === 'protocol-error'));
    await assert.rejects(f.adapter.drain()); await assert.rejects(f.session.finish());
    assert.equal((await audits(f.session.directory)).some(record => record.stage === 'observed'), false);
    assert.ok(f.raw.some(event => event.line.includes(mode === 'command' ? 'commandExecution' : 'forged result')), 'Actual raw negative preserved');
  }
});

test('P8-READER-I04 actual Node terminal before response or without observed completion remains incomplete', async t => {
  const valid = await fixture(t); valid.delayWrittenAudit(); await valid.start();
  await waitFor(() => valid.raw.some(event => event.line.includes('turn/completed')));
  await valid.adapter.drain(); await valid.session.finish();
  assert.equal(valid.auditDelayed(), true);
  assert.deepEqual((await audits(valid.session.directory)).map(record => record.stage), ['prepared', 'write-attempt', 'written', 'observed', 'closed']);
  assert.ok(valid.raw.some(event => event.line.includes('item/completed')));
  for (const mode of ['terminal', 'missingobserved', 'failedterminal', 'badcompletion']) {
    const f = await fixture(t, mode); await f.start().catch(() => {});
    await waitFor(() => f.events.some(event => event.kind === 'protocol-error'));
    await assert.rejects(f.adapter.drain()); await assert.rejects(f.session.finish());
    assert.equal((await audits(f.session.directory)).some(record => record.stage === 'closed'), false);
  }
});

test('P8-READER-I05 cancel drains a pre-ack actual-process request with no late reply and exact aborted audit', async t => {
  const f = await fixture(t, 'noack');
  const start = f.start().catch(() => {});
  await waitFor(() => f.events.some(event => event.kind === 'server-request'));
  await f.session.cancel('Actual consumer cancelled before turn acknowledgement');
  await assert.rejects(f.adapter.drain(), /closed\/cancelled/);
  assert.equal(f.writes.filter(line => line.id === 900 && line.result).length, 0);
  const records = await audits(f.session.directory); assert.deepEqual(records.map(record => record.stage), ['aborted']);
  assert.ok(records[0]!.eventSequence && records[0]!.requestDigest, 'Actual server event is pinned even before turn ack');
  await assert.rejects(f.session.finish()); assert.equal((await inspectProcess(f.child.identity)).status, 'verified');
  f.adapter.dispose(); await start;
});

test('P8-READER-I06 actual response write followed by real journal conflict remains incomplete and cannot replay on reopen', async t => {
  const f = await fixture(t); let delivered = false;
  f.setAfterWrite(line => {
    if (line.id !== 900 || !line.result) return;
    delivered = true;
    // Actual exclusive-file conflict injected after transport.write returned.
    execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],"partial receipt")', join(f.session.directory, '3.json')]);
  });
  await f.start().catch(() => {});
  await waitFor(() => f.events.some(event => event.kind === 'protocol-error'));
  assert.equal(delivered, true); await assert.rejects(f.session.finish());
  await assert.rejects(f.session.drain(), /partial research receipt/);
  assert.equal(await readFile(join(f.session.directory, '3.json'), 'utf8'), 'partial receipt');
  await assert.rejects(MaterialReaderSession.create(f.options), /never replay/);
  assert.equal(JSON.parse(await readFile(join(f.session.directory, '2.json'), 'utf8')).stage, 'write-attempt');
  const bounded = await fixture(t, 'normal', 1024);
  await bounded.start().catch(() => {});
  await waitFor(() => bounded.events.some(event => event.kind === 'protocol-error'));
  await assert.rejects(bounded.adapter.drain(), /transcript capacity exceeded/);
  assert.equal(bounded.writes.filter(line => line.id === 900 && line.result).length, 0, 'Oversized complete transcript is never silently sliced or sent');
  await assert.rejects(bounded.session.finish());
});

test('P8-READER-I07 version schema drift writable sandbox host revocation and fake sessions reject before tool transport authority', async t => {
  const f = await fixture(t, 'silent');
  await assert.rejects(inspectMaterialReaderProtocol('0.153.3', f.options.protocolDirectory), /version differs/);
  const schemaPath = join(f.options.protocolDirectory, 'DynamicToolCallResponse.json');
  const original = await readFile(schemaPath); await writeFile(schemaPath, '{}');
  await assert.rejects(inspectMaterialReaderProtocol(f.options.version, f.options.protocolDirectory), /schema differs/);
  await writeFile(schemaPath, original);
  assert.throws(() => new CodexAdapter({transport: {write() {}, onLine() {return () => {};}, onClose() {return () => {};}},
    materialReader: {} as MaterialReaderSession, onRawEvent() {}, onEvent() {}}), /Actual host reader/);
  // Regression for actual constructor captured-ref bypass; no provider invocation.
  let reads = 0, unsafeWrites = 0;
  const accessor = {
    transport: {write() {unsafeWrites++;}, onLine() {return () => {};}, onClose() {return () => {};}},
    onRawEvent() {}, onEvent() {},
    get materialReader() {return ++reads === 1 ? {} as MaterialReaderSession : undefined;},
  };
  assert.throws(() => new CodexAdapter(accessor as AdapterOptions), /Actual host reader/);
  assert.equal(reads, 1, 'Factory check must validate the exact captured instance');
  assert.equal(unsafeWrites, 0, 'Accessor cannot enable experimental mode or register arbitrary tools');
  assert.throws(() => {f.session.reader.view.allowedMaterialIds.push('two');}, TypeError);
  assert.equal(Reflect.set(f.session, 'owner', f.options.owner), false);
  assert.equal(Reflect.set(f.session, 'directory', f.root), false);
  await f.adapter.initialize();
  await assert.rejects(f.adapter.startThread({cwd: f.root, sandbox: 'workspace-write', approvalPolicy: 'never'}), /read-only/);
  assert.equal(f.writes.some(line => line.method === 'thread/start'), false);
  await f.adapter.startThread({cwd: f.root, sandbox: 'read-only', approvalPolicy: 'never'});
  f.setAfterWrite(line => {if (line.method === 'turn/start') f.revoke();});
  await f.adapter.startTurn('actual-thread', [{type: 'text', text: 'Revoked actual server request'}]).catch(() => {});
  await waitFor(() => f.events.some(event => event.kind === 'protocol-error'));
  await assert.rejects(f.session.drain(), /eligibility revoked/);
  assert.equal(f.writes.filter(line => line.id === 900 && line.result).length, 0);
  await assert.rejects(f.session.finish());
});

test('P8-READER-I08 actual audit tamper after observed completion rejects clean closure without rewriting history', async t => {
  const f = await fixture(t); await f.start();
  await waitFor(() => f.events.some(event => event.kind === 'turn-status' && event.terminal));
  await f.adapter.drain();
  const path = join(f.session.directory, '1.json'), original = await readFile(path, 'utf8');
  const changed = JSON.parse(original); changed.response.contentItems[0].text = 'forged evidence';
  const {digest: _digest, ...body} = changed; changed.digest = researchDigest(body);
  await writeFile(path, JSON.stringify(changed));
  await assert.rejects(f.session.finish(), /actual reader transcript changed/);
  assert.equal((await audits(f.session.directory)).some(record => record.stage === 'closed'), false);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(changed), 'Bad historical evidence is not silently repaired');
  await writeFile(path, original); await f.session.finish();
});
