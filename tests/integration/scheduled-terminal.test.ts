import {LocalRuntimeAdapter} from '../../packages/runtime/index.js';
import {readOwnership} from '../../packages/runtime/worker-ownership.js';
import {terminateProcess} from '../../packages/process-control/index.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {TaskSchedulerRepository,SCHEDULED_MIGRATION_SQL} from '../../packages/persistence/task-scheduler.js';
import {TaskResultRepository} from '../../packages/persistence/task-results.js';
import {createScheduledDispatch} from '../../packages/domain/scheduled-dispatch.js';
import {spawnManagedProcess} from '../../packages/process-control/index.js';
import {ExecutionManager} from '../../packages/execution/manager.js';
import {setTimeout as delay} from 'node:timers/promises';
import type {ExecutionRecord} from '../../packages/contracts/p2.js';
import {applyAction} from '../../packages/domain/index.js';
import {createTaskResultDomain} from '../../packages/domain/task-results.js';
import type {Run} from '../../packages/contracts/p1.js';
import type {ScheduledPlan,ScheduledClaim} from '../../packages/contracts/p7-dispatch.js';
import type {ResultAction,TaskResultManifest} from '../../packages/contracts/p7-results.js';
const sha256=(s:string)=>createHash('sha256').update(s).digest('hex'),domain=createScheduledDispatch({sha256});
async function fixture(t:TestContext){
 const cleanups:(()=>Promise<void>)[]=[];
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-scheduled-'))),data=join(root,'data');await mkdir(data);const store=new SupervisorStore(data),db=new DatabaseSync(join(data,'supervisor.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');const repository=new TaskSchedulerRepository(db,data),results=new TaskResultRepository(db,data);
 t.after(async()=>{for(const cleanup of cleanups)await cleanup();db.close();store.close();await rm(root,{recursive:true,force:true});});
 const workspace=join(root,'integration');await mkdir(workspace);const runtime=store.runtime.submit({type:'submit',commandId:'original',workspace,workspaceKind:'project',goal:'Same required criterion',tokenLimit:100,verificationReserve:30,steps:[{id:'integrate',kind:'codex',prompt:'Integrate after branches',model:'mechanism-no-model',effort:'low',reservation:10,timeoutMs:10000}]});
 results.initializeScope({commandId:'results',projectId:runtime.projectId,runId:runtime.runId});
 const run=()=>JSON.parse(String(db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(runtime.projectId,runtime.runId)!.snapshot)) as Run;
 const required=run().contract.criteria.filter(c=>c.required).map(c=>c.id);assert.ok(required.length);
 const plan:ScheduledPlan={schemaVersion:1,engine:'scheduled-v1',workflowVersion:2,id:'scheduled',runtimeId:runtime.id,projectId:runtime.projectId,runId:runtime.runId,revision:1,contractVersion:run().contract.version,contractDigest:domain.digest(run().contract),integrationNodeId:'integrate',tasks:[],tier:'low',loops:[],limits:{maxActive:2,maxNodes:10,maxDepth:3,deadlineMs:Date.now()+100000}};
 for(const id of ['A','B','C']){const workspace=join(root,id);await mkdir(workspace);plan.tasks.push({node:{id,dependencies:[],required:true,admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:required,quality:'strong',value:'strong',reasons:['Frozen same contract decomposition']},resources:[{kind:'path',key:workspace,mode:'write'}],reservation:20,loopIds:[]},inputRequirements:[],step:{id,kind:'codex',prompt:'Mechanism only no model invoked',model:'mechanism-no-model',effort:'low',reservation:20,timeoutMs:10000},workspace,workspaceKind:'project',generation:1});}
 const install=(p=plan)=>repository.install({commandId:'install',plan:p,expectedRunRevision:run().revision,expectedResultRevision:results.inspect(p).revision});
 const claim=(commandId='claim',owner='owner')=>repository.claim({commandId,id:plan.id,expected:repository.expected(plan.id),owner});
 return {root,data,store,db,repository,results,run,plan,install,claim,cleanups};
}

import {ScheduledResultPublisher} from '../../packages/runtime/scheduled-publication.js';
import {inspectProcess} from '../../packages/process-control/index.js';
import {ScheduledRuntimeWorker} from '../../packages/runtime/scheduled-worker.js';
import {fixture as loopFixture} from '../helpers/scheduled-loop-fixture.js';
async function failActual(f:Awaited<ReturnType<typeof fixture>>,commandId:string){
 const c=f.claim(commandId);assert.equal(c.kind,'claimed');if(c.kind!=='claimed')throw Error('no actual claim');
 const binary=join(f.root,'actual-local-rejection');await writeFile(binary,'#!'+process.execPath+'\nprocess.exit(23);\n',{mode:0o700});
 const manager=new ExecutionManager(f.store,f.data,binary,{scope:'scheduled'});f.cleanups.push(()=>manager.close());const binding=f.repository.binding(c.claim.id,'owner'),{workspaceKind,...input}=f.repository.executionInput(c.claim.id);await manager.startScheduled(input,binding);
 const deadline=Date.now()+10000;while(!f.store.executionGet(c.claim.attemptId).stopConfirmed){assert.ok(Date.now()<deadline);await delay(20);}
 const e=f.store.executionGet(c.claim.attemptId);assert.equal(e.state,'failed');assert.equal(e.usageStatus,'reported');assert.equal(e.usage!.totalTokens,0);
 await f.repository.reconcileExecution({commandId:commandId+':actual-stop',claimId:c.claim.id,executionId:e.id});return c.claim;
}
const observe=(f:Awaited<ReturnType<typeof fixture>>,commandId:string)=>f.repository.reconcileTerminal({commandId,id:f.plan.id,expected:f.repository.expected(f.plan.id)});
test('P7-TERM-I01 actual stopped failed required branch propagates blocked once through worker without fee reset or delivery',async t=>{
 const f=await fixture(t);f.plan.tasks=f.plan.tasks.slice(0,1);f.install();const c=await failActual(f,'failed'),before=f.run();
 const worker=new ScheduledRuntimeWorker(f.store,f.data,'owner');f.cleanups.push(()=>worker.close());await worker.tick();
 assert.equal(f.repository.get(f.plan.id).state,'blocked');assert.equal(f.store.runtime.get(f.plan.runtimeId).phase,'blocked');assert.match(f.store.runtime.get(f.plan.runtimeId).error!,/cannot satisfy integration/);assert.equal(f.run().status,'blocked');assert.deepEqual(f.run().budget,before.budget);assert.deepEqual(f.run().contract,before.contract);assert.deepEqual(f.run().attempts,before.attempts);assert.equal(f.run().artifact,null);assert.equal(f.store.verification.list('delivery').length,0);assert.equal(f.repository.operation(c.operationId).state,'failed');
 const frozen=JSON.stringify(f.run());await worker.tick();assert.equal(JSON.stringify(f.run()),frozen);
 const reopen=new SupervisorStore(f.data);try{assert.equal(reopen.scheduler.get(f.plan.id).state,'blocked');assert.equal(reopen.runtime.get(f.plan.runtimeId).phase,'blocked');}finally{reopen.close();}
 f.store.runtime.control({type:'pause',commandId:'pause-blocked',runtimeId:f.plan.runtimeId});const paused=JSON.stringify(f.store.runtime.get(f.plan.runtimeId));assert.throws(()=>f.store.runtime.control({type:'resume',commandId:'resume-blocked',runtimeId:f.plan.runtimeId}),/cannot authorize retry/);assert.equal(JSON.stringify(f.store.runtime.get(f.plan.runtimeId)),paused);const cancelled=f.store.runtime.control({type:'cancel',commandId:'cancel-blocked',runtimeId:f.plan.runtimeId});assert.equal(cancelled.phase,'cancelled');assert.deepEqual(f.run().budget,before.budget);
 // A lowered tier cannot erase a genuinely attempted optional failure after
 // the required core has already published its actual bytes.
 const optional=await submittedFixture(t,100000,true);
 const core=optional.claim('core');await optional.complete(core);await optional.published(core);
 const failed=optional.claim('optional-failed');assert.equal(failed.taskId,'C');
 const binary=join(optional.root,'actual-optional-rejection');await writeFile(binary,'#!'+process.execPath+'\nprocess.exit(23);\n',{mode:0o700});
 const manager=new ExecutionManager(optional.store,optional.data,binary,{scope:'scheduled'});
 try{
  const binding=optional.scheduler.binding(failed.id,'owner'),{workspaceKind,...input}=optional.scheduler.executionInput(failed.id);
  await manager.startScheduled(input,binding);const deadline=Date.now()+10000;
  while(!optional.store.executionGet(failed.attemptId).stopConfirmed){assert.ok(Date.now()<deadline);await delay(20);}
  const actual=optional.store.executionGet(failed.attemptId);assert.equal(actual.state,'failed');assert.equal(actual.usageStatus,'reported');assert.equal(actual.usage!.totalTokens,0);
  await optional.scheduler.reconcileExecution({commandId:'actual-optional-stop',claimId:failed.id,executionId:actual.id});
  optional.scheduler.setExplorationTier({commandId:'lower-failed',id:optional.plan.id,expected:optional.scheduler.expected(optional.plan.id),tier:'low'});
  assert.equal(optional.scheduler.exploration(optional.plan.id).decision!.nodes.find(n=>n.taskId==='C')!.admitted,false);
  const budget=optional.run().budget;
  assert.equal(new ScheduledResultPublisher(optional.store).releaseIfReady(optional.plan.id),false);
  assert.throws(()=>optional.scheduler.releaseIntegration({commandId:'failed-cannot-disappear',id:optional.plan.id,expected:optional.scheduler.expected(optional.plan.id)}),/required or attempted branch not confirmed successful/);
  const terminal=await optional.scheduler.reconcileTerminal({commandId:'failed-optional-terminal',id:optional.plan.id,expected:optional.scheduler.expected(optional.plan.id)});
  assert.equal(terminal.kind,'blocked');assert.equal(terminal.known,true);assert.equal(optional.scheduler.get(optional.plan.id).fence,'held');assert.deepEqual(optional.run().budget,budget);
 }finally{await manager.close();}

});
test('P7-TERM-I02 failed sibling leaves unrelated legal frontier available until all required branches cannot continue',async t=>{
 const f=await fixture(t);f.plan.tasks=f.plan.tasks.slice(0,2);f.install();await failActual(f,'first');assert.equal((await observe(f,'frontier')).kind,'waiting');assert.equal(f.run().status,'ready');await failActual(f,'second');const expected=f.repository.expected(f.plan.id),input={commandId:'blocked',id:f.plan.id,expected},result=await f.repository.reconcileTerminal(input);assert.equal(result.kind,'blocked');assert.equal(result.known,true);assert.deepEqual(await f.repository.reconcileTerminal(input),result);
});
test('P7-TERM-I03 active actual writer and unknown stop or usage cannot become known terminal failure',async t=>{
 const f=await fixture(t);f.plan.tasks=f.plan.tasks.slice(0,1);f.install();const c=await failActual(f,'original');const original=f.store.executionGet(c.attemptId);
 for(const patch of [{stopConfirmed:false},{usageStatus:'unknown',usage:null},{state:'unknown'}]){f.db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify({...original,...patch}),original.id);if('usageStatus' in patch)await assert.rejects(observe(f,'unknown:'+Object.keys(patch).join()),/actual settled accounting inconsistent/);else assert.equal((await observe(f,'unknown:'+Object.keys(patch).join())).kind,'waiting');assert.notEqual(f.run().status,'blocked');}
 const child=await spawnManagedProcess({operationId:c.attemptId,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:c.workspace,timeoutMs:20000,onBeforeSpawn:intent=>{f.db.prepare('INSERT INTO scheduled_events(scheduler_id,kind,record) VALUES(?,?,?)').run(c.schedulerId,'explicit-process-intent',JSON.stringify(intent));},onIdentity:identity=>{f.db.prepare('INSERT INTO scheduled_events(scheduler_id,kind,record) VALUES(?,?,?)').run(c.schedulerId,'actual-process-identity',JSON.stringify(identity));}});f.cleanups.push(async()=>{await child.terminate();});
 // Explicit corrupt persisted stop receipt plus actual live OS identity. Host must
 // reject the fake stopped flag even though the ledger was genuinely settled.
 f.db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify({...original,identity:child.identity,pid:child.identity.pid}),original.id);assert.equal((await observe(f,'actually-live')).kind,'waiting');assert.notEqual(f.run().status,'blocked');await child.terminate();
 // Separately keep the unknown-cost gate meaningful: a fresh optional attempt
 // really stops but was never settled, rather than corrupting a settled receipt.
 const optional=await submittedFixture(t,100000,true);
 const core=optional.claim('core');await optional.complete(core);await optional.published(core);
 const unknown=optional.claim('optional-unknown');assert.equal(unknown.taskId,'C');
 const actual=await optional.complete(unknown,false,true);assert.equal((await inspectProcess(actual.child.identity)).status,'stopped');
 const frozen=optional.run();assert.equal(frozen.attempts.find(a=>a.id===unknown.attemptId)!.settled,false);
 assert.equal(frozen.attempts.find(a=>a.id===unknown.attemptId)!.reservation,20);
 optional.scheduler.setExplorationTier({commandId:'lower-unknown',id:optional.plan.id,expected:optional.scheduler.expected(optional.plan.id),tier:'low'});
 assert.equal(new ScheduledResultPublisher(optional.store).releaseIfReady(optional.plan.id),false);
 assert.throws(()=>optional.scheduler.releaseIntegration({commandId:'unknown-cannot-disappear',id:optional.plan.id,expected:optional.scheduler.expected(optional.plan.id)}),/unresolved cost or effects/);
 const terminal=await optional.scheduler.reconcileTerminal({commandId:'unknown-optional-terminal',id:optional.plan.id,expected:optional.scheduler.expected(optional.plan.id)});
 assert.equal(terminal.kind,'waiting');assert.equal(terminal.known,false);assert.deepEqual(optional.run(),frozen);assert.equal(optional.scheduler.get(optional.plan.id).fence,'held');

});
test('P7-TERM-I04 parent rollback stale CAS and stale immutable generation cannot partially block runtime or spend budget',async t=>{
 const f=await fixture(t);f.plan.tasks=f.plan.tasks.slice(0,1);f.install();await failActual(f,'failed');const expected=f.repository.expected(f.plan.id),before=JSON.stringify(f.run()),runtime=JSON.stringify(f.store.runtime.get(f.plan.runtimeId));
 await assert.rejects(f.repository.reconcileTerminal({commandId:'stale',id:f.plan.id,expected:{...expected,runRevision:expected.runRevision-1}}),/stale/);
 f.db.exec("CREATE TRIGGER fail_parent BEFORE INSERT ON runtime_events WHEN NEW.kind='scheduled-blocked' BEGIN SELECT RAISE(ABORT,'parent rollback evidence');END;");await assert.rejects(observe(f,'broken-parent'),/parent rollback/);assert.equal(JSON.stringify(f.run()),before);assert.equal(JSON.stringify(f.store.runtime.get(f.plan.runtimeId)),runtime);assert.equal(f.repository.get(f.plan.id).state,'active');assert.equal(f.db.prepare('SELECT 1 FROM scheduled_receipts WHERE command_id=?').get('broken-parent'),undefined);f.db.exec('DROP TRIGGER fail_parent');
 const c=f.repository.claims(f.plan.id)[0]!;assert.throws(()=>f.db.prepare('UPDATE scheduled_claims SET record=? WHERE id=?').run(JSON.stringify({...c,generation:c.generation+1}),c.id),/Claim intent immutable/);const changed=structuredClone(f.run());changed.contract.version++;f.db.prepare('UPDATE runs SET snapshot=? WHERE project_id=? AND id=?').run(JSON.stringify(changed),changed.projectId,changed.id);await assert.rejects(observe(f,'stale-contract'),/terminal contract stale/);f.db.prepare('UPDATE runs SET snapshot=? WHERE project_id=? AND id=?').run(before,changed.projectId,changed.id);assert.equal(JSON.stringify(f.run()),before);
});
test('P7-TERM-I05 absolute scheduler deadline blocks without silently clearing unknown accounting or held integration fence',async t=>{
 const f=await fixture(t);f.plan.tasks=f.plan.tasks.slice(0,1);f.install();const c=f.claim('unstarted');assert.equal(c.kind,'claimed');if(c.kind!=='claimed')throw Error('missing claim');const binding=f.repository.binding(c.claim.id,'owner'),{workspaceKind,...input}=f.repository.executionInput(c.claim.id);const original=f.store.executionCreate({...input,workspace:c.claim.workspace,workspaceKind},binding).record;
 const child=await spawnManagedProcess({operationId:c.claim.attemptId,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:c.claim.workspace,timeoutMs:20000,onBeforeSpawn:intent=>{f.db.prepare('INSERT INTO scheduled_events(scheduler_id,kind,record) VALUES(?,?,?)').run(c.claim.schedulerId,'explicit-process-intent',JSON.stringify(intent));},onIdentity:identity=>{f.db.prepare('INSERT INTO scheduled_events(scheduler_id,kind,record) VALUES(?,?,?)').run(c.claim.schedulerId,'actual-process-identity',JSON.stringify(identity));}});f.cleanups.push(async()=>{await child.terminate();});
 // Explicit local Node receipt metadata, not a provider completion. Its actual
 // durable spawn intent, birth identity and later OS stop are never fabricated.
 f.db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify({...original,state:'running',identity:child.identity,pid:child.identity.pid,stopConfirmed:false,usageStatus:'unknown',usage:null}),original.id);const before=f.run();const repo=new TaskSchedulerRepository(f.db,f.data,()=>f.plan.limits.deadlineMs);const result=await repo.reconcileTerminal({commandId:'expired',id:f.plan.id,expected:repo.expected(f.plan.id)});assert.equal(result.kind,'blocked');assert.equal(result.known,false);assert.match(result.reason!,/unresolved/);assert.deepEqual(f.run().attempts,before.attempts);assert.deepEqual(f.run().budget,before.budget);assert.deepEqual(f.run().operations,before.operations);assert.deepEqual(f.run().leases,before.leases);assert.equal(repo.get(f.plan.id).fence,'held');assert.equal(f.store.runtime.get(f.plan.runtimeId).phase,'blocked');
 const stop=await child.terminate();assert.equal(stop.stopped,true);f.db.prepare('INSERT INTO scheduled_events(scheduler_id,kind,record) VALUES(?,?,?)').run(c.claim.schedulerId,'actual-process-stop',JSON.stringify(stop));
 const cancelled={...original,state:'cancelled',identity:child.identity,pid:child.identity.pid,stopConfirmed:true,usageStatus:'reported',usage:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0},cancelRequested:true};f.db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify(cancelled),original.id);
 let settled=f.run();for(const action of [{type:'finishAttempt',attemptId:c.claim.attemptId,outcome:'cancelled'},{type:'settleAttempt',attemptId:c.claim.attemptId,actual:0},{type:'setOperation',operationId:c.claim.operationId,attemptId:c.claim.attemptId,status:'confirmed'},{type:'releaseLease',attemptId:c.claim.attemptId,resource:'workspace:'+c.claim.workspace}] as const)settled=applyAction(settled,action).run;f.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(JSON.stringify(settled),settled.revision,settled.projectId,settled.id);
 assert.equal((await repo.reconcileExecution({commandId:'later-actual-stop',claimId:c.claim.id,executionId:original.id})).state,'cancelled');assert.equal(f.run().status,'blocked');assert.equal(f.store.runtime.get(f.plan.runtimeId).phase,'blocked');assert.equal(repo.get(f.plan.id).state,'blocked');assert.equal(f.run().attempts[0]!.settled,true);assert.equal(f.run().budget.spent,0);assert.equal(repo.leases().every(l=>l.state==='released'),true);assert.equal(repo.get(f.plan.id).fence,'held');
});
test('P7-TERM-I06 actual installed continuing Loop stays eligible and genuine root exhaustion propagates blocked', {timeout:120000},async t=>{
 const f=await loopFixture(t,'constant');await f.install();const result=await f.store.scheduler.reconcileTerminal({commandId:'next-real-iteration',id:f.plan.id,expected:f.store.scheduler.expected(f.plan.id)});assert.equal(result.kind,'waiting');f.openWorker();await f.until(()=>f.store.scheduler.get(f.plan.id).state==='blocked');assert.equal(f.store.runtime.get(f.plan.runtimeId).phase,'blocked');assert.equal(f.store.scheduledLoops.inspect(f.plan.id)!.frames.find(x=>x.key==='root')!.state,'blocked');assert.ok(f.store.scheduledLoops.decisions(f.plan.id).some(d=>d.decision==='continue'));assert.equal(f.store.verification.list('delivery').length,0);
});

import {submittedFixture} from '../helpers/scheduled-terminal-producer-fixture.js';
test('P7-TERM-I07 complete exact published graph survives late observation while missing corrupt packages or drain SQL faults cannot release', {timeout:90000},async t=>{
 for(const variant of ['published','missing','corrupt','sql-fault'] as const){
  const withOptional=variant==='published',f=await submittedFixture(t,withOptional?18000:10000,withOptional);assert.equal(f.plan.tasks.length,withOptional?2:1);assert.deepEqual(f.scheduler.get(f.plan.id).plan.tasks.map(task=>[task.node.id,task.node.required]),withOptional?[['A',true],['C',false]]:[['A',true]]);assert.deepEqual(f.run().nodes.find(n=>n.id==='integrate')!.dependencies,['A']);
  const claim=f.claim('actual-A');const done=await f.complete(claim);assert.ok(done.child.identity);assert.equal((await (await import('../../packages/process-control/index.js')).inspectProcess(done.child.identity)).status,'stopped');assert.equal(f.run().attempts[0]!.settled,true);assert.equal(f.scheduler.operation(claim.operationId).state,'confirmed');
  const published=variant==='missing'?null:await f.published(claim);if(published)assert.equal(f.results.inspect(f.scope).heads.length,1);
  if(withOptional){
   const optional=f.claim('actual-C');assert.equal(optional.taskId,'C');const done=await f.complete(optional);await f.published(optional);
   assert.equal((await inspectProcess(done.child.identity)).status,'stopped');assert.equal(f.scheduler.operation(optional.operationId).state,'confirmed');
   assert.equal(f.results.inspect(f.scope).heads.length,2);assert.ok(f.run().attempts.every(attempt=>attempt.settled));
  }
  const completedAt=Date.now();assert.ok(completedAt<f.plan.limits.deadlineMs,'Real completion and publication precede deadline');
  if(variant==='corrupt')await writeFile(join(published!.pack.directory,'files/output.txt'),'actual package tampering');
  if(variant==='sql-fault')f.db.exec("CREATE TRIGGER drain_sql_failure BEFORE INSERT ON scheduled_receipts WHEN NEW.command_id LIKE 'scheduled-terminal-drain:%' BEGIN SELECT RAISE(ABORT,'actual late drain write failure');END;");
  await delay(Math.max(0,f.plan.limits.deadlineMs-Date.now()+40));
  const before=f.run(),runtimeBefore=f.store.runtime.get(f.runtime.id),recordBefore=f.scheduler.get(f.plan.id),input={commandId:'late-observe',id:f.plan.id,expected:f.scheduler.expected(f.plan.id)};
  if(variant==='sql-fault'){
   await assert.rejects(f.scheduler.reconcileTerminal(input),/actual late drain write failure/);assert.deepEqual(f.run(),before);assert.deepEqual(f.store.runtime.get(f.runtime.id),runtimeBefore);assert.deepEqual(f.scheduler.get(f.plan.id),recordBefore);assert.equal(f.db.prepare('SELECT 1 FROM scheduled_receipts WHERE command_id=?').get(input.commandId),undefined);assert.equal(f.db.prepare("SELECT 1 FROM scheduled_events WHERE kind='integration-fence-released'").get(),undefined);
   f.db.exec('DROP TRIGGER drain_sql_failure');assert.equal((await f.scheduler.reconcileTerminal(input)).kind,'drained');
  }else{
   const result=await f.scheduler.reconcileTerminal(input);assert.equal(result.kind,variant==='published'?'drained':'blocked');assert.equal(result.known,true);
   if(variant==='published'){assert.deepEqual(await f.scheduler.reconcileTerminal(input),result);assert.deepEqual(f.run(),before);assert.equal(f.store.executionList().length,2);}
  }
  const record=f.scheduler.get(f.plan.id);assert.equal(record.fence,['published','sql-fault'].includes(variant)?'released':'held');assert.equal(record.state,['published','sql-fault'].includes(variant)?'drained':'blocked');assert.deepEqual(f.run().budget,before.budget);assert.deepEqual(f.run().contract,before.contract);assert.equal(f.store.verification.list('delivery').length,0);
 }
});

test('P7-TERM-I08 never-attempted budget-exhausted optional closure can remain unperformed only after exact quiet required publication', {timeout:120000},async t=>{
 for(const variant of ['budget','closure','affordable','unknown-stop','unknown-accounting','active-held','missing-package','required-gap','required-dependency'] as const){
  const f=await submittedFixture(t,120000,{tokenLimit:100,verificationReserve:20,configure:async(plan,root)=>{
   const optional=structuredClone(plan.tasks[0]!);optional.node.id='O';optional.node.required=false;optional.node.reservation=['affordable','active-held'].includes(variant)?20:80;optional.step.id='O';optional.step.reservation=optional.node.reservation;optional.workspace=join(root,'O');optional.node.resources=[{kind:'path',key:optional.workspace,mode:'write'}];await mkdir(optional.workspace);plan.tasks.push(optional);if(variant==='required-dependency'){plan.tasks[0]!.node.dependencies=['O'];plan.tasks[0]!.inputRequirements=[{dependencyNodeId:'O',minimumState:'submitted'}];}
   if(variant==='closure'){const successor=structuredClone(optional);successor.node.id='S';successor.step.id='S';successor.node.reservation=20;successor.step.reservation=20;successor.node.dependencies=['O'];successor.inputRequirements=[{dependencyNodeId:'O',minimumState:'submitted'}];successor.workspace=join(root,'S');successor.node.resources=[{kind:'path',key:successor.workspace,mode:'write'}];await mkdir(successor.workspace);plan.tasks.push(successor);}
  }});
  assert.equal(f.scheduler.persistedCompletion(f.plan.id),null);assert.equal(f.run().budget.limit,100);assert.equal(f.run().budget.verificationReserve,20);assert.equal(f.scheduler.get(f.plan.id).plan.tier,'low');
  if(['required-gap','required-dependency'].includes(variant)){assert.equal(f.scheduler.completionEligibility(f.plan.id).ready,false);assert.equal(new ScheduledResultPublisher(f.store).releaseIfReady(f.plan.id),false);continue;}
  const core=f.claim('real-core');assert.equal(core.taskId,'A');const done=await f.complete(core);assert.equal((await (await import('../../packages/process-control/index.js')).inspectProcess(done.child.identity)).status,'stopped');
  if(variant!=='missing-package')await f.published(core);
  const before=f.run().budget,original=f.store.executionGet(core.attemptId);
  if(variant==='unknown-stop')f.db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify({...original,stopConfirmed:false}),original.id);
  if(variant==='active-held'){const optional=f.claim('temporarily-held-optional');assert.equal(optional.taskId,'O');assert.equal(f.scheduler.completionEligibility(f.plan.id).ready,false);assert.equal(new ScheduledResultPublisher(f.store).releaseIfReady(f.plan.id),false);assert.equal(f.run().attempts.find(a=>a.id===optional.attemptId)!.settled,false);assert.deepEqual(f.run().budget,before);continue;}
  if(variant==='unknown-accounting'){f.db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify({...original,usageStatus:'unknown',usage:null}),original.id);assert.throws(()=>f.scheduler.completionEligibility(f.plan.id),/actual settled accounting inconsistent/);assert.throws(()=>new ScheduledResultPublisher(f.store).releaseIfReady(f.plan.id),/completion\/accounting unknown|actual settled accounting inconsistent/);assert.deepEqual(f.run().budget,before);continue;}
  const eligibility=f.scheduler.completionEligibility(f.plan.id);t.diagnostic(JSON.stringify({variant,eligibility,budget:f.run().budget,claims:f.scheduler.claims(f.plan.id).map(c=>c.taskId)}));
  if(['unknown-stop','missing-package'].includes(variant)){assert.equal(eligibility.ready,false);if(variant==='unknown-stop')assert.throws(()=>new ScheduledResultPublisher(f.store).releaseIfReady(f.plan.id),/completion\/accounting unknown/);else assert.equal(new ScheduledResultPublisher(f.store).releaseIfReady(f.plan.id),false);assert.equal(f.scheduler.get(f.plan.id).fence,'held');continue;}
  if(variant==='affordable'){
   assert.equal(eligibility.ready,false);assert.deepEqual(eligibility.unperformedOptional,[]);assert.equal(new ScheduledResultPublisher(f.store).releaseIfReady(f.plan.id),false);
   const optional=f.claim('affordable-optional');assert.equal(optional.taskId,'O');await f.complete(optional);await f.published(optional);assert.equal(f.scheduler.completionEligibility(f.plan.id).ready,true);assert.equal(new ScheduledResultPublisher(f.store).releaseIfReady(f.plan.id),true);assert.equal(f.run().budget.spent,10);continue;
  }
  assert.equal(eligibility.ready,true);assert.equal(eligibility.remaining,75);assert.deepEqual(eligibility.unperformedOptional.map(n=>n.taskId),variant==='closure'?['O','S']:['O']);assert.equal(f.scheduler.claims(f.plan.id).filter(c=>c.taskId!=='A').length,0);
  const result=await f.scheduler.reconcileTerminal({commandId:'original-budget-reproduction',id:f.plan.id,expected:f.scheduler.expected(f.plan.id)});assert.equal(result.kind,'drained');assert.equal(f.scheduler.get(f.plan.id).fence,'released');assert.equal(new ScheduledResultPublisher(f.store).releaseIfReady(f.plan.id),true);assert.deepEqual(f.run().budget,before);
  for(const id of eligibility.unperformedOptional.map(t=>t.taskId))assert.equal(f.run().nodes.find(n=>n.id===id)!.status,'pending','unperformed optional is not passed');
  const event=f.db.prepare("SELECT record FROM scheduled_events WHERE scheduler_id=? AND kind='integration-fence-released' ORDER BY rowid DESC LIMIT 1").get(f.plan.id)!;assert.ok(String(event.record).includes('never attempted'));assert.deepEqual(f.scheduler.persistedCompletion(f.plan.id),{planDigest:f.scheduler.get(f.plan.id).planDigest,protectedRemaining:75,unperformedOptional:eligibility.unperformedOptional});assert.equal(f.store.verification.list('delivery').length,0);
  const visible=f.scheduler.exploration(f.plan.id);assert.equal(visible.counts.waiting,0);assert.deepEqual(visible.completion?.unperformedOptional,eligibility.unperformedOptional);assert.equal(visible.canChangeTier,false);
  if(variant==='budget'){
   // Actual private SQLite fault injection: a damaged committed observation must
   // stay visible as an error, not be hidden behind a normal lifecycle notice.
   const row=f.db.prepare("SELECT rowid AS eventRow,record FROM scheduled_events WHERE scheduler_id=? AND kind='integration-fence-released' ORDER BY rowid DESC LIMIT 1").get(f.plan.id)!;
   const invalid={...JSON.parse(String(row.record)),protectedRemaining:-1};f.db.prepare('UPDATE scheduled_events SET record=? WHERE rowid=?').run(JSON.stringify(invalid),row.eventRow!);
   assert.throws(()=>f.scheduler.persistedCompletion(f.plan.id),/invalid committed completion evidence/);
   const damaged=f.scheduler.exploration(f.plan.id);assert.equal(damaged.completion,null);assert.match(damaged.reason!,/invalid committed completion evidence/);assert.equal(damaged.canChangeTier,false);
   f.db.prepare('UPDATE scheduled_events SET record=? WHERE rowid=?').run(row.record!,row.eventRow!);assert.deepEqual(f.scheduler.exploration(f.plan.id).completion,visible.completion);
  }
 }
});
