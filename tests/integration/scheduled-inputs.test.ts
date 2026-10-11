import {scheduledExecutionPrompt} from '../../packages/contracts/p7-inputs.js';
import {HostScheduledInputs} from '../../packages/workspace/scheduled-inputs.js';
import {execFileSync} from 'node:child_process';
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
async function fixture(t:TestContext,lifetime=100000){
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-producer-'))),data=join(root,'data'),workspace=join(root,'integration');await mkdir(workspace);const store=new SupervisorStore(data),db=new DatabaseSync(join(data,'supervisor.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
 const scheduler=new TaskSchedulerRepository(db,data),results=new TaskResultRepository(db,data),children:Awaited<ReturnType<typeof spawnManagedProcess>>[]=[];
 t.after(async()=>{for(const child of children){await child.terminate();await child.completion;}db.close();store.close();await rm(root,{recursive:true,force:true});});
 const runtime=store.runtime.submit({type:'submit',commandId:'original',workspace,workspaceKind:'project',goal:'Same required integration criterion',tokenLimit:200,verificationReserve:30,steps:[{id:'integrate',kind:'codex',prompt:'Integrate published branch packages',model:'mechanism-no-model',effort:'low',reservation:20,timeoutMs:10000}]});
 const scope={projectId:runtime.projectId,runId:runtime.runId};results.initializeScope({commandId:'results',...scope});const run=()=>store.query({type:'run',...scope}) as Run;
 const plan:ScheduledPlan={schemaVersion:1,engine:'scheduled-v1',workflowVersion:2,id:'scheduled',runtimeId:runtime.id,...scope,revision:1,contractVersion:run().contract.version,contractDigest:digest(canonical(run().contract)),integrationNodeId:'integrate',tasks:[],tier:'low',loops:[],limits:{maxActive:3,maxNodes:10,maxDepth:3,deadlineMs:Date.now()+lifetime}};
 for(const id of ['A','B','C']){const branch=join(root,id);await mkdir(branch);plan.tasks.push({node:{id,dependencies:id==='B'?['A']:[],required:true,admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:run().contract.criteria.filter(c=>c.required).map(c=>c.id),quality:'strong',value:'strong',reasons:['Host frozen same contract decomposition']},resources:[{kind:'path',key:branch,mode:'write'}],reservation:20,loopIds:[]},inputRequirements:id==='B'?[{dependencyNodeId:'A',minimumState:'submitted'}]:[],step:{id,kind:'codex',prompt:'Explicit real Node mechanism fixture; no provider is invoked',model:'mechanism-no-model',effort:'low',reservation:20,timeoutMs:10000},workspace:branch,workspaceKind:'project',generation:1});}
 scheduler.install({commandId:'install',plan,expectedRunRevision:run().revision,expectedResultRevision:results.inspect(scope).revision});
 function claim(commandId:string){const result=scheduler.claim({commandId,id:plan.id,expected:scheduler.expected(plan.id),owner:'owner'});assert.equal(result.kind,'claimed');if(result.kind!=='claimed')throw Error('No actual claim');scheduler.prepareInputs(result.claim.id,'owner');return result.claim;}
 async function complete(c:ScheduledClaim,keepAlive=false,mutateFrozenInput=false){
  const binding=scheduler.binding(c.id,'owner'),input=scheduler.executionInput(c.id),now=new Date().toISOString();scheduler.markStarted(binding);
  const receipt:ExecutionRecord={id:c.attemptId,commandId:c.id,...scope,attemptId:c.attemptId,workspace:c.workspace,workspaceKind:c.workspaceKind,prompt:input.prompt,model:input.model,effort:input.effort,images:input.images??[],state:'starting',createdAt:now,updatedAt:now,deadline:new Date(Date.now()+10000).toISOString(),timeoutMs:input.timeoutMs,tokenLimit:input.tokenLimit,reservation:c.reservation,verificationReserve:input.verificationReserve,identity:null,pid:null,threadId:'fixture-thread-'+c.id,turnId:'fixture-turn',turnIntent:true,lastEventSeq:0,message:'Actual Node bytes; synthetic P2 receipt',diff:'',error:null,usage:null,usageStatus:'unknown',stopConfirmed:false,cancelRequested:false,artifactId:null,protocolVersion:null,schemaDigest:null,scheduledBinding:binding};
  db.prepare('INSERT INTO executions(id,command_id,project_id,run_id,request,record) VALUES(?,?,?,?,?,?)').run(receipt.id,receipt.commandId,scope.projectId,scope.runId,canonical(input),canonical(receipt));
  const child=await spawnManagedProcess({operationId:c.attemptId,command:process.execPath,args:['-e',"const fs=require('node:fs');fs.writeFileSync('output.txt','actual branch output\\n');fs.writeFileSync('runner.sh','#!/bin/sh\\nexit 0\\n');fs.chmodSync('runner.sh',0o755);"+(mutateFrozenInput?"const index=JSON.parse(fs.readFileSync('.supervisor/task-inputs/"+c.id+"/manifest.json','utf8'));fs.writeFileSync('.supervisor/task-inputs/"+c.id+"/'+index.inputs[0].directory+'/output.txt','Actual branch changed its frozen input');":"")+(keepAlive?"setInterval(()=>{},1000)":"")],cwd:c.workspace,timeoutMs:10000,onBeforeSpawn:intent=>{store.executionUpdate(receipt.id,{},'process-intent',intent);},onIdentity:identity=>{store.executionUpdate(receipt.id,{identity,pid:identity.pid,state:'running'},'process-identity',identity);}});children.push(child);
  if(keepAlive){for(let n=0;;n++){try{await readFile(join(c.workspace,'runner.sh'));break;}catch{assert.ok(n<150);await new Promise(resolve=>setTimeout(resolve,20));}}}else await child.completion;
  const usage={inputTokens:3,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:5},files:Record<string,{digest:string;size:number;executable:number}>={};for(const path of ['output.txt','runner.sh']){const bytes=await readFile(join(c.workspace,path)),metadata=await stat(join(c.workspace,path));files[path]={digest:digest(bytes),size:bytes.length,executable:metadata.mode&0o111};}
  const snapshot={files};store.executionUpdate(receipt.id,{},'workspace-captured',snapshot);const candidateSnapshot=store.managedSnapshot(JSON.stringify({executionId:receipt.id,threadId:receipt.threadId,turnId:receipt.turnId,state:'completed',message:receipt.message,diff:'',usage,snapshot}));
  store.executionUpdate(receipt.id,{state:'completed',terminalStatus:'completed',stopConfirmed:true,usageStatus:'reported',usage,candidateSnapshot},'explicit-fixture-completion',{fixture:'Synthetic receipt, actual output/process; not model'},[{type:'finishAttempt',attemptId:c.attemptId,outcome:'succeeded'},{type:'settleAttempt',attemptId:c.attemptId,actual:5},{type:'setOperation',operationId:c.operationId,attemptId:c.attemptId,status:'confirmed'},{type:'releaseLease',attemptId:c.attemptId,resource:'workspace:'+c.workspace}]);
  const operation=await scheduler.reconcileExecution({commandId:'reconcile-'+c.id,claimId:c.id,executionId:c.attemptId});assert.equal(operation.state,keepAlive?'unknown':'confirmed');return {child,receipt:store.executionGet(receipt.id),candidateSnapshot};
 }
 async function prepared(c:ScheduledClaim){const descriptor=await results.qualifyScheduledProducer({...scope,operationId:c.operationId}),manifest:TaskResultManifest={schemaVersion:1,...descriptor.producer,inputs:descriptor.inputs,artifacts:descriptor.artifacts,conclusion:'Actual branch bytes submitted, independent scoped verification unsupported',sources:[],checks:[],limitations:['Explicit mechanism fixture, no model/P4 approval'],unresolved:[]};const ref=await results.stageDraft({...scope,commandId:'stage-'+c.id,operationId:c.operationId,expectedRevision:results.inspect(scope).revision,expectedHead:null,manifest});const intent=await results.preparePackage({...scope,commandId:'prepare-'+c.id,ref,operationId:c.operationId});return {ref,intent,manifest,submit:{...scope,commandId:'submit-'+c.id,ref,intentId:intent.id,expectedRevision:results.inspect(scope).revision,expectedHead:null}};}
 async function published(c:ScheduledClaim){const p=await prepared(c),pack=results.materializePackage(p.intent.id);await results.submit(p.submit);return {...p,pack};}
 return {root,data,store,db,runtime,scope,plan,scheduler,results,run,claim,complete,prepared,published};
}

test('P7-INPUT-I01 exact complete dependency files and executable modes are copied before launch and prompt binds their index',async t=>{
 const f=await fixture(t),a=f.claim('A');await f.complete(a);await f.published(a);const b=f.claim('B');assert.equal(b.taskId,'B');
 assert.equal(a.hostExecutionBrief?.workspaceMode,'plain-directory');
 assert.equal(b.hostExecutionBrief?.workspaceMode,'plain-directory');
 assert.equal(b.hostExecutionBrief?.reservation,b.reservation);
 assert.deepEqual(b.hostExecutionBrief?.inputs.map(input=>input.dependencyNodeId),['A']);
 const legacy=f.scheduler.claimGet(b.id);delete legacy.hostExecutionBrief;
 const taskPrompt=f.plan.tasks.find(task=>task.node.id==='B')!.step.prompt;
 const legacyPrompt=scheduledExecutionPrompt(taskPrompt,legacy);
 assert.ok(f.scheduler.executionInput(b.id).prompt.startsWith(legacyPrompt+'\n\nHost execution brief'));
 assert.throws(()=>scheduledExecutionPrompt(taskPrompt,{...a,hostExecutionBrief:undefined} as unknown as ScheduledClaim),/Invalid scheduled host brief/);
 const legacyA=structuredClone(a);delete legacyA.hostExecutionBrief;assert.equal(scheduledExecutionPrompt(taskPrompt,legacyA),taskPrompt);
 const legacyHost=new HostScheduledInputs(),unexpectedRead=()=>{throw Error('Legacy empty inputs must not read current sources');};
 assert.equal(legacyHost.prepare(legacyA,unexpectedRead),null);assert.equal(legacyHost.verify(legacyA,unexpectedRead),null);
 assert.throws(()=>legacyHost.verify(a,unexpectedRead),/must not read current sources/,'A new generic brief still revalidates its source callback');
 // Pure rendering boundary on cloned input; this is not published source authority.
 const large=f.scheduler.claimGet(b.id);
 large.hostExecutionBrief!.inputs[0]!.files=Array.from({length:100},(_,i)=>({path:'.supervisor/task-inputs/'+large.id+'/packages/inventory/files/file-'+i+'.txt',digest:'a'.repeat(64),size:i}));
 const fullInventory=JSON.stringify(large.hostExecutionBrief!.inputs);assert.ok(fullInventory.length>8192);
 const frozenLarge=JSON.stringify(large),largePrompt=scheduledExecutionPrompt(taskPrompt,large);
 assert.ok(largePrompt.startsWith(legacyPrompt+'\n\nHost execution brief'));
 assert.ok(largePrompt.includes('exceeds 8192 characters'));assert.ok(largePrompt.includes('This is not a complete file listing'));
 assert.ok(largePrompt.includes('.supervisor/task-inputs/'+large.id+'/manifest.json'));assert.ok(largePrompt.includes('\"fileCount\":100'));
 assert.equal(largePrompt.includes(fullInventory),false);assert.equal(JSON.stringify(large),frozenLarge,'Presentation does not truncate the complete stored inventory');
 assert.ok(f.scheduler.executionInput(b.id).prompt.includes(JSON.stringify(f.scheduler.claimGet(b.id).hostExecutionBrief!.inputs)),'Small inventory remains complete');
const input=f.scheduler.executionInput(b.id),receipt=f.scheduler.prepareInputs(b.id,'owner')!;assert.ok(input.prompt.includes('.supervisor/task-inputs/'+b.id+'/manifest.json'));const index=JSON.parse(await readFile(receipt.indexPath,'utf8'));assert.deepEqual(index.inputs[0].binding,b.inputBindings[0]);
 const inventory=b.hostExecutionBrief!.inputs[0]!.files;
 assert.deepEqual(inventory,index.inputs[0].manifest.artifacts.map((file:{relativePath:string;digest:string;size:number})=>({path:'.supervisor/task-inputs/'+b.id+'/'+index.inputs[0].directory+'/'+file.relativePath,digest:file.digest,size:file.size})));
 assert.ok(inventory.every(file=>!file.path.includes(f.root)),'Only current claim relative sealed source paths');
 const reopened=new DatabaseSync(join(f.data,'supervisor.sqlite'),{readOnly:true});
 try{assert.deepEqual(new TaskSchedulerRepository(reopened,f.data).executionInput(b.id),input);}finally{reopened.close();}
 const foreign=structuredClone(b);foreign.hostExecutionBrief!.inputs[0]!.files[0]!.path='.supervisor/task-inputs/'+a.id+'/packages/other/files/output.txt';
 assert.throws(()=>scheduledExecutionPrompt(taskPrompt,foreign),/Invalid scheduled host brief file/);
 const changed=structuredClone(b);changed.hostExecutionBrief!.inputs[0]!.files[0]!.digest='0'.repeat(64);
 const source=f.results.inspect(f.scope).versions.find(v=>v.ref.taskId==='A')!,pack=f.results.readPublished({...f.scope,ref:source.ref,minimumState:'submitted'});
 assert.throws(()=>new HostScheduledInputs().verify(changed,()=>[{manifest:source.manifest,package:pack}]),/host brief differs/);
const directory=join(receipt.indexPath,'..',index.inputs[0].directory);assert.equal(await readFile(join(directory,'output.txt'),'utf8'),'actual branch output\n');assert.equal((await stat(join(directory,'runner.sh'))).mode&0o111,0o111);assert.deepEqual(f.scheduler.prepareInputs(b.id,'owner'),receipt);await f.complete(b);await f.published(b);assert.ok(f.results.readPublished({...f.scope,ref:f.results.inspect(f.scope).heads.find(h=>h.taskId==='B')!.ref,minimumState:'submitted'}));
 execFileSync('git',['init','--quiet'],{cwd:f.plan.tasks.find(task=>task.node.id==='C')!.workspace});const c=f.claim('C');assert.equal(c.hostExecutionBrief?.workspaceMode,'git-metadata-present');assert.deepEqual(c.hostExecutionBrief?.inputs,[]);await f.complete(c);
 assert.equal(new HostScheduledInputs().captureBrief({...a,workspace:join(a.workspace,'absent-information-only')},()=>[]).workspaceMode,'unknown');
});
test('P7-INPUT-I02 tampered copied bytes index modes and upstream prevent actual dispatch qualification without new spending',async t=>{
 const f=await fixture(t),a=f.claim('A');await f.complete(a);const published=await f.published(a),b=f.claim('B'),receipt=f.scheduler.prepareInputs(b.id,'owner')!,before=f.run(),original=await readFile(receipt.indexPath);const index=JSON.parse(original.toString()),file=join(receipt.indexPath,'..',index.inputs[0].directory,'output.txt'),bytes=await readFile(file);await writeFile(file,'corrupt');assert.throws(()=>f.scheduler.eligible(b.operationId,'owner'),/package bytes changed/);await writeFile(file,bytes);await writeFile(receipt.indexPath,'{}');assert.throws(()=>f.scheduler.eligible(b.operationId,'owner'),/input index changed/);await writeFile(receipt.indexPath,original);const script=join(receipt.indexPath,'..',index.inputs[0].directory,'runner.sh');await chmod(script,0o600);assert.throws(()=>f.scheduler.eligible(b.operationId,'owner'),/executable mode changed/);await chmod(script,0o711);await writeFile(join(published.pack.directory,'files/output.txt'),'broken upstream');assert.throws(()=>f.scheduler.eligible(b.operationId,'owner'),/package bytes changed/);assert.deepEqual(f.run(),before);assert.equal(f.store.executionList().length,1);
});
test('P7-INPUT-I03 foreign workspace index and incomplete copy are never silently adopted or overwritten',async t=>{
 const f=await fixture(t),a=f.claim('A');await f.complete(a);await f.published(a);const next=f.scheduler.claim({commandId:'raw-B',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),owner:'owner'});assert.equal(next.kind,'claimed');if(next.kind!=='claimed')throw Error('missing claim');const b=next.claim;assert.throws(()=>f.scheduler.eligible(b.operationId,'owner'));const parent=join(b.workspace,'.supervisor','task-inputs');await mkdir(parent,{recursive:true});const staging=join(parent,b.id+'.staging');await mkdir(staging);await writeFile(join(staging,'original.txt'),'preserve partial');assert.throws(()=>f.scheduler.prepareInputs(b.id,'owner'),/partial input copy/);assert.equal(await readFile(join(staging,'original.txt'),'utf8'),'preserve partial');assert.equal(f.store.executionList().length,1);assert.ok(f.scheduler.leases().some(l=>l.claimId===b.id&&l.state==='held'));
});

test('P7-INPUT-I04 actual downstream process changing frozen input copies cannot publish a result while known accounting remains settled',async t=>{
 const f=await fixture(t),a=f.claim('A');await f.complete(a);const prior=await f.published(a),b=f.claim('B'),receipt=f.scheduler.prepareInputs(b.id,'owner')!,index=JSON.parse(await readFile(receipt.indexPath,'utf8'));
 await f.complete(b,false,true);assert.equal(await readFile(join(receipt.indexPath,'..',index.inputs[0].directory,'output.txt'),'utf8'),'Actual branch changed its frozen input');const run=f.run(),record=f.store.executionGet(b.attemptId);assert.equal(record.state,'completed');assert.equal(record.stopConfirmed,true);assert.equal(record.usageStatus,'reported');assert.equal(run.attempts.find(a=>a.id===b.attemptId)!.actual,5);
 await assert.rejects(f.published(b),/package bytes changed/);assert.equal(f.results.inspect(f.scope).versions.some(v=>v.ref.taskId==='B'),false);assert.deepEqual(f.run(),run,'Rejecting publication neither repeats reservation nor loses actual settlement');assert.equal(f.run().artifact,null);assert.ok(f.results.readPublished({...f.scope,ref:prior.ref,minimumState:'submitted'}));
});
