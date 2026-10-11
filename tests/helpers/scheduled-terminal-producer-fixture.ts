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
export async function submittedFixture(t:TestContext,lifetime=15000,configuration?:boolean|{tokenLimit:number;verificationReserve:number;configure:(plan:ScheduledPlan,root:string)=>Promise<void>|void}){
 const withOptional=configuration===true,options=typeof configuration==='object'?configuration:undefined;
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-producer-'))),data=join(root,'data'),workspace=join(root,'integration');await mkdir(workspace);const store=new SupervisorStore(data),db=new DatabaseSync(join(data,'supervisor.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
 const scheduler=new TaskSchedulerRepository(db,data),results=new TaskResultRepository(db,data),children:Awaited<ReturnType<typeof spawnManagedProcess>>[]=[];
 t.after(async()=>{for(const child of children){await child.terminate();await child.completion;}db.close();store.close();await rm(root,{recursive:true,force:true});});
 const runtime=store.runtime.submit({type:'submit',commandId:'original',workspace,workspaceKind:'project',goal:'Same required integration criterion',tokenLimit:options?.tokenLimit??200,verificationReserve:options?.verificationReserve??30,steps:[{id:'integrate',kind:'codex',prompt:'Integrate published branch packages',model:'mechanism-no-model',effort:'low',reservation:20,timeoutMs:10000}]});
 const scope={projectId:runtime.projectId,runId:runtime.runId};results.initializeScope({commandId:'results',...scope});const run=()=>store.query({type:'run',...scope}) as Run;
 const plan:ScheduledPlan={schemaVersion:1,engine:'scheduled-v1',workflowVersion:2,id:'scheduled',runtimeId:runtime.id,...scope,revision:1,contractVersion:run().contract.version,contractDigest:digest(canonical(run().contract)),integrationNodeId:'integrate',tasks:[],tier:'low',loops:[],limits:{maxActive:3,maxNodes:10,maxDepth:3,deadlineMs:Date.now()+lifetime}};
 if(withOptional)plan.tier='high';
 for(const id of (withOptional?['A','C']:['A'])){const branch=join(root,id);await mkdir(branch);plan.tasks.push({node:{id,dependencies:id==='B'?['A']:[],required:id==='A',admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:run().contract.criteria.filter(c=>c.required).map(c=>c.id),quality:id==='A'?'strong':'exploratory',value:id==='A'?'strong':'exploratory',reasons:['Host frozen same contract decomposition']},resources:[{kind:'path',key:branch,mode:'write'}],reservation:20,loopIds:[]},inputRequirements:id==='B'?[{dependencyNodeId:'A',minimumState:'submitted'}]:[],step:{id,kind:'codex',prompt:'Explicit real Node mechanism fixture; no provider is invoked',model:'mechanism-no-model',effort:'low',reservation:20,timeoutMs:10000},workspace:branch,workspaceKind:'project',generation:1});}
 if(options)await options.configure(plan,root);
 scheduler.install({commandId:'install',plan,expectedRunRevision:run().revision,expectedResultRevision:results.inspect(scope).revision});
 function claim(commandId:string){const result=scheduler.claim({commandId,id:plan.id,expected:scheduler.expected(plan.id),owner:'owner'});assert.equal(result.kind,'claimed');if(result.kind!=='claimed')throw Error('No actual claim');scheduler.prepareInputs(result.claim.id,'owner');return result.claim;}
 async function complete(c:ScheduledClaim,keepAlive=false,unknownUsage=false){
  const binding=scheduler.binding(c.id,'owner'),input=scheduler.executionInput(c.id),now=new Date().toISOString();scheduler.markStarted(binding);
  const receipt:ExecutionRecord={id:c.attemptId,commandId:c.id,...scope,attemptId:c.attemptId,workspace:c.workspace,workspaceKind:c.workspaceKind,prompt:input.prompt,model:input.model,effort:input.effort,images:input.images??[],state:'starting',createdAt:now,updatedAt:now,deadline:new Date(Date.now()+10000).toISOString(),timeoutMs:input.timeoutMs,tokenLimit:input.tokenLimit,reservation:c.reservation,verificationReserve:input.verificationReserve,identity:null,pid:null,threadId:'fixture-thread-'+c.id,turnId:'fixture-turn',turnIntent:true,lastEventSeq:0,message:'Actual Node bytes; synthetic P2 receipt',diff:'',error:null,usage:null,usageStatus:'unknown',stopConfirmed:false,cancelRequested:false,artifactId:null,protocolVersion:null,schemaDigest:null,scheduledBinding:binding};
  db.prepare('INSERT INTO executions(id,command_id,project_id,run_id,request,record) VALUES(?,?,?,?,?,?)').run(receipt.id,receipt.commandId,scope.projectId,scope.runId,canonical(input),canonical(receipt));
  const child=await spawnManagedProcess({operationId:c.attemptId,command:process.execPath,args:['-e',"const fs=require('node:fs');fs.writeFileSync('output.txt','actual branch output\\n');fs.writeFileSync('runner.sh','#!/bin/sh\\nexit 0\\n');fs.chmodSync('runner.sh',0o755);"+(keepAlive?"setInterval(()=>{},1000)":"")],cwd:c.workspace,timeoutMs:10000,onBeforeSpawn:intent=>{store.executionUpdate(receipt.id,{},'process-intent',intent);},onIdentity:identity=>{store.executionUpdate(receipt.id,{identity,pid:identity.pid,state:'running'},'process-identity',identity);}});children.push(child);
  if(keepAlive){for(let n=0;;n++){try{await readFile(join(c.workspace,'runner.sh'));break;}catch{assert.ok(n<150);await new Promise(resolve=>setTimeout(resolve,20));}}}else await child.completion;
  const usage={inputTokens:3,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:5},files:Record<string,{digest:string;size:number;executable:number}>={};for(const path of ['output.txt','runner.sh']){const bytes=await readFile(join(c.workspace,path)),metadata=await stat(join(c.workspace,path));files[path]={digest:digest(bytes),size:bytes.length,executable:metadata.mode&0o111};}
  const snapshot={files};store.executionUpdate(receipt.id,{},'workspace-captured',snapshot);const candidateSnapshot=store.managedSnapshot(JSON.stringify({executionId:receipt.id,threadId:receipt.threadId,turnId:receipt.turnId,state:'completed',message:receipt.message,diff:'',usage,snapshot}));
  if(unknownUsage){
   // Actual Node output and stopped identity, deliberately unreported supplier
   // accounting. This attempt has never been settled; no real model is invoked.
   assert.equal(keepAlive,false);
   store.executionUpdate(receipt.id,{state:'failed',stopConfirmed:true,usageStatus:'unknown',usage:null,error:'Explicit mechanism fixture: supplier cost not reported'},'fixture-unreported-usage',{fixture:'Actual Node stop and bytes; synthetic unreported provider accounting'},[{type:'finishAttempt',attemptId:c.attemptId,outcome:'failed'},{type:'setOperation',operationId:c.operationId,attemptId:c.attemptId,status:'unknown'}]);
   const operation=await scheduler.reconcileExecution({commandId:'unknown-'+c.id,claimId:c.id,executionId:c.attemptId});
   assert.equal(operation.state,'unknown');
   return {child,receipt:store.executionGet(receipt.id),candidateSnapshot};
  }
  store.executionUpdate(receipt.id,{state:'completed',terminalStatus:'completed',stopConfirmed:true,usageStatus:'reported',usage,candidateSnapshot},'explicit-fixture-completion',{fixture:'Synthetic receipt, actual output/process; not model'},[{type:'finishAttempt',attemptId:c.attemptId,outcome:'succeeded'},{type:'settleAttempt',attemptId:c.attemptId,actual:5},{type:'setOperation',operationId:c.operationId,attemptId:c.attemptId,status:'confirmed'},{type:'releaseLease',attemptId:c.attemptId,resource:'workspace:'+c.workspace}]);
  const operation=await scheduler.reconcileExecution({commandId:'reconcile-'+c.id,claimId:c.id,executionId:c.attemptId});assert.equal(operation.state,keepAlive?'unknown':'confirmed');return {child,receipt:store.executionGet(receipt.id),candidateSnapshot};
 }
 async function prepared(c:ScheduledClaim){const descriptor=await results.qualifyScheduledProducer({...scope,operationId:c.operationId}),manifest:TaskResultManifest={schemaVersion:1,...descriptor.producer,inputs:descriptor.inputs,artifacts:descriptor.artifacts,conclusion:'Actual branch bytes submitted, independent scoped verification unsupported',sources:[],checks:[],limitations:['Explicit mechanism fixture, no model/P4 approval'],unresolved:[]};const ref=await results.stageDraft({...scope,commandId:'stage-'+c.id,operationId:c.operationId,expectedRevision:results.inspect(scope).revision,expectedHead:null,manifest});const intent=await results.preparePackage({...scope,commandId:'prepare-'+c.id,ref,operationId:c.operationId});return {ref,intent,manifest,submit:{...scope,commandId:'submit-'+c.id,ref,intentId:intent.id,expectedRevision:results.inspect(scope).revision,expectedHead:null}};}
 async function published(c:ScheduledClaim){const p=await prepared(c),pack=results.materializePackage(p.intent.id);await results.submit(p.submit);return {...p,pack};}
 return {root,data,store,db,runtime,scope,plan,scheduler,results,run,claim,complete,prepared,published};
}
