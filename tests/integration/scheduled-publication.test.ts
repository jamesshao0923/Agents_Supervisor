import {ScheduledRuntimeWorker} from '../../packages/runtime/scheduled-worker.js';
import {ScheduledResultPublisher,scheduledPublicationCommand} from '../../packages/runtime/scheduled-publication.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,readFile,writeFile,chmod,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {TaskSchedulerRepository} from '../../packages/persistence/task-scheduler.js';
import {TaskResultRepository} from '../../packages/persistence/task-results.js';
import {spawnManagedProcess,inspectProcess} from '../../packages/process-control/index.js';
import type {ExecutionRecord} from '../../packages/contracts/p2.js';
import {applyAction} from '../../packages/domain/index.js';
import type {Run} from '../../packages/contracts/p1.js';
import type {ScheduledPlan,ScheduledClaim} from '../../packages/contracts/p7-dispatch.js';
import type {TaskResultManifest} from '../../packages/contracts/p7-results.js';
import {canonical} from '../../packages/verification/candidate.js';
const digest=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
// Real SQLite/domain/scheduler/result repository, actual managed Node output and
// physical stop. Persisted P2 record and five token accounting are explicit
// mechanism fixtures, never provider execution or independent P4 evidence.
async function fixture(t:TestContext,lifetime=100000,configure?:(plan:ScheduledPlan)=>void){
 const cleanups:(()=>Promise<void>)[]=[];
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-producer-'))),data=join(root,'data'),workspace=join(root,'integration');await mkdir(workspace);const store=new SupervisorStore(data),db=new DatabaseSync(join(data,'supervisor.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
 const scheduler=new TaskSchedulerRepository(db,data),results=new TaskResultRepository(db,data),children:Awaited<ReturnType<typeof spawnManagedProcess>>[]=[];
 t.after(async()=>{for(const cleanup of cleanups)await cleanup();for(const child of children){await child.terminate();await child.completion;}db.close();store.close();await rm(root,{recursive:true,force:true});});
 const runtime=store.runtime.submit({type:'submit',commandId:'original',workspace,workspaceKind:'project',goal:'Same required integration criterion',tokenLimit:200,verificationReserve:30,steps:[{id:'integrate',kind:'codex',prompt:'Integrate published branch packages',model:'mechanism-no-model',effort:'low',reservation:20,timeoutMs:10000}]});
 const scope={projectId:runtime.projectId,runId:runtime.runId};results.initializeScope({commandId:'results',...scope});const run=()=>store.query({type:'run',...scope}) as Run;
 const plan:ScheduledPlan={schemaVersion:1,engine:'scheduled-v1',workflowVersion:2,id:'scheduled',runtimeId:runtime.id,...scope,revision:1,contractVersion:run().contract.version,contractDigest:digest(canonical(run().contract)),integrationNodeId:'integrate',tasks:[],tier:'low',loops:[],limits:{maxActive:3,maxNodes:10,maxDepth:3,deadlineMs:Date.now()+lifetime}};
 for(const id of ['A','B','C']){const branch=join(root,id);await mkdir(branch);plan.tasks.push({node:{id,dependencies:id==='B'?['A']:[],required:true,admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:run().contract.criteria.filter(c=>c.required).map(c=>c.id),quality:'strong',value:'strong',reasons:['Host frozen same contract decomposition']},resources:[{kind:'path',key:branch,mode:'write'}],reservation:20,loopIds:[]},inputRequirements:id==='B'?[{dependencyNodeId:'A',minimumState:'submitted'}]:[],step:{id,kind:'codex',prompt:'Explicit real Node mechanism fixture; no provider is invoked',model:'mechanism-no-model',effort:'low',reservation:20,timeoutMs:10000},workspace:branch,workspaceKind:'project',generation:1});}
 configure?.(plan);
 scheduler.install({commandId:'install',plan,expectedRunRevision:run().revision,expectedResultRevision:results.inspect(scope).revision});
 function claim(commandId:string){const result=scheduler.claim({commandId,id:plan.id,expected:scheduler.expected(plan.id),owner:'owner'});assert.equal(result.kind,'claimed');if(result.kind!=='claimed')throw Error('No actual claim');scheduler.prepareInputs(result.claim.id,'owner');return result.claim;}
 async function complete(c:ScheduledClaim,keepAlive=false){
  const binding=scheduler.binding(c.id,'owner'),input=scheduler.executionInput(c.id),now=new Date().toISOString();scheduler.markStarted(binding);
  const receipt:ExecutionRecord={id:c.attemptId,commandId:c.id,...scope,attemptId:c.attemptId,workspace:c.workspace,workspaceKind:c.workspaceKind,prompt:input.prompt,model:input.model,effort:input.effort,images:input.images??[],state:'starting',createdAt:now,updatedAt:now,deadline:new Date(Date.now()+10000).toISOString(),timeoutMs:input.timeoutMs,tokenLimit:input.tokenLimit,reservation:c.reservation,verificationReserve:input.verificationReserve,identity:null,pid:null,threadId:'fixture-thread-'+c.id,turnId:'fixture-turn',turnIntent:true,lastEventSeq:0,message:'Actual Node bytes; synthetic P2 receipt',diff:'',error:null,usage:null,usageStatus:'unknown',stopConfirmed:false,cancelRequested:false,artifactId:null,protocolVersion:null,schemaDigest:null,scheduledBinding:binding};
  db.prepare('INSERT INTO executions(id,command_id,project_id,run_id,request,record) VALUES(?,?,?,?,?,?)').run(receipt.id,receipt.commandId,scope.projectId,scope.runId,canonical(input),canonical(receipt));
  const child=await spawnManagedProcess({operationId:c.attemptId,command:process.execPath,args:['-e',"const fs=require('node:fs');fs.writeFileSync('output.txt','actual branch output\\n');fs.writeFileSync('runner.sh','#!/bin/sh\\nexit 0\\n');fs.chmodSync('runner.sh',0o755);"+(keepAlive?"setInterval(()=>{},1000)":"")],cwd:c.workspace,timeoutMs:10000,onBeforeSpawn:intent=>{store.executionUpdate(receipt.id,{},'process-intent',intent);},onIdentity:identity=>{store.executionUpdate(receipt.id,{identity,pid:identity.pid,state:'running'},'process-identity',identity);}});children.push(child);
  if(keepAlive){for(let n=0;;n++){try{await readFile(join(c.workspace,'runner.sh'));break;}catch{assert.ok(n<150);await new Promise(resolve=>setTimeout(resolve,20));}}}else await child.completion;
  const usage={inputTokens:3,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:5},files:Record<string,{digest:string;size:number;executable:number}>={};for(const path of ['output.txt','runner.sh']){const bytes=await readFile(join(c.workspace,path)),metadata=await stat(join(c.workspace,path));files[path]={digest:digest(bytes),size:bytes.length,executable:metadata.mode&0o111};}
  const snapshot={files};store.executionUpdate(receipt.id,{},'workspace-captured',snapshot);const candidateSnapshot=store.managedSnapshot(JSON.stringify({executionId:receipt.id,threadId:receipt.threadId,turnId:receipt.turnId,state:'completed',message:receipt.message,diff:'',usage,snapshot}));
  store.executionUpdate(receipt.id,{state:'completed',terminalStatus:'completed',stopConfirmed:true,usageStatus:'reported',usage,candidateSnapshot},'explicit-fixture-completion',{fixture:'Synthetic receipt, actual output/process; not model'},[{type:'finishAttempt',attemptId:c.attemptId,outcome:'succeeded'},{type:'settleAttempt',attemptId:c.attemptId,actual:5},{type:'setOperation',operationId:c.operationId,attemptId:c.attemptId,status:'confirmed'},{type:'releaseLease',attemptId:c.attemptId,resource:'workspace:'+c.workspace}]);
  const operation=await scheduler.reconcileExecution({commandId:'reconcile-'+c.id,claimId:c.id,executionId:c.attemptId});assert.equal(operation.state,keepAlive?'unknown':'confirmed');return {child,receipt:store.executionGet(receipt.id),candidateSnapshot};
 }
 async function prepared(c:ScheduledClaim){const descriptor=await results.qualifyScheduledProducer({...scope,operationId:c.operationId}),manifest:TaskResultManifest={schemaVersion:1,...descriptor.producer,inputs:descriptor.inputs,artifacts:descriptor.artifacts,conclusion:'Actual branch bytes submitted, independent scoped verification unsupported',sources:[],checks:[],limitations:['Explicit mechanism fixture, no model/P4 approval'],unresolved:[]};const ref=await results.stageDraft({...scope,commandId:'stage-'+c.id,operationId:c.operationId,expectedRevision:results.inspect(scope).revision,expectedHead:null,manifest});const intent=await results.preparePackage({...scope,commandId:'prepare-'+c.id,ref,operationId:c.operationId});return {ref,intent,manifest,submit:{...scope,commandId:'submit-'+c.id,ref,intentId:intent.id,expectedRevision:results.inspect(scope).revision,expectedHead:null}};}
 async function published(c:ScheduledClaim){const p=await prepared(c),pack=results.materializePackage(p.intent.id);await results.submit(p.submit);return {...p,pack};}
 return {root,data,store,db,runtime,scope,plan,scheduler,results,run,claim,complete,prepared,published,cleanups};
}

test('P7-PUBLISH-I01 real publisher unlocks frozen dependent claim and worker auto publishes all confirmed branches before integration release',async t=>{
 const f=await fixture(t),a=f.claim('A');await f.complete(a);const before=f.run(),publisher=new ScheduledResultPublisher(f.store),aRef=await publisher.publish(a);assert.equal(f.results.inspect(f.scope).heads[0]!.ref.manifestDigest,aRef.manifestDigest);assert.deepEqual(f.run(),before);assert.equal(f.scheduler.integrationFenced(f.runtime.id),true);
 const b=f.claim('B');assert.equal(b.taskId,'B');assert.deepEqual(b.inputBindings,[{dependencyNodeId:'A',result:aRef,minimumState:'submitted'}]);await f.complete(b);const c=f.claim('C');await f.complete(c);const settled=f.run();
 const worker=new ScheduledRuntimeWorker(f.store,f.data,'owner',join(f.root,'uninvoked-no-provider'));f.cleanups.push(()=>worker.close());await worker.tick();assert.deepEqual(worker.errors(),[]);assert.equal(f.results.inspect(f.scope).heads.length,3);assert.ok(f.results.inspect(f.scope).versions.every(version=>version.state==='submitted'&&version.verification===null));assert.equal(f.scheduler.get(f.plan.id).state,'drained');assert.equal(f.scheduler.integrationFenced(f.runtime.id),false);assert.equal(f.run().artifact,null);assert.deepEqual(f.run(),settled);assert.equal(f.store.executionList().length,3,'Publication never starts another model or creates another execution');
 const snapshot=canonical({ledger:f.results.inspect(f.scope),scheduler:f.scheduler.get(f.plan.id),run:f.run()});await worker.tick();assert.equal(canonical({ledger:f.results.inspect(f.scope),scheduler:f.scheduler.get(f.plan.id),run:f.run()}),snapshot);assert.ok(f.store.runtime.claim(f.runtime.id,'serial-integration-owner'),'Only now original serial integration may claim');assert.notEqual(f.run().status,'succeeded');
});
test('P7-PUBLISH-I02 committed draft intent and sealed package recover across actual SQLite failure and store reopen without duplicate receipts',async t=>{
 const f=await fixture(t),a=f.claim('A');await f.complete(a);const before=f.run();
 f.db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON task_result_intents BEGIN SELECT RAISE(ABORT,'actual intent insert failure');END;");await assert.rejects(new ScheduledResultPublisher(f.store).publish(a),/actual intent insert failure/);assert.equal(f.results.inspect(f.scope).versions.length,1);assert.equal(f.results.inspect(f.scope).versions[0]!.state,'draft');f.db.exec('DROP TRIGGER fail_intent');
 f.db.exec("CREATE TRIGGER fail_submit BEFORE INSERT ON task_result_packages BEGIN SELECT RAISE(ABORT,'actual submit insert failure');END;");await assert.rejects(new ScheduledResultPublisher(f.store).publish(a),/actual submit insert failure/);assert.equal(f.results.inspect(f.scope).heads.length,0);assert.equal(f.results.recoverPackages(f.scope)[0]!.status,'sealed-unpublished');assert.equal(f.db.prepare('SELECT count(*) n FROM task_result_intents').get()!.n,1);f.db.exec('DROP TRIGGER fail_submit');
 const reopened=new SupervisorStore(f.data);try{const publisher=new ScheduledResultPublisher(reopened),ref=await publisher.publish(a),after=canonical(f.results.inspect(f.scope));assert.deepEqual(await publisher.publish(a),ref);assert.equal(canonical(f.results.inspect(f.scope)),after);assert.equal(f.results.inspect(f.scope).versions.length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM task_result_intents').get()!.n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM task_result_packages').get()!.n,1);assert.deepEqual(f.run(),before);
  for(const row of f.db.prepare("SELECT command_id,request FROM task_result_receipts WHERE command_id LIKE 'scheduled-result-%'").all()){const {method,...request}=JSON.parse(String(row.request));const kind=method==='stage-result'?'stage':method==='prepare-result-package'?'prepare':'submit';const {commandId,...payload}=request;assert.equal(commandId,row.command_id);assert.equal(commandId,scheduledPublicationCommand(kind,payload),'Full immutable payload, including CAS, fixes command identity');}
 }finally{reopened.close();}
});
test('P7-PUBLISH-I03 one blocked partial publication preserves staging while unrelated confirmed output still auto submits',async t=>{
 const f=await fixture(t),a=f.claim('A'),c=f.claim('C');assert.equal(c.taskId,'C');await f.complete(a);await f.complete(c);const p=await f.prepared(a),prepare={...f.scope,ref:p.ref,operationId:a.operationId},intent=await f.results.preparePackage({...prepare,commandId:scheduledPublicationCommand('prepare',prepare)});await mkdir(join(f.data,'task-result-packages',intent.id+'.staging'));await writeFile(join(f.data,'task-result-packages',intent.id+'.staging','partial'),'Crash residue is retained');
 const worker=new ScheduledRuntimeWorker(f.store,f.data,'owner',join(f.root,'uninvoked-no-provider'));f.cleanups.push(()=>worker.close());await worker.tick();assert.ok(worker.errors().some(error=>error.reason.includes('staging requires explicit recovery')));assert.equal(f.results.inspect(f.scope).heads.some(head=>head.taskId==='A'),false);assert.equal(f.results.inspect(f.scope).heads.some(head=>head.taskId==='C'),true,'Independent confirmed output still publishes');assert.equal(await readFile(join(f.data,'task-result-packages',intent.id+'.staging','partial'),'utf8'),'Crash residue is retained');assert.equal(f.scheduler.integrationFenced(f.runtime.id),true);assert.equal(f.scheduler.claims(f.plan.id).some(claim=>claim.taskId==='B'),false);assert.equal(f.store.executionList().length,2);
 const run=applyAction(f.run(),{type:'cancel'}).run;f.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(canonical(run),run.revision,run.projectId,run.id);const before=f.results.inspect(f.scope);await worker.tick();assert.deepEqual(f.results.inspect(f.scope),before);assert.equal(f.scheduler.integrationFenced(f.runtime.id),true);await assert.rejects(new ScheduledResultPublisher(f.store).publish(a),/scope stopped/);
});


// Real Node/SQLite/FS publication fixtures above; fixed P2 token receipts remain
// synthetic and do not establish provider planning, tool use or P4 acceptance.
test('P7-EXPLORE-I03 durable four tier control preserves plan and claims with full command CAS rollback reopen and unknown accounting',async t=>{
 const f=await fixture(t,100000,plan=>{plan.tasks[2]!.node.required=false;plan.tasks[2]!.node.admission.quality='exploratory';plan.tasks[2]!.node.admission.value='supported';});
 const requiredOnly=await fixture(t);assert.equal(requiredOnly.scheduler.exploration(requiredOnly.plan.id).canChangeTier,false);assert.throws(()=>requiredOnly.scheduler.setExplorationTier({commandId:'no-optional',id:requiredOnly.plan.id,expected:requiredOnly.scheduler.expected(requiredOnly.plan.id),tier:'high'}),/require optional candidates/);assert.equal(requiredOnly.db.prepare('SELECT count(*) AS n FROM scheduled_exploration_policy').get()!.n,0);
 const ipc=await fixture(t,100000,plan=>{plan.tasks[2]!.node.required=false;});
 ipc.store.runtime.control({type:'pause',commandId:'pause-for-ipc',runtimeId:ipc.runtime.id});
 const {startService}=await import('../../apps/supervisor/server.js'),{request:send}=await import('../../apps/cli/client.js');
 const service=await startService(ipc.data);
 try{
  const response=await send(ipc.data,{id:'inspect-tier',method:'exploration',action:{type:'inspect',schedulerId:ipc.plan.id}});
  assert.equal(response.ok,true);
  const actual=response.value as import('../../packages/contracts/p7-exploration.js').ExplorationInspection;
  const action={type:'set-tier' as const,commandId:'ipc-high',schedulerId:ipc.plan.id,expected:actual.expected,tier:'high' as const};
  const changed=await send(ipc.data,{id:'change-tier',method:'exploration',action});assert.equal(changed.ok,true);
  assert.deepEqual(await send(ipc.data,{id:'repeat-tier',method:'exploration',action}),{...changed,id:'repeat-tier'});
  const conflict=await send(ipc.data,{id:'conflict-tier',method:'exploration',action:{...action,tier:'low'}});assert.equal(conflict.ok,false);
  assert.equal(ipc.scheduler.exploration(ipc.plan.id).tier,'high');assert.equal(ipc.store.executionList().length,0,'Paused API must not dispatch a provider');
 }finally{await service.close();}
 const original=canonical(f.scheduler.get(f.plan.id).plan),budget=canonical(f.run().budget),before=f.scheduler.exploration(f.plan.id);
 assert.equal(before.canChangeTier,true);assert.equal(before.tier,'low');assert.equal(before.decision!.nodes.find(node=>node.taskId==='C')!.admitted,false);
 const request={commandId:'tier-medium',id:f.plan.id,expected:before.expected,tier:'medium' as const};
 const medium=f.scheduler.setExplorationTier(request);assert.equal(medium.decision!.nodes.find(node=>node.taskId==='C')!.admitted,false);
 assert.deepEqual(f.scheduler.setExplorationTier(request),medium);assert.throws(()=>f.scheduler.setExplorationTier({...request,tier:'high'}),/command conflict/);
 assert.throws(()=>f.scheduler.setExplorationTier({...request,commandId:'stale',tier:'high'}),/CAS/);
 f.db.exec('BEGIN IMMEDIATE');f.scheduler.setExplorationTier({commandId:'rollback',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),tier:'high'});f.db.exec('ROLLBACK');assert.equal(f.scheduler.exploration(f.plan.id).tier,'medium');assert.equal(f.db.prepare('SELECT 1 FROM scheduled_receipts WHERE command_id=?').get('rollback'),undefined);
 const high=f.scheduler.setExplorationTier({commandId:'high',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),tier:'high'});assert.equal(high.decision!.nodes.find(node=>node.taskId==='C')!.admitted,true);
 const a=f.claim('A-high'),c=f.claim('C-high');assert.equal(c.taskId,'C');const frozen=canonical(c);
 f.scheduler.setExplorationTier({commandId:'lower-active',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),tier:'low'});assert.equal(canonical(f.scheduler.claimGet(c.id)),frozen);assert.equal(f.scheduler.operation(c.operationId).state,'claimed');
 const reopened=new SupervisorStore(f.data);try{assert.equal(reopened.scheduler.exploration(f.plan.id).tier,'low');assert.equal(canonical(reopened.scheduler.get(f.plan.id).plan),original);}finally{reopened.close();}
 const unknown=applyAction(f.run(),{type:'finishAttempt',attemptId:a.attemptId,outcome:'failed'}).run;f.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(canonical(unknown),unknown.revision,unknown.projectId,unknown.id);
 const unlimited=f.scheduler.setExplorationTier({commandId:'unlimited-unknown',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),tier:'unlimited'});assert.ok(unlimited.decision?.reasons.includes('unknown shared accounting'));assert.equal(unlimited.decision!.dispatchTaskIds.length,0);assert.equal(canonical(f.run().budget),budget);assert.equal(canonical(f.scheduler.get(f.plan.id).plan),original);
});

test('P7-EXPLORE-I04 actual stopped optional output survives lowering and every attempted package precedes final integration',async t=>{
 const f=await fixture(t,100000,plan=>{plan.tasks[2]!.node.required=false;plan.tasks[2]!.node.admission.quality='exploratory';plan.tasks[2]!.node.admission.value='supported';});
 const publisher=new ScheduledResultPublisher(f.store),a=f.claim('required-A');await f.complete(a);await publisher.publish(a);const b=f.claim('required-B');await f.complete(b);await publisher.publish(b);
 f.scheduler.setExplorationTier({commandId:'raise',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),tier:'high'});
 assert.equal(publisher.releaseIfReady(f.plan.id),false);
 assert.throws(()=>f.scheduler.releaseIntegration({commandId:'cannot-race',id:f.plan.id,expected:f.scheduler.expected(f.plan.id)}),/optional work remains/);
 const c=f.claim('optional-C');await f.complete(c);
 f.scheduler.setExplorationTier({commandId:'lower',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),tier:'low'});
 assert.equal(publisher.releaseIfReady(f.plan.id),false,'Attempted optional output cannot disappear after lowering');
 await publisher.publish(c);assert.equal(publisher.releaseIfReady(f.plan.id),true);
 assert.equal(f.scheduler.exploration(f.plan.id).canChangeTier,false);assert.equal(f.results.inspect(f.scope).heads.length,3);assert.equal(f.run().budget.spent,15);assert.notEqual(f.run().status,'succeeded');
 assert.throws(()=>f.scheduler.setExplorationTier({commandId:'late-raise',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),tier:'high'}),/cannot reopen/);
 assert.ok(f.store.runtime.claim(f.runtime.id,'final-owner'));
 // A strong optional successor cannot force its weak, excluded prerequisite
 // to execute or permanently block the already completed required core.
 const chain=await fixture(t,100000,plan=>{
  const b=plan.tasks[1]!,c=plan.tasks[2]!;b.node.required=false;b.node.dependencies=['C'];b.inputRequirements=[{dependencyNodeId:'C',minimumState:'submitted'}];
  c.node.required=false;c.node.admission.quality='exploratory';c.node.admission.value='exploratory';c.node.dependencies=['A'];c.inputRequirements=[{dependencyNodeId:'A',minimumState:'submitted'}];
 });
 const publication=new ScheduledResultPublisher(chain.store),core=chain.claim('chain-core');await chain.complete(core);await publication.publish(core);
 assert.equal(chain.scheduler.exploration(chain.plan.id).decision!.state,'exhausted');assert.ok(chain.scheduler.exploration(chain.plan.id).decision!.nodes.filter(n=>n.taskId!=='A').every(n=>!n.admitted));
 chain.db.exec('BEGIN IMMEDIATE');chain.scheduler.releaseIntegration({commandId:'low-core-release',id:chain.plan.id,expected:chain.scheduler.expected(chain.plan.id)});assert.equal(chain.scheduler.get(chain.plan.id).fence,'released');chain.db.exec('ROLLBACK');assert.equal(chain.scheduler.get(chain.plan.id).fence,'held');
 chain.scheduler.setExplorationTier({commandId:'chain-high',id:chain.plan.id,expected:chain.scheduler.expected(chain.plan.id),tier:'high'});assert.equal(publication.releaseIfReady(chain.plan.id),false);
 assert.deepEqual(chain.scheduler.exploration(chain.plan.id).decision!.dispatchTaskIds,['C']);
 chain.scheduler.setExplorationTier({commandId:'chain-low',id:chain.plan.id,expected:chain.scheduler.expected(chain.plan.id),tier:'low'});assert.equal(chain.scheduler.exploration(chain.plan.id).decision!.state,'exhausted');
 chain.scheduler.setExplorationTier({commandId:'chain-high-again',id:chain.plan.id,expected:chain.scheduler.expected(chain.plan.id),tier:'high'});
 const weak=chain.claim('weak-start');assert.equal(weak.taskId,'C');chain.scheduler.setExplorationTier({commandId:'lower-with-real-claim',id:chain.plan.id,expected:chain.scheduler.expected(chain.plan.id),tier:'low'});
 assert.equal(chain.scheduler.exploration(chain.plan.id).decision!.nodes.find(n=>n.taskId==='B')!.admitted,true);assert.equal(publication.releaseIfReady(chain.plan.id),false);
 await chain.complete(weak);await publication.publish(weak);const strong=chain.claim('strong-after-real-weak');assert.equal(strong.taskId,'B');assert.equal(strong.inputBindings[0]!.dependencyNodeId,'C');await chain.complete(strong);await publication.publish(strong);
 assert.equal(publication.releaseIfReady(chain.plan.id),true);assert.equal(chain.run().budget.spent,15);assert.equal(chain.results.inspect(chain.scope).heads.length,3);
});
