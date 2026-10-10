import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile,readFile,stat} from 'node:fs/promises';
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
import {spawnManagedProcess,terminateProcess,inspectProcess} from '../../packages/process-control/index.js';
import {readOwnership,workerAlive} from '../../packages/runtime/worker-ownership.js';
import type {GoalProposal,GoalInspection} from '../../packages/contracts/p5.js';
import type {Run,RunAction} from '../../packages/contracts/p1.js';
const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
/** Explicit synthetic planning JSON and 7-token accounting. The Node emitter,
 * stop identity, persisted P5 job, files, SQLite and runtime controls are real.
 * No provider is called and no synthetic result claims product acceptance. */
async function fixture(t:TestContext,mode:'independent'|'shared'|'unknown'|'resource'|'original'='independent',empty=false,single=false){
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-graph-admit-'))),workspace=join(root,'project'),data=join(root,'data');await mkdir(workspace);if(!empty)await writeFile(join(workspace,'seed.txt'),'original user bytes\n');
 let store=new SupervisorStore(data);const db=new DatabaseSync(join(data,'supervisor.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
 t.after(async()=>{const owned=await readOwnership(data);if(owned?.identity)await terminateProcess(owned.identity,{graceMs:300,killWaitMs:3000});db.close();store.close();await rm(root,{recursive:true,force:true});});
 const first=store.goals.start({type:'start',commandId:'start',goal:'Implement named sum and double exports, preserving zero and negative checks.',model:'explicit-no-provider-fixture',effort:'low',reservation:20,timeoutMs:10000,tokenLimit:150,verificationReserve:30,maxContextChars:100000},workspace,'project'),job=first.session.jobs[0]!;
 const proposal:GoalProposal={decision:'ready',summary:'Explicit synthetic proposal fixture',questions:[],facts:[{text:first.session.goal,sourceId:first.session.messages[0]!.id,origin:'explicit'}],constraints:['Only named exports.'],style:[],criteria:[{id:'sum',description:'sum(a,b) returns a+b',kind:'command',target:'math.test.mjs',checks:['Check zero, positive, negative.']},{id:'double',description:'double(x) returns x+x',kind:'command',target:'math.test.mjs',checks:['Check zero, positive, negative.']}],steps:[{id:'sum',description:'Implement sum and checks',dependencies:[],acceptanceIds:['sum']},{id:'double',description:'Implement double and checks',dependencies:['sum'],acceptanceIds:['double']}]};
 if(single)proposal.steps=[{id:'only-task',description:'Implement both named APIs and all original checks',dependencies:[],acceptanceIds:['sum','double']}];
 proposal.steps[1]!.dependencies=mode==='original'?['sum']:[];proposal.decomposition={schemaVersion:1,tasks:proposal.steps.map(step=>({taskId:step.id,knowledge:mode==='unknown'?'unknown':'declared',reads:[],writes:[{path:mode==='shared'?'shared.mjs':step.id+'.mjs',kind:'file'}],resources:mode==='resource'?[{kind:'custom',key:'shared-project-database',mode:'write'}]:[],reason:'Explicit synthetic declaration, actual downstream graph and filesystem checks.'}))};
 parseReasonerOutput(JSON.stringify(proposal),goalProposalSchema(first.session.messages.map(m=>m.id),'graph-v1'));
 const child=await spawnManagedProcess({operationId:job.id+'-fixture',command:process.execPath,args:['-e','console.log(process.argv[1])',JSON.stringify(proposal)],cwd:workspace,timeoutMs:5000,onBeforeSpawn:intent=>{store.goals.update(first.session.id,job.id,j=>j.intents.push(intent));},onIdentity:identity=>{store.goals.update(first.session.id,job.id,j=>j.identities.push(identity));}});
 let raw='';child.stdout.on('data',b=>raw+=b);const stopped=await child.completion;assert.equal(stopped.stopped,true);assert.deepEqual(JSON.parse(raw),proposal);
 const output=join(data,'planner-fixture.json');await writeFile(output,raw);
 const ready=store.goals.finish(first.session.id,job.id,j=>{j.modelStarted=true;j.threadId='explicit-synthetic-thread';j.usage=7;j.stopConfirmed=true;j.proofs={[output]:hash(raw)};j.proposal=proposal;});
 const action={type:'admit' as const,commandId:'admit',sessionId:ready.session.id,expectedRevision:ready.session.revision};
 return {root,workspace,data,db,ready,action,output,get store(){return store},reopen(){store.close();store=new SupervisorStore(data);},async prepare(){return prepareGoalGraphAdmission(store,data,action);}};
}
function persist(f:{db:DatabaseSync},run:Run){f.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(JSON.stringify(run),run.revision,run.projectId,run.id);}
function evolve(f:{db:DatabaseSync},run:Run,...actions:RunAction[]):Run{for(const a of actions)run=applyAction(run,a).run;persist(f,run);return run;}


import {parseReasonerOutput} from '../../packages/orchestration/reasoner-schema.js';
import {goalProposalSchema,parseOrchestrationAction} from '../../packages/contracts/p5.js';
import {validateProposal} from '../../packages/orchestration/admission.js';
import {canonical,digest,scanCandidate} from '../../packages/verification/candidate.js';
import type {ScheduledClaim} from '../../packages/contracts/p7-dispatch.js';
import type {ExecutionRecord} from '../../packages/contracts/p2.js';
import type {TaskResultManifest} from '../../packages/contracts/p7-results.js';
import {TaskResultRepository} from '../../packages/persistence/task-results.js';

async function graph(t:TestContext,mode:Parameters<typeof fixture>[1]='independent',tier:'low'|'medium'|'high'|'unlimited'='low'){
 const f=await fixture(t,mode),prepared=await prepareGoalGraphAdmission(f.store,f.data,{...f.action,explorationTier:tier}),admitted=f.store.goals.admitGraph(prepared),scheduler=f.store.scheduler,results=f.store.taskResults,scope={projectId:admitted.run.projectId,runId:admitted.run.id},id=prepared.policy.schedulerId;
 const children:Awaited<ReturnType<typeof spawnManagedProcess>>[]=[];t.after(async()=>{for(const child of children){await child.terminate();await child.completion;}});
 const claim=(commandId:string)=>{const result=scheduler.claim({commandId,id,expected:scheduler.expected(id),owner:'fixture-owner'});if(result.kind!=='claimed')throw Error('Expected real scheduler claim: '+JSON.stringify(result));scheduler.prepareInputs(result.claim.id,'fixture-owner');return result.claim;};
 async function launch(c:ScheduledClaim,outside=false){
  const binding=scheduler.binding(c.id,'fixture-owner'),input=scheduler.executionInput(c.id),now=new Date().toISOString();scheduler.markStarted(binding);
  const receipt:ExecutionRecord={id:c.attemptId,commandId:c.id,...scope,attemptId:c.attemptId,workspace:c.workspace,workspaceKind:c.workspaceKind,prompt:input.prompt,model:input.model,effort:input.effort,images:input.images??[],state:'starting',createdAt:now,updatedAt:now,deadline:new Date(Date.now()+10000).toISOString(),timeoutMs:input.timeoutMs,tokenLimit:input.tokenLimit,reservation:c.reservation,verificationReserve:input.verificationReserve,identity:null,pid:null,threadId:'synthetic-P2-thread-'+c.id,turnId:'synthetic-P2-turn',turnIntent:true,lastEventSeq:0,message:'Real Node content/stop, explicitly synthetic P2 receipt and 5 token accounting',diff:'',error:null,usage:null,usageStatus:'unknown',stopConfirmed:false,cancelRequested:false,artifactId:null,protocolVersion:null,schemaDigest:null,scheduledBinding:binding};
  f.db.prepare('INSERT INTO executions(id,command_id,project_id,run_id,request,record) VALUES(?,?,?,?,?,?)').run(receipt.id,receipt.commandId,scope.projectId,scope.runId,canonical(input),canonical(receipt));
  const child=await spawnManagedProcess({operationId:c.attemptId,command:process.execPath,args:['-e',"const fs=require('node:fs');fs.writeFileSync(process.argv[1], process.argv[2]);if(process.argv[3]==='outside')fs.writeFileSync('seed.txt','unauthorized changed user bytes');console.log('actual-ready');setTimeout(()=>{},5000)",c.taskId+'.mjs','export const answer=42;\n',outside?'outside':'allowed'],cwd:c.workspace,timeoutMs:10000,onBeforeSpawn:intent=>{f.store.executionUpdate(receipt.id,{},'process-intent',intent)},onIdentity:identity=>{f.store.executionUpdate(receipt.id,{identity,pid:identity.pid,state:'running'},'process-identity',identity)}});children.push(child);
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.completion.then(()=>reject(Error('Node finished before fixture ready'))).catch(reject);});
  async function finish(){const stopped=await child.completion;assert.equal(stopped.stopped,true);const usage={inputTokens:3,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:5},files:Record<string,{digest:string;size:number;executable:number}>={};for(const path of Object.keys(await scanCandidate(c.workspace))){const bytes=await readFile(join(c.workspace,path)),metadata=await stat(join(c.workspace,path));files[path]={digest:digest(bytes),size:bytes.length,executable:metadata.mode&0o111};}
   const snapshot={files};f.store.executionUpdate(receipt.id,{},'workspace-captured',snapshot);const candidateSnapshot=f.store.managedSnapshot(JSON.stringify({executionId:receipt.id,threadId:receipt.threadId,turnId:receipt.turnId,state:'completed',message:receipt.message,diff:'',usage,snapshot}));
   f.store.executionUpdate(receipt.id,{state:'completed',terminalStatus:'completed',stopConfirmed:true,usageStatus:'reported',usage,candidateSnapshot},'explicit-fixture-completion',{fixture:'Not a provider response'},[{type:'finishAttempt',attemptId:c.attemptId,outcome:'succeeded'},{type:'settleAttempt',attemptId:c.attemptId,actual:5},{type:'setOperation',operationId:c.operationId,attemptId:c.attemptId,status:'confirmed'},{type:'releaseLease',attemptId:c.attemptId,resource:'workspace:'+c.workspace}]);
   assert.equal((await scheduler.reconcileExecution({commandId:'reconcile-'+c.id,claimId:c.id,executionId:c.attemptId})).state,'confirmed');return candidateSnapshot;
  }
  return {child,finish};
 }
 async function draft(c:ScheduledClaim){const descriptor=await results.qualifyScheduledProducer({...scope,operationId:c.operationId}),manifest:TaskResultManifest={schemaVersion:1,...descriptor.producer,inputs:descriptor.inputs,artifacts:descriptor.artifacts,conclusion:'Real branch bytes submitted, not verified',sources:[],checks:[],limitations:['Synthetic provider receipt; actual Node/SQLite/FS only'],unresolved:[]};const ref=await results.stageDraft({...scope,commandId:'stage-'+c.id,operationId:c.operationId,expectedRevision:results.inspect(scope).revision,expectedHead:null,manifest});const intent=await results.preparePackage({...scope,commandId:'prepare-'+c.id,ref,operationId:c.operationId});return {ref,intent,submit:{...scope,commandId:'submit-'+c.id,ref,intentId:intent.id,expectedRevision:results.inspect(scope).revision,expectedHead:null}};}
 async function publish(c:ScheduledClaim){const value=await draft(c),pack=results.materializePackage(value.intent.id);await results.submit(value.submit);return {...value,pack};}
 return {...f,prepared,admitted,scheduler,results,scope,id,claim,launch,draft,publish};
}

test('P7-PARALLEL-I01 new P5 schema binds declarations while legacy schema and original authority remain compatible',async t=>{
 const f=await fixture(t),proposal=f.ready.session.proposal!,sources=f.ready.session.messages.map(m=>m.id),old=structuredClone(proposal);delete old.decomposition;
 for(const explorationTier of ['low','medium','high','unlimited'])assert.equal((parseOrchestrationAction({...f.action,explorationTier}) as {explorationTier:string}).explorationTier,explorationTier);assert.throws(()=>parseOrchestrationAction({...f.action,explorationTier:'eight-agents'}),/tier/);
 parseReasonerOutput(JSON.stringify(old),goalProposalSchema(sources));assert.throws(()=>parseReasonerOutput(JSON.stringify(old),goalProposalSchema(sources,'graph-v1')),/decomposition/);parseReasonerOutput(JSON.stringify({...old,decomposition:null}),goalProposalSchema(sources,'graph-v1'));validateProposal(proposal,f.ready.session);
 for(const path of ['../outside','/outside','*.mjs','.supervisor/inputs']){const bad=structuredClone(proposal);bad.decomposition!.tasks[0]!.writes[0]!.path=path;assert.throws(()=>validateProposal(bad,f.ready.session),/unsafe/);}
 const bad=structuredClone(proposal);bad.decomposition!.tasks[0]!.taskId='not-original';assert.throws(()=>validateProposal(bad,f.ready.session),/foreign/);assert.equal(f.ready.session.jobs.length,1);assert.equal(f.ready.run.budget.spent,7);
});

test('P7-PARALLEL-I02 actual automatic graph claims overlapping Node branches and publishes within scopes before unchanged final integration', {timeout:30000},async t=>{
 const f=await graph(t),a=f.claim('claim-a'),b=f.claim('claim-b');assert.notEqual(a.workspace,b.workspace);assert.deepEqual(a.inputBindings,[]);assert.deepEqual(b.inputBindings,[]);const beforeContract=f.admitted.run.contract;
 const first=await f.launch(a),second=await f.launch(b);assert.equal((await inspectProcess(first.child.identity)).status,'verified');assert.equal((await inspectProcess(second.child.identity)).status,'verified');await Promise.all([first.finish(),second.finish()]);
 const d=await f.draft(a),pack=f.results.materializePackage(d.intent.id),before=f.results.inspect(f.scope);f.db.exec("CREATE TRIGGER publication_fault BEFORE INSERT ON task_result_packages BEGIN SELECT RAISE(ABORT,'explicit parallel publication fault'); END;");await assert.rejects(f.results.submit(d.submit),/explicit parallel publication fault/);assert.deepEqual(f.results.inspect(f.scope),before);f.db.exec('DROP TRIGGER publication_fault');await f.results.submit(d.submit);const pubB=await f.publish(b);
 assert.equal(f.results.inspect(f.scope).versions.every(v=>v.state==='submitted'),true);await assert.rejects(f.results.recordVerification({...f.scope,commandId:'no-fake-verified',ref:pubB.ref,jobId:'absent',expectedRevision:f.results.inspect(f.scope).revision}),/scoped P4 verification unsupported/);
 f.scheduler.releaseIntegration({commandId:'release',id:f.id,expected:f.scheduler.expected(f.id)});const after=f.store.goals.inspect(f.admitted.session.id).run;assert.deepEqual(after.contract,beforeContract);assert.equal(after.budget.spent,17);assert.equal(futureExecutionFloor(after),20);assert.notEqual(after.status,'succeeded');assert.equal(after.artifact,null);
 await writeFile(join(a.workspace,'sum.mjs'),'later historical checkout change');const reopened=new DatabaseSync(join(f.data,'supervisor.sqlite'));try{const repo=new TaskResultRepository(reopened,f.data);assert.deepEqual(repo.readPublished({...f.scope,ref:d.ref,minimumState:'submitted'}),pack);}finally{reopened.close();}
});

test('P7-PARALLEL-I03 actual compiler serializes shared writes unknown resources and retained original dependencies regardless of tier',async t=>{
 for(const mode of ['shared','unknown','resource','original'] as const){const f=await graph(t,mode,'unlimited'),plan=f.scheduler.get(f.id).plan;assert.deepEqual(plan.tasks[1]!.node.dependencies,['sum']);assert.equal(plan.tier,'unlimited');assert.equal(plan.limits.maxActive,2);f.claim('first-'+mode);const blocked=f.scheduler.claim({commandId:'second-'+mode,id:f.id,expected:f.scheduler.expected(f.id),owner:'fixture-owner'});assert.equal(blocked.kind,'waiting');assert.equal(f.scheduler.claims(f.id).length,1);}
});

test('P7-PARALLEL-I04 actual out-of-scope captured bytes cannot stage or publish and all stopped execution costs remain recorded',async t=>{
 const f=await graph(t),claim=f.claim('outside'),run=await f.launch(claim,true);await run.finish();const before=f.results.inspect(f.scope),ledger=f.store.goals.inspect(f.admitted.session.id).run;
 await assert.rejects(f.draft(claim),/violates frozen declared write scope: seed.txt/);assert.deepEqual(f.results.inspect(f.scope),before);assert.equal(f.store.executionGet(claim.attemptId).stopConfirmed,true);assert.equal(ledger.budget.spent,12);assert.equal(ledger.attempts.find(a=>a.id===claim.attemptId)?.settled,true);assert.equal(futureExecutionFloor(ledger),20);
});

test('P7-PARALLEL-I05 actual immutable baseline tampering and late candidate mutation block publication without freeing budget',async t=>{
 const f=await graph(t),claim=f.claim('late'),execution=await f.launch(claim);await execution.finish();const seedPath=join(f.prepared.preparation.request.seed.tree,'seed.txt'),seed=await readFile(seedPath);await writeFile(seedPath,'changed baseline');await assert.rejects(f.draft(claim),/snapshot actual bytes/);await writeFile(seedPath,seed);
 const value=await f.draft(claim);await writeFile(join(claim.workspace,'sum.mjs'),'late mutation');assert.throws(()=>f.results.materializePackage(value.intent.id),/source bytes|source inventory/);assert.equal(f.results.inspect(f.scope).heads.length,0);assert.equal(f.store.goals.inspect(f.admitted.session.id).run.budget.spent,12);
});
