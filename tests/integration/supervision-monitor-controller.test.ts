import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {runtimeCanonical} from '../../packages/persistence/runtime.js';
import {SupervisionMonitorController} from '../../packages/orchestration/supervision-monitor-controller.js';
import {SupervisionController} from '../../packages/orchestration/supervision-controller.js';
import {LocalRuntimeAdapter} from '../../packages/runtime/index.js';
import {VerificationController} from '../../packages/verification/controller.js';
import {spawnManagedProcess,inspectProcess,type ManagedProcess} from '../../packages/process-control/index.js';
import type {GoalProposal} from '../../packages/contracts/p5.js';
import type {RuntimeRecord} from '../../packages/contracts/p3.js';

// Actual controllers, SQLite and managed Node processes. Stored old epochs and
// model-start markers are explicit restart/mechanism fixtures, never evidence
// that a 300-second model window or a real Codex invocation occurred. No transport
// or runtime is mocked and no test below calls a model.
const config={model:'must-not-launch-monitor-mechanism',effort:'low',reservation:30,timeoutMs:1000};
async function fixture(t:TestContext,options:{historical?:boolean;structured?:boolean}={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-monitor-controller-'))),data=join(root,'data'),workspace=join(root,'workspace');await mkdir(workspace);
  const store=new SupervisorStore(data),db=new DatabaseSync(join(data,'supervisor.sqlite')),children:ManagedProcess[]=[];
  let runtime:RuntimeRecord;
  if(options.structured){
    const start=store.goals.start({type:'start',commandId:randomUUID(),goal:'Obtain the required input',tokenLimit:1000,verificationReserve:100,...config},workspace,'project');
    const proposal:GoalProposal={decision:'ready',summary:'Explicit repository goal fixture',questions:[],facts:[{text:start.session.goal,origin:'explicit',sourceId:start.session.messages[0]!.id}],constraints:[],style:[],criteria:[{id:'input',description:'Obtain the required input',kind:'command',target:'input',checks:['Input is present']}],steps:[{id:'implement',description:'Obtain input',dependencies:[],acceptanceIds:['input']}]};
    const ready=store.goals.finish(start.session.id,start.session.jobs[0]!.id,job=>{job.usage=0;job.stopConfirmed=true;job.proposal=proposal;});
    const admitted=store.goals.control({type:'admit',commandId:randomUUID(),sessionId:ready.session.id,expectedRevision:ready.session.revision});
    runtime=store.runtime.revise({commandId:randomUUID(),runtimeId:admitted.session.runtimeId!,expectedContractVersion:admitted.run.contract.version,contract:{...admitted.run.contract,version:admitted.run.contract.version+1},nodes:[{id:'input',required:true,dependencies:[]}],steps:[{id:'input',kind:'input',prompt:'Wait for actual user input'}],reason:'Explicit timer mechanism fixture; no model execution'});
  }else runtime=store.runtime.submit({type:'submit',commandId:'runtime',workspace,workspaceKind:'project',goal:'Observe current durable execution facts',tokenLimit:1000,verificationReserve:100,steps:[{id:'work',kind:'codex',prompt:'Actual managed Node writer fixture, not a model',...config},{id:'next',kind:'input',prompt:'Next boundary input'}]});
  const loop=store.supervision.attach({commandId:'loop',runtimeId:runtime.id,config,limits:{maxRepairs:1,maxReasoningCalls:5,maxDurationMs:2_000_000,maxContextChars:200000}});
  if(options.historical){loop.createdAt=new Date(Date.now()-300100).toISOString();db.prepare('UPDATE supervision_loops SET record=? WHERE id=?').run(runtimeCanonical(loop),loop.id);}
  let monitor=new SupervisionMonitorController(store,data);monitor.ensure(loop.id);
  const adapter=new LocalRuntimeAdapter(store,data),verification=new VerificationController(store,data);let main:SupervisionController|null=null;
  t.after(async()=>{await main?.close();await monitor.close();await verification.close();await adapter.close();for(const child of children){await child.terminate();await child.completion;}db.close();store.close();await rm(root,{recursive:true,force:true});});
  async function writer(){
    const operation=store.runtime.claim(runtime.id,'mechanism-owner')!,binding=store.runtime.binding(operation.id,'mechanism-owner');assert.ok(operation);
    const receipt=store.executionCreate({type:'start',commandId:operation.id,workspace,workspaceKind:'project',prompt:'Actual Node writer; no model',...config,tokenLimit:1000,verificationReserve:100},binding).record;
    const child=await spawnManagedProcess({operationId:receipt.id,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:workspace,timeoutMs:20000,onBeforeSpawn:intent=>{store.executionUpdate(receipt.id,{},'mechanism-intent',intent);},onIdentity:identity=>{store.executionUpdate(receipt.id,{state:'running',identity,pid:identity.pid},'mechanism-process',{kind:'real-node-not-model'});}});children.push(child);store.runtime.markStarted(operation.id,'mechanism-owner');
    async function finish(){await child.terminate();await child.completion;store.executionUpdate(receipt.id,{state:'completed',stopConfirmed:true,usageStatus:'reported',usage:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0}},'mechanism-complete',{kind:'Node process ended; no model usage'},[{type:'finishAttempt',attemptId:receipt.id,outcome:'succeeded'},{type:'settleAttempt',attemptId:receipt.id,actual:0},{type:'releaseLease',attemptId:receipt.id,resource:'workspace:'+workspace},{type:'setOperation',operationId:receipt.id,attemptId:receipt.id,status:'confirmed'}]);store.runtime.report(operation.id,'mechanism-owner',{messageId:randomUUID(),outcome:'confirmed',result:'Actual Node ended'});}
    return {operation,receipt,child,finish};
  }
  function begin(){const refs=monitor.evidenceRefs(loop.id),current=store.supervision.get(loop.id);store.supervisionMonitor.observe({commandId:randomUUID(),loopId:loop.id,expectedRevision:current.revision,input:{nowMs:Date.now(),lifecycle:'active',evidenceCursor:store.supervisionMonitor.cursor(loop.id,refs)},evidenceRefs:refs});return store.supervisionMonitor.beginInspection({commandId:randomUUID(),loopId:loop.id,expectedRevision:store.supervision.get(loop.id).revision,prompt:'Explicit frozen repository inspection fixture, never dispatched to a model',evidenceRefs:refs});}
  return {root,data,workspace,store,db,runtime,loop,children,writer,begin,get monitor(){return monitor;},async reopenMonitor(){await monitor.close();monitor=new SupervisionMonitorController(store,data);await monitor.initialize();},main(){main??=new SupervisionController(store,data,adapter,verification);return main;}};
}
async function waitFor(predicate:()=>boolean,timeout:number){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail('Expected real asynchronous state before deadline');}

test('P6-MCTL-I01 attach baseline and service monitor restart retain the real epoch without model allocation',{timeout:15000},async t=>{
  const f=await fixture(t),before=f.store.supervisionMonitor.envelope(f.loop.id)!;await f.monitor.tick(f.loop.id);await f.reopenMonitor();await f.monitor.tick(f.loop.id);const after=f.store.supervisionMonitor.envelope(f.loop.id)!;
  assert.equal(after.state.startedAtMs,before.state.startedAtMs);assert.equal(after.state.lastCheckedEvidenceCursor,before.state.lastCheckedEvidenceCursor);assert.equal(after.activeJobId,null);assert.equal(f.store.supervision.jobs(f.loop.id).length,0);assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,0);

  // Hold only the return of the actual monitor tick after its SQLite observation;
  // the controller, dependency reads and all effects still run normally. No fake
  // time, transport or successful business outcome is introduced by this barrier.
  const live=await fixture(t,{structured:true}),main=live.main();
  const actual=(main as unknown as {monitor:SupervisionMonitorController}).monitor;
  const original=actual.tick.bind(actual);
  function barrier(){let release!:()=>void;const promise=new Promise<void>(yes=>{release=yes;});return {promise,release};}
  const firstEntered=barrier(),firstRelease=barrier(),nextEntered=barrier(),nextRelease=barrier(),closingEntered=barrier(),closingRelease=barrier();
  let calls=0,nextObservedCursor:string|null=null,actionFinished=false;
  actual.tick=async loopId=>{
    const result=await original(loopId);calls++;
    if(calls===1){firstEntered.release();await firstRelease.promise;}
    else if(calls===2){nextObservedCursor=live.store.supervisionMonitor.cursor(loopId,actual.evidenceRefs(loopId));nextEntered.release();await nextRelease.promise;}
    else if(calls===3){closingEntered.release();await closingRelease.promise;}
    return result;
  };
  let current:Promise<void>|undefined,next:Promise<void>|undefined,action:Promise<unknown>|undefined;
  try{
    current=main.scan();assert.equal(main.scan(),current,'Not-yet-started requests share one actual pass');
    await firstEntered.promise;
    const priorCursor=live.store.supervisionMonitor.cursor(live.loop.id,actual.evidenceRefs(live.loop.id));
    live.store.runtime.control({type:'input',runtimeId:live.runtime.id,commandId:randomUUID(),stepId:'input',text:'Actual user input received while the first observation is held'});
    const expectedCursor=live.store.supervisionMonitor.cursor(live.loop.id,actual.evidenceRefs(live.loop.id));
    assert.notEqual(expectedCursor,priorCursor,'Actual input updates the durable runtime phase and observation cursor');
    next=main.scan();assert.notEqual(next,current,'A request during a running pass waits for a fresh pass');
    assert.equal(main.scan(),next,'Requests during a running pass share only the dedicated next observation');
    let nextFinished=false;void next.then(()=>{nextFinished=true;});
    action=main.dispatch({type:'inspect',loopId:live.loop.id}).then(value=>{actionFinished=true;return value;});
    firstRelease.release();await current;await action;await nextEntered.promise;
    assert.equal(actionFinished,true,'An already queued public action runs before the next scan slot');
    assert.equal(nextObservedCursor,expectedCursor,'The next real observation sees the updated runtime input');
    assert.equal(nextFinished,false,'Next-pass promise cannot settle while its own actual tick is held');
    nextRelease.release();await next;assert.equal(nextFinished,true);
    assert.equal(calls,2,'The queued burst is exactly two real observations');
    assert.equal(live.store.supervision.jobs(live.loop.id).length,0);
    current=main.scan();await closingEntered.promise;next=main.scan();
    action=main.close();closingRelease.release();await Promise.all([current,next,action]);
    assert.equal(calls,3,'Close settles a retained next request without running another pass');
  }finally{
    firstRelease.release();nextRelease.release();closingRelease.release();actual.tick=original;
    await Promise.allSettled([current,next,action].filter((value):value is Promise<unknown>=>value!==undefined));
  }
});

test('P6-MCTL-I02 database evidence excludes paginated token noise but includes distinct normalized diffs and rejects capacity overflow',async t=>{
  const f=await fixture(t),writer=await f.writer();const baseline=f.store.supervisionMonitor.cursor(f.loop.id,f.monitor.evidenceRefs(f.loop.id));
  for(let i=0;i<505;i++)f.store.executionUpdate(writer.receipt.id,{},'codex-event',{kind:'token-usage',totalTokens:i});
  assert.equal(f.store.supervisionMonitor.cursor(f.loop.id,f.monitor.evidenceRefs(f.loop.id)),baseline);
  f.store.executionUpdate(writer.receipt.id,{},'codex-event',{kind:'diff',diff:'Actual recorded diff fixture A'});const refs=f.monitor.evidenceRefs(f.loop.id),changed=f.store.supervisionMonitor.cursor(f.loop.id,refs);assert.notEqual(changed,baseline);assert.equal(refs.filter(ref=>ref.kind==='execution-event').length,1);
  f.store.executionUpdate(writer.receipt.id,{},'codex-event',{kind:'diff',diff:'Actual recorded diff fixture A'});assert.deepEqual(f.monitor.evidenceRefs(f.loop.id),refs,'Duplicate facts retain the first original evidence reference');
  for(let i=0;i<129;i++)f.store.executionUpdate(writer.receipt.id,{},'codex-event',{kind:'diff',diff:'Distinct durable diff '+i});assert.throws(()=>f.monitor.evidenceRefs(f.loop.id),/capacity exceeded/);assert.equal(f.store.supervision.jobs(f.loop.id).length,0);
});

test('P6-MCTL-I03 a persisted due observation whose writer ended defers without leaving an in-flight reservation',async t=>{
  const f=await fixture(t,{historical:true}),writer=await f.writer(),refs=f.monitor.evidenceRefs(f.loop.id),loop=f.store.supervision.get(f.loop.id);
  f.store.supervisionMonitor.observe({commandId:'saved-window',loopId:loop.id,expectedRevision:loop.revision,input:{nowMs:Date.now(),lifecycle:'active',evidenceCursor:f.store.supervisionMonitor.cursor(loop.id,refs)},evidenceRefs:refs});assert.ok(f.store.supervisionMonitor.envelope(loop.id)!.state.inFlight);
  await writer.finish();await f.monitor.tick(loop.id);const envelope=f.store.supervisionMonitor.envelope(loop.id)!;assert.equal(envelope.state.inFlight,null);assert.equal(envelope.activeJobId,null);assert.equal(f.store.supervision.jobs(loop.id).length,0);assert.equal(f.store.supervision.get(loop.id).reasoningCount,0);assert.equal(f.monitor.inspect(loop.id).events.at(-1)!.record.disposition,'discarded-by-runner');
});

test('P6-MCTL-I04 restart preserves unknown inspection usage and blocks replay while the actual writer is left alone',async t=>{
  const f=await fixture(t,{historical:true}),writer=await f.writer(),job=f.begin();f.store.supervision.observeJob(job.id,{modelStarted:true,observedUsage:7});
  await f.reopenMonitor();await assert.rejects(f.monitor.tick(f.loop.id),/unknown|unresolved/i);const saved=f.store.supervision.job(job.id);assert.equal(saved.status,'finished');assert.equal(saved.usage,null);assert.equal(saved.identities.length,0);assert.equal(f.store.supervisionMonitor.envelope(f.loop.id)!.activeJobId,job.id);assert.equal((await inspectProcess(writer.child.identity)).status,'verified');assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts.find(attempt=>attempt.id===job.id)!.settled,false);assert.equal(f.store.supervision.jobs(f.loop.id).length,1);assert.equal(f.monitor.inspect(f.loop.id).events.filter(event=>event.jobId===job.id&&event.kind==='disposition').length,1);
});

test('P6-MCTL-I05 writer completion drains an actual pre-turn inspection process before the next workflow node can start',async t=>{
  const f=await fixture(t,{historical:true}),writer=await f.writer(),job=f.begin(),privateCwd=join(f.root,'private-inspector');await mkdir(privateCwd);
  const child=await spawnManagedProcess({operationId:job.id+'-pre-turn',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:privateCwd,timeoutMs:15000,onBeforeSpawn:intent=>{f.store.supervision.observeJob(job.id,{intents:[intent]});},onIdentity:identity=>{f.store.supervision.observeJob(job.id,{identities:[identity]});}});f.children.push(child);
  await writer.finish();f.store.runtime.control({type:'input',runtimeId:f.runtime.id,commandId:randomUUID(),stepId:'next',text:'Ready'});const before=f.store.runtime.inspect(f.runtime.id);assert.equal(f.store.runtime.claim(f.runtime.id,'next-owner'),null);assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);
  const decision=await f.monitor.tick(f.loop.id);assert.equal(decision.waiting,false);const saved=f.store.supervision.job(job.id);assert.equal(saved.usage,0);assert.equal(saved.modelStarted,false);assert.equal(saved.stopConfirmed,true);assert.equal((await inspectProcess(child.identity)).status,'stopped');assert.equal(f.store.supervisionMonitor.envelope(f.loop.id)!.activeJobId,null);assert.equal(f.store.supervision.get(f.loop.id).phase,'executing');
  assert.ok(f.store.runtime.claim(f.runtime.id,'next-owner'));
});

test('P6-MCTL-I06 a future persisted observation explicitly blocks the main loop when the real clock is behind it',async t=>{
  const f=await fixture(t,{structured:true}),loop=f.store.supervision.get(f.loop.id),monitor=f.store.supervisionMonitor.envelope(loop.id)!;monitor.state.lastObservedAtMs=Date.now()+60000;
  // Durable chronology fixture, not a patched clock or a shortened interval.
  f.store.supervision.update(loop.id,loop.revision,{monitor});await f.main().scan();const blocked=f.store.supervision.get(loop.id);assert.equal(blocked.phase,'blocked');assert.match(blocked.reason!,/time moved backwards/);assert.equal(f.store.supervision.jobs(loop.id).length,0);assert.equal(f.store.runtime.get(f.runtime.id).phase,'waiting-input');
});

test('P6-MCTL-I07 one real wake timer records four consecutive 10–15-second health intervals and pause/resume without model allocation',{timeout:110000},async t=>{
  const f=await fixture(t,{structured:true}),epoch=f.store.supervisionMonitor.envelope(f.loop.id)!.state.startedAtMs;
  const health=()=>{const events=f.store.supervisionMonitor.events(f.loop.id).filter(event=>event.kind==='health');evidence.observed=events.map(event=>Date.parse(event.record.observedAt));return events;};
  const observed=()=>health().map(event=>Date.parse(event.record.observedAt));
  const evidence:{epoch:number;began:number;pauseAt?:number;resumeAt?:number;finishedAt?:number;observed?:number[];gaps?:number[]}={epoch,began:Date.now()};
  t.after(()=>{evidence.finishedAt=Date.now();console.log(JSON.stringify({healthCadence:evidence}));});
  await f.main().initialize();
  await waitFor(()=>health().length>=5,75000);
  const first=observed(),gaps=first.slice(1).map((at,index)=>at-first[index]!);evidence.gaps=gaps;
  assert.ok(first[0]!-epoch>=10000&&first[0]!-epoch<=15000,'The first real health observation meets the new 10-second target with bounded wake slack');
  assert.ok(gaps.length>=4,'At least four consecutive real automatic timer intervals are required');
  for(const gap of gaps)assert.ok(gap>=10000&&gap<=15000,'Every unpaused real health interval must remain within 10–15 seconds: '+gap);
  assert.equal(f.store.supervisionMonitor.events(f.loop.id).filter(event=>event.kind==='window').length,0);
  assert.equal(f.store.supervision.jobs(f.loop.id).length,0);
  assert.equal(f.store.runtime.get(f.runtime.id).phase,'waiting-input');
  assert.equal(f.main().inspect(f.loop.id).capabilities.modelMonitoring,true);
  assert.equal(f.main().inspect(f.loop.id).capabilities.scanIntervalMs,2000);
  assert.equal(f.main().inspect(f.loop.id).capabilities.healthIntervalMs,10000);
  assert.equal(f.main().inspect(f.loop.id).monitor!.envelope!.state.startedAtMs,epoch);
  evidence.pauseAt=Date.now();await f.main().dispatch({type:'pause',loopId:f.loop.id});const pausedCount=health().length;
  await new Promise(resolve=>setTimeout(resolve,12000));
  assert.equal(health().length,pausedCount,'The actual timer does not record health while paused');
  evidence.resumeAt=Date.now();await f.main().dispatch({type:'resume',loopId:f.loop.id});
  assert.equal(health().length,pausedCount+1,'Resume records one actual due observation, never replays missed wakes');
  assert.ok(observed().at(-1)!>=evidence.resumeAt);
  await waitFor(()=>health().length>=pausedCount+2,15000);
  const after=observed();assert.equal(after.length,pausedCount+2);
  assert.ok(after.at(-1)!-after.at(-2)!>=10000&&after.at(-1)!-after.at(-2)!<=15000,'Automatic health resumes without a burst');
  assert.equal(f.store.supervisionMonitor.envelope(f.loop.id)!.state.startedAtMs,epoch);
  assert.equal(f.store.supervisionMonitor.events(f.loop.id).filter(event=>event.kind==='window').length,0);
  assert.equal(f.store.supervision.jobs(f.loop.id).length,0);
  assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,0);
  assert.equal(f.store.runtime.get(f.runtime.id).phase,'waiting-input');
});
