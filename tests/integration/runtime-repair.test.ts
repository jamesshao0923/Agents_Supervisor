import {buildSupervisionRepairPrompt} from '../../packages/orchestration/supervision-controller.js';
import {unpackQualificationReview} from '../../packages/verification/qualification-review-wire.js';
import {publishLegacyControlReviewFixture} from '../helpers/legacy-control-review-fixture.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { RuntimeRepository } from '../../packages/persistence/runtime.js';
import { codexStart, type RuntimeRecord } from '../../packages/contracts/p3.js';
import type { RuntimeAppendRepair, RuntimeRetryFailure } from '../../packages/contracts/p6-loop.js';
import type { VerificationSpec } from '../../packages/contracts/p4.js';
import type { FrozenPlan, Proposal, VerificationJob } from '../../packages/verification/records.js';
import { canonical, captureCandidate, digest, environmentFingerprint } from '../../packages/verification/candidate.js';
import { captureDefinition } from '../../packages/verification/definition.js';
import { executeInstances } from '../../packages/verification/engine.js';
import { evaluateVerification, selectInstances } from '../../packages/verification/rules.js';
import { inspectProcess } from '../../packages/process-control/index.js';

const repairStep={id:'repair-1',kind:'codex' as const,prompt:'Repair the observed result while retaining strict original behavior',model:'not-invoked-in-repository-tests',effort:'low',reservation:30,timeoutMs:1000};
async function fixture(t:TestContext,codex=false){
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-runtime-repair-'))),data=join(root,'data'),workspace=join(root,'workspace');await mkdir(workspace);await writeFile(join(workspace,'result.json'),'{"value":1}\n');
  let store=new SupervisorStore(data);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const runtime=store.runtime.submit({type:'submit',commandId:'fixture',workspace,workspaceKind:'project',goal:'result.json.value must equal 2',tokenLimit:100,verificationReserve:20,steps:codex?[{...repairStep,id:'initial'}]:[{id:'ready',kind:'input',prompt:'Ready for independent verification'}]});
  if(!codex){store.runtime.control({type:'input',commandId:'ready',runtimeId:runtime.id,stepId:'ready',text:'Ready'});const op=store.runtime.claim(runtime.id,'fixture-owner')!;store.runtime.report(op.id,'fixture-owner',{messageId:'actual-input-report',outcome:'confirmed',result:{text:'Ready'}});}
  const boundary=()=>{const {run}=store.runtime.inspect(runtime.id);return {runtimeId:runtime.id,expectedContractVersion:run.contract.version,expectedRevision:run.revision};};
  return {root,data,workspace,runtime,boundary,get store(){return store;},restart(){store.close();store=new SupervisorStore(data);return store;}};
}

/** Exercise the real P4 command engine and frozen assets. Catalog publication is a
 * repository-boundary fixture; this does not claim an independent live model review. */
async function failedCandidate(t:TestContext){
  const f=await fixture(t),good=join(f.root,'good'),bad=join(f.root,'bad'),author=join(f.root,'author');
  for(const path of [good,bad,author])await mkdir(path);await writeFile(join(good,'result.json'),'{"value":2}\n');await writeFile(join(bad,'result.json'),'{"value":1}\n');
  const checker="import {readFileSync,writeFileSync} from 'node:fs';\nconst value=JSON.parse(readFileSync(process.argv[2]+'/result.json','utf8')).value;\nconst passed=value===2;\nwriteFileSync(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks:[{obligationId:'correct',verdict:passed?'passed':'failed',reason:'Actual result.json.value is '+value+'; required value is 2'}]}));\nprocess.exitCode=passed?0:1;\n";
  await writeFile(join(author,'check.mjs'),checker);
  const spec:VerificationSpec={schemaVersion:1,contractVersion:1,standardsVersion:'strict-value-2',obligations:[{id:'correct',criterionId:'independent-acceptance',expectation:'value must equal 2',required:true,applicable:true}],cases:[{id:'value',revision:1,obligationIds:['correct'],parameters:[{}],modules:['result'],replaces:[],defectRefs:['WRONG-VALUE'],verifier:{kind:'command',version:'strict-v1',entry:'check.mjs',files:['check.mjs'],timeoutMs:5000}}],controls:[{id:'good',workspace:good,expect:'passed',mustFail:[]},{id:'bad',workspace:bad,expect:'failed',mustFail:['correct']}],moduleDependencies:{}};
  const specPath=join(author,'spec.json');await writeFile(specPath,JSON.stringify(spec));const {bundle}=await captureDefinition(specPath,join(f.root,'definition'));
  const candidate=await captureCandidate(f.workspace,join(f.root,'candidate')),run=f.store.runtime.inspect(f.runtime.id).run;
  const proposal:Proposal={id:'proposal-fixture',runtimeId:f.runtime.id,projectId:run.projectId,runId:run.id,baseVersion:0,version:null,spec,bundle,candidate,contractDigest:digest(canonical(run.contract)),status:'proposed',createdAt:new Date().toISOString()};
  const plan:FrozenPlan={id:'plan-fixture',runtimeId:f.runtime.id,projectId:run.projectId,runId:run.id,proposalId:proposal.id,catalogVersion:1,candidate,contractDigest:proposal.contractDigest,definitionDigest:bundle.digest,environmentDigest:'repository-boundary-fixture',selection:selectInstances(spec,{mode:'final'}),createdAt:new Date().toISOString()};
  const job:VerificationJob={id:'job-fixture',runtimeId:f.runtime.id,projectId:run.projectId,runId:run.id,workspace:f.workspace,kind:'verification',proposalId:proposal.id,planId:plan.id,request:{purpose:'real-command-engine-fixture'},status:'running',attemptId:'job-fixture',config:{model:'no-model-needed',effort:'low',reservation:10,timeoutMs:1000},startedAt:new Date().toISOString(),finishedAt:null,environmentDigest:plan.environmentDigest,intents:[],identities:[],usage:0,modelStarted:false,usageUnknown:false,results:[],controls:[],evaluation:null,approved:false,stopConfirmed:false,error:null,proofs:{},sources:[]};
  f.store.verification.insert('proposal',proposal);f.store.verification.artifact(run.projectId,run.id,{id:proposal.id,...f.store.managedSnapshot(canonical(candidate)),contractVersion:run.contract.version});await publishFixtureReview(f.store,proposal,f.root);
  f.store.verification.transaction(()=>{
    f.store.verification.insert('plan',plan);
    f.store.verification.artifact(run.projectId,run.id,{id:plan.id,...f.store.managedSnapshot(canonical(plan)),contractVersion:1});
    f.store.verification.act(run.projectId,run.id,{type:'startAttempt',attemptId:job.id,nodeId:'ready',contractVersion:1,reservation:10,purpose:'verification',resources:[]});f.store.verification.insert('job',job);
  });
  job.results=await executeInstances({job,signal:new AbortController().signal,output:join(f.root,'verification-output'),save:()=>f.store.verification.update('job',job),eligible:()=>{}},spec,bundle,candidate,plan.selection.instances,'candidate');
  assert.equal(job.results[0]?.executionStatus,'executed',JSON.stringify(job.results));assert.equal(job.results[0]?.checks[0]?.verdict,'failed');
  for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');assert.ok(job.identities.length>0);
  job.evaluation=evaluateVerification(spec,plan.selection,job.results);job.status='finished';job.finishedAt=new Date().toISOString();job.stopConfirmed=true;
  for(const path of job.results.flatMap(r=>r.proofFiles??[]))job.proofs[path]=digest(await readFile(path));
  f.store.verification.transaction(()=>{f.store.verification.act(run.projectId,run.id,{type:'finishAttempt',attemptId:job.id,outcome:'failed'});f.store.verification.act(run.projectId,run.id,{type:'settleAttempt',attemptId:job.id,actual:0});f.store.verification.update('job',job);});
  const append=(commandId='append'):RuntimeAppendRepair=>({...f.boundary(),commandId,steps:[repairStep],failureJobId:job.id,failedObligationIds:['correct'],reason:'Repair actual failed necessary obligation'});
  return {...f,get store(){return f.store;},job,plan,proposal,append};
}

test('P6-REPAIR-I01 real verifier failure appends once preserving contract failed evidence and checkpoint ancestry',async t=>{
  const f=await failedCandidate(t);f.store.runtime.setFutureVerification({...f.boundary(),commandId:'allocate',allocationId:'final',amount:50,reason:'Mandatory re-verification'});
  const old=f.store.runtime.inspect(f.runtime.id),input=f.append();
  const context={contract:old.run.contract,criteria:[{id:'correct',kind:'command' as const,target:'result.json',description:'Value equals two',checks:['result.json value must equal 2']}],failure:{kind:'verification' as const,jobId:f.job.id,planId:f.plan.id,failedObligationIds:['correct'],results:f.job.results,proofs:f.job.proofs}};
  const original=canonical(context),prompt=buildSupervisionRepairPrompt(context,repairStep.prompt);
  assert.equal(canonical(context),original,'Presentation cannot change original failure evidence or standards');
  const blocks=prompt.split('\n\n'),table=JSON.parse(blocks[2]!);
  assert.equal(canonical(unpackQualificationReview(table)),original,'Every real failure result/path/hash and original requirement survives presentation');
  assert.ok(Buffer.byteLength(canonical(table))<Buffer.byteLength(original),'Repeated actual proof bindings are shared without dropping evidence');
  assert.equal(blocks.at(-1),repairStep.prompt);assert.match(prompt,/not authority to change or approve verification/);
  input.steps=[{...repairStep,prompt}];
  const next=f.store.runtime.appendRepair(input);
  assert.deepEqual(f.store.runtime.inspect(next.id).run.contract,old.run.contract);assert.deepEqual(f.store.runtime.inspect(next.id).run.attempts,old.run.attempts);
  assert.equal(next.cursor,1);assert.equal(next.definition.steps.length,2);assert.deepEqual(next.inputs,old.runtime.inputs);assert.equal(next.phase,'ready');
  assert.equal(f.store.runtime.inspect(next.id).run.artifact,null);assert.deepEqual(f.store.verification.get('job',f.job.id),f.job);
  const checkpoint=f.store.runtime.checkpoint(next.id)!;assert.equal(checkpoint.parentId,old.runtime.checkpointId);assert.equal(checkpoint.contractVersion,1);assert.equal(checkpoint.budget.futureVerification?.amount,50);
  assert.deepEqual(checkpoint.frozenPlans.find(p=>(p as {id:string}).id===f.plan.id),JSON.parse(JSON.stringify(f.plan)),'All P4 product frozen plan JSON fields survive repair checkpoints; JSON dictionaries have plain prototypes');
  assert.equal(f.store.runtime.appendRepair(input).id,next.id);assert.equal(f.store.runtime.operations(next.id).length,2);
  f.restart();assert.equal(f.store.runtime.appendRepair(input).id,next.id);assert.equal(f.store.runtime.operations(next.id).length,2);assert.ok(f.store.runtime.inspect(next.id).checkpoints.every(c=>c.valid));
  assert.equal(f.store.runtime.inspect(next.id).runtime.definition.steps.at(-1)!.kind,'codex');
  assert.equal((f.store.runtime.inspect(next.id).runtime.definition.steps.at(-1)! as typeof repairStep).prompt,prompt,'Exact repair input survives restart without regeneration');
  assert.throws(()=>f.store.runtime.appendRepair({...input,reason:'Conflicting retry of same command'}),/conflicts/);
});
test('P6-REPAIR-I02 failed commit rolls back domain repair artifact checkpoint outbox events and receipt',async t=>{
  const f=await failedCandidate(t),before=f.store.runtime.inspect(f.runtime.id),events=f.store.runtime.events(f.runtime.id,0),input=f.append();
  assert.throws(()=>f.store.runtime.appendRepair(input,()=>{throw new Error('Ack rollback');}),/Ack rollback/);
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.deepEqual(f.store.runtime.events(f.runtime.id,0),events);
  assert.equal(f.store.runtime.appendRepair(input).definition.steps.length,2,'No success receipt survived rollback');
});
test('P6-REPAIR-I03 current candidate or actual proof tampering cannot authorize product repair',async t=>{
  const f=await failedCandidate(t);await writeFile(join(f.workspace,'result.json'),'{"value":3}\n');assert.throws(()=>f.store.runtime.appendRepair(f.append()),/current candidate changed/);
  await writeFile(join(f.workspace,'result.json'),'{"value":1}\n');const path=Object.keys(f.job.proofs)[0]!;await writeFile(path,'Changed evidence');assert.throws(()=>f.store.runtime.appendRepair(f.append()),/evidence changed/);
  assert.equal(f.store.runtime.operations(f.runtime.id).length,1);
});
test('P6-REPAIR-I04 verifier error unknown usage or nonexecuted result remains blocked and never becomes repair',async t=>{
  const f=await failedCandidate(t),original=structuredClone(f.job);
  for(const mutate of [(j:VerificationJob)=>{j.error='Verifier crashed';},(j:VerificationJob)=>{j.usageUnknown=true;},(j:VerificationJob)=>{j.results[0]!.executionStatus='verifier-error';},(j:VerificationJob)=>{j.stopConfirmed=false;}]){
    const altered=structuredClone(original);mutate(altered);f.store.verification.update('job',altered);assert.throws(()=>f.store.runtime.appendRepair(f.append()));
  }
  f.store.verification.update('job',original);assert.throws(()=>f.store.runtime.appendRepair({...f.append(),failedObligationIds:['unsupported']}),/actual necessary failure/);
  assert.equal(f.store.runtime.get(f.runtime.id).definition.steps.length,1);
});
test('P6-REPAIR-I05 stale revision pause cancellation and an unfundable repair cannot mutate old standards',async t=>{
  const f=await failedCandidate(t);assert.throws(()=>f.store.runtime.appendRepair({...f.append(),expectedRevision:0}),/revision changed/);
  const before=f.store.runtime.inspect(f.runtime.id);assert.throws(()=>f.store.runtime.appendRepair({...f.append(),steps:[{...repairStep,reservation:90}]}),/budget|Step exceeds/);assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);
  f.store.runtime.control({type:'pause',commandId:'pause',runtimeId:f.runtime.id});assert.throws(()=>f.store.runtime.appendRepair(f.append()),/paused/);
  f.store.runtime.control({type:'cancel',commandId:'cancel',runtimeId:f.runtime.id});assert.throws(()=>f.store.runtime.appendRepair(f.append()),/terminal/);
});

/** A real prelaunch failure boundary. No model call or model usage is claimed. */
async function prelaunchFailure(t:TestContext){
  const f=await fixture(t,true),op=f.store.runtime.claim(f.runtime.id,'fixture-owner')!;
  const execution=f.store.executionCreate({...codexStart(f.store.runtime.get(f.runtime.id),op),workspace:f.workspace,workspaceKind:'project'},f.store.runtime.binding(op.id,'fixture-owner')).record;
  f.store.executionUpdate(execution.id,{state:'failed',stopConfirmed:true,usageStatus:'reported',usage:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0},error:'Confirmed fixture failure before releasing a model turn'},'fixture-prelaunch-failed',{modelInvoked:false},[{type:'finishAttempt',attemptId:op.attemptId,outcome:'failed'},{type:'settleAttempt',attemptId:op.attemptId,actual:0},{type:'setOperation',operationId:op.attemptId,attemptId:op.attemptId,status:'confirmed'},{type:'releaseLease',resource:'workspace:'+f.workspace,attemptId:op.attemptId}]);
  f.store.runtime.report(op.id,'fixture-owner',{messageId:'failure-report',outcome:'failed',result:{executionId:execution.id},error:'Prelaunch failure'});
  const retry=(commandId='retry'):RuntimeRetryFailure=>({...f.boundary(),commandId,operationId:op.id,replacement:{...repairStep,id:'initial'},reason:'Retry a confirmed failed local operation with retained budget'});
  return {...f,get store(){return f.store;},op,execution,retry};
}
test('P6-REPAIR-I06 confirmed failure creates a new generation once and restart selects it preserving old receipt',async t=>{
  const f=await prelaunchFailure(t),old=f.store.runtime.operations(f.runtime.id)[0]!,input=f.retry();
  const next=f.store.runtime.retryConfirmedFailure(input);assert.equal(next.phase,'ready');const current=f.store.runtime.currentOperations(next.id)[0]!;
  assert.notEqual(current.id,old.id);assert.notEqual(current.attemptId,old.attemptId);assert.equal(current.generation,1);assert.equal(current.supersedes,old.id);assert.equal(current.state,'queued');
  assert.deepEqual(f.store.runtime.operations(next.id)[0],old);assert.equal(f.store.runtime.inspect(next.id).run.attempts.length,1,'Retry does not invent an execution attempt before claim');
  f.restart();f.store.runtime.retryConfirmedFailure(input);assert.equal(f.store.runtime.currentOperations(next.id)[0]?.id,current.id);assert.equal(f.store.runtime.operations(next.id).length,2);
  const claimed=f.store.runtime.claim(next.id,'new-owner')!;assert.equal(claimed.id,current.id);assert.equal(f.store.runtime.inspect(next.id).run.attempts.length,2);assert.throws(()=>f.store.runtime.retryConfirmedFailure({...f.retry('new-retry'),operationId:old.id}),/unresolved/);
});
test('P6-REPAIR-I07 retry rollback unknown usage changed step id and cancellation do not release a new operation',async t=>{
  const f=await prelaunchFailure(t),before=f.store.runtime.inspect(f.runtime.id),input=f.retry();
  assert.throws(()=>f.store.runtime.retryConfirmedFailure(input,()=>{throw new Error('Retry rollback');}),/Retry rollback/);assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);
  assert.throws(()=>f.store.runtime.retryConfirmedFailure({...input,replacement:{...repairStep,id:'different'}}),/preserve/);
  f.store.executionUpdate(f.execution.id,{usageStatus:'unknown'},'fixture-unknown-usage',{});assert.throws(()=>f.store.runtime.retryConfirmedFailure(input),/unknown usage/);
  f.store.runtime.control({type:'cancel',commandId:'cancel',runtimeId:f.runtime.id});assert.throws(()=>f.store.runtime.retryConfirmedFailure(f.retry()),/terminal/);assert.equal(f.store.runtime.operations(f.runtime.id).length,1);
});
test('P6-REPAIR-I08 allocation persists through restart and constrains real claim without double charging legacy reserve',async t=>{
  const f=await fixture(t,true),allocate={...f.boundary(),commandId:'allocate',allocationId:'final',amount:80,reason:'Keep room for full verification'};
  f.store.runtime.setFutureVerification(allocate);f.restart();assert.equal(f.store.runtime.futureVerification(f.runtime.id)?.amount,80);
  assert.throws(()=>f.store.runtime.claim(f.runtime.id,'fixture-owner'),/insufficient budget/);assert.equal(f.store.runtime.currentOperations(f.runtime.id)[0]?.state,'queued');assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts.length,0);
  const release={...f.boundary(),commandId:'release',allocationId:'final',amount:0,reason:'Release obsolete allocation while retaining independent acceptance'};
  f.store.runtime.setFutureVerification(release);assert.equal(f.store.runtime.futureVerification(f.runtime.id),null);assert.ok(f.store.runtime.claim(f.runtime.id,'fixture-owner'));
  assert.throws(()=>f.store.runtime.setFutureVerification({...f.boundary(),commandId:'during-flight',allocationId:'new',amount:10,reason:'Cannot change allocation during execution'}),/unresolved/);
});
test('P6-REPAIR-I09 enclosing SQLite rollback retains budget allocation checkpoint and receipt consistency',async t=>{
  const f=await fixture(t,true),db=new DatabaseSync(join(f.data,'supervisor.sqlite')),before=f.store.runtime.inspect(f.runtime.id);t.after(()=>db.close());
  const input={...f.boundary(),commandId:'rollback-allocation',allocationId:'final',amount:50,reason:'Future verification'};
  const repository=new RuntimeRepository(db);db.exec('BEGIN IMMEDIATE');
  repository.setFutureVerification(input);assert.equal(db.isTransaction,true,'Repository must not commit the enclosing transaction');
  assert.equal(repository.futureVerification(f.runtime.id)?.amount,50);db.exec('ROLLBACK');
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.equal(db.prepare('SELECT command_id FROM runtime_receipts WHERE command_id=?').get(input.commandId),undefined);
  f.store.runtime.setFutureVerification(input);assert.equal(f.store.runtime.futureVerification(f.runtime.id)?.amount,50);
});
test('P6-REPAIR-I10 asynchronous commit callbacks are rejected without partial allocation publication',async t=>{
  const f=await fixture(t,true),before=f.store.runtime.inspect(f.runtime.id);
  assert.throws(()=>f.store.runtime.setFutureVerification({...f.boundary(),commandId:'async-commit',allocationId:'final',amount:50,reason:'No asynchronous transaction'},()=>Promise.resolve()),/synchronous/);
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);
});
test('P6-REPAIR-I11 a job id alone cannot authorize repair with mismatched frozen results or actual settlement',async t=>{
  const f=await failedCandidate(t),original=structuredClone(f.job);
  for(const mutate of [(j:VerificationJob)=>{j.usage=1;},(j:VerificationJob)=>{j.proposalId='unrelated';},(j:VerificationJob)=>{j.evaluation!.reasons=['Caller supplied claim'];},(j:VerificationJob)=>{j.results[0]!.instanceId='not-in-frozen-plan';}]){
    const altered=structuredClone(original);mutate(altered);f.store.verification.update('job',altered);assert.throws(()=>f.store.runtime.appendRepair(f.append()));
  }
  assert.equal(f.store.runtime.operations(f.runtime.id).length,1);assert.deepEqual(f.store.runtime.inspect(f.runtime.id).run.contract.criteria,[{id:'independent-acceptance',description:'Independently verify the candidate; completing workflow steps is not delivery acceptance',required:true}]);
});

/** Explicit stored review fixture for repository/controller boundaries. Proof bytes
 * and accounting are real, but approval metadata is NOT a live model review. */
async function publishFixtureReview(store:SupervisorStore,proposal:Proposal,_root:string):Promise<void>{
 await publishLegacyControlReviewFixture(store,proposal);
}
