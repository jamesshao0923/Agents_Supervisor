import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {LocalRuntimeAdapter} from '../../packages/runtime/index.js';
import {VerificationController} from '../../packages/verification/controller.js';
import {SupervisionController} from '../../packages/orchestration/supervision-controller.js';
import type {GoalProposal} from '../../packages/contracts/p5.js';
import type {SupervisionInspection} from '../../packages/contracts/p6-supervision-actions.js';
import type {VerificationSpec} from '../../packages/contracts/p4.js';
import type {Proposal} from '../../packages/verification/records.js';
import {captureCandidate,canonical,digest} from '../../packages/verification/candidate.js';
import {spawnManagedProcess,inspectProcess} from '../../packages/process-control/index.js';

// These are real SQLite/controller boundary tests. The explicitly recorded goal
// proposal is repository fixture data, never a model answer or live acceptance.
// No reasoner/runtime mock is passed, and every path below stops before model or
// runtime worker launch. P4 propose captures actual files, without claiming review.
const config={model:'must-not-launch-in-mechanism-tests',effort:'low',reservation:30,timeoutMs:1000};
const limits={maxRepairs:2,maxReasoningCalls:5,maxDurationMs:60000,maxContextChars:200000};
async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-supervision-controller-'))),data=join(root,'data'),workspace=join(root,'workspace');await mkdir(workspace);await writeFile(join(workspace,'result.mjs'),'export const value=2;\n');
  let store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),verification=new VerificationController(store,data),controller=new SupervisionController(store,data,runtime,verification);
  const goal=store.goals.start({type:'start',commandId:randomUUID(),goal:'Export value equal to two',tokenLimit:1000,verificationReserve:100,...config},workspace,'project');
  const proposal:GoalProposal={decision:'ready',summary:'Repository mechanism fixture',questions:[],facts:[{text:goal.session.goal,origin:'explicit',sourceId:goal.session.messages[0]!.id}],constraints:[],style:[],criteria:[{id:'value',description:'Export value equal to two',kind:'command',target:'result.mjs',checks:['Actual exported value is exactly two']}],steps:[{id:'implement',description:'Create the requested module',dependencies:[],acceptanceIds:['value']}]};
  const ready=store.goals.finish(goal.session.id,goal.session.jobs[0]!.id,job=>{job.usage=0;job.stopConfirmed=true;job.proposal=proposal;});
  const admitted=store.goals.control({type:'admit',commandId:randomUUID(),sessionId:ready.session.id,expectedRevision:ready.session.revision}),runtimeId=admitted.session.runtimeId!;
  store.runtime.revise({commandId:randomUUID(),runtimeId,expectedContractVersion:admitted.run.contract.version,contract:{...admitted.run.contract,version:admitted.run.contract.version+1},nodes:[{id:'input',required:true,dependencies:[]}],steps:[{id:'input',kind:'input',prompt:'Repository boundary input'}],reason:'Mechanism fixture uses real input operation, not substituted model execution'});
  const conversation=store.conversations.ensureForGoal(goal.session.id);
  async function close(){await controller.close();await verification.close();await runtime.close();store.close();}
  t.after(async()=>{await close();await rm(root,{recursive:true,force:true});});
  return {root,data,workspace,runtimeId,conversationId:conversation.id,get store(){return store;},get controller(){return controller;},get verification(){return verification;},
    async attach(overrides:Partial<typeof limits>={}){return await controller.dispatch({type:'attach',commandId:'attach',runtimeId,config,limits:{...limits,...overrides}}) as SupervisionInspection;},
    completeInput(){store.runtime.control({type:'input',runtimeId,commandId:randomUUID(),stepId:'input',text:'Ready'});const operation=store.runtime.claim(runtimeId,'fixture-owner')!;assert.ok(operation);store.runtime.report(operation.id,'fixture-owner',{messageId:randomUUID(),outcome:'confirmed',result:'Ready'});},
    async restart(){await close();store=new SupervisorStore(data);runtime=new LocalRuntimeAdapter(store,data);verification=new VerificationController(store,data);controller=new SupervisionController(store,data,runtime,verification);await controller.initialize();}
  };
}

test('P6-SCTL-I01 attach is payload idempotent and restart preserves a waiting runtime without model dispatch',async t=>{
  const f=await fixture(t),first=await f.attach(),second=await f.attach();assert.equal(first.loop.id,second.loop.id);assert.equal(second.loop.phase,'executing');assert.equal(second.jobs.length,0);assert.equal(second.runtime.runtime.phase,'waiting-input');
  await assert.rejects(f.attach({maxRepairs:1}),/Conflicting supervision commandId/);
  await f.restart();const after=f.controller.inspect(first.loop.id);assert.equal(after.loop.phase,'executing');assert.equal(after.jobs.length,0);assert.equal(after.runtime.runtime.phase,'waiting-input');assert.equal(after.capabilities.modelMonitoring,false);
  const listed=await f.controller.dispatch({type:'list'}) as SupervisionInspection[];assert.equal(listed[0]!.loop.id,first.loop.id);
});
test('P6-SCTL-I02 pending user requirements fence supervision without allocating or revising the task',async t=>{
  const f=await fixture(t),before=f.store.runtime.inspect(f.runtimeId);f.store.conversations.receive({conversationId:f.conversationId,commandId:'change',kind:'change',source:'user',text:'Please add another required result'});
  const attached=await f.attach();assert.match(attached.loop.reason!,/Pending user follow-up/);await f.controller.scan();assert.equal(f.controller.inspect(attached.loop.id).jobs.length,0);assert.deepEqual(f.store.runtime.inspect(f.runtimeId),before);
});
test('P6-SCTL-I03 supervision pause resume stop and task cancellation hooks do not mutate the main execution ledger',async t=>{
  const f=await fixture(t),first=await f.attach(),before=f.store.runtime.inspect(f.runtimeId);
  const paused=await f.controller.dispatch({type:'pause',loopId:first.loop.id}) as SupervisionInspection;assert.equal(paused.loop.paused,true);assert.match(paused.loop.reason!,/main execution is unchanged/);
  const resumed=await f.controller.dispatch({type:'resume',loopId:first.loop.id}) as SupervisionInspection;assert.equal(resumed.loop.paused,false);
  await f.controller.cancelRuntime(f.runtimeId);const cancelled=f.controller.inspect(first.loop.id);assert.equal(cancelled.loop.stopped,true);assert.match(cancelled.loop.reason!,/domain cancellation/);
  await f.controller.dispatch({type:'stop',loopId:first.loop.id});await assert.rejects(f.controller.dispatch({type:'resume',loopId:first.loop.id}),/cannot resume/);assert.deepEqual(f.store.runtime.inspect(f.runtimeId),before);
});
test('P6-SCTL-I04 raw runtime without authoritative structured criteria blocks before any reasoning reservation',async t=>{
  const f=await fixture(t),workspace=join(f.root,'raw');await mkdir(workspace);await writeFile(join(workspace,'x.mjs'),'export const x=1;');
  const runtime=f.store.runtime.submit({type:'submit',commandId:'raw',workspace,workspaceKind:'project',goal:'Raw goal',tokenLimit:1000,verificationReserve:100,steps:[{id:'input',kind:'input',prompt:'Wait'}]});const before=f.store.runtime.inspect(runtime.id);
  const result=await f.controller.dispatch({type:'attach',commandId:'attach-raw',runtimeId:runtime.id,config,limits}) as SupervisionInspection;assert.equal(result.loop.phase,'blocked');assert.match(result.loop.reason!,/structured goal criteria/);assert.equal(result.jobs.length,0);assert.deepEqual(result.runtime,before);
});
test('P6-SCTL-I05 full bounded context rejection rolls back future floor checkpoint and reasoning reservation',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.mjs'),'\uFEFF// '+ 'a'.repeat(30000)+'\nexport const value=2;');f.completeInput();const before=f.store.runtime.inspect(f.runtimeId);
  const result=await f.attach({maxContextChars:8000});assert.equal(result.loop.phase,'blocked');assert.match(result.loop.reason!,/capacity|context|limit|length/i);assert.equal(result.jobs.length,0);assert.deepEqual(f.store.runtime.inspect(f.runtimeId),before,'Capacity failure cannot leave a floor or model reservation');
});
test('P6-SCTL-I06 restart acknowledges an actual P4 proposal receipt while paused without launching its review',async t=>{
  const f=await fixture(t),attached=await f.attach();f.completeInput();const current=f.store.runtime.inspect(f.runtimeId),good=join(f.root,'good'),bad=join(f.root,'bad'),author=join(f.root,'author');for(const path of [good,bad,author])await mkdir(path);await writeFile(join(good,'result.mjs'),'export const value=2;');await writeFile(join(bad,'result.mjs'),'export const value=1;');await writeFile(join(author,'check.mjs'),'// Mechanism test proposes only; this verifier is never reviewed or executed.');
  const spec:VerificationSpec={schemaVersion:1,contractVersion:current.run.contract.version,standardsVersion:'mechanism-v1',obligations:[{id:'value',criterionId:'value',expectation:'Actual exported value is exactly two',required:true,applicable:true}],cases:[{id:'value',revision:1,obligationIds:['value'],parameters:[{}],modules:['value'],replaces:[],defectRefs:['wrong-value'],verifier:{kind:'command',version:'fixture-only',entry:'check.mjs',files:['check.mjs'],timeoutMs:1000}}],controls:[{id:'good',workspace:good,expect:'passed',mustFail:[]},{id:'bad',workspace:bad,expect:'failed',mustFail:['value']}],moduleDependencies:{}};const specPath=join(author,'spec.json');await writeFile(specPath,JSON.stringify(spec));
  const loop=f.store.supervision.get(attached.loop.id),action={type:'propose' as const,commandId:'durable-proposal',runtimeId:f.runtimeId,specPath};f.store.supervision.prepareIntent({commandId:action.commandId,loopId:loop.id,expectedRevision:loop.revision,kind:'propose',action});
  const proposal=await f.verification.dispatch(action) as Proposal;const pending=f.store.supervision.get(loop.id);f.store.supervision.update(loop.id,pending.revision,{paused:true,reason:'Mechanism pause before acknowledgement'});
  await f.restart();const recovered=f.controller.inspect(loop.id);assert.equal(recovered.loop.intent?.receipt&&((recovered.loop.intent.receipt as {id:string}).id),proposal.id);assert.equal(recovered.loop.references.proposalId,proposal.id);assert.equal(recovered.loop.phase,'reviewing');assert.equal(recovered.loop.paused,true);assert.equal(recovered.loop.reason,'Mechanism pause before acknowledgement');assert.equal(recovered.verification.proposals.length,1);assert.equal(recovered.verification.jobs.length,0);assert.equal(recovered.jobs.length,0);
});
test('P6-SCTL-I07 recovery never relaunches a durable started reasoning job with unknown usage',async t=>{
  const f=await fixture(t),attached=await f.attach(),loop=f.store.supervision.get(attached.loop.id);
  const job=f.store.supervision.beginJob({commandId:'lost-process-intent',loopId:loop.id,expectedRevision:loop.revision,purpose:'diagnosis',context:{prompt:'Repository recovery boundary; never actually dispatch.',outputSchema:{type:'object',properties:{decision:{type:'string'}},required:['decision'],additionalProperties:false},context:{fixture:'interrupted model start intent, no actual model claimed'}}});
  f.store.supervision.observeJob(job.id,{modelStarted:true});const begun=f.store.supervision.get(loop.id);f.store.supervision.update(loop.id,begun.revision,{phase:'diagnosing',references:{diagnosisJobId:job.id}});
  await f.restart();const recovered=f.controller.inspect(loop.id);assert.equal(recovered.loop.phase,'blocked');assert.equal(recovered.jobs.length,1);assert.equal(recovered.jobs[0]!.usage,null);assert.equal(recovered.runtime.run.attempts.find(attempt=>attempt.id===job.id)!.settled,false);await f.controller.scan();assert.equal(f.store.supervision.jobs(loop.id).length,1);assert.equal(f.store.supervision.get(loop.id).reasoningCount,1);
  await f.controller.dispatch({type:'pause',loopId:loop.id});await assert.rejects(f.controller.dispatch({type:'resume',loopId:loop.id}),/unknown usage or stop/);assert.equal(f.store.supervision.jobs(loop.id).length,1);assert.equal(f.controller.inspect(loop.id).loop.paused,true);
});

test('P6-SCTL-I08 pause stops an actual pre-turn process and explicit resume reserves a distinct request preserving frozen input',async t=>{
  const f=await fixture(t);for(const name of ['Z.mjs','a.mjs','é.mjs','中.mjs'])await writeFile(join(f.workspace,name),'export const metadata=1;\n');
  const attached=await f.attach(),loop=f.store.supervision.get(attached.loop.id),candidate=await captureCandidate(f.workspace,join(f.root,'pause-snapshot'));
  const input={prompt:'Explicit repository pre-turn process fixture, not an LLM request.',outputSchema:{type:'object',additionalProperties:false,properties:{decision:{type:'string'}},required:['decision']},context:{candidate,fixture:'Actual Node process, no model turn and no model tokens'}};
  const job=f.store.supervision.beginJob({commandId:'pause-process',loopId:loop.id,expectedRevision:loop.revision,purpose:'diagnosis',context:input});
  assert.notEqual(job.inputDigest,digest(canonical(job.input)),'This candidate must exercise repository/P4 canonical key-order differences');
  const child=await spawnManagedProcess({operationId:job.id+'-pre-turn',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.workspace,timeoutMs:10000,onBeforeSpawn:intent=>{f.store.supervision.observeJob(job.id,{intents:[intent]});},onIdentity:identity=>{f.store.supervision.observeJob(job.id,{identities:[identity]});}});t.after(async()=>{await child.terminate();});
  const started=f.store.supervision.get(loop.id);f.store.supervision.update(loop.id,started.revision,{phase:'diagnosing',references:{diagnosisJobId:job.id}});
  const paused=await f.controller.dispatch({type:'pause',loopId:loop.id}) as SupervisionInspection;assert.equal(paused.loop.phase,'diagnosing');const old=paused.jobs[0]!;assert.equal(old.status,'finished');assert.equal(old.stopConfirmed,true);assert.equal(old.modelStarted,false);assert.equal(old.usage,0);assert.equal((await inspectProcess(old.identities[0]!)).status,'stopped');await child.completion;
  const resumed=await f.controller.dispatch({type:'resume',loopId:loop.id}) as SupervisionInspection;assert.equal(resumed.loop.paused,false);assert.equal(resumed.loop.phase,'diagnosing');assert.equal(resumed.jobs.length,2);assert.equal(resumed.loop.reasoningCount,2);const replacement=resumed.jobs[1]!;assert.notEqual(replacement.id,old.id);assert.deepEqual(replacement.input,old.input);assert.deepEqual(resumed.jobs[0],old);assert.equal(replacement.status,'running');assert.equal(replacement.modelStarted,false);assert.equal(resumed.runtime.run.attempts.find(attempt=>attempt.id===replacement.id)!.reservation,config.reservation);
  // No scan is invoked: prove the new reservation, then pause before any real
  // Codex dispatch. This is a mechanism check, never model or product acceptance.
  await f.controller.dispatch({type:'pause',loopId:loop.id});assert.equal(f.store.supervision.job(replacement.id).usage,0);assert.equal(f.store.supervision.job(replacement.id).modelStarted,false);
});


test('P6-SCTL-I09 actual duration deadline stops a silent owned process and retains unknown cost without cancelling main execution',async t=>{
  const f=await fixture(t),attached=await f.attach({maxDurationMs:1000,maxReasoningCalls:1}),loop=f.store.supervision.get(attached.loop.id),before=f.store.runtime.inspect(f.runtimeId);
  const job=f.store.supervision.beginJob({commandId:'deadline-process',loopId:loop.id,expectedRevision:loop.revision,purpose:'diagnosis',context:{prompt:'Durable process fixture only; no actual model request.',outputSchema:{type:'object',additionalProperties:false,properties:{decision:{type:'string'}},required:['decision']},context:{fixture:'Actual silent Node process; synthetic durable turn intent represents uncertain cost'}}});
  f.store.supervision.observeJob(job.id,{modelStarted:true,observedUsage:3});
  const child=await spawnManagedProcess({operationId:job.id+'-silent',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.workspace,timeoutMs:10000,onBeforeSpawn:intent=>{f.store.supervision.observeJob(job.id,{intents:[intent]});},onIdentity:identity=>{f.store.supervision.observeJob(job.id,{identities:[identity]});}});t.after(async()=>{await child.terminate();});
  // Keep this explicitly persisted in-flight job outside runner.run: a timer must
  // stop it despite receiving no model callbacks. No synthetic transport is used.
  const current=f.store.supervision.get(loop.id);f.store.supervision.update(loop.id,current.revision,{phase:'blocked',reason:'Mechanism fixture has an existing silent request',references:{diagnosisJobId:job.id}});
  await f.controller.scan();assert.equal(f.store.supervision.get(loop.id).stopped,false,'The final authorized reasoning call is not stopped by maxReasoningCalls');assert.equal((await inspectProcess(child.identity)).status,'verified');
  const until=Date.now()+5000;while(f.store.supervision.job(job.id).status==='running'&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
  const after=f.controller.inspect(loop.id),done=after.jobs[0]!;assert.equal(after.loop.stopped,true);assert.match(after.loop.reason!,/duration exhausted/);assert.match(after.loop.reason!,/Main execution is unchanged/);assert.equal(done.status,'finished');assert.equal(done.stopConfirmed,true);assert.equal(done.usage,null);assert.equal(done.observedUsage,3);assert.equal((await inspectProcess(child.identity)).status,'stopped');await child.completion;
  assert.deepEqual(after.runtime.runtime,before.runtime);assert.deepEqual(after.runtime.run.contract,before.run.contract);assert.deepEqual(after.runtime.run.nodes,before.run.nodes);assert.notEqual(after.runtime.run.status,'cancelled');assert.equal(after.runtime.run.budget.spent,before.run.budget.spent);assert.equal(after.runtime.run.attempts.find(attempt=>attempt.id===job.id)!.settled,false);assert.equal(after.runtime.run.attempts.find(attempt=>attempt.id===job.id)!.reservation,config.reservation);assert.equal(after.loop.reasoningCount,1);
  await f.restart();const recovered=f.controller.inspect(loop.id);assert.equal(recovered.loop.stopped,true);assert.equal(recovered.jobs.length,1);assert.equal(recovered.jobs[0]!.usage,null);await assert.rejects(f.controller.dispatch({type:'resume',loopId:loop.id}),/cannot resume/);
});
