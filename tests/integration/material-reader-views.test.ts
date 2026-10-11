import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {join, basename} from 'node:path';
import {writeFile, readFile, readdir, mkdir, cp} from 'node:fs/promises';
import {setTimeout as delay, setImmediate as nextLoop} from 'node:timers/promises';
import {researchReaderFixture} from '../helpers/research-reader-fixture.js';
import {prepareResearchReader} from '../../packages/workspace/research-reader.js';
import {prepareResearchViewSet} from '../../packages/workspace/research-reader-views.js';
import {researchDigest} from '../../packages/workspace/research-materials.js';
import {spawnManagedProcess, inspectProcess} from '../../packages/process-control/index.js';
import {MaterialReaderSession} from '../../packages/executor-codex/material-reader-session.js';
import {CodexAdapter, type NormalizedEvent, type RawEvent, type LineTransport} from '../../packages/executor-codex/index.js';
import type {ResearchReaderAudit, ResearchViewReadResult} from '../../packages/contracts/p8-research-reader.js';

// Generated Node speaks explicit synthetic JSON protocol. All material reads,
// owner identity, transport writes and audit files below are actual modules.
// Neither the reference digests nor tool completion grants P4 authority.
test('P8-READER-VIEWS-I01 owned Node reads both frozen views with distinct actual calls and closes exact journal', {timeout: 60000}, async t => {
  const f = await researchReaderFixture(t), schemas = join(f.root, 'schemas');
  const version = execFileSync('codex', ['--version'], {encoding: 'utf8', timeout: 15000}).trim();
  execFileSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', schemas], {timeout: 15000, stdio: 'pipe'});
  const old = await prepareResearchReader({intake: f.intake, context: f.context, materialIds: ['one'], role: 'historical', dataRoot: f.data});
  const set = await prepareResearchViewSet(f.data, [{viewId: 'current', reader: f.reader, reference: {role: 'current', bindingDigest: researchDigest('fixture-current')}},
    {viewId: 'original', reader: old, reference: {role: 'historical', epochDigest: researchDigest('fixture-epoch')}}]);
  const script = join(f.root, 'ordinary-protocol.cjs'), wire = join(f.root, 'wire.jsonl');
  await writeFile(script, `const fs=require('node:fs');let phase=0;const views=['current','original'];
const send=x=>{fs.appendFileSync(${JSON.stringify(wire)},JSON.stringify({direction:'out',value:x})+'\\n');console.log(JSON.stringify(x))};
const args=()=>({viewId:views[phase],materialId:'one',start:0,end:2});
const item=(status,contentItems=null,success=null)=>({id:'item-'+phase,type:'dynamicToolCall',tool:'research_view_range',arguments:args(),namespace:null,status,contentItems,success,durationMs:null});
const read=()=>{send({id:900+phase,method:'item/tool/call',params:{callId:'call-'+phase,threadId:'thread',turnId:'turn',tool:'research_view_range',arguments:args(),namespace:null}});send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:item('inProgress')}})};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(wire)},JSON.stringify({direction:'in',value:m})+'\\n');
if(m.method==='initialize')return send({id:m.id,result:{userAgent:'explicit-synthetic-node',codexHome:'fixture',platformFamily:'unix',platformOs:'test'}});
if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'thread',turns:[]}}});
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn',status:'inProgress',items:[]}}});read();return;}
if(m.id===900+phase&&m.result){send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:item('completed',m.result.contentItems,true)}});phase++;if(phase<views.length)setImmediate(read);else send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[],error:null}}});}});`);
  const child = await spawnManagedProcess({operationId: 'view-session-ordinary', command: process.execPath, args: [script], cwd: f.root, timeoutMs: 15000,
    onBeforeSpawn: intent => writeFile(join(f.root,'actual-intent.json'),JSON.stringify(intent),{flag:'wx'}),
    onIdentity: identity => writeFile(join(f.root,'actual-identity.json'),JSON.stringify(identity),{flag:'wx'})});
  f.addCleanup(async () => {const stopped = await child.terminate(); const inspection = await inspectProcess(child.identity); assert.equal(stopped.stopped, true); assert.equal(inspection.status, 'stopped');
    if (process.env.SUPERVISOR_EVIDENCE_DIR) {await writeFile(join(f.root,'actual-stop.json'),JSON.stringify({identity:child.identity,completion:await child.completion,stopped,inspection},null,2));
      await mkdir(process.env.SUPERVISOR_EVIDENCE_DIR,{recursive:true}); await cp(f.root,join(process.env.SUPERVISOR_EVIDENCE_DIR,basename(f.root)),{recursive:true,errorOnExist:true,force:false});}});
  const lines = createInterface({input: child.stdout}), events: NormalizedEvent[] = [], raw: RawEvent[] = [];
  const transport: LineTransport = {write: line => child.writeLine(line.trimEnd()),
    onLine(callback) {lines.on('line', callback); return () => {lines.off('line', callback);};},
    onClose(callback) {const close = () => callback('Actual stdout closed'); lines.on('close', close); return () => {lines.off('close', close);};}};
  let enteredWritten!: () => void;
  const writtenEntered = new Promise<void>(resolve=>{enteredWritten=resolve;});
  let releaseWritten!: () => void;
  const writtenGate = new Promise<void>(resolve => {releaseWritten = resolve;});
  let secondReceived!: () => void;
  const secondGate = new Promise<void>(resolve => {secondReceived = resolve;});
  const committed: {stage:string;callId:string|null}[] = [];
  let writtenHeld = false;
  const options = {reader: f.reader, viewSet: set,
    async onAuditCommitted(record: Readonly<ResearchReaderAudit>) {
      committed.push({stage:record.stage,callId:record.callId});
      if(record.stage==='written'&&record.callId==='call-0') {writtenHeld=true; enteredWritten(); await writtenGate; writtenHeld=false;}
    },
    owner: {jobId: 'fixture-job', attemptId: 'fixture-attempt', inputDigest: researchDigest(set), processIdentity: child.identity},
    protocolDirectory: schemas, version, assertEligible() {}};
  // Explicit unsupported opt-in envelopes must not fall back to the old protocol.
  // The actual owned Node/FS lifecycle remains the same ordinary fixture.
  for (const viewSet of [false, 0, null, '', undefined]) {
    await assert.rejects(MaterialReaderSession.create({...options, viewSet} as unknown as Parameters<typeof MaterialReaderSession.create>[0]), viewSet === undefined ? /unsafe JSON value/ : /exact fields required/);
  }
  const session = await MaterialReaderSession.create(options);
  const adapter = new CodexAdapter({transport, materialReader: session, requestTimeoutMs: 3000, onRawEvent: e => {raw.push(e);}, onEvent: e => {events.push(e);if(e.kind==='server-request'&&e.requestId===901)secondReceived();}});
  f.addCleanup(async () => {releaseWritten(); adapter.dispose(); await session.cancel(); lines.close();});
  assert.deepEqual(session.tools().map(v => v.name), ['research_view_range', 'research_view_search']);
  await adapter.initialize(); await adapter.startThread({cwd: f.root, sandbox: 'read-only', approvalPolicy: 'never'});
  await adapter.startTurn('thread', [{type: 'text', text: 'Explicit ordinary protocol component, no model semantic approval.'}]);
  const deadline = Date.now() + 10000;
  // Hold only the return from an audit which has already written real bytes.
  // The actual Node emits its exact first completion and next request. Give the
  // receive queue one event-loop turn, then verify the pending prior work has
  // not been treated as a true concurrent request or a delivered second reply.
  try {
    await Promise.race([Promise.all([secondGate,writtenEntered]), delay(10000).then(()=>{throw Error('Actual second request missing');})]);
    await nextLoop();
    assert.equal(writtenHeld,true);
    assert.equal(events.some(e=>e.kind==='protocol-error'),false);
    const pendingWire=(await readFile(wire,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(pendingWire.some(v=>v.direction==='in'&&v.value.id===901&&v.value.result),false);
    await writeFile(join(f.root,'audit-order-barrier.json'),JSON.stringify({writtenHeld,committed,secondActualRequest:events.find(e=>e.kind==='server-request'&&e.requestId===901)}));
  } finally {releaseWritten();}
  while (!events.some(e => e.kind === 'turn-status' && e.terminal) && Date.now() < deadline) await delay(10);
  // Preserve actual receive/error chronology even when the original terminal
  // assertion fails. These files are diagnostics, not a generated verdict.
  await writeFile(join(f.root,'normalized-events.json'),JSON.stringify(events));
  await writeFile(join(f.root,'raw-events.json'),JSON.stringify(raw));
  await writeFile(join(f.root,'protocol-errors.json'),JSON.stringify(events.filter(e=>e.kind==='protocol-error')));
  assert.ok(events.some(e => e.kind === 'turn-status' && e.status === 'completed'));
  await adapter.drain(); await session.finish();
  const audits: ResearchReaderAudit[] = await Promise.all((await readdir(session.directory)).filter(n => /^\d+\.json$/.test(n)).sort((a,b) => parseInt(a)-parseInt(b)).map(async n => JSON.parse(await readFile(join(session.directory,n),'utf8'))));
  assert.equal(audits.at(-1)?.stage, 'closed');
  const observed = audits.filter(a => a.stage === 'observed');
  assert.deepEqual(observed.map(a => [a.viewId,a.callId,a.itemId]), [['current','call-0','item-0'],['original','call-1','item-1']]);
  for (const record of observed) {assert.equal(record.inventoryDigest,set.digest); const result = JSON.parse(record.response!.contentItems[0]!.text) as ResearchViewReadResult;
    assert.equal(result.viewId,record.viewId); assert.equal(result.inventoryDigest,set.digest); assert.equal(result.result.ranges[0]!.text,f.text.slice(0,2));}
  const actualWire = (await readFile(wire,'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(actualWire.filter(v => v.direction==='in'&&[900,901].includes(v.value.id)&&v.value.result).length,2);
  // These four explicitly invalid synthetic protocol prefixes must not receive
  // the sequential-wait permission. All reads, writes and process stops remain
  // actual; no proof file, frozen material, result or timestamp is rewritten.
  for (const mode of ['no-completion','wrong-item','wrong-view','early-third'] as const) {
    const negativeRoot=join(f.root,mode);await mkdir(negativeRoot);
    const negativeWire=join(negativeRoot,'wire.jsonl'), negativeScript=join(negativeRoot,'protocol.cjs');
    let source=(await readFile(script,'utf8')).split(JSON.stringify(wire)).join(JSON.stringify(negativeWire));
    const completion="send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:item('completed',m.result.contentItems,true)}});";
    assert.ok(source.includes(completion));
    source=source.replace(completion, mode==='early-third' ? completion : mode==='no-completion' ? '' : mode==='wrong-item'
      ? "send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{...item('completed',m.result.contentItems,true),id:'wrong-actual-item'}}});"
      : "send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{...item('completed',m.result.contentItems,true),arguments:{...args(),viewId:'original'}}}});");
    if(mode==='early-third') {
      const next="phase++;if(phase<views.length)setImmediate(read)";
      assert.ok(source.includes(next));
      source=source.replace(next,"phase++;if(phase<views.length)setImmediate(()=>{read();const third={viewId:'original',materialId:'one',start:1,end:3};send({id:902,method:'item/tool/call',params:{callId:'call-third',threadId:'thread',turnId:'turn',tool:'research_view_range',arguments:third,namespace:null}});send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{...item('inProgress'),id:'item-third',arguments:third}}});})");
    }
    await writeFile(negativeScript,source);
    const actual=await spawnManagedProcess({operationId:'view-prefix-'+mode,command:process.execPath,args:[negativeScript],cwd:negativeRoot,timeoutMs:15000,
      onBeforeSpawn:intent=>writeFile(join(negativeRoot,'actual-intent.json'),JSON.stringify(intent),{flag:'wx'}),
      onIdentity:identity=>writeFile(join(negativeRoot,'actual-identity.json'),JSON.stringify(identity),{flag:'wx'})});
    let writtenReady!:()=>void;const committedWritten=new Promise<void>(resolve=>{writtenReady=resolve;});
    let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});let held=false;
    const negativeSession=await MaterialReaderSession.create({...options,
      owner:{jobId:'fixture-negative-'+mode,attemptId:'fixture-negative-'+mode,inputDigest:researchDigest(set),processIdentity:actual.identity},
      async onAuditCommitted(record){if(record.stage==='written'&&record.callId==='call-0'){held=true;writtenReady();await pending;held=false;}}});
    const incoming=createInterface({input:actual.stdout}), actualEvents:NormalizedEvent[]=[], actualRaw:RawEvent[]=[];
    let failed!:()=>void;const errorEvent=new Promise<void>(resolve=>{failed=resolve;});
    const negativeTransport:LineTransport={write:line=>actual.writeLine(line.trimEnd()),
      onLine(callback){incoming.on('line',callback);return()=>{incoming.off('line',callback);};},
      onClose(callback){const close=()=>callback('Actual negative stdout closed');incoming.on('close',close);return()=>{incoming.off('close',close);};}};
    const negativeAdapter=new CodexAdapter({transport:negativeTransport,materialReader:negativeSession,requestTimeoutMs:3000,
      onRawEvent:event=>{actualRaw.push(event);},onEvent:event=>{actualEvents.push(event);if(event.kind==='protocol-error')failed();}});
    f.addCleanup(async()=>{release();negativeAdapter.dispose();await negativeSession.cancel();incoming.close();
      const stopped=await actual.terminate(),inspection=await inspectProcess(actual.identity);assert.equal(stopped.stopped,true);assert.equal(inspection.status,'stopped');
      await writeFile(join(negativeRoot,'actual-stop.json'),JSON.stringify({identity:actual.identity,completion:await actual.completion,stopped,inspection}));});
    try {
      await negativeAdapter.initialize();await negativeAdapter.startThread({cwd:negativeRoot,sandbox:'read-only',approvalPolicy:'never'});
      await negativeAdapter.startTurn('thread',[{type:'text',text:'Explicit invalid protocol prefix, no model approval.'}]);
      await Promise.race([Promise.all([errorEvent,committedWritten]),delay(10000).then(()=>{throw Error('Invalid prefix was not rejected: '+mode);})]);
      assert.equal(held,true);
      const sent=(await readFile(negativeWire,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      assert.equal(sent.some(v=>v.direction==='in'&&[901,902].includes(v.value.id)&&v.value.result),false);
      assert.equal(actualEvents.some(event=>event.kind==='turn-status'&&event.status==='completed'),false);
      await writeFile(join(negativeRoot,'normalized-events.json'),JSON.stringify(actualEvents));
      await writeFile(join(negativeRoot,'raw-events.json'),JSON.stringify(actualRaw));
      await writeFile(join(negativeRoot,'prefix-rejection.json'),JSON.stringify({mode,held,errors:actualEvents.filter(event=>event.kind==='protocol-error')}));
    } finally {release();}
  }
});
