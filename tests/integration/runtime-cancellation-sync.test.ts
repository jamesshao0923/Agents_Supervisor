import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import{mkdtemp,mkdir,realpath,rm,writeFile}from'node:fs/promises';
import{join}from'node:path';import{tmpdir}from'node:os';import{setTimeout as delay}from'node:timers/promises';
import{SupervisorStore}from'../../packages/persistence/store.js';
import{LocalRuntimeAdapter}from'../../packages/runtime/index.js';
import{readOwnership}from'../../packages/runtime/worker-ownership.js';
import{terminateProcess,inspectProcess,spawnManagedProcess}from'../../packages/process-control/index.js';
import{ExecutionManager}from'../../packages/execution/manager.js';
import type{RuntimeStep}from'../../packages/contracts/p3.js';
async function fixture(t:TestContext,steps:RuntimeStep[]=[{id:'wait',kind:'input',prompt:'Wait for explicit input'}]){
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-run-cancel-'))),data=join(root,'data'),workspace=join(root,'workspace');await mkdir(workspace);
 let store=new SupervisorStore(data);t.after(async()=>{const ownership=await readOwnership(data);if(ownership?.identity){assert.equal((await terminateProcess(ownership.identity)).stopped,true);assert.equal((await inspectProcess(ownership.identity)).status,'stopped');}store.close();await rm(root,{recursive:true,force:true});});
 const runtime=store.runtime.submit({type:'submit',commandId:'case',workspace,workspaceKind:'project',goal:'Real cancellation projection and accounting preservation',tokenLimit:100,verificationReserve:20,steps});
 return{root,data,workspace,runtime,get store(){return store;},restart(){store.close();store=new SupervisorStore(data);},cancelDomain(){const run=store.runtime.inspect(runtime.id).run;store.command({type:'act',commandId:'external-execution-cancel',projectId:run.projectId,runId:run.id,expectedRevision:run.revision,action:{type:'cancel'}});}};
}
test('P6-CANCEL-I01 real cancelled Run synchronizes queued runtime once and remains cancelled after SQLite reopen',async t=>{
 const f=await fixture(t);
 // A real independent writer holds the private database's write lock. This
 // ordinary read-only observation must not acquire BEGIN IMMEDIATE.
 const before=f.store.runtime.inspect(f.runtime.id),writerSource=`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');process.stdin.once('data',()=>{db.exec('ROLLBACK');db.close();process.exit(0);});`;
 const writer=await spawnManagedProcess({operationId:'cancel-i01-private-writer',command:process.execPath,args:['-e',writerSource,join(f.data,'supervisor.sqlite')],cwd:f.workspace,timeoutMs:10000,onBeforeSpawn:async intent=>{await writeFile(join(f.root,'writer-intent.json'),JSON.stringify(intent));},onIdentity:async identity=>{await writeFile(join(f.root,'writer-identity.json'),JSON.stringify(identity));}});
 let output='';const locked=new Promise<void>((resolve,reject)=>{writer.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('locked\n'))resolve();});writer.completion.then(()=>reject(new Error('Private writer exited before lock readiness')),reject);});
 try{await locked;assert.equal((await inspectProcess(writer.identity)).status,'verified');assert.deepEqual(f.store.runtime.synchronizeCancellation(f.runtime.id),before.runtime);assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);writer.writeLine('release');const ended=await writer.completion;assert.equal(ended.exitCode,0);assert.equal(ended.stop.stopped,true);assert.equal((await inspectProcess(writer.identity)).status,'stopped');}
 finally{if((await inspectProcess(writer.identity)).status!=='stopped')assert.equal((await writer.terminate()).stop.stopped,true);}
 f.cancelDomain();const original=f.store.runtime.inspect(f.runtime.id);assert.equal(original.runtime.cancelled,false);assert.equal(original.run.status,'cancelled');
 assert.equal(f.store.runtime.claim(f.runtime.id,'worker'),null);const current=f.store.runtime.inspect(f.runtime.id);assert.equal(current.runtime.phase,'cancelled');assert.equal(current.runtime.cancelled,true);assert.equal(current.operations[0]!.state,'cancelled');assert.deepEqual(current.run,original.run);const seq=current.runtime.projectionVersion;
 f.restart();assert.equal(f.store.runtime.synchronizeCancellation(f.runtime.id).projectionVersion,seq);assert.equal(f.store.runtime.events(f.runtime.id,0).filter(e=>e.kind==='run-cancellation-observed').length,1);assert.throws(()=>f.store.runtime.control({type:'resume',runtimeId:f.runtime.id,commandId:'illegal-resume'}),/Cancelled/);assert.deepEqual(f.store.runtime.inspect(f.runtime.id).run,original.run);
});
test('P6-CANCEL-I02 synchronizing cancelled claimed work retains unknown fees effects leases and immutable checkpoints',async t=>{
 const f=await fixture(t,[{id:'work',kind:'codex',prompt:'Never dispatched in this repository mechanism check',model:'not-called',effort:'low',reservation:30,timeoutMs:1000}]);const op=f.store.runtime.claim(f.runtime.id,'owner')!;assert.ok(op);f.cancelDomain();const before=f.store.runtime.inspect(f.runtime.id);
 f.store.runtime.synchronizeCancellation(f.runtime.id);const after=f.store.runtime.inspect(f.runtime.id);assert.deepEqual(after.run,before.run);assert.deepEqual(after.checkpoints,before.checkpoints);assert.deepEqual(after.operations,before.operations);assert.equal(after.run.attempts[0]!.settled,false);assert.equal(after.run.attempts[0]!.reservation,30);assert.equal(after.run.operations[0]!.status,'pending');assert.equal(after.run.leases[0]!.released,false);assert.equal(after.runtime.phase,'cancelled');assert.throws(()=>f.store.runtime.eligible(op.id,'owner'),/cancelled/);assert.equal(f.store.executionList().length,0);
});
test('P6-CANCEL-I03 real execution manager cancellation before process dispatch reports a cancelled runtime without a new attempt',async t=>{
 const f=await fixture(t,[{id:'work',kind:'codex',prompt:'Cancelled before any executor spawn',model:'not-called',effort:'low',reservation:30,timeoutMs:1000}]);const op=f.store.runtime.claim(f.runtime.id,'owner')!,binding=f.store.runtime.binding(op.id,'owner'),input=f.store.runtime.executionInput(op.id,'owner');const {record}=f.store.executionCreate({...input,workspace:f.workspace,workspaceKind:'project'},binding);const manager=new ExecutionManager(f.store,f.data);
 try{await manager.cancel(record.id,'Observed token usage reached the reserved attempt limit');const actual=f.store.executionGet(record.id);assert.equal(actual.state,'cancelled');assert.equal(actual.stopConfirmed,true);assert.match(actual.error!,/reserved attempt limit/);assert.equal(actual.identity,null);assert.notEqual(actual.turnIntent,true);assert.ok(!f.store.executionEvents(record.id,0).some(e=>e.kind==='process-intent'));
 const reported=f.store.runtime.report(op.id,'owner',{messageId:'actual-cancel-report',outcome:'cancelled',result:{executionId:actual.id,state:actual.state,stopConfirmed:actual.stopConfirmed},error:actual.error!});assert.equal(reported.phase,'cancelled');assert.equal(reported.cancelled,true);const inspection=f.store.runtime.inspect(f.runtime.id);assert.equal(inspection.run.status,'cancelled');assert.equal(inspection.run.attempts.length,1);assert.equal(inspection.run.attempts[0]!.actual,0);assert.equal(inspection.run.attempts[0]!.settled,true);assert.equal(inspection.runtime.cursor,0);assert.ok(inspection.checkpoints.every(c=>c.valid));
 }finally{await manager.close();}
});
test('P6-CANCEL-I04 actual managed worker converges externally cancelled input task and preserves cancellation through restart',{timeout:20000},async t=>{
 const f=await fixture(t),adapter=new LocalRuntimeAdapter(f.store,f.data);try{await adapter.ensureWorker();f.cancelDomain();const deadline=Date.now()+6000;while(f.store.runtime.get(f.runtime.id).phase!=='cancelled'){assert.ok(Date.now()<deadline,'Actual worker failed to reconcile cancellation');await delay(30);}assert.equal(f.store.runtime.get(f.runtime.id).cancelled,true);assert.equal(f.store.executionList().length,0);
 const ownership=await readOwnership(f.data);assert.ok(ownership?.identity);assert.equal((await terminateProcess(ownership.identity)).stopped,true);await adapter.ensureWorker();assert.equal(f.store.runtime.get(f.runtime.id).phase,'cancelled');assert.equal(f.store.runtime.events(f.runtime.id,0).filter(e=>e.kind==='run-cancellation-observed').length,1);assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts.length,0);
 }finally{await adapter.close();}
});

// The managed child is real and remains alive. Only the absent-stop observation
// is injected at the finalization boundary; this is not a provider failure claim.
test('P6-CANCEL-I05 cancelled domain never converts an unconfirmed actual live process stop into terminal execution',async t=>{
 const f=await fixture(t,[{id:'work',kind:'codex',prompt:'Explicit managed Node stop mechanism check',model:'not-called',effort:'low',reservation:30,timeoutMs:1000}]),op=f.store.runtime.claim(f.runtime.id,'owner')!,binding=f.store.runtime.binding(op.id,'owner'),input=f.store.runtime.executionInput(op.id,'owner'),record=f.store.executionCreate({...input,workspace:f.workspace,workspaceKind:'project'},binding).record;
 const child=await spawnManagedProcess({operationId:record.id,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.workspace,timeoutMs:10000,onBeforeSpawn:intent=>{f.store.executionUpdate(record.id,{},'process-intent',intent);},onIdentity:identity=>{f.store.executionUpdate(record.id,{state:'running',identity,pid:identity.pid,turnIntent:true},'process-identity',{fixture:'actual Node process; no model or real provider turn'});}}),manager=new ExecutionManager(f.store,f.data);
 try{assert.equal((await inspectProcess(child.identity)).status,'verified');f.cancelDomain();await Reflect.get(manager,'finalize').call(manager,record.id,'unknown',false,{fixture:'Stop not obtained; real process alive'},true,false);const actual=f.store.executionGet(record.id);assert.equal(actual.state,'unknown');assert.equal(actual.stopConfirmed,false);assert.equal((await inspectProcess(child.identity)).status,'verified');const run=f.store.runtime.inspect(f.runtime.id).run;assert.equal(run.attempts[0]!.settled,false);assert.equal(run.leases[0]!.released,false);assert.equal(run.operations[0]!.status,'unknown');
 }finally{assert.equal((await terminateProcess(child.identity)).stopped,true);await child.completion;await manager.close();}
});
