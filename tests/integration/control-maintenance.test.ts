import {verificationDirectory} from '../../packages/verification/scoped-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {failedCandidate} from '../helpers/control-maintenance-fixture.js';
import {spawnManagedProcess,inspectProcess} from '../../packages/process-control/index.js';
import {codexStart} from '../../packages/contracts/p3.js';
import {canonical,captureCandidate,digest} from '../../packages/verification/candidate.js';
import {executeInstances} from '../../packages/verification/engine.js';
import {evaluateVerification} from '../../packages/verification/rules.js';
import type {VerificationJob,FrozenPlan} from '../../packages/verification/records.js';
import type {TestContext} from 'node:test';
/** Explicit SQLite/P2 accounting fixture. Processes, files and P4 checkers execute;
 * no provider/model planning, review or success is claimed. */
async function repaired(t:TestContext){
 const f=await failedCandidate(t);f.store.runtime.appendRepair(f.append());const op=f.store.runtime.claim(f.runtime.id,'fixture-owner')!;
 const receipt=f.store.executionCreate({...codexStart(f.store.runtime.get(f.runtime.id),op),workspace:f.workspace,workspaceKind:'project'},f.store.runtime.binding(op.id,'fixture-owner')).record;
 const child=await spawnManagedProcess({operationId:receipt.id,command:process.execPath,args:['-e',"require('node:fs').writeFileSync('result.json','{\"value\":2}\\n')"],cwd:f.workspace,timeoutMs:5000,onBeforeSpawn:intent=>{f.store.executionUpdate(receipt.id,{},'fixture-intent',intent);},onIdentity:identity=>{f.store.executionUpdate(receipt.id,{state:'running',identity,pid:identity.pid},'fixture-node',{});}});
 f.store.runtime.markStarted(op.id,'fixture-owner');await child.completion;assert.equal((await inspectProcess(child.identity)).status,'stopped');
 f.store.executionUpdate(receipt.id,{state:'completed',stopConfirmed:true,usageStatus:'reported',usage:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0}},'fixture-no-provider',{},[{type:'finishAttempt',attemptId:receipt.id,outcome:'succeeded'},{type:'settleAttempt',attemptId:receipt.id,actual:0},{type:'releaseLease',attemptId:receipt.id,resource:'workspace:'+f.workspace},{type:'setOperation',operationId:receipt.id,attemptId:receipt.id,status:'confirmed'}]);
 f.store.runtime.report(op.id,'fixture-owner',{messageId:'actual-repair-node',outcome:'confirmed',result:'Actual Node wrote repaired file; no model'});
 const candidate=await captureCandidate(f.workspace,join(f.data,'passing'));
 const plan:FrozenPlan={...f.plan,id:'pass-plan',candidate,createdAt:new Date().toISOString()};
 const job:VerificationJob={...structuredClone(f.job),id:'pass-job',planId:plan.id,attemptId:'pass-job',status:'running',startedAt:new Date().toISOString(),finishedAt:null,intents:[],identities:[],results:[],controls:[],proofs:{},approved:false,evaluation:null,stopConfirmed:false};
 f.store.verification.transaction(()=>{f.store.verification.insert('plan',plan);f.store.verification.artifact(job.projectId,job.runId,{id:plan.id,...f.store.managedSnapshot(canonical(candidate)),contractVersion:1});f.store.verification.act(job.projectId,job.runId,{type:'startAttempt',attemptId:job.id,nodeId:'repair-1',contractVersion:1,reservation:10,purpose:'verification',resources:[]});f.store.verification.insert('job',job);});
 job.results=await executeInstances({job,signal:new AbortController().signal,output:verificationDirectory(f.data,job),save:()=>f.store.verification.update('job',job),eligible:()=>{}},f.proposal.spec,f.proposal.bundle,candidate,plan.selection.instances,'candidate');
 job.evaluation=evaluateVerification(f.proposal.spec,plan.selection,job.results);assert.equal(job.evaluation.complete,true);job.approved=true;job.status='finished';job.stopConfirmed=true;job.finishedAt=new Date().toISOString();for(const p of job.results.flatMap(r=>r.proofFiles??[]))job.proofs[p]=digest(await readFile(p));
 const actualReport=join(verificationDirectory(f.data,job),'report.json');await writeFile(actualReport,JSON.stringify({results:job.results,controls:job.controls,evaluation:job.evaluation,error:job.error}));job.proofs[actualReport]=digest(await readFile(actualReport));
 f.store.verification.transaction(()=>{f.store.verification.act(job.projectId,job.runId,{type:'finishAttempt',attemptId:job.id,outcome:'succeeded'});f.store.verification.act(job.projectId,job.runId,{type:'settleAttempt',attemptId:job.id,actual:0});f.store.verification.update('job',job);});
 const loop=f.store.supervision.attach({commandId:'loop',runtimeId:f.runtime.id,config:{model:'mechanism-only-no-provider',effort:'low',reservation:100,timeoutMs:1000},limits:{maxRepairs:3,maxReasoningCalls:4,maxDurationMs:60000,maxContextChars:200000}});
 return {...f,get store(){return f.store;},pass:job,passPlan:plan,loop};
}
test('P6-MAINT-I01 actual command failure repair and original full pass reserve maintenance atomically and reopen once',async t=>{
 const f=await repaired(t),repo=f.store.controlMaintenance,basis=repo.assess(f.loop.id,f.pass.id)!;assert.equal(basis.sources.length,1);assert.equal(basis.sources[0]!.result.checks[0]!.verdict,'failed');
 const input={commandId:'maintenance',loopId:f.loop.id,expectedRevision:f.loop.revision,basis,authorInput:{prompt:'No model dispatch in this repository fixture',outputSchema:{},context:{evolution:{maintenance:{basis}}}}};const before=f.store.runtime.inspect(f.runtime.id);
 assert.throws(()=>repo.transaction(()=>{repo.begin(input);throw Error('parent rollback');}),/parent rollback/);assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.equal(repo.forLoop(f.loop.id),null);assert.equal(f.store.supervision.jobs(f.loop.id).length,0);
 const result=repo.begin(input);assert.equal(result.maintenance.basis.necessity,'required-regression');assert.equal(f.store.runtime.futureVerification(f.runtime.id)?.allocationId,result.maintenance.id+':final');assert.deepEqual(repo.begin(input),result);assert.throws(()=>repo.begin({...input,authorInput:{different:true}}),/Conflicting/);
 f.restart();assert.deepEqual(f.store.controlMaintenance.begin(input),result);assert.equal(f.store.supervision.jobs(f.loop.id).length,1);assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,1);
});
test('P6-MAINT-I02 actual proof and workspace tampering or unknown cost cannot create a maintenance allowance',async t=>{
 const f=await repaired(t);await writeFile(join(f.workspace,'result.json'),'{"value":3}');assert.throws(()=>f.store.controlMaintenance.assess(f.loop.id,f.pass.id),/bytes changed/);await writeFile(join(f.workspace,'result.json'),'{"value":2}\n');
 const valid=f.store.controlMaintenance.assess(f.loop.id,f.pass.id);assert.ok(valid);const unknown=structuredClone(f.pass);unknown.usageUnknown=true;assert.deepEqual({...unknown,usageUnknown:false},f.pass);f.store.verification.update('job',unknown);assert.throws(()=>f.store.controlMaintenance.assess(f.loop.id,f.pass.id),/^Error: Control maintenance: Overlapping verification usage is unknown$/);assert.equal(f.store.controlMaintenance.forLoop(f.loop.id),null);f.store.verification.update('job',f.pass);assert.deepEqual(f.store.controlMaintenance.assess(f.loop.id,f.pass.id),valid);
 await writeFile(Object.keys(f.job.proofs)[0]!,'tampered');assert.throws(()=>f.store.controlMaintenance.assess(f.loop.id,f.pass.id),/proof bytes changed/);assert.equal(f.store.controlMaintenance.forLoop(f.loop.id),null);
});

test('P6-MAINT-I03 actual regression pairs require exact business failure and passing repaired bytes and forbid same-job replay',async t=>{
 const f=await repaired(t),basis=f.store.controlMaintenance.assess(f.loop.id,f.pass.id)!;
 const {executeMaintenanceReplay}=await import('../../packages/verification/control-maintenance-replay.js');
 const {assertMaintenancePlan}=await import('../../packages/verification/control-maintenance-rules.js');
 const proposal=structuredClone(f.proposal);proposal.id='proposed-replay';const revision={...proposal.spec.cases[0]!,revision:2,defectRefs:[...proposal.spec.cases[0]!.defectRefs,basis.sources[0]!.defectRef]};proposal.spec.cases.push(revision);
 const plan={regressions:[{defectRef:basis.sources[0]!.defectRef,caseId:revision.id,revision:2,parameters:{}}],reason:'Bind actual wrong-value fault'};assertMaintenancePlan(basis,f.proposal.spec,proposal.spec,plan);
 const job={...structuredClone(f.pass),id:'replay-review',kind:'review' as const,proposalId:proposal.id,planId:null,status:'running' as const,intents:[],identities:[],controls:[],results:[],proofs:{},approved:false,stopConfirmed:false};const context={job,output:join(f.data,'replay-output'),save(){},eligible(){},signal:new AbortController().signal};
 const replay=await executeMaintenanceReplay(context,proposal,basis,plan);assert.equal(replay.replays[0]!.bad[0]!.checks[0]!.verdict,'failed');assert.equal(replay.replays[0]!.good[0]!.checks[0]!.verdict,'passed');assert.equal(job.controls.length,2);for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');await assert.rejects(executeMaintenanceReplay(context,proposal,basis,plan),/must not be replayed/);
 const invalid=structuredClone(replay.replays[0]!);invalid.bad[0]!.executionStatus='verifier-error';const {assertMaintenanceReplay}=await import('../../packages/verification/control-maintenance-rules.js');assert.throws(()=>assertMaintenanceReplay(invalid),/did not execute/);invalid.bad[0]!.executionStatus='executed';invalid.bad[0]!.checks[0]!.obligationId='unrelated';assert.throws(()=>assertMaintenanceReplay(invalid),/specific failed/);
});

test('P6-MAINT-I04 required classification tampering budget exhaustion and cancellation preserve the passing baseline',async t=>{
 const f=await repaired(t),basis=f.store.controlMaintenance.assess(f.loop.id,f.pass.id)!,before=f.store.runtime.inspect(f.runtime.id),input={commandId:'required',loopId:f.loop.id,expectedRevision:f.loop.revision,basis,authorInput:{context:{evolution:{maintenance:{basis}}}}};
 assert.throws(()=>f.store.controlMaintenance.begin({...input,basis:{...basis,necessity:'optional-deduplication'}}),/differs/);assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);
 const cost={projectId:f.loop.projectId,runId:f.loop.runId};f.store.verification.act(cost.projectId,cost.runId,{type:'startAttempt',attemptId:'explicit-spend-fixture',nodeId:'@supervisor',contractVersion:f.loop.contractVersion,purpose:'reasoning',reservation:9750,resources:[]});f.store.verification.act(cost.projectId,cost.runId,{type:'finishAttempt',attemptId:'explicit-spend-fixture',outcome:'succeeded'});f.store.verification.act(cost.projectId,cost.runId,{type:'settleAttempt',attemptId:'explicit-spend-fixture',actual:9750});assert.throws(()=>f.store.controlMaintenance.begin(input),/cannot fund/);assert.equal(f.store.runtime.futureVerification(f.runtime.id),null);
 f.store.runtime.control({type:'cancel',commandId:'cancel-maintenance',runtimeId:f.runtime.id});assert.throws(()=>f.store.controlMaintenance.begin(input),/disabled/);assert.equal(f.store.controlMaintenance.forLoop(f.loop.id),null);assert.deepEqual(f.store.verification.get('job',f.pass.id),f.pass);
});

test('P6-MAINT-I08 overlapping other-Run queued execution cannot consume the bounded maintenance allowance',async t=>{
 const f=await repaired(t),basis=f.store.controlMaintenance.assess(f.loop.id,f.pass.id)!,input={commandId:'overlap',loopId:f.loop.id,expectedRevision:f.loop.revision,basis,authorInput:{context:{evolution:{maintenance:{basis}}}}};
 const other=f.store.runtime.submit({type:'submit',commandId:'other-run',workspace:f.workspace,workspaceKind:'project',goal:'Explicit overlapping execution mechanism fixture',tokenLimit:100,verificationReserve:20,steps:[{id:'write',kind:'codex',prompt:'Never dispatch this fixture',model:'no-model',effort:'low',reservation:10,timeoutMs:1000}]});const op=f.store.runtime.claim(other.id,'other-owner')!;
 f.store.executionCreate({...codexStart(f.store.runtime.get(other.id),op),workspace:f.workspace,workspaceKind:'project'},f.store.runtime.binding(op.id,'other-owner'));
 assert.throws(()=>f.store.controlMaintenance.begin(input),/Overlapping execution/);await assert.rejects(f.store.controlMaintenance.assertPhysical(f.loop.id),/Overlapping execution/);assert.equal(f.store.controlMaintenance.forLoop(f.loop.id),null);assert.equal(f.store.supervision.jobs(f.loop.id).length,0);assert.equal(f.store.runtime.futureVerification(f.runtime.id),null);
});
