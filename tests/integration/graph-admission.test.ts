import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {OrchestrationController} from '../../packages/orchestration/controller.js';
import {LocalRuntimeAdapter} from '../../packages/runtime/index.js';
import {prepareGoalGraphAdmission} from '../../packages/orchestration/graph-admission.js';
import {admittedPlan} from '../../packages/orchestration/admission.js';
import {applyAction,futureExecutionFloor} from '../../packages/domain/index.js';
import {spawnManagedProcess,terminateProcess} from '../../packages/process-control/index.js';
import {readOwnership,workerAlive} from '../../packages/runtime/worker-ownership.js';
import type {GoalProposal,GoalInspection} from '../../packages/contracts/p5.js';
import type {Run,RunAction} from '../../packages/contracts/p1.js';
const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
/** Explicit synthetic planning JSON and 7-token accounting. The Node emitter,
 * stop identity, persisted P5 job, files, SQLite and runtime controls are real.
 * No provider is called and no synthetic result claims product acceptance. */
async function fixture(t:TestContext,empty=false,single=false){
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-graph-admit-'))),workspace=join(root,'project'),data=join(root,'data');await mkdir(workspace);if(!empty)await writeFile(join(workspace,'seed.txt'),'original user bytes\n');
 let store=new SupervisorStore(data);const db=new DatabaseSync(join(data,'supervisor.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
 t.after(async()=>{const owned=await readOwnership(data);if(owned?.identity)await terminateProcess(owned.identity,{graceMs:300,killWaitMs:3000});db.close();store.close();await rm(root,{recursive:true,force:true});});
 const first=store.goals.start({type:'start',commandId:'start',goal:'Implement named sum and double exports, preserving zero and negative checks.',model:'explicit-no-provider-fixture',effort:'low',reservation:20,timeoutMs:1000,tokenLimit:150,verificationReserve:30,maxContextChars:100000},workspace,'project'),job=first.session.jobs[0]!;
 const proposal:GoalProposal={decision:'ready',summary:'Explicit synthetic proposal fixture',questions:[],facts:[{text:first.session.goal,sourceId:first.session.messages[0]!.id,origin:'explicit'}],constraints:['Only named exports.'],style:[],criteria:[{id:'sum',description:'sum(a,b) returns a+b',kind:'command',target:'math.test.mjs',checks:['Check zero, positive, negative.']},{id:'double',description:'double(x) returns x+x',kind:'command',target:'math.test.mjs',checks:['Check zero, positive, negative.']}],steps:[{id:'sum',description:'Implement sum and checks',dependencies:[],acceptanceIds:['sum']},{id:'double',description:'Implement double and checks',dependencies:['sum'],acceptanceIds:['double']}]};
 if(single)proposal.steps=[{id:'only-task',description:'Implement both named APIs and all original checks',dependencies:[],acceptanceIds:['sum','double']}];
 const child=await spawnManagedProcess({operationId:job.id+'-fixture',command:process.execPath,args:['-e','console.log(process.argv[1])',JSON.stringify(proposal)],cwd:workspace,timeoutMs:5000,onBeforeSpawn:intent=>{store.goals.update(first.session.id,job.id,j=>j.intents.push(intent));},onIdentity:identity=>{store.goals.update(first.session.id,job.id,j=>j.identities.push(identity));}});
 let raw='';child.stdout.on('data',b=>raw+=b);const stopped=await child.completion;assert.equal(stopped.stopped,true);assert.deepEqual(JSON.parse(raw),proposal);
 const output=join(data,'planner-fixture.json');await writeFile(output,raw);
 const ready=store.goals.finish(first.session.id,job.id,j=>{j.modelStarted=true;j.threadId='explicit-synthetic-thread';j.usage=7;j.stopConfirmed=true;j.proofs={[output]:hash(raw)};j.proposal=proposal;});
 const action={type:'admit' as const,commandId:'admit',sessionId:ready.session.id,expectedRevision:ready.session.revision};
 return {root,workspace,data,db,ready,action,output,get store(){return store},reopen(){store.close();store=new SupervisorStore(data);},async prepare(){return prepareGoalGraphAdmission(store,data,action);}};
}
function persist(f:{db:DatabaseSync},run:Run){f.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(JSON.stringify(run),run.revision,run.projectId,run.id);}
function evolve(f:{db:DatabaseSync},run:Run,...actions:RunAction[]):Run{for(const a of actions)run=applyAction(run,a).run;persist(f,run);return run;}

test('P7-ADMIT-I01 actual P5 empty-project admission atomically binds anchor graph floor and same Run without replanning',async t=>{
 const f=await fixture(t,true),prepared=await f.prepare(),oldJob=JSON.stringify(f.ready.session.jobs),contract=admittedPlan(f.ready.session,f.ready.run).contract;
 assert.deepEqual(prepared.preparation.request.seed.files,{});const value=f.store.goals.admitGraph(prepared);assert.deepEqual(value.run.contract,contract);assert.equal(value.run.budget.spent,7);assert.equal(value.session.jobs.length,1);assert.equal(JSON.stringify(value.session.jobs),oldJob);assert.equal(value.run.budget.limit,150);assert.equal(value.run.budget.verificationReserve,30);
 const runtime=f.store.runtime.get(value.session.id),op=f.store.runtime.currentOperations(runtime.id)[0]!;assert.equal(runtime.definition.steps.length,1);assert.equal(value.run.budget.futureExecution!.attemptId,op.attemptId);assert.equal(value.run.budget.futureExecution!.nodeId,op.step.id);assert.equal(value.run.budget.futureExecution!.amount,20);assert.equal(value.session.graphAdmission!.schedulerDigest,f.store.scheduler.get(prepared.policy.schedulerId).planDigest);assert.equal(f.store.runtime.claim(runtime.id,'blocked-final'),null);
 assert.deepEqual(f.store.goals.admitGraph(prepared),value);assert.throws(()=>f.store.goals.admitGraph({...prepared,policy:{...prepared.policy,tier:'high'}}),/Conflicting graph/);f.reopen();assert.deepEqual(f.store.goals.admitGraph(prepared),value);const claim=f.store.scheduler.claim({commandId:'actual-branch-claim',id:prepared.policy.schedulerId,expected:f.store.scheduler.expected(prepared.policy.schedulerId),owner:'owner'});assert.equal(claim.kind,'claimed');assert.equal(futureExecutionFloor(f.store.goals.inspect(value.session.id).run),20);
});

test('P7-ADMIT-I02 SQLite trigger failure rolls back anchor adoption graph receipt result ledger and floor while owned preparation remains recoverable',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),before=f.store.goals.inspect(f.ready.session.id);
 f.db.exec("CREATE TRIGGER graph_fault BEFORE INSERT ON scheduled_records BEGIN SELECT RAISE(ABORT,'explicit graph install fault'); END;");assert.throws(()=>f.store.goals.admitGraph(prepared),/explicit graph install fault/);assert.deepEqual(f.store.goals.inspect(f.ready.session.id),before);for(const table of ['runtime_runs','runtime_outbox','scheduled_records','scheduled_plans','task_result_ledgers'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM goal_receipts WHERE command_id='admit'").get()!.n,0);assert.ok(await readFile(join(prepared.preparation.directory,'complete.json'),'utf8'));
 f.db.exec('DROP TRIGGER graph_fault');f.reopen();const retry=await f.prepare();assert.deepEqual(retry,prepared);const value=f.store.goals.admitGraph(retry);assert.equal(value.session.phase,'admitted');assert.equal(futureExecutionFloor(value.run),20);assert.equal(value.run.budget.spent,7);
});

test('P7-ADMIT-I03 final floor is additive to verification and all common reasoning and scheduled reservations preserve it',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),value=f.store.goals.admitGraph(prepared),run=value.run;
 // Explicit domain/accounting mechanism: no new model job is claimed here.
 assert.throws(()=>applyAction(run,{type:'startAttempt',attemptId:'too-large',nodeId:'@supervisor',contractVersion:run.contract.version,purpose:'reasoning',reservation:94,resources:[]}),/insufficient budget/);
 assert.throws(()=>applyAction(run,{type:'setFutureVerification',contractVersion:run.contract.version,allocationId:'too-large-p4',amount:124,reason:'Must also preserve final execution'}),/insufficient future verification budget/);
 const current=evolve(f,run,{type:'startAttempt',attemptId:'explicit-reasoning-fixture',nodeId:'@supervisor',contractVersion:run.contract.version,purpose:'reasoning',reservation:93,resources:[]},{type:'finishAttempt',attemptId:'explicit-reasoning-fixture',outcome:'succeeded'},{type:'settleAttempt',attemptId:'explicit-reasoning-fixture',actual:93});assert.equal(current.budget.spent,100);assert.equal(futureExecutionFloor(current),20);
 const blocked=f.store.scheduler.claim({commandId:'protected-claim',id:prepared.policy.schedulerId,expected:f.store.scheduler.expected(prepared.policy.schedulerId),owner:'owner'});assert.equal(blocked.kind,'waiting');assert.equal(f.store.scheduler.claims(prepared.policy.schedulerId).length,0);assert.equal(f.store.runtime.claim(value.session.id,'cannot-bypass-required-branches'),null);assert.equal(f.store.goals.inspect(value.session.id).run.budget.spent,100);assert.equal(f.store.goals.inspect(value.session.id).run.budget.verificationReserve,30);
});

test('P7-ADMIT-I04 exact final attempt alone consumes protection in real runtime claim with pause resume and legacy budget compatibility',async t=>{
 const f=await fixture(t),other=join(f.root,'raw-runtime');await mkdir(other);
 const runtime=f.store.runtime.submit({type:'submit',commandId:'raw-final-mechanism',workspace:other,workspaceKind:'project',goal:'Mechanism only final reservation consumption',tokenLimit:50,verificationReserve:30,steps:[{id:'final',kind:'codex',prompt:'Not dispatched to provider in this test',model:'no-provider',effort:'low',reservation:20,timeoutMs:1000}]}),op=f.store.runtime.currentOperations(runtime.id)[0]!,base=f.store.runtime.inspect(runtime.id).run;
 assert.equal(futureExecutionFloor(base),0);const allocation={allocationId:'protected-final',contractVersion:base.contract.version,nodeId:'final',attemptId:op.attemptId,amount:20};const protectedRun=evolve(f,base,{type:'setFutureExecution',allocation,reason:'Actual runtime outbox attempt'});
 for(const wrong of [{attemptId:'different-attempt'},{nodeId:'@supervisor',purpose:'reasoning' as const},{reservation:19},{contractVersion:2}])assert.throws(()=>applyAction(protectedRun,{type:'startAttempt',attemptId:op.attemptId,nodeId:'final',contractVersion:base.contract.version,reservation:20,purpose:'execution',resources:[],futureExecutionAllocationId:allocation.allocationId,...wrong}));
 f.store.runtime.control({type:'pause',runtimeId:runtime.id,commandId:'pause'});assert.equal(f.store.runtime.claim(runtime.id,'owner'),null);assert.equal(futureExecutionFloor(f.store.runtime.inspect(runtime.id).run),20);f.store.runtime.control({type:'resume',runtimeId:runtime.id,commandId:'resume'});
 const claimed=f.store.runtime.claim(runtime.id,'owner')!;assert.equal(claimed.attemptId,allocation.attemptId);const after=f.store.runtime.inspect(runtime.id).run;assert.equal(futureExecutionFloor(after),0);assert.equal(after.budget.spent,0);assert.equal(after.budget.verificationReserve,30);assert.equal(after.attempts.at(-1)!.reservation,20);assert.equal(after.attempts.at(-1)!.settled,false);assert.equal(f.store.runtime.claim(runtime.id,'another'),null);
 assert.ok(f.db.prepare("SELECT payload FROM events WHERE run_id=? AND type='startAttempt'").all(runtime.id).some(row=>String(row.payload).includes('consumedFutureExecution')));
});

test('P7-ADMIT-I05 cancelled pending changed source and tampered actual preparation cannot partially admit',async t=>{
 const f=await fixture(t),prepared=await f.prepare();await writeFile(join(prepared.preparation.workspaces[0]!.path,'seed.txt'),'tampered');assert.throws(()=>f.store.goals.admitGraph(prepared),/files or modes changed/);assert.equal(f.store.runtime.list().length,0);assert.deepEqual(f.store.goals.inspect(f.ready.session.id),f.ready);
 await writeFile(join(prepared.preparation.workspaces[0]!.path,'seed.txt'),'original user bytes\n');const conversation=f.store.conversations.forRun(f.ready.session.projectId,f.ready.session.id)!;
 f.store.conversations.receive({conversationId:conversation.id,commandId:'pending',source:'user',text:'Add another requirement',kind:'change'});assert.throws(()=>f.store.goals.admitGraph(prepared),/Pending follow-up/);assert.equal(f.store.runtime.list().length,0);
 f.store.goals.control({type:'cancel',commandId:'cancel',sessionId:f.ready.session.id});assert.throws(()=>f.store.goals.admitGraph(prepared));assert.equal(f.store.goals.inspect(f.ready.session.id).run.budget.futureExecution,undefined);assert.equal(f.db.prepare('SELECT count(*) n FROM scheduled_records').get()!.n,0);
});

test('P7-ADMIT-I06 actual controller default admit starts a real worker only after graph commit and replays without another planner', {timeout:30000},async t=>{
 const f=await fixture(t),oldEnv=process.env.SUPERVISOR_CODEX_PATH;process.env.SUPERVISOR_CODEX_PATH=join(f.root,'intentionally-absent-codex-no-provider');
 const adapter=new LocalRuntimeAdapter(f.store,f.data),controller=new OrchestrationController(f.store,f.data,adapter);
 try{
  const value=await controller.dispatch(f.action) as GoalInspection;assert.equal(value.session.phase,'admitted');assert.ok(value.session.graphAdmission);assert.equal(value.session.jobs.length,1);const owned=await readOwnership(f.data);assert.ok(owned?.ready&&await workerAlive(owned));assert.equal(f.store.scheduler.get(value.session.graphAdmission!.policy.schedulerId).fence,'held');
  const repeat=await controller.dispatch(f.action) as GoalInspection;assert.equal(repeat.session.graphAdmission!.requestDigest,value.session.graphAdmission!.requestDigest);assert.equal(repeat.session.jobs.length,1);assert.equal(f.store.runtime.currentOperations(value.session.id).length,1);assert.equal(f.store.goals.inspect(value.session.id).run.budget.futureExecution!.attemptId,f.store.runtime.currentOperations(value.session.id)[0]!.attemptId);assert.equal(f.store.runtime.currentOperations(value.session.id)[0]!.state,'queued');
  // ENOENT is a real unsupported execution environment, not a fake success.
  // This test proves admission/worker wiring only, not branch implementation.
 }finally{await controller.close();await adapter.close();const owned=await readOwnership(f.data);if(owned?.identity)await terminateProcess(owned.identity,{graceMs:300,killWaitMs:3000});if(oldEnv===undefined)delete process.env.SUPERVISOR_CODEX_PATH;else process.env.SUPERVISOR_CODEX_PATH=oldEnv;}
});

test('P7-ADMIT-I07 quiet contract revision explicitly invalidates final floor while active effects and cancel retain the allocation',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),admitted=f.store.goals.admitGraph(prepared),allocation=admitted.run.budget.futureExecution!;
 const revisedContract={...admitted.run.contract,version:admitted.run.contract.version+1};
 const active=applyAction(admitted.run,{type:'startAttempt',attemptId:'explicit-unknown-cost-fixture',nodeId:'@supervisor',contractVersion:admitted.run.contract.version,reservation:1,purpose:'reasoning',resources:[]}).run;
 assert.throws(()=>applyAction(active,{type:'revisePlan',contract:revisedContract,reason:'Explicit fixture authorized revision',nodes:[{id:'replacement',dependencies:[],required:true}]}),/settled/);
 assert.throws(()=>applyAction(active,{type:'replaceContract',contract:revisedContract}),/settled/);
 const cancelled=applyAction(active,{type:'cancel'}).run;assert.deepEqual(cancelled.budget.futureExecution,allocation);assert.equal(cancelled.attempts.at(-1)!.settled,false);
 const quiet=applyAction(admitted.run,{type:'revisePlan',contract:revisedContract,reason:'Explicit fixture authorized revision',nodes:[{id:'replacement',dependencies:[],required:true}]});assert.equal(quiet.run.budget.futureExecution,undefined);assert.deepEqual(quiet.events[0]!.details.invalidatedFutureExecution,allocation);assert.equal(quiet.run.budget.spent,7);assert.equal(quiet.run.budget.limit,150);assert.equal(quiet.run.budget.verificationReserve,30);
});

test('P7-ADMIT-I08 full preparation request and late proof bytes remain immutable before the admission transaction',async t=>{
 const f=await fixture(t),prepared=await f.prepare();await assert.rejects(prepareGoalGraphAdmission(f.store,f.data,f.action,{tier:'high',maxActive:2,maxNodes:32,maxDepth:1,maxDurationMs:24*60*60*1000}),/command conflicts/);
 const before=f.store.goals.inspect(f.ready.session.id);await writeFile(f.output,'changed physical proof');assert.throws(()=>f.store.goals.admitGraph(prepared),/Reasoning evidence changed/);assert.deepEqual(f.store.goals.inspect(f.ready.session.id),before);assert.equal(f.store.runtime.list().length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM scheduled_records').get()!.n,0);
});

test('P7-ADMIT-I09 authorized quiet revision retires old scheduled fence atomically and retains immutable plan while unknown claims block',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),admitted=f.store.goals.admitGraph(prepared),planBytes=String(f.db.prepare('SELECT record FROM scheduled_plans WHERE id=?').get(prepared.policy.schedulerId)!.record),prior=f.store.scheduler.get(prepared.policy.schedulerId),old=f.store.runtime.inspect(admitted.session.id);
 const contract={...admitted.run.contract,version:admitted.run.contract.version+1},step={...prepared.admission.integrationStep,id:prepared.admission.integrationStep.id,prompt:'New authorized same requirements revision; no model called'};
 const request={commandId:'quiet-revision',runtimeId:admitted.session.id,expectedContractVersion:admitted.run.contract.version,contract,nodes:[{id:step.id,dependencies:[],required:true}],steps:[step],reason:'Explicit new requirement revision fixture with unchanged acceptance'};
 assert.throws(()=>f.store.runtime.revise(request,()=>{throw Error('parent revision fault')}),/parent revision fault/);assert.deepEqual(f.store.runtime.inspect(admitted.session.id),old);assert.deepEqual(f.store.scheduler.get(prior.id),prior);
 f.store.runtime.revise(request);const retired=f.store.scheduler.get(prior.id);assert.equal(retired.state,'cancelled');assert.equal(retired.fence,'released');assert.equal(String(f.db.prepare('SELECT record FROM scheduled_plans WHERE id=?').get(prior.id)!.record),planBytes);assert.equal(f.store.runtime.inspect(admitted.session.id).run.budget.futureExecution,undefined);f.reopen();
 const op=f.store.runtime.currentOperations(admitted.session.id)[0]!;assert.equal(f.store.runtime.hasScheduledIntegration(op.id),false,'Same textual node ID in a new contract must not inherit old package binding');assert.ok(f.store.runtime.claim(admitted.session.id,'new-owner'));assert.equal(f.store.scheduler.get(prior.id).state,'cancelled');assert.equal(f.db.prepare("SELECT count(*) n FROM scheduled_events WHERE kind='contract-revision-retired'").get()!.n,1);
 const g=await fixture(t),input=await g.prepare(),value=g.store.goals.admitGraph(input);g.store.scheduler.claim({commandId:'active-claim',id:input.policy.schedulerId,expected:g.store.scheduler.expected(input.policy.schedulerId),owner:'old-owner'});const active=g.store.runtime.inspect(value.session.id);assert.throws(()=>g.store.runtime.revise({...request,commandId:'blocked-revision',runtimeId:value.session.id,expectedContractVersion:active.run.contract.version,contract:{...active.run.contract,version:active.run.contract.version+1}}),/settled|unresolved|effects/);assert.deepEqual(g.store.runtime.inspect(value.session.id),active);assert.equal(g.store.scheduler.get(input.policy.schedulerId).fence,'held');assert.equal(g.store.runtime.inspect(value.session.id).run.budget.futureExecution!.amount,20);
 // Even synthetic settled domain accounting cannot retire an unknown scheduler
 // effect: its actual outbox and held scheduler lease remain authoritative.
 const claim=g.store.scheduler.claims(input.policy.schedulerId)[0]!;const quiet=evolve(g,active.run,{type:'finishAttempt',attemptId:claim.attemptId,outcome:'failed'},{type:'settleAttempt',attemptId:claim.attemptId,actual:1},{type:'setOperation',operationId:claim.operationId,attemptId:claim.attemptId,status:'confirmed'},{type:'releaseLease',attemptId:claim.attemptId,resource:'workspace:'+claim.workspace});
 const scheduledOperation=g.store.scheduler.operation(claim.operationId);g.db.prepare('UPDATE scheduled_outbox SET record=? WHERE id=?').run(JSON.stringify({...scheduledOperation,state:'unknown'}),claim.operationId);
 assert.throws(()=>g.store.runtime.revise({...request,commandId:'known-ledger-unknown-effect',runtimeId:value.session.id,expectedContractVersion:quiet.contract.version,contract:{...quiet.contract,version:quiet.contract.version+1}}),/active or unknown effects/);assert.deepEqual(g.store.runtime.inspect(value.session.id).run,quiet);assert.equal(g.store.scheduler.get(input.policy.schedulerId).fence,'held');
 g.store.runtime.control({type:'cancel',commandId:'preserve-unknown-cancel',runtimeId:value.session.id});assert.equal(g.store.runtime.inspect(value.session.id).run.budget.futureExecution!.amount,20);assert.equal(g.store.scheduler.operation(claim.operationId).state,'unknown');assert.equal(g.store.scheduler.leases().some(l=>l.claimId===claim.id&&l.state==='held'),true);
});

test('P7-ADMIT-I10 established single-step P5 admission remains one execution without a redundant branch or final-integration turn', {timeout:30000},async t=>{
 const f=await fixture(t,false,true),oldEnv=process.env.SUPERVISOR_CODEX_PATH;process.env.SUPERVISOR_CODEX_PATH=join(f.root,'intentionally-absent-codex-no-provider');const adapter=new LocalRuntimeAdapter(f.store,f.data),controller=new OrchestrationController(f.store,f.data,adapter);
 try{const result=await controller.dispatch(f.action) as GoalInspection;assert.equal(result.session.phase,'admitted');assert.equal(result.session.graphAdmission,undefined);assert.equal(result.run.budget.futureExecution,undefined);assert.equal(result.session.jobs.length,1);const runtime=f.store.runtime.get(result.session.id);assert.equal(runtime.definition.steps.length,1);assert.equal(runtime.definition.steps[0]!.id,'only-task');assert.equal(f.store.runtime.currentOperations(runtime.id).length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM scheduled_records').get()!.n,0);assert.equal(result.run.budget.spent,7);assert.deepEqual(result.run.contract,admittedPlan(f.ready.session,f.ready.run).contract);assert.equal((await controller.dispatch(f.action) as GoalInspection).session.jobs.length,1);}
 finally{await controller.close();await adapter.close();const owned=await readOwnership(f.data);if(owned?.identity)await terminateProcess(owned.identity,{graceMs:300,killWaitMs:3000});if(oldEnv===undefined)delete process.env.SUPERVISOR_CODEX_PATH;else process.env.SUPERVISOR_CODEX_PATH=oldEnv;}
});

test('P7-ADMIT-I11 actual frozen host request rejects changed returned policy and derived identity before any admission mutation',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),before=f.store.goals.inspect(f.ready.session.id);
 for(const policy of [{...prepared.policy,tier:'unlimited' as const},{...prepared.policy,limits:{...prepared.policy.limits,maxActive:8}},{...prepared.policy,limits:{...prepared.policy.limits,deadlineMs:prepared.policy.limits.deadlineMs+86400000}},{...prepared.policy,schedulerId:'different-id'},{...prepared.policy,preparationRoot:f.workspace}]){
  assert.throws(()=>f.store.goals.admitGraph({...prepared,policy}),/Frozen graph policy/);assert.deepEqual(f.store.goals.inspect(f.ready.session.id),before);assert.equal(f.store.runtime.list().length,0);
 }
 f.reopen();assert.equal(f.store.goals.admitGraph(prepared).session.phase,'admitted');
});

test('P7-ADMIT-I12 transaction rereads actual request and seed bytes and rejects stale command without leaving graph state',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),before=f.store.goals.inspect(f.ready.session.id),directory=join(f.data,'graph-admission',hash(f.action.commandId)),requestPath=join(directory,'prepare-request.json'),seedPath=join(directory,'seed','candidate.json'),raw=await readFile(requestPath,'utf8'),seedRaw=await readFile(seedPath,'utf8');
 const altered=JSON.parse(raw);altered.options.maxActive=8;await writeFile(requestPath,JSON.stringify(altered));assert.throws(()=>f.store.goals.admitGraph(prepared),/Frozen graph/);await writeFile(requestPath,raw);
 const seed=JSON.parse(seedRaw);seed.createdAt=new Date(Date.parse(seed.createdAt)+86400000).toISOString();await writeFile(seedPath,JSON.stringify(seed));assert.throws(()=>f.store.goals.admitGraph(prepared),/Frozen graph seed/);await writeFile(seedPath,seedRaw);
 assert.throws(()=>f.store.goals.admitGraph({...prepared,action:{...prepared.action,commandId:'unprepared-command'}}));assert.deepEqual(f.store.goals.inspect(f.ready.session.id),before);for(const table of ['runtime_runs','scheduled_records','scheduled_plans','task_result_ledgers'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0);
 f.reopen();assert.equal(f.store.goals.admitGraph(prepared).session.phase,'admitted');
});

test('P7-ADMIT-I13 asynchronous preparation freezes caller action and host options before yielding',async t=>{
 const f=await fixture(t),action={...f.action},options={tier:'low' as const,maxActive:2,maxNodes:32,maxDepth:1,maxDurationMs:86400000};
 const pending=prepareGoalGraphAdmission(f.store,f.data,action,options);action.commandId='changed-after-call';options.maxActive=8;options.maxDurationMs*=2;
 const prepared=await pending;assert.equal(prepared.action.commandId,f.action.commandId);assert.equal(prepared.policy.limits.maxActive,2);assert.equal(prepared.policy.limits.deadlineMs-Date.parse(prepared.preparation.request.seed.createdAt),86400000);assert.equal(f.store.goals.admitGraph(prepared).session.phase,'admitted');
});
