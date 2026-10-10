import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {ExecutionManager,readExecutionEventsThrough} from '../../packages/execution/manager.js';
import {CodexAdapter,type NormalizedEvent} from '../../packages/executor-codex/index.js';
import {spawnManagedProcess,inspectProcess,type ManagedProcess} from '../../packages/process-control/index.js';
import type {Run} from '../../packages/contracts/p1.js';
/** Explicit synthetic protocol via a real managed Node child + actual adapter,
 * manager, process identity, SQLite/events/accounting. Never vendor-live evidence. */
async function fixture(t:TestContext, options:{retry:boolean;terminal:'completed'|'failed'|null;legacy?:boolean;fatal?:boolean;filler?:number}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-ex-warning-'))),data=join(root,'data'),workspace=join(root,'workspace');await mkdir(data);await mkdir(workspace);
 let store=new SupervisorStore(data);const manager=new ExecutionManager(store,data,'not-invoked-synthetic-fixture');
 const record=store.executionCreate({type:'start',commandId:'fixture',workspace,workspaceKind:'project',prompt:'Explicit synthetic protocol mechanism, not Codex outcome evidence',model:'synthetic-not-invoked',effort:'low',timeoutMs:10000,tokenLimit:100,reservation:60,verificationReserve:20}).record;
 const internal=manager as unknown as {active:Map<string,{process:ManagedProcess;adapter:CodexAdapter;launchedTurn:boolean}>;onEvent:(id:string,event:NormalizedEvent)=>void;finish:(id:string)=>Promise<void>};
 const emit=(method:string,params:object)=>JSON.stringify({method,params});
 const usage={inputTokens:10,cachedInputTokens:0,outputTokens:7,reasoningOutputTokens:0,totalTokens:17};
 const notifications=[emit('error',{threadId:'thread',turnId:'turn',error:{message:'Reconnecting... 5/5'},willRetry:options.retry})];
 for(let n=0;n<(options.filler??0);n++)notifications.push(emit('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'item',delta:'explicit filler '+n}));
 if(options.terminal)notifications.push(emit('thread/tokenUsage/updated',{threadId:'thread',turnId:'turn',tokenUsage:{total:usage,last:usage}}),emit('turn/completed',{threadId:'thread',turn:{id:'turn',status:options.terminal,items:[],error:options.terminal==='failed'?{message:'Actual synthetic terminal failure'}:null}}));
 const source=`process.stdin.once('data',()=>{for(const line of ${JSON.stringify(notifications)})process.stdout.write(line+'\\n');});setInterval(()=>{},1000);`;
 const child=await spawnManagedProcess({operationId:record.id,command:process.execPath,args:['-e',source],cwd:workspace,timeoutMs:10000,onBeforeSpawn:intent=>{store.executionUpdate(record.id,{state:'running',turnIntent:true},'process-intent',intent);},onIdentity:identity=>{store.executionUpdate(record.id,{identity,pid:identity.pid},'process-identity',identity);}});
 const lines=createInterface({input:child.stdout});let warningsObserved=0;
 const adapter=new CodexAdapter({transport:{write:line=>{child.stdin.write(line);},onLine:callback=>{lines.on('line',callback);return()=>{lines.off('line',callback);};},onClose:callback=>{const close=()=>callback('real managed stdout closed');lines.on('close',close);return()=>{lines.off('close',close);};}},onRawEvent:event=>{store.executionUpdate(record.id,{},'codex-raw',event);},onEvent:event=>{
  internal.onEvent(record.id,event);
  if(event.kind==='error'){
   warningsObserved++;assert.equal(store.executionGet(record.id).state,'running');
   if(options.retry)assert.equal(store.executionGet(record.id).error,null);
   if(options.legacy)store.executionUpdate(record.id,{error:JSON.stringify(event.raw.params)},'legacy-diagnostic-projection',{reason:'Replay prior manager record projection only; real protocol raw is unchanged'});
   if(options.fatal)store.executionUpdate(record.id,{error:JSON.stringify(event.raw.params)},'execution-error',{message:'Explicit controller fatal boundary fixture'});
  }
 }});
 internal.active.set(record.id,{process:child,adapter,launchedTurn:true});
 t.after(async()=>{adapter.dispose();await child.terminate();await manager.close();store.close();await rm(root,{recursive:true,force:true});});child.stdin.write('emit\n');
 const until=async(test:()=>boolean)=>{const end=Date.now()+5000;while(!test()){if(Date.now()>end)throw Error('actual mechanism did not converge');await delay(15);}};
 await until(()=>warningsObserved===1);
 if(!options.terminal)await internal.finish(record.id);
 await until(()=>store.executionGet(record.id).stopConfirmed);
 const final=store.executionGet(record.id),events=readExecutionEventsThrough(record.id,final.lastEventSeq,after=>store.executionEvents(record.id,after))!,run=store.query({type:'run',projectId:final.projectId,runId:final.runId}) as Run;
 assert.equal((await inspectProcess(child.identity)).status,'stopped');
 return {final,events,run,reconcile:()=>manager.reconcile(record.id),raceResolve:()=>Promise.all([manager.reconcile(record.id),new ExecutionManager(store,data,'not-invoked').reconcile(record.id)]),readEvents:()=>{const current=store.executionGet(record.id);return readExecutionEventsThrough(record.id,current.lastEventSeq,after=>store.executionEvents(record.id,after))!;},restoreLegacyError:(unknownUsage=false)=>{const warning=events.find(e=>e.kind==='codex-event'&&(e.payload as NormalizedEvent).kind==='error')!.payload as NormalizedEvent;return store.executionUpdate(record.id,{error:JSON.stringify(warning.raw.params),...(unknownUsage?{usageStatus:'unknown' as const}:{})},'legacy-confirmed-diagnostic-projection',{reason:'Old completed record projection fixture; no new vendor success or accounting fact'});},staleCAS:(seq:number)=>store.executionUpdate(record.id,{error:'must not overwrite'},'must-not-be-appended',{},[],seq),reopen:()=>{const reopened=new SupervisorStore(data);try{return reopened.executionGet(record.id);}finally{reopened.close();}}};
}
test('P6-EXEC-WARN-I01 synthetic retry diagnostics survive actual events while authoritative completion settles without final error',async t=>{
 const f=await fixture(t,{retry:true,terminal:'completed'});assert.equal(f.final.state,'completed');assert.equal(f.final.error,null);assert.equal(f.final.usageStatus,'reported');assert.equal(f.run.attempts[0]!.actual,17);assert.equal(f.run.attempts[0]!.status,'succeeded');assert.equal(f.run.attempts[0]!.settled,true);
 assert.ok(f.events.some(e=>e.kind==='codex-event'&&(e.payload as NormalizedEvent).willRetry===true));assert.ok(f.events.some(e=>e.kind==='codex-raw'&&JSON.stringify(e.payload).includes('Reconnecting')));assert.deepEqual(f.reopen(),f.final);
});
test('P6-EXEC-WARN-I02 synthetic failed terminal and stopped unknown outcome retain failure or unsettled usage rather than becoming success',async t=>{
 const failed=await fixture(t,{retry:false,terminal:'failed'});assert.equal(failed.final.state,'failed');assert.match(failed.final.error!,/Reconnecting/);assert.equal(failed.run.attempts[0]!.status,'failed');assert.equal(failed.run.attempts[0]!.settled,true);
 const unknown=await fixture(t,{retry:true,terminal:null});assert.equal(unknown.final.state,'interrupted');assert.equal(unknown.final.usageStatus,'unknown');assert.equal(unknown.run.attempts[0]!.settled,false);assert.equal(unknown.run.operations[0]!.status,'unknown');
});
test('P6-EXEC-WARN-I03 matching legacy diagnostic is cleared only by same successful stopped turn and never clears fatal controller evidence',async t=>{
 const legacy=await fixture(t,{retry:true,terminal:'completed',legacy:true});assert.equal(legacy.final.error,null);assert.ok(legacy.events.some(e=>e.kind==='execution-stopped'&&Object.hasOwn(e.payload as object,'resolvedDiagnosticEventSeq')));assert.deepEqual(legacy.reopen(),legacy.final);
 const older=legacy.restoreLegacyError(),beforeEvents=legacy.readEvents();assert.notEqual(older.error,null);await legacy.raceResolve();const repaired=legacy.reopen();assert.equal(repaired.error,null);assert.equal(legacy.readEvents().filter(e=>e.kind==='execution-diagnostic-resolved').length,1);assert.deepEqual(legacy.readEvents().slice(0,beforeEvents.length),beforeEvents);assert.deepEqual(repaired.usage,legacy.final.usage);assert.equal(repaired.state,legacy.final.state);await legacy.reconcile();assert.equal(legacy.readEvents().filter(e=>e.kind==='execution-diagnostic-resolved').length,1);const total=legacy.readEvents().length;assert.equal(legacy.staleCAS(older.lastEventSeq).error,null);assert.equal(legacy.readEvents().length,total);
 legacy.restoreLegacyError(true);assert.notEqual((await legacy.reconcile()).error,null);
 const fatal=await fixture(t,{retry:true,terminal:'completed',legacy:true,fatal:true});assert.notEqual(fatal.final.error,null);assert.ok(fatal.events.some(e=>e.kind==='execution-error'));await fatal.reconcile();assert.notEqual(fatal.reopen().error,null);assert.equal(fatal.readEvents().filter(e=>e.kind==='execution-diagnostic-resolved').length,0);
 const nonretry=await fixture(t,{retry:false,terminal:'completed'});assert.notEqual(nonretry.final.error,null);nonretry.restoreLegacyError();assert.notEqual((await nonretry.reconcile()).error,null);
});

test('P6-EXEC-WARN-I04 legacy resolution reaches actual completion beyond 500 events and preserves the full warning trajectory exactly once',async t=>{
 const f=await fixture(t,{retry:true,terminal:'completed',legacy:true,filler:350});
 assert.equal(f.final.error,null);assert.ok(f.events.length>500);const success=f.events.find(e=>e.kind==='codex-event'&&(e.payload as NormalizedEvent).kind==='turn-status');assert.ok(success&&success.seq>500);
 const old=f.restoreLegacyError(),before=f.readEvents();assert.notEqual(old.error,null);await f.raceResolve();assert.equal(f.reopen().error,null);assert.deepEqual(f.readEvents().slice(0,before.length),before);assert.equal(f.readEvents().filter(e=>e.kind==='execution-diagnostic-resolved').length,1);await f.reconcile();assert.equal(f.readEvents().filter(e=>e.kind==='execution-diagnostic-resolved').length,1);
});
