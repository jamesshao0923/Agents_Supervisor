import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,realpath,rm,readdir,readFile,writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { runtimeCanonical as canonical } from '../../packages/persistence/runtime.js';
import { SUPERVISION_MONITOR_MIGRATION_SQL } from '../../packages/persistence/supervision-monitor.js';
import { SupervisionInspectionRunner,SupervisionInspectionError } from '../../packages/orchestration/supervision-inspection.js';
import { SupervisionReasoningRunner } from '../../packages/orchestration/supervision-reasoning.js';
import { ReasonerError,prepareReasonerTurn } from '../../packages/orchestration/reasoner.js';
import type { ReasonerInput,ReasonerResult,SupervisorReasoner } from '../../packages/orchestration/reasoner.js';
import { inspectProcess,spawnManagedProcess } from '../../packages/process-control/index.js';
import type { ManagedProcess } from '../../packages/process-control/index.js';
import { INSPECTION_RESULT_SCHEMA } from '../../packages/contracts/p6-monitor.js';
import type { FrozenInspectionInput } from '../../packages/contracts/p6-monitor.js';

// Real SQLite and managed Node processes; model JSON/token values and old epoch
// are explicit mechanism fixtures, not live Codex or elapsed five-minute evidence.
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
class ProcessFixtureTransport implements SupervisorReasoner {
  calls = 0;
  inputs: ReasonerInput[] = [];
  children: ManagedProcess[] = [];
  started = deferred();
  completed = deferred();
  constructor(readonly options: { hold?: boolean; liveClaim?: boolean; usage?: number | null; observed?: number; value?: unknown; noProof?: boolean; contradictoryStart?: boolean; afterProcess?: () => Promise<void>; beforeTurn?: () => Promise<void> } = {}) {}
  async request(request: ReasonerInput): Promise<ReasonerResult> {
    this.calls++; this.inputs.push(request);
    const result: ReasonerResult = { value: this.options.value ?? {summary:'Explicit Node transport fixture only',assessment:'progress',observations:[],concerns:[],recommendation:'continue-observing'}, usage: this.options.usage === undefined ? 7 : this.options.usage, threadId: 'fixture-thread', turnId: 'fixture-turn', proofFiles: [], stopConfirmed: false, modelStarted: false };
    let child: ManagedProcess | undefined;
    try {
      request.assertEligible?.();
      await this.options.beforeTurn?.();
      await prepareReasonerTurn(request, result, () => request.assertEligible?.());
      const path = join(request.logDir, 'process-fixture.json');
      const code = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({kind:'managed-process-fixture',prompt:process.argv[2]})); ${this.options.hold || this.options.liveClaim ? 'setInterval(()=>{},1000);' : ''}`;
      child = await spawnManagedProcess({ operationId: request.id + '-fixture-process', command: process.execPath, args: ['-e', code, path, request.prompt], cwd: request.cwd, timeoutMs: 5000, onBeforeSpawn: intent => request.onIntent?.(intent), onIdentity: identity => request.onIdentity?.(identity) });
      this.children.push(child); this.started.resolve();
      const stop = () => { void child!.terminate('cancelled'); };
      request.signal?.addEventListener('abort', stop, { once: true });
      if (request.signal?.aborted) stop();
      try {
        await request.onUsage?.(this.options.observed ?? 7);
        if (this.options.liveClaim) {
          // The deliberately lying stop flag is checked against the actual process.
          result.stopConfirmed = true; return result;
        }
        const completion = await child.completion; result.stopConfirmed = completion.stopped;
        if (!this.options.noProof) result.proofFiles = [path];
        this.completed.resolve(); await this.options.afterProcess?.();
        if (request.signal?.aborted) { result.usage = null; throw new Error('Fixture transport cancelled before authoritative final usage'); }
        if (this.options.contradictoryStart) result.modelStarted = false;
        return result;
      } finally { request.signal?.removeEventListener('abort', stop); }
    } catch (error) {
      if (!result.modelStarted) result.usage = 0; // Fixture made no model turn; do not invent its token charge.
      if (child) result.stopConfirmed = (await child.terminate('cancelled')).stopped;
      throw new ReasonerError(error instanceof Error ? error.message : String(error), result, { cause: error });
    }
  }
  async close() { await Promise.all(this.children.map(child => child.terminate('cancelled'))); }
}
const config={model:'repository-mechanism-no-model-launch',effort:'low',reservation:30,timeoutMs:5000};
async function fixture(t:TestContext,transport=new ProcessFixtureTransport(),next=false,futureFloor=0){
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-monitor-'))),data=join(root,'data'),workspace=join(root,'workspace');await mkdir(workspace);
  const store=new SupervisorStore(data),db=new DatabaseSync(join(data,'supervisor.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
  if(!db.prepare("SELECT name FROM sqlite_master WHERE name='supervision_monitor_events'").get())db.exec(SUPERVISION_MONITOR_MIGRATION_SQL);
  const monitor=store.supervisionMonitor,runner=new SupervisionInspectionRunner(store,data,transport);
  const runtime=store.runtime.submit({type:'submit',commandId:'runtime',workspace,workspaceKind:'project',goal:'Observe the explicitly declared repository execution fixture',tokenLimit:1000,verificationReserve:100,steps:[{id:'implementation',kind:'codex',prompt:'Mechanism fixture: no actual Codex is launched',...config},...(next?[{id:'next',kind:'codex' as const,prompt:'Second explicit mechanism node',...config}]:[])]});
  if(futureFloor){const run=store.runtime.inspect(runtime.id).run;store.runtime.setFutureVerification({commandId:'future-floor',runtimeId:runtime.id,expectedContractVersion:run.contract.version,expectedRevision:run.revision,allocationId:'future-acceptance',amount:futureFloor,reason:'Keep actual future independent verification funded'});}
  const loop=store.supervision.attach({commandId:'attach',runtimeId:runtime.id,config,limits:{maxRepairs:2,maxReasoningCalls:8,maxDurationMs:2_000_000,maxContextChars:200_000}});
  // Fixture chronology only, not a shortened production interval or a live
  // scheduler assertion. Production constants remain 15s and 300s.
  const epoch=Date.now()-300_100;loop.createdAt=new Date(epoch).toISOString();db.prepare('UPDATE supervision_loops SET record=? WHERE id=?').run(canonical(loop),loop.id);
  const baseline=monitor.cursor(loop.id);
  monitor.initialize({commandId:'initialize',loopId:loop.id,expectedRevision:loop.revision,startedAtMs:epoch,evidenceCursor:baseline});
  const operation=store.runtime.claim(runtime.id,'fixture-owner')!,binding=store.runtime.binding(operation.id,'fixture-owner');
  const receipt=store.executionCreate({type:'start',commandId:operation.id,workspace,workspaceKind:'project',prompt:'Real Node process fixture; not a model completion',...config,tokenLimit:1000,verificationReserve:100},binding).record;
  const writer=await spawnManagedProcess({operationId:receipt.id,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:workspace,timeoutMs:50000,onBeforeSpawn:intent=>{store.executionUpdate(receipt.id,{},'fixture-process-intent',intent);},onIdentity:identity=>{store.executionUpdate(receipt.id,{state:'running',identity,pid:identity.pid},'fixture-process',{purpose:'Actual managed Node process, no model turn'});}});store.runtime.markStarted(operation.id,'fixture-owner');
  const event=store.runtime.events(runtime.id,0).at(-1)!;
  const refs=[{kind:'runtime-event' as const,seq:event.seq}];
  function observe(_cursor='changed-A',time=Date.now()){const cursor=monitor.cursor(loop.id,refs);const current=store.supervision.get(loop.id);return monitor.observe({commandId:randomUUID(),loopId:loop.id,expectedRevision:current.revision,input:{nowMs:time,lifecycle:'active',evidenceCursor:cursor},evidenceRefs:refs});}
  function begin(commandId='inspection'){const current=store.supervision.get(loop.id);return monitor.beginInspection({commandId,loopId:loop.id,expectedRevision:current.revision,prompt:'Describe supplied immutable ledger evidence only. Do not execute or authorize actions.',evidenceRefs:[{kind:'runtime-event',seq:event.seq}]});}
  t.after(async()=>{await runner.close();await transport.close();await writer.terminate();await writer.completion;db.close();store.close();await rm(root,{recursive:true,force:true});});
  async function finishWriter(){await writer.terminate();await writer.completion;store.executionUpdate(receipt.id,{state:'completed',stopConfirmed:true,usageStatus:'reported',usage:{inputTokens:7,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:7}},'fixture-completed',{fixture:'Actual Node stopped, declared accounting fixture only'},[{type:'finishAttempt',attemptId:receipt.id,outcome:'succeeded'},{type:'settleAttempt',attemptId:receipt.id,actual:7},{type:'releaseLease',attemptId:receipt.id,resource:'workspace:'+workspace},{type:'setOperation',operationId:receipt.id,attemptId:receipt.id,status:'confirmed'}]);store.runtime.report(operation.id,'fixture-owner',{messageId:randomUUID(),outcome:'confirmed',result:'Actual Node process fixture ended'});}
  return {runner,transport,baseline,finishWriter,root,data,workspace,store,db,monitor,runtime,loop,epoch,operation,receipt,writer,event,observe,begin};
}

async function failure(promise:Promise<unknown>){await assert.rejects(promise,SupervisionInspectionError);}
function pause(f:Awaited<ReturnType<typeof fixture>>){const loop=f.store.supervision.get(f.loop.id);f.store.supervision.update(loop.id,loop.revision,{paused:true});}

test('P6-SIR-I01 concurrent real writer survives one inspection with full frozen prompt private cwd and settled budget',async t=>{
 const f=await fixture(t);f.observe();const job=f.begin(),before=f.store.runtime.inspect(f.runtime.id).run,a=f.runner.run(job.id),b=f.runner.run(job.id);assert.equal(a,b);const done=await a;
 assert.equal(done.usage,7);assert.equal(done.error,null);assert.equal(done.status,'finished');assert.equal(f.transport.calls,1);assert.equal((await inspectProcess(f.writer.identity)).status,'verified');
 const request=f.transport.inputs[0]!,input=job.input as FrozenInspectionInput;assert.ok(request.prompt.includes(canonical(input.context)));assert.deepEqual(request.outputSchema,INSPECTION_RESULT_SCHEMA);assert.notEqual(request.cwd,f.workspace);assert.equal((await readdir(request.cwd)).length,0);assert.ok(request.logDir.includes('supervision-inspection/logs'));assert.equal(Object.keys(done.proofs).length,1);assert.equal((await inspectProcess(done.identities[0]!)).status,'stopped');
 const run=f.store.runtime.inspect(f.runtime.id).run;assert.deepEqual(run.contract,before.contract);assert.deepEqual(run.nodes,before.nodes);assert.deepEqual(run.leases,before.leases);assert.equal(run.budget.spent,7);assert.equal(run.attempts.find(a=>a.id===job.id)!.settled,true);assert.equal(f.monitor.envelope(f.loop.id)!.activeJobId,job.id,'Runner does not advance monitor cursor');assert.deepEqual(await f.runner.run(job.id),done);assert.equal(f.transport.calls,1);
});

test('P6-SIR-I02 frozen input mutation rejects before transport without spending or changing execution',async t=>{
 const f=await fixture(t);f.observe();const job=f.begin();f.db.prepare("UPDATE supervision_jobs SET record=json_set(record,'$.input.context.binding.evidenceCursor','tampered') WHERE id=?").run(job.id);await failure(f.runner.run(job.id));const done=f.store.supervision.job(job.id);assert.match(done.error!,/digest/);assert.equal(done.usage,0);assert.equal(done.stopConfirmed,true);assert.equal(f.transport.calls,0);assert.equal((await inspectProcess(f.writer.identity)).status,'verified');
});

test('P6-SIR-I03 caller-rehashed weakened schema is still refused with known zero accounting',async t=>{
 const f=await fixture(t);f.observe();const job=f.begin(),input=job.input as FrozenInspectionInput;input.outputSchema={type:'object',properties:{},required:[],additionalProperties:false};job.input=input;job.inputDigest=createHash('sha256').update(canonical(input)).digest('hex');f.db.prepare('UPDATE supervision_jobs SET record=? WHERE id=?').run(canonical(job),job.id);await failure(f.runner.run(job.id));assert.match(f.store.supervision.job(job.id).error!,/schema changed/);assert.equal(f.transport.calls,0);
});

test('P6-SIR-I04 persisted successful result rechecks actual proof bytes across reopen without replay',async t=>{
 const f=await fixture(t);f.observe();const job=f.begin(),done=await f.runner.run(job.id),store=new SupervisorStore(f.data),runner=new SupervisionInspectionRunner(store,f.data,f.transport);try{await runner.initialize();assert.deepEqual(await runner.run(job.id),done);await writeFile(Object.keys(done.proofs)[0]!,'mutated bytes');await assert.rejects(runner.run(job.id),/proof digest changed/);assert.equal(f.transport.calls,1);assert.equal(store.runtime.inspect(f.runtime.id).run.budget.spent,7);}finally{await runner.close();store.close();}
});

test('P6-SIR-I05 pause after actual inspection stop rejects publication while preserving known final cost',async t=>{
 const gate=deferred(),f=await fixture(t,new ProcessFixtureTransport({afterProcess:()=>gate.promise}));f.observe();const job=f.begin(),pending=f.runner.run(job.id),rejected=failure(pending);await f.transport.completed.promise;pause(f);gate.resolve();await rejected;const done=f.store.supervision.job(job.id);assert.equal(done.usage,7);assert.equal(done.result,null);assert.equal(done.stopConfirmed,true);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,7);assert.equal((await inspectProcess(f.writer.identity)).status,'verified');
});

test('P6-SIR-I06 explicit cancel terminates only inspector and preserves unknown model usage reservation',async t=>{
 const f=await fixture(t,new ProcessFixtureTransport({hold:true}));f.observe();const job=f.begin(),pending=f.runner.run(job.id),rejected=failure(pending);await f.transport.started.promise;const done=await f.runner.cancel(job.id);await rejected;assert.equal(done.usage,null);assert.equal(done.stopConfirmed,true);assert.equal(done.result,null);assert.equal((await inspectProcess(done.identities[0]!)).status,'stopped');assert.equal((await inspectProcess(f.writer.identity)).status,'verified');assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts.find(a=>a.id===job.id)!.settled,false);
});

test('P6-SIR-I07 initialize stops persisted orphan process without replay and conservatively retains started usage',async t=>{
 const f=await fixture(t);f.observe();const job=f.begin();const child=await spawnManagedProcess({operationId:job.id+'-orphan',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.root,timeoutMs:10000,onBeforeSpawn:intent=>{f.store.supervision.observeJob(job.id,{intents:[intent]});},onIdentity:identity=>{f.store.supervision.observeJob(job.id,{identities:[identity],modelStarted:true});}});await f.runner.initialize();await child.completion;const done=f.store.supervision.job(job.id);assert.equal((await inspectProcess(child.identity)).status,'stopped');assert.equal(done.status,'finished');assert.equal(done.usage,null);assert.equal(f.transport.calls,0);await failure(f.runner.run(job.id));assert.equal((await inspectProcess(f.writer.identity)).status,'verified');
});

test('P6-SIR-I08 original writer may settle after turn authorization while inspection retains frozen evidence',async t=>{
 const gate=deferred(),f=await fixture(t,new ProcessFixtureTransport({afterProcess:()=>gate.promise}),true);f.observe();const job=f.begin(),pending=f.runner.run(job.id);await f.transport.completed.promise;await f.finishWriter();assert.equal(f.store.runtime.claim(f.runtime.id,'next-owner'),null);gate.resolve();const done=await pending;assert.equal(done.error,null);assert.equal(done.usage,7);assert.equal(f.store.runtime.get(f.runtime.id).cursor,1);f.monitor.completeInspection({commandId:'apply',jobId:job.id});assert.ok(f.store.runtime.claim(f.runtime.id,'next-owner'));
});

test('P6-SIR-I09 physical writer loss before turn rejects without trusting stale running metadata',async t=>{
 let stop!:()=>Promise<void>;const f=await fixture(t,new ProcessFixtureTransport({beforeTurn:()=>stop()}));stop=async()=>{await f.writer.terminate();await f.writer.completion;};f.observe();const job=f.begin();await failure(f.runner.run(job.id));const done=f.store.supervision.job(job.id);assert.equal(done.modelStarted,false);assert.equal(done.usage,0);assert.match(done.error!,/birth identity/);assert.equal(done.identities.length,0);
});

test('P6-SIR-I10 unknown underreported overspent and exact reserved usage keep honest accounting',async t=>{
 for(const options of [{usage:null,observed:7},{usage:6,observed:7},{usage:31,observed:7},{usage:30,observed:30}]){const f=await fixture(t,new ProcessFixtureTransport(options));f.observe();const job=f.begin();if(options.usage===30){assert.equal((await f.runner.run(job.id)).usage,30);}else{await failure(f.runner.run(job.id));const done=f.store.supervision.job(job.id);assert.equal(done.result,null);assert.equal(done.usage,options.usage===6?null:options.usage);assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts.find(a=>a.id===job.id)!.settled,options.usage===31);}}
});

test('P6-SIR-I11 transport cannot invent evidence IDs or business authorization in structured result',async t=>{
 for(const value of [{summary:'Fixture',assessment:'progress',observations:[{evidenceId:'foreign',text:'Unsupported fact'}],concerns:[],recommendation:'continue-observing'},{summary:'Fixture',assessment:'progress',observations:[],concerns:[],recommendation:'deliver'}]){const f=await fixture(t,new ProcessFixtureTransport({value}));f.observe();const job=f.begin();await failure(f.runner.run(job.id));assert.equal(f.store.supervision.job(job.id).usage,7);assert.equal(f.store.supervision.job(job.id).result,null);}
});

test('P6-SIR-I12 false process stop flag cannot publish and inspector is actually terminated',async t=>{
 const f=await fixture(t,new ProcessFixtureTransport({liveClaim:true}));f.observe();const job=f.begin();await failure(f.runner.run(job.id));const done=f.store.supervision.job(job.id);assert.match(done.error!,/actual stopped/);assert.equal(done.stopConfirmed,true);assert.equal((await inspectProcess(done.identities[0]!)).status,'stopped');assert.equal((await inspectProcess(f.writer.identity)).status,'verified');
});

test('P6-SIR-I13 ordinary runner never recovers cancels or closes an active inspection owned by dedicated runner',async t=>{
 const f=await fixture(t,new ProcessFixtureTransport({hold:true}));f.observe();const job=f.begin(),pending=f.runner.run(job.id),rejected=failure(pending);await f.transport.started.promise;const normal=new SupervisionReasoningRunner(f.store,f.data,f.transport);await normal.initialize();await normal.close();assert.throws(()=>normal.run(job.id),/dedicated/);await assert.rejects(normal.cancel(job.id),/dedicated/);assert.equal(f.store.supervision.job(job.id).status,'running');assert.equal((await inspectProcess(f.transport.children[0]!.identity)).status,'verified');await f.runner.cancel(job.id);await rejected;
});

test('P6-SIR-I14 reservation floor and a foreign unresolved operation prevent model dispatch',async t=>{
 for(const tamper of ['budget','operation']){const f=await fixture(t);f.observe();const job=f.begin(),run=f.store.runtime.inspect(f.runtime.id).run;if(tamper==='budget')run.budget.limit=100;else run.operations.push({id:'foreign-effect',attemptId:'orphan',status:'pending'});f.db.prepare('UPDATE runs SET snapshot=? WHERE project_id=? AND id=?').run(canonical(run),run.projectId,run.id);await failure(f.runner.run(job.id));assert.equal(f.transport.calls,0);assert.equal(f.store.supervision.job(job.id).usage,0);assert.equal((await inspectProcess(f.writer.identity)).status,'verified');}
});

test('P6-SIR-I15 missing persisted birth identity remains unknown stop across recovery and cannot release reserve',async t=>{
 const f=await fixture(t);f.observe();const job=f.begin();f.store.supervision.observeJob(job.id,{intents:[{operationId:job.id+'-missing',ownerToken:'unobserved',command:process.execPath,args:[],cwd:f.root,createdAt:new Date().toISOString()}]});await f.runner.initialize();const done=f.store.supervision.job(job.id);assert.equal(done.stopConfirmed,false);assert.equal(done.usage,null);assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts.find(a=>a.id===job.id)!.settled,false);assert.equal(f.transport.calls,0);
});

test('P6-SIR-I16 runtime cancel after process stop retains known cost and rejects late inspection',async t=>{
 const gate=deferred(),f=await fixture(t,new ProcessFixtureTransport({afterProcess:()=>gate.promise}));f.observe();const job=f.begin(),pending=f.runner.run(job.id),rejected=failure(pending);await f.transport.completed.promise;f.store.runtime.control({type:'cancel',runtimeId:f.runtime.id,commandId:'cancel-runtime'});gate.resolve();await rejected;const done=f.store.supervision.job(job.id);assert.equal(done.usage,7);assert.equal(done.stopConfirmed,true);assert.equal(done.result,null);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,7);assert.equal((await inspectProcess(f.writer.identity)).status,'verified','Inspector must not kill the independently owned writer');
});

test('P6-SIR-I17 missing proof rejects finished output while preserving truthful process and cost evidence',async t=>{
 const f=await fixture(t,new ProcessFixtureTransport({noProof:true}));f.observe();const job=f.begin();await failure(f.runner.run(job.id));const done=f.store.supervision.job(job.id);assert.equal(done.usage,7);assert.equal(done.stopConfirmed,true);assert.equal(done.result,null);assert.match(done.error!,/proof files/);
});

test('P6-SIR-I18 writer receipt birth identity mutation prevents a successful raw result from application',async t=>{
 const gate=deferred(),f=await fixture(t,new ProcessFixtureTransport({afterProcess:()=>gate.promise}));f.observe();const job=f.begin(),pending=f.runner.run(job.id),rejected=failure(pending);await f.transport.completed.promise;f.store.executionUpdate(f.receipt.id,{identity:{...f.writer.identity,startIdentity:'foreign-birth'}},'explicit-corruption-fixture',{});gate.resolve();await rejected;const done=f.store.supervision.job(job.id);assert.equal(done.usage,7);assert.equal(done.result,null);assert.match(done.error!,/identity changed/);assert.equal((await inspectProcess(f.writer.identity)).status,'verified');
});

test('P6-SIR-I19 future verification allocation remains intact during actual concurrent inspection accounting',async t=>{
 const f=await fixture(t,new ProcessFixtureTransport(),false,900);f.observe();const before=f.store.runtime.inspect(f.runtime.id).run,job=f.begin(),done=await f.runner.run(job.id),run=f.store.runtime.inspect(f.runtime.id).run;assert.equal(done.usage,7);assert.deepEqual(run.budget.futureVerification,before.budget.futureVerification);assert.equal(run.budget.futureVerification!.amount,900);assert.equal(run.budget.spent,7);assert.equal(run.attempts.find(a=>a.id===f.receipt.id)!.reservation,30);assert.equal(run.attempts.find(a=>a.id===job.id)!.settled,true);assert.equal(run.budget.spent+30+900,937);assert.deepEqual(run.nodes,before.nodes);
});
