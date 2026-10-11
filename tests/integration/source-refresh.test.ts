import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {readFileSync as readFileSyncCompatible} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import type {AddressInfo} from 'node:net';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {ResearchRuntimeActivity} from '../../packages/runtime/research-activity.js';
import {MaterialIntake} from '../../packages/workspace/material-intake.js';
import {spawnManagedProcess,inspectProcess} from '../../packages/process-control/index.js';
import {parseFollowupEvolution,followupEvolutionReviewSchema,validateEvolutionReview} from '../../packages/orchestration/followup-evolution.js';
import {assertSourceRefreshIntent,sourceRefreshDigest,assertSourceRefreshConfiguration} from '../../packages/verification/source-refresh-intent.js';
import {readSourceRefreshGeneration} from '../../packages/verification/source-refresh-binding.js';
import {canonical,digest} from '../../packages/verification/candidate.js';
import type {TaskContract} from '../../packages/contracts/p1.js';
import type {GoalProposal} from '../../packages/contracts/p5.js';
// Explicit synthetic model receipts/fees, actual Node/SQLite/files; no provider approval.
async function actualFollowup(
 f:{store:SupervisorStore;root:string;workspace:string;beforeApply?:()=>void},sessionId:string,messageId:string,
 originalContract:TaskContract,originalProposal:GoalProposal,rawFollowup:unknown
){
 const begun=f.store.goals.beginFollowup(sessionId,messageId);
 const context={originalContract:originalContract,originalProposal:originalProposal,
  frozenMessages:f.store.conversations.messages(f.store.conversations.message(messageId).conversationId),newMessageId:messageId,session:begun.session};
 const followup=parseFollowupEvolution(rawFollowup,context,[]);
 const reviewSchema=followupEvolutionReviewSchema(followup,context,[]) as {properties:{proposalDigest:{const:string};sourceDigest:{const:string}}};
 const review={...(followup.sourceRefresh?{sourceRefresh:{intentDigest:sourceRefreshDigest(followup.sourceRefresh),authorized:true,reasons:['Explicit synthetic independent refresh intent authorization, not supplier evidence']}}:{}),approved:true,proposalDigest:reviewSchema.properties.proposalDigest.const,sourceDigest:reviewSchema.properties.sourceDigest.const,
  changes:followup.criterionChanges!.map(change=>({kind:change.kind,criterionId:change.criterionId,authorized:true,reasons:['Explicit synthetic authorization review of actual new user quotation; no model approval claimed']}))};
 const followupJob=begun.session.jobs.at(-1)!,followupProof=join(f.root,followupJob.id+'-authorization.process.json');
 let followupIntent:unknown,followupIdentity:unknown;
 const reasonNode=await spawnManagedProcess({operationId:followupJob.id,command:process.execPath,args:['-e','process.exit(0)'],cwd:f.workspace,timeoutMs:3000,
  onBeforeSpawn:i=>{followupIntent=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.intents.push(i);});},
  onIdentity:i=>{followupIdentity=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.identities.push(i);});}});
 const reasonStop=await reasonNode.completion;assert.equal(reasonStop.stopped,true);
 await writeFile(followupProof,JSON.stringify({intent:followupIntent,identity:followupIdentity,result:reasonStop,output:rawFollowup}));
 const reviewProof=join(f.root,followupJob.id+'-review.process.json');let reviewIntent:unknown,reviewIdentity:unknown;
 const reviewNode=await spawnManagedProcess({operationId:followupJob.id+'-review',command:process.execPath,args:['-e','process.exit(0)'],cwd:f.workspace,timeoutMs:3000,
  onBeforeSpawn:i=>{reviewIntent=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.intents.push(i);});},
  onIdentity:i=>{reviewIdentity=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.identities.push(i);});}});
 const reviewStop=await reviewNode.completion;assert.equal(reviewStop.stopped,true);
 await writeFile(reviewProof,JSON.stringify({intent:reviewIntent,identity:reviewIdentity,result:reviewStop,output:review}));
 const proofMap={[followupProof]:digest(readFileSyncCompatible(followupProof)),[reviewProof]:digest(readFileSyncCompatible(reviewProof))};
 f.store.goals.finish(sessionId,followupJob.id,j=>{j.modelStarted=true;j.usage=2;j.stopConfirmed=true;j.threadId='synthetic-followup-author';j.proofs=proofMap;j.followupResult=followup;j.context={input:{...context,researchConfiguration:begun.session.research},acceptanceReview:review,callReceipts:[{id:followupJob.id,output:rawFollowup,outputDigest:digest(canonical(rawFollowup)),threadId:'synthetic-proposal-thread',usage:1,stopConfirmed:true,proofs:{[followupProof]:proofMap[followupProof]}},{id:followupJob.id+'-review',output:review,outputDigest:digest(canonical(review)),threadId:'synthetic-authorization-review-thread',usage:1,stopConfirmed:true,proofs:{[reviewProof]:proofMap[reviewProof]}}]};});
 f.beforeApply?.();return f.store.goals.applyFollowup(sessionId,followupJob.id);
}


async function prepared(t:TestContext){
 const root=await realpath(await mkdtemp('/tmp/sv-source-refresh-')),data=join(root,'data'),workspace=join(root,'workspace'),source=join(root,'notes.md'),frozenSource=join(root,'frozen.md');await mkdir(workspace);await writeFile(source,'Original source version A.\n');await writeFile(frozenSource,'Unselected source remains frozen.\n');const store=new SupervisorStore(data);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const config={model:'explicit-synthetic-no-provider',effort:'low',reservation:30,timeoutMs:5000},research={schemaVersion:1 as const,inputs:[{id:'original',kind:'local' as const,path:source},{id:'frozen',kind:'local' as const,path:frozenSource}],materialLimits:{maxInputs:5,parallel:2,maxItemBytes:4096,maxTotalBytes:8192,timeoutMs:1000,maxDurationMs:3000,maxRedirects:0},researchLimits:{maxContextChars:100000,maxClaims:8,maxCitations:8,maxQuoteChars:12000},reportDirectory:'report',cutoff:null,maxSourceAgeMs:600000};
 const started=store.goals.start({type:'start',commandId:'original',workspace,goal:'Preserve faithful full indexed summary with actual source quotes and every required check.',tokenLimit:1000,verificationReserve:100,...config,research},workspace,'project');
 const proposal:GoalProposal={decision:'ready',summary:'Explicit mechanism proposal',questions:[],facts:[],constraints:[],style:[],criteria:[{id:'meaning',kind:'material',target:'report/report.json',description:'Faithful source summary',checks:['Full source index, every original question and literal citations remain independently checked.']}],steps:[{id:'analyze',description:'Read the actual frozen source and report',dependencies:[],acceptanceIds:['meaning']}]};
 const ready=store.goals.finish(started.session.id,started.session.jobs[0]!.id,j=>{j.usage=0;j.stopConfirmed=true;j.proposal=proposal;});store.goals.control({type:'admit',commandId:'admit-original',sessionId:ready.session.id,expectedRevision:ready.session.revision});
 const runtime=store.runtime.get(store.goals.get(ready.session.id).runtimeId!),activity=new ResearchRuntimeActivity(store,data),old=store.runtime.claim(runtime.id,'original-owner')!;await activity.acquire(old,'original-owner');
 return {root,data,workspace,source,frozenSource,store,runtime,old,activity,research,proposal};
}

test('P8-REFRESH-I01 actual explicit dual-call applied intent and new local source generation remain integrity-only across restart', {timeout:90000},async t=>{
 const f=await prepared(t),before=f.store.runtime.inspect(f.runtime.id).run,oldReceipt=f.store.runtime.getOperation(f.old.id).result;
 const conversation=f.store.conversations.ensureForGoal(before.id),message=f.store.conversations.receive({conversationId:conversation.id,commandId:'refresh-user',source:'user',kind:'change',text:'Refresh original from the same local source now; retain every original question, check, input and cutoff.'});
 const raw={decision:'revise',response:'Refresh original evidence; adapted P4 publication remains unsupported.',proposal:f.proposal,retiredCriterionIds:[],retirementSources:[],criterionChanges:[],sourceRefresh:{materialIds:['original'],sources:[{messageId:message.id,quote:message.text}]}};
 const db=new DatabaseSync(join(f.data,'supervisor.sqlite'));try{
  await assert.rejects(actualFollowup({...f,beforeApply:()=>db.exec("CREATE TRIGGER refresh_application_fault BEFORE INSERT ON verification_contract_transitions BEGIN SELECT RAISE(ABORT,'actual refresh application rollback');END;")},before.id,message.id,before.contract,f.proposal,raw),/actual refresh application rollback/);
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id).run.contract,before.contract);assert.equal(f.store.conversations.message(message.id).state,'processing');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_contract_transitions').get()!.n,0);
  db.exec('DROP TRIGGER refresh_application_fault');
 }finally{db.close();}
 const finished=f.store.goals.get(before.id).jobs.at(-1)!;const applied=f.store.goals.applyFollowup(before.id,finished.id);const job=applied.session.jobs.at(-1)!,transitionId='transition:'+job.id,authorization=f.store.verificationLineage.sourceRefreshAuthorization(transitionId);
 assert.throws(()=>f.store.verificationLineage.assertRefreshPublicationSupported(before.projectId,before.id),/blocked until adapted P4/);assert.equal(f.store.verificationLineage.headForRun(before.projectId,before.id),null);

 const originalProofPath=Object.keys(job.proofs)[0]!,originalProofBytes=await readFile(originalProofPath);await writeFile(originalProofPath,'Forged original authorization receipt');assert.throws(()=>f.store.verificationLineage.sourceRefreshAuthorization(transitionId),/proof bytes changed/);await writeFile(originalProofPath,originalProofBytes);
 assert.deepEqual(authorization.intent,raw.sourceRefresh);assert.deepEqual(applied.run.contract.criteria,before.contract.criteria);assert.equal(applied.run.budget.limit,before.budget.limit);assert.equal(applied.run.budget.spent,before.budget.spent+2);assert.deepEqual(applied.session.research,f.research);
 await writeFile(f.source,'New source version B.\n');const fresh=f.store.runtime.claim(f.runtime.id,'refresh-owner')!;await f.activity.acquire(fresh,'refresh-owner');
 const args={transitionId,previousOperationId:f.old.id,currentOperationId:fresh.id},proof=readSourceRefreshGeneration(f.store,f.data,args);
 assert.equal(proof.state,'changed');assert.equal(proof.entries.find(e=>e.id==='frozen')!.state,'current');assert.equal(proof.entries.find(e=>e.id==='frozen')!.selected,false);assert.equal(proof.publication,'blocked-until-adapted-p4');assert.notEqual(proof.previousGeneration,proof.currentGeneration);assert.deepEqual(f.store.runtime.getOperation(f.old.id).result,oldReceipt);assert.equal(f.store.verification.list('delivery').length,0);
 f.store.runtime.control({type:'pause',runtimeId:f.runtime.id,commandId:'pause-observation'});assert.throws(()=>readSourceRefreshGeneration(f.store,f.data,args),/boundary closed/);f.store.runtime.control({type:'resume',runtimeId:f.runtime.id,commandId:'resume-observation'});assert.deepEqual(readSourceRefreshGeneration(f.store,f.data,args),proof);
 const reopened=new SupervisorStore(f.data);try{assert.deepEqual(readSourceRefreshGeneration(reopened,f.data,args),proof);assert.deepEqual(reopened.verificationLineage.sourceRefreshAuthorization(transitionId),authorization);}finally{reopened.close();}
 assert.throws(()=>readSourceRefreshGeneration(f.store,f.data,{...args,currentOperationId:f.old.id}),/contract boundary|Two actual|stale/);
 const run=f.store.runtime.inspect(f.runtime.id).run;assert.ok(run.attempts.every(a=>a.settled));assert.equal(run.budget.spent,before.budget.spent+2);assert.equal(f.store.verificationLineage.transition(transitionId).changes.length,0);
 const receiptFile=join(f.data,'materials-receipts',digest(fresh.id),'receipt.json'),receiptBytes=await readFile(receiptFile);await writeFile(receiptFile,'{}');assert.throws(()=>readSourceRefreshGeneration(f.store,f.data,args),/actual archived operation receipt/);await writeFile(receiptFile,receiptBytes);assert.deepEqual(readSourceRefreshGeneration(f.store,f.data,args),proof);
 // Fresh unselected acquisition timestamps are allowed; changed or missing actual bytes are not authorization.
 for(const variant of ['unchanged','changed','missing'] as const){
  const v=await prepared(t),oldRun=v.store.runtime.inspect(v.runtime.id).run,cv=v.store.conversations.ensureForGoal(oldRun.id),m=v.store.conversations.receive({conversationId:cv.id,commandId:'refresh-only-original',source:'user',kind:'change',text:'Refresh original only; preserve frozen input and every original check.'});
  const proposal={decision:'revise',response:'Explicit original-only refresh',proposal:v.proposal,retiredCriterionIds:[],retirementSources:[],criterionChanges:[],sourceRefresh:{materialIds:['original'],sources:[{messageId:m.id,quote:m.text}]}};
  const applied=await actualFollowup(v,oldRun.id,m.id,oldRun.contract,v.proposal,proposal),transition='transition:'+applied.session.jobs.at(-1)!.id,oldResult=v.store.runtime.getOperation(v.old.id).result;
  if(variant!=='unchanged')await writeFile(v.source,'Selected new source bytes.\n');if(variant==='changed')await writeFile(v.frozenSource,'Unauthorized unselected new bytes.\n');else if(variant==='missing')await rm(v.frozenSource);
  const op=v.store.runtime.claim(v.runtime.id,'scope-owner')!;await v.activity.acquire(op,'scope-owner');const acquisition=v.store.runtime.getOperation(op.id).result;
  const generationArgs={transitionId:transition,previousOperationId:v.old.id,currentOperationId:op.id};
  if(variant==='unchanged'){
   const current=readSourceRefreshGeneration(v.store,v.data,generationArgs);
   assert.equal(current.state,'current');assert.ok(current.entries.every(entry=>entry.state==='current'));
   assert.ok(current.entries.some(entry=>entry.selected&&entry.id==='original'));
   for(const entry of current.entries){assert.equal(entry.oldRawDigest,entry.newRawDigest);assert.equal(entry.oldTextDigest,entry.newTextDigest);}
   assert.notEqual(current.currentGeneration,current.previousGeneration);
   assert.notEqual(current.currentIndexDigest,current.previousIndexDigest);
   assert.notEqual(current.currentReceiptDigest,current.previousReceiptDigest);
   const previous=(oldResult as {receipt:{index:{directory:string;acquiredAt:string}}}).receipt;
   const latest=(acquisition as {receipt:{index:{directory:string;acquiredAt:string}}}).receipt;
   assert.notEqual(latest.index.directory,previous.index.directory);
   assert.ok(Date.parse(latest.index.acquiredAt)>=Date.parse(previous.index.acquiredAt));
   assert.deepEqual(applied.run.contract.criteria,oldRun.contract.criteria);
   assert.equal(applied.run.budget.limit,oldRun.budget.limit);
   assert.ok(v.store.runtime.inspect(v.runtime.id).run.attempts.every(attempt=>attempt.settled));
   assert.throws(()=>v.store.verificationLineage.assertRefreshPublicationSupported(oldRun.projectId,oldRun.id),/blocked until adapted P4/);
   const reopened=new SupervisorStore(v.data);
   try{assert.deepEqual(readSourceRefreshGeneration(reopened,v.data,generationArgs),current);}finally{reopened.close();}
  }else assert.throws(()=>readSourceRefreshGeneration(v.store,v.data,generationArgs),/Unselected refresh input basis changed or unknown: frozen/);
  assert.deepEqual(v.store.runtime.getOperation(op.id).result,acquisition);assert.deepEqual(v.store.runtime.getOperation(v.old.id).result,oldResult);assert.equal(v.store.verification.list('delivery').length,0);assert.equal(v.store.runtime.inspect(v.runtime.id).run.budget.spent,oldRun.budget.spent+2);
 }
 // Snapshot tampering must reject, not become another refresh generation.
 const receipt=(f.store.runtime.getOperation(fresh.id).result as any).receipt;await writeFile(join(receipt.index.directory,receipt.index.entries[0].raw.path),'Tampered snapshot');assert.throws(()=>readSourceRefreshGeneration(f.store,f.data,args),/Material bytes changed/);
});

test('P8-REFRESH-I02 refresh request cannot change source IDs original checks or bypass independent intent authorization',async t=>{
 const f=await prepared(t),session=f.store.goals.get(f.runtime.runId),original=f.store.runtime.inspect(f.runtime.id).run.contract;
 const conversation=f.store.conversations.ensureForGoal(session.id),m=f.store.conversations.receive({conversationId:conversation.id,commandId:'refresh-boundary',source:'user',kind:'change',text:'Refresh original without changing any requirement.'});
 const messages=f.store.conversations.messages(conversation.id),intent={materialIds:['original'],sources:[{messageId:m.id,quote:m.text}]};
 assert.deepEqual(assertSourceRefreshIntent(intent,f.research,messages,original,original),intent);
 assert.throws(()=>assertSourceRefreshConfiguration({...f.research,cutoff:'2000-01-01T00:00:00Z'},f.store.runtime.operations(f.runtime.id),original.version),/cutoff/);assert.throws(()=>assertSourceRefreshConfiguration({...f.research,inputs:[{id:'original',kind:'local',path:join(f.root,'another.md')}]},f.store.runtime.operations(f.runtime.id),original.version),/inputs/);
 for(const broken of [{...intent,materialIds:['external']},{...intent,materialIds:['original','original']},{...intent,sources:[{messageId:m.id,quote:'not said'}]}])assert.throws(()=>assertSourceRefreshIntent(broken,f.research,messages,original,original));
 assert.throws(()=>assertSourceRefreshIntent(intent,f.research,messages,original,{...original,criteria:[]}));
 assert.throws(()=>assertSourceRefreshIntent(intent,f.research,messages.map(message=>({...message,kind:'question' as const})),original,original));
 const context={originalContract:original,originalProposal:f.proposal,frozenMessages:messages,newMessageId:m.id,session};const result=parseFollowupEvolution({decision:'revise',response:'Proposed refresh',proposal:f.proposal,retiredCriterionIds:[],retirementSources:[],criterionChanges:[],sourceRefresh:intent},context,[]);const schema=followupEvolutionReviewSchema(result,context,[]) as any;
 const review={approved:true,changes:[],proposalDigest:schema.properties.proposalDigest.const,sourceDigest:schema.properties.sourceDigest.const,sourceRefresh:{intentDigest:sourceRefreshDigest(intent),authorized:false,reasons:['Rejected actual intent fixture']}};assert.throws(()=>validateEvolutionReview(review,result,context,[]),/independent authorization/);
 assert.throws(()=>f.store.verificationLineage.sourceRefreshAuthorization('missing'));
 assert.equal(f.store.verification.list('delivery').length,0);
});

test('P8-REFRESH-I03 actual same-loopback HTTP byte refresh retains both snapshots and explicit failed later observation',async t=>{
 const root=await realpath(await mkdtemp('/tmp/sv-refresh-http-'));let body='Actual HTTP version A',status=200,requests=0;const server=createServer((_request,response)=>{requests++;response.writeHead(status,{'content-type':'text/plain'});response.end(body);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(root,{recursive:true,force:true});});
 const intake=new MaterialIntake(root,{allowLoopbackHTTP:true}),inputs=[{id:'official',kind:'url' as const,url:'http://127.0.0.1:'+(server.address() as AddressInfo).port+'/same'}],limits={maxInputs:5,parallel:2,maxItemBytes:4096,maxTotalBytes:8192,timeoutMs:1000,maxDurationMs:3000,maxRedirects:0};
 const old=await intake.acquire({commandId:'original',inputs,limits});assert.equal(requests,1);
 const same=await intake.refresh(old.directory,inputs);assert.equal(requests,2);
 assert.equal(same.state,'current');assert.equal(same.entries[0]!.state,'current');
 const sameIndex=await intake.inspect(same.directory);
 assert.notEqual(sameIndex.generation,old.generation);assert.notEqual(sameIndex.indexDigest,old.indexDigest);
 assert.notEqual(sameIndex.directory,old.directory);assert.equal(sameIndex.entries[0]!.raw!.sha256,old.entries[0]!.raw!.sha256);
 assert.ok(Date.parse(sameIndex.entries[0]!.acquiredAt)>=Date.parse(old.entries[0]!.acquiredAt));
 assert.deepEqual(await intake.inspect(old.directory),old);
 body='Actual HTTP version B';const observed=await intake.refresh(old.directory,inputs);assert.equal(requests,3);assert.equal(observed.state,'changed');assert.equal(observed.entries[0]!.state,'changed');assert.deepEqual(await intake.inspect(old.directory),old);const current=await intake.inspect(observed.directory);assert.notEqual(current.generation,old.generation);assert.equal(await readFile(join(current.directory,current.entries[0]!.raw!.path),'utf8'),body);
 status=503;const failure=await intake.refresh(old.directory,inputs);assert.equal(requests,4);assert.equal(failure.state,'unknown');assert.equal((await intake.inspect(failure.directory)).entries[0]!.status,'failed');assert.deepEqual(await intake.inspect(old.directory),old);
});
