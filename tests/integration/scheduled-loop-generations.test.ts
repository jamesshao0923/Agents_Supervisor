import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {ScheduledLoopController} from '../../packages/runtime/scheduled-loop-advance.js';
import {ScheduledRuntimeWorker} from '../../packages/runtime/scheduled-worker.js';
import {captureGraphSeed} from '../../packages/workspace/graph-workspaces.js';
import {canonical,digest} from '../../packages/verification/candidate.js';
import {applyAction,futureExecutionFloor} from '../../packages/domain/index.js';
import type {Run} from '../../packages/contracts/p1.js';
import type {ScheduledPlan} from '../../packages/contracts/p7-dispatch.js';
import type {LoopProgramSource,LoopProgramNode} from '../../packages/contracts/p7-loop.js';
import {inspectProcess,type ProcessIdentity} from '../../packages/process-control/index.js';
import {hash,fixture} from '../helpers/scheduled-loop-fixture.js';
test('P7-NEST-I10 actual repeated parallel body preserves current iteration dependencies and sealed input across restart',{timeout:120000},async t=>{
 const f=await fixture(t),tasks=f.source.templatePlan.tasks;tasks.splice(0,tasks.length,...tasks.filter(x=>['transform','summarize'].includes(x.node.id)));const a=tasks.find(x=>x.node.id==='transform')!;a.node.dependencies=[];a.inputRequirements=[];
 f.source.program.tree={kind:'loop',id:'loop',limits:{iterations:3,tokens:300,nodes:12,durationMs:100000,unchangedIterations:1},until:{taskId:'summarize',path:'state.json',field:'value',atLeast:2},body:{kind:'parallel',id:'parallel-body',children:[{kind:'task',id:'transform',taskId:'transform'},{kind:'task',id:'summarize',taskId:'summarize'}]}};f.source.program.sourceDigest=hash(f.source.templatePlan);
 await f.install();f.openWorker();await f.until(()=>f.store.executionList().length===2&&f.store.executionList().every(e=>e.stopConfirmed));await f.reopen();await f.until(()=>f.store.scheduledLoops.decisions(f.plan.id).some(x=>x.decision==='continue'));const plan=f.store.scheduler.get(f.plan.id).plan,all=plan.tasks,oldA=all[0]!,newA=all[2]!,newB=all[3]!;assert.ok(newB.node.dependencies.includes(newA.node.id),'B2 must depend on A2');assert.notEqual(oldA.node.id,newA.node.id);await f.until(()=>f.store.scheduler.get(f.plan.id).fence==='released');
 const bClaim=f.store.scheduler.claims(f.plan.id).find(c=>c.taskId===newB.node.id)!;assert.ok(bClaim.inputBindings.some(r=>r.dependencyNodeId===newA.node.id));const bExecution=f.store.executionGet(bClaim.attemptId),aClaim=f.store.scheduler.claims(f.plan.id).find(c=>c.taskId===newA.node.id)!,aExecution=f.store.executionGet(aClaim.attemptId);assert.ok(Date.parse(bExecution.createdAt)>=Date.parse(aExecution.updatedAt),'B2 cannot begin before A2 is stopped');
 const head=f.store.taskResults.inspect(f.scope).heads.find(h=>h.taskId===newB.node.id)!,pack=f.store.taskResults.readPublished({...f.scope,ref:head.ref,minimumState:'submitted'});assert.equal(JSON.parse(await readFile(join(pack.directory,'files','state.json'),'utf8')).value,2);assert.equal(f.store.executionList().length,4);assert.equal(f.run().budget.spent,20);assert.equal(futureExecutionFloor(f.run()),20);
});
test('P7-NEST-I11 two actual scheduler programs in one SQLite database keep iteration decisions isolated',{timeout:120000},async t=>{
 const first=await fixture(t,'cap'),second=await fixture(t,'cap',{data:first.data,suffix:'-second'});
 for(const f of [first,second]){f.source.templatePlan.tasks.splice(0,f.source.templatePlan.tasks.length,...f.source.templatePlan.tasks.filter(x=>x.node.id==='transform'));const task=f.source.templatePlan.tasks[0]!;task.node.dependencies=[];task.inputRequirements=[];f.source.program.tree={kind:'loop',id:'loop',limits:{iterations:1,tokens:30,nodes:2,durationMs:30000,unchangedIterations:1},until:{taskId:'transform',path:'state.json',field:'value',atLeast:1},body:{kind:'task',id:'transform',taskId:'transform'}};f.source.program.sourceDigest=hash(f.source.templatePlan);await f.install();}
 first.openWorker();await first.until(()=>[first,second].every(f=>first.store.scheduler.get(f.plan.id).fence==='released'));for(const f of [first,second]){const decisions=first.store.scheduledLoops.decisions(f.plan.id);assert.equal(decisions.length,1);assert.equal(decisions[0]!.iterationId,'root/iteration-1');assert.equal(decisions[0]!.decision,'yield');assert.equal(f.run().budget.spent,5);}assert.equal(first.db.prepare('SELECT count(*) n FROM scheduled_loop_decisions').get()!.n,2);await first.reopen();await first.worker.tick();assert.equal(first.store.executionList().length,2);assert.equal(first.db.prepare('SELECT count(*) n FROM scheduled_loop_decisions').get()!.n,2);
});

test('P7-NEST-I12 known failed original dependency blocks its pending child while unrelated actual sibling completes',{timeout:120000},async t=>{
 const f=await fixture(t,'failure'),tasks=f.source.templatePlan.tasks;tasks.splice(0,tasks.length,...tasks.filter(x=>x.node.id!=='left'));const right=tasks.find(x=>x.node.id==='right')!;right.node.dependencies=['seed'];right.inputRequirements=[{dependencyNodeId:'seed',minimumState:'submitted'}];
 f.source.program.tree={kind:'sequence',id:'start',children:[{kind:'task',id:'seed',taskId:'seed'},{kind:'parallel',id:'branches',children:[{kind:'loop',id:'loop',limits:{iterations:3,tokens:300,nodes:12,durationMs:100000,unchangedIterations:1},until:{taskId:'summarize',path:'state.json',field:'value',atLeast:2},body:{kind:'parallel',id:'dependent-body',children:[{kind:'task',id:'transform',taskId:'transform'},{kind:'task',id:'summarize',taskId:'summarize'}]}},{kind:'task',id:'right',taskId:'right'}]}]};f.source.program.sourceDigest=hash(f.source.templatePlan);await f.install();f.openWorker();await f.until(()=>f.store.scheduledLoops.inspect(f.plan.id)!.frames.find(x=>x.key==='root')!.state==='blocked');const state=f.store.scheduledLoops.inspect(f.plan.id)!,dependent=state.frames.find(x=>x.nodeId==='summarize')!;assert.equal(dependent.state,'blocked');assert.match(dependent.reason!,/Required actual dependency/);const executions=f.store.executionList();assert.equal(executions.filter(e=>JSON.parse(e.prompt.split('\n\n')[0]!).task==='summarize').length,0);assert.equal(executions.find(e=>JSON.parse(e.prompt.split('\n\n')[0]!).task==='right')!.state,'completed');assert.ok(f.run().attempts.every(a=>a.settled));assert.equal(f.run().budget.spent,15);assert.equal(f.store.scheduler.get(f.plan.id).fence,'held');await f.reopen();await f.worker.tick();assert.equal(f.store.executionList().length,executions.length);
});
