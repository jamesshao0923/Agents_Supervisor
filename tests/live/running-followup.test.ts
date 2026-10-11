import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,writeFile,readFile,cp,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {request} from '../../apps/cli/client.js';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {spawnManagedProcess,inspectProcess,terminateProcess,type ManagedProcess,type ProcessIdentity} from '../../packages/process-control/index.js';
import {readOwnership} from '../../packages/runtime/worker-ownership.js';
import {runtimeCanonical} from '../../packages/persistence/runtime.js';
import {authorWireInput,type PresentedAuthorInput} from '../../packages/orchestration/author-presentation.js';
import type {SupervisionJob} from '../../packages/contracts/p6-supervision.js';
import type {Run} from '../../packages/contracts/p1.js';
import type {Request} from '../../packages/contracts/p1.js';
import type {GoalInspection} from '../../packages/contracts/p5.js';
import type {ConversationInspection} from '../../packages/contracts/p6-actions.js';
import type {SupervisionInspection} from '../../packages/contracts/p6-supervision-actions.js';
const exec=promisify(execFile),sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');


// Evidence assertions read actual product files/events; they never fabricate a
// provider completion, usage, accepted proposal, or delivery.
async function modelProof(proofs:Record<string,string>,suffix:string,requireJSON=true){
 const paths=Object.keys(proofs).filter(path=>path.endsWith(suffix));assert.equal(paths.length,1);
 const resultPath=paths[0]!,directory=resultPath.slice(0,-'result.json'.length),outputPath=directory+'output.txt',eventsPath=directory+'events.jsonl';
 assert.ok(proofs[outputPath]&&proofs[eventsPath]);
 for(const path of [resultPath,outputPath,eventsPath])assert.equal(sha(await readFile(path)),proofs[path]);
 const result=JSON.parse(await readFile(resultPath,'utf8'));
 assert.ok(typeof result.threadId==='string'&&result.threadId.length>0);assert.ok(typeof result.turnId==='string'&&result.turnId.length>0);
 assert.equal(result.modelStarted,true);assert.equal(result.stopConfirmed,true);assert.ok(Number.isSafeInteger(result.usage)&&result.usage>0);
 const raw=await readFile(outputPath,'utf8'),events=(await readFile(eventsPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const completed=events.filter(event=>event.kind==='codex-event'&&event.value?.raw?.method==='turn/completed').map(event=>event.value.raw.params);
 assert.equal(completed.length,1);assert.equal(completed[0].threadId,result.threadId);assert.equal(completed[0].turn.id,result.turnId);assert.equal(completed[0].turn.status,'completed');
 assert.equal(completed[0].turn.items.filter((item:{type:string})=>item.type==='agentMessage').at(-1)?.text,raw);
 const messages=events.filter(event=>event.kind==='codex-event'&&event.value?.raw?.method==='item/completed').map(event=>event.value.raw.params).filter(params=>params.threadId===result.threadId&&params.turnId===result.turnId&&params.item?.type==='agentMessage');
 assert.equal(messages.at(-1)?.item.text,raw);
 return {result,raw,output:requireJSON?JSON.parse(raw):null};
}

// Historical failure is charged evidence, not a success requirement. The
// accepted current author still uses modelProof's strict completed predicate.
async function historicalJobEvidence(job:SupervisionJob,run:Run){
 assert.equal(job.status,'finished');assert.equal(job.stopConfirmed,true);
 assert.ok(job.usage!==null&&Number.isSafeInteger(job.usage)&&job.usage>=0);
 assert.equal(job.inputDigest,sha(Buffer.from(runtimeCanonical(job.input))));
 const attempt=run.attempts.find(a=>a.id===job.attemptId);
 assert.ok(attempt?.settled);assert.equal(attempt.purpose,'reasoning');assert.equal(attempt.nodeId,'@supervisor');
 assert.equal(attempt.contractVersion,job.contractVersion);assert.equal(attempt.actual,job.usage);assert.equal(attempt.reservation,job.config.reservation);
 const completion={usage:job.reportedUsage??job.usage,stopConfirmed:job.stopConfirmed,error:job.error,proofs:job.proofs,threadId:job.threadId,result:job.result};
 assert.equal(job.completionDigest,sha(Buffer.from(runtimeCanonical(completion))));
 assert.equal(job.intents.length,job.identities.length);
 for(const identity of job.identities){assert.ok(job.intents.some(intent=>intent.operationId===identity.operationId&&intent.ownerToken===identity.ownerToken));assert.equal((await inspectProcess(identity)).status,'stopped');}
 for(const [path,digest]of Object.entries(job.proofs))assert.equal(sha(await readFile(path)),digest);
 const results=Object.keys(job.proofs).filter(path=>path.endsWith('/result.json'));
 if(!results.length){
  // A host rejection before any intent has no fabricated provider transcript.
  assert.equal(job.modelStarted,false);assert.equal(job.usage,0);assert.equal(job.threadId,null);assert.equal(job.intents.length,0);assert.equal(job.identities.length,0);assert.ok(job.error);assert.equal(job.result,null);return;
 }
 assert.equal(results.length,1);
 const path=results[0]!,eventsPath=path.slice(0,-'result.json'.length)+'events.jsonl';assert.ok(job.proofs[eventsPath]);
 const result=JSON.parse(await readFile(path,'utf8')),events=(await readFile(eventsPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const input=authorWireInput(job.input as PresentedAuthorInput,job.purpose),recorded=events.filter(e=>e.kind==='reasoner-input');assert.equal(recorded.length,1);
 assert.equal(recorded[0].value.id,job.id);assert.equal(recorded[0].value.prompt,input.prompt);assert.deepEqual(recorded[0].value.outputSchema,input.outputSchema);assert.equal(recorded[0].value.model,job.config.model);assert.equal(recorded[0].value.effort,job.config.effort);
 assert.equal(result.modelStarted,job.modelStarted);assert.equal(result.stopConfirmed,true);assert.equal(result.threadId,job.threadId);
 for(const identity of job.identities)assert.ok(events.some(e=>e.kind==='process-identity'&&runtimeCanonical(e.value.identity)===runtimeCanonical(identity)));
 for(const intent of job.intents)assert.ok(events.some(e=>e.kind==='process-intent'&&runtimeCanonical(e.value.intent)===runtimeCanonical(intent)));
 if(!job.modelStarted){
  // Thread creation and a prepared turn-intent may precede a refused dispatch.
  // Neither is evidence that a model turn was sent; the durable target flag is
  // false, the actual result has no turn, and all original processes stopped.
  assert.equal(job.usage,0);assert.ok(result.usage===null||result.usage===0);assert.equal(result.turnId,null);assert.ok(job.error);assert.equal(job.result,null);
  assert.equal(events.filter(e=>e.kind==='reasoner-turn-started').length,0);
  assert.equal(events.filter(e=>e.kind==='codex-event'&&e.value?.turnId).length,0);return;
 }
 assert.ok(result.threadId&&result.turnId);assert.equal(result.usage,job.usage);assert.ok(job.identities.length);
 const terminal=events.filter(e=>e.kind==='codex-event'&&e.value?.raw?.method==='turn/completed'&&e.value.raw.params.threadId===result.threadId&&e.value.raw.params.turn.id===result.turnId);
 assert.equal(terminal.length,1);assert.ok(['completed','failed','interrupted'].includes(terminal[0].value.raw.params.turn.status));
 const observedUsage=events.filter(e=>e.kind==='codex-event'&&e.value?.tokenUsage);assert.ok(observedUsage.length);assert.equal(observedUsage.at(-1).value.tokenUsage.total.totalTokens,result.usage);
 if(job.error)assert.equal(job.result,null);else assert.deepEqual(result.value,job.result);
}

// Real product service processes and Unix-socket API only. No injected model,
// seeded proposal/approval, hand-authored verifier or persisted success fixture.
test('P6 running followup survives real service restart applies once and independently delivers original plus additive requirements',{timeout:3_360_000},async t=>{
 const root=await realpath(await mkdtemp('/tmp/sv-running-chat-')),data=join(root,'d'),workspace=join(root,'project');await mkdir(workspace);
 const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','p6-running-followup-'+randomUUID());await mkdir(evidence,{recursive:true});
 const end=Date.now()+3_240_000,services:ProcessIdentity[]=[];let service:ManagedProcess|undefined,runtimeId:string|undefined,sessionId:string|undefined,loopId:string|undefined;
 const logWrites:Promise<void>[]=[],logErrors:string[]=[];
 const save=(name:string,value:unknown)=>writeFile(join(evidence,name+'.json'),JSON.stringify(value,null,2));
 async function rpc<T>(method:string,action?:unknown):Promise<T>{const response=await request(data,{id:randomUUID(),method,...(action===undefined?{}:{action})} as Request);if(!response.ok)throw Error(response.error);return response.value as T;}
 async function until<T>(read:()=>T|Promise<T>,done:(v:T)=>boolean,label:string):Promise<T>{for(;;){const value=await read();if(done(value))return value;if(Date.now()>=end){await save('deadline-'+label,value);throw Error('Running-followup deadline: '+label);}await delay(150);}}
 async function startService(){
  const ordinal=services.length+1;
  service=await spawnManagedProcess({operationId:'live-service-'+randomUUID(),command:process.execPath,args:[resolve('dist/apps/cli/main.js'),'serve','--data',data],cwd:process.cwd(),timeoutMs:3_360_000,onBeforeSpawn:intent=>save('service-intent-'+ordinal,intent),onIdentity:identity=>save('service-identity-'+ordinal,identity)});
  services.push(service.identity);service.stdout.on('data',(b:Buffer)=>{logWrites.push(appendFile(join(evidence,'service-'+ordinal+'.stdout.log'),b).catch(error=>{logErrors.push(String(error));}));});service.stderr.on('data',(b:Buffer)=>{logWrites.push(appendFile(join(evidence,'service-'+ordinal+'.stderr.log'),b).catch(error=>{logErrors.push(String(error));}));});
  const readyBy=Date.now()+30_000;
  for(;;){try{await rpc('health');return;}catch(error){if(Date.now()>readyBy)throw error;await delay(100);}}
 }
 t.after(async()=>{
  const errors:string[]=[],safe=async<T>(name:string,fn:()=>Promise<T>):Promise<T|null>=>{try{return await fn();}catch(error){errors.push(name+': '+String(error));return null;}};
  if(service&&runtimeId)await safe('cancel unfinished runtime',async()=>{const state=await rpc<any>('runtime',{type:'inspect',runtimeId});if(state.run.status!=='succeeded')await rpc('runtime',{type:'cancel',commandId:randomUUID(),runtimeId});});
  if(service)await safe('service stop',async()=>{assert.equal((await service!.terminate()).stopped,true);service=undefined;});
  const owner=await safe('worker ownership',()=>readOwnership(data));if(owner?.identity)await safe('worker stop',async()=>assert.equal((await terminateProcess(owner.identity!)).stopped,true));
  await safe('archive state and physical identities',async()=>{
   const store=new SupervisorStore(data);try{
    const state={goal:sessionId?store.goals.inspect(sessionId):null,runtime:runtimeId?store.runtime.inspect(runtimeId):null,loop:loopId?store.supervision.get(loopId):null,loopJobs:loopId?store.supervision.jobs(loopId):[],executions:store.executionList(),verification:store.verification.list('job'),deliveries:store.verification.list('delivery')};
    const identities=new Map<string,ProcessIdentity>();function collect(v:unknown):void{if(!v||typeof v!=='object')return;const x=v as Record<string,unknown>;if(x.version===1&&x.ownerToken&&x.startIdentity&&x.pid)identities.set(String(x.operationId),x as unknown as ProcessIdentity);for(const child of Object.values(x))collect(child);}collect(state);collect(services);collect(owner);
    // Unknown usage remains an unsettled reservation; cleanup never makes it free.
    if(state.runtime)for(const execution of state.executions.filter(e=>e.runId===state.runtime!.run.id&&e.usageStatus==='unknown')){
     const attempt=state.runtime.run.attempts.find(a=>a.id===execution.attemptId);assert.ok(attempt&&!attempt.settled&&attempt.actual===null&&attempt.reservation===execution.reservation);
    }
    const physical=[];for(const identity of identities.values()){const observed=await inspectProcess(identity);if(observed.status!=='stopped')await terminateProcess(identity);const actual=await inspectProcess(identity);physical.push({identity,observed,actual});assert.equal(actual.status,'stopped');}
    await save('final',{state,physical});
   }finally{store.close();}
  });
  await Promise.all(logWrites);errors.push(...logErrors);
  await safe('archive files',()=>cp(root,join(evidence,'runtime'),{recursive:true}));await save('cleanup-errors',errors);t.diagnostic(JSON.stringify({root,evidence}));assert.deepEqual(errors,[]);
 });
 await exec('git',['init','--quiet'],{cwd:workspace});await exec('git',['-c','user.name=Supervisor Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Running followup baseline'],{cwd:workspace});await startService();
 const model=process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol',effort=process.env.SUPERVISOR_LIVE_EFFORT??'low';
 const capabilities=await rpc<any>('execution',{type:'capabilities'});assert.ok(capabilities.models.some((m:any)=>m.id===model&&m.reasoningEfforts.includes(effort)));await save('capabilities',capabilities);
 const config={model,effort,reservation:150_000,timeoutMs:240_000};
 const goal='Build an offline Node ESM math module in math.mjs and a real Node assert/strict test in math.test.mjs. Export sum(a,b): finite number inputs add; a non-number or nonfinite value at either argument throws TypeError. Actual tests cover 2+3=5, -1+1=0 and NaN, Infinity, -Infinity, strings at both positions. Exactly one implementation step and one command acceptance criterion id=sum target=math.test.mjs, preserving every requirement in its checks. Future additive exports in these files are allowed. No dependencies, network or publication. Execute the real test. Independent final acceptance is still mandatory. No clarification is needed.';
 const started=await rpc<GoalInspection>('orchestration',{type:'start',commandId:randomUUID(),workspace,goal,tokenLimit:1_600_000,verificationReserve:300_000,maxContextChars:200_000,...config});sessionId=started.session.id;
 const ready=await until(()=>rpc<GoalInspection>('orchestration',{type:'inspect',sessionId}),v=>v.session.phase!=='thinking','planning');assert.equal(ready.session.phase,'ready',ready.session.error??'');assert.deepEqual(ready.session.proposal!.criteria.map(c=>c.id),['sum']);assert.equal(ready.session.proposal!.steps.length,1);await save('ready',ready);
 const admitted=await rpc<GoalInspection>('orchestration',{type:'admit',commandId:randomUUID(),sessionId,expectedRevision:ready.session.revision});runtimeId=admitted.session.runtimeId!;
 const conversation=await rpc<ConversationInspection>('conversation',{type:'forSession',sessionId}),conversationId=conversation.conversation.id;
 const active=await until(async()=>{const list=await rpc<any[]>('execution',{type:'list'}),execution=list.find(e=>e.runtimeBinding?.runtimeId===runtimeId);if(execution&&['completed','failed','cancelled','unknown'].includes(execution.state))throw Error('Original execution ended before the required running-message boundary: '+execution.state);return list;},list=>list.some(e=>e.runtimeBinding?.runtimeId===runtimeId&&e.turnId&&!e.stopConfirmed),'actual execution started');
 const initial=active.find(e=>e.runtimeBinding?.runtimeId===runtimeId&&e.turnId&&!e.stopConfirmed)!;assert.equal((await inspectProcess(initial.identity)).status,'verified');await save('actual-running-execution',initial);
 const commandId=randomUUID(),text='While this task is running, add multiply(a,b) to the same math.mjs and math.test.mjs. Finite numbers multiply; every non-number or nonfinite input at either position throws TypeError. Add tests for 3*4=12, -2*3=-6 and both invalid positions. Retain the original sum criterion id/description/kind/target/checks byte-for-byte and all sum behavior; add exactly one command criterion id=multiply target=math.test.mjs. Keep a single implementation step, no dependencies/network, and independent final acceptance. This change is explicitly authorized; do not ask again.';
 const waiting=await rpc<ConversationInspection>('conversation',{type:'send',conversationId,commandId,kind:'change',text});const message=waiting.messages.find(m=>m.commandId===commandId)!;assert.equal(message.state,'waiting');assert.equal((await inspectProcess(initial.identity)).status,'verified');assert.equal(waiting.active.session.jobs.filter(j=>j.purpose==='followup').length,0);await save('waiting-before-service-restart',waiting);
 const workerBefore=await readOwnership(data);assert.ok(workerBefore?.identity);const oldService=service!;assert.equal((await oldService.terminate()).stopped,true);service=undefined;assert.equal((await inspectProcess(oldService.identity)).status,'stopped');await startService();
 assert.notEqual(service!.identity.pid,oldService.identity.pid);const workerAfter=await readOwnership(data);assert.deepEqual(workerAfter?.identity,workerBefore.identity,'Restart must retain the actual durable worker, not replay its model operation');
 const inspect=()=>rpc<ConversationInspection>('conversation',{type:'inspect',conversationId});const reopened=await inspect();assert.equal(reopened.messages.filter(m=>m.commandId===commandId).length,1);assert.equal(reopened.messages.find(m=>m.commandId===commandId)!.id,message.id);await save('after-real-service-restart',reopened);
 await rpc('conversation',{type:'send',conversationId,commandId,kind:'change',text});
 const revised=await until(inspect,v=>['applied','failed','clarifying'].includes(v.messages.find(m=>m.commandId===commandId)!.state),'apply once');assert.equal(revised.messages.find(m=>m.commandId===commandId)!.state,'applied');assert.equal(revised.messages.filter(m=>m.commandId===commandId).length,1);assert.equal(revised.messages.find(m=>m.commandId===commandId)!.processingHistory.length,1);assert.equal(revised.messages.find(m=>m.commandId===commandId)!.history.filter(h=>h.state==='applied').length,1);assert.equal(revised.active.run.id,admitted.run.id);assert.equal(revised.active.run.contract.version,admitted.run.contract.version+1);
 for(const criterion of admitted.session.proposal!.criteria)assert.deepEqual(revised.active.session.proposal!.criteria.find(c=>c.id===criterion.id),criterion);assert.deepEqual(revised.active.session.proposal!.criteria.map(c=>c.id).sort(),['multiply','sum']);assert.equal(revised.active.session.proposal!.steps.length,1);assert.equal(revised.active.session.jobs.filter(j=>j.purpose==='followup').length,1);await save('revised',revised);
 const revisionJob=revised.active.session.jobs.find(j=>j.purpose==='followup')!,context=revisionJob.context as {acceptanceReview:{approved:boolean;changes:{authorized:boolean}[]};callReceipts:{threadId:string;usage:number;stopConfirmed:boolean;output:unknown;proofs:Record<string,string>}[]};
 assert.ok(context.acceptanceReview.approved&&context.acceptanceReview.changes.every(c=>c.authorized));assert.equal(context.callReceipts.length,2);assert.notEqual(context.callReceipts[0]!.threadId,context.callReceipts[1]!.threadId);assert.equal(context.callReceipts.reduce((sum,c)=>sum+c.usage,0),revisionJob.usage);
 for(const receipt of context.callReceipts){const actual=await modelProof(receipt.proofs,'/result.json');assert.equal(actual.result.threadId,receipt.threadId);assert.equal(actual.result.usage,receipt.usage);assert.deepEqual(actual.result.value,receipt.output);assert.deepEqual(actual.output,receipt.output);assert.ok(receipt.stopConfirmed&&receipt.usage>0&&Object.keys(receipt.proofs).length>0);for(const [path,digest]of Object.entries(receipt.proofs))assert.equal(sha(await readFile(path)),digest);}for(const job of revised.active.session.jobs){assert.ok(job.status==='finished'&&job.stopConfirmed&&job.usage!==null&&job.usage>0);for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');if(job.purpose!=='followup'){const actual=await modelProof(job.proofs,'/result.json');assert.equal(actual.result.threadId,job.threadId);assert.equal(actual.result.usage,job.usage);assert.deepEqual(actual.output,job.proposal);}}

 const executed=await until(()=>rpc<any>('runtime',{type:'inspect',runtimeId}),v=>['awaiting-verification','blocked','cancelled'].includes(v.runtime.phase),'revised execution');assert.equal(executed.runtime.phase,'awaiting-verification',executed.runtime.error??'');
 await exec(process.execPath,['math.test.mjs'],{cwd:workspace,timeout:10_000});await exec(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {sum,multiply} from './math.mjs';assert.equal(sum(7,9),16);assert.equal(sum(-1,1),0);assert.equal(multiply(6,7),42);assert.equal(multiply(-2,3),-6);for(const f of [sum,multiply])for(const x of [NaN,Infinity,-Infinity,'2',null,undefined]){assert.throws(()=>f(x,1),TypeError);assert.throws(()=>f(1,x),TypeError);}`],{cwd:workspace,timeout:10_000});
 const beforeDeliveryContract=JSON.stringify(executed.run.contract);const attached=await rpc<SupervisionInspection>('supervision',{type:'attach',commandId:randomUUID(),runtimeId,config:{...config,reservation:180_000},limits:{maxRepairs:0,maxReasoningCalls:4,maxDurationMs:1_320_000,maxContextChars:200_000}});loopId=attached.loop.id;
 const delivered=await until(()=>rpc<SupervisionInspection>('supervision',{type:'inspect',loopId}),v=>['complete','blocked'].includes(v.loop.phase)||v.loop.stopped,'independent delivery');assert.equal(delivered.loop.phase,'complete',delivered.loop.reason??'');assert.equal(JSON.stringify(delivered.runtime.run.contract),beforeDeliveryContract);assert.equal(delivered.runtime.run.status,'succeeded');assert.deepEqual(delivered.loop.config,{...config,reservation:180_000});assert.equal(delivered.verification.deliveries.length,1);
 const delivery=delivered.verification.deliveries[0]!;
 const final=delivered.verification.jobs.find(j=>j.id===delivery.jobId)!;assert.equal(final.kind,'verification');
 const plan=delivered.verification.plans.find(p=>p.id===delivery.planId)!;assert.equal(final.planId,plan.id);assert.equal(plan.selection.mode,'final');assert.equal(plan.selection.completeScope,true);assert.equal(plan.runId,delivered.runtime.run.id);assert.equal(delivery.runtimeId,runtimeId);assert.equal(delivery.candidateDigest,plan.candidate.digest);assert.equal(delivery.definitionDigest,plan.definitionDigest);
 assert.ok(final.evaluation?.obligations.length&&final.evaluation.obligations.every(o=>o.satisfied));
 const authors=delivered.jobs.filter(j=>j.purpose==='acceptance-authoring');assert.ok(authors.length>0);
 for(const job of delivered.jobs){
  assert.ok(capabilities.models.some((m:any)=>m.id===job.config.model&&m.reasoningEfforts.includes(job.config.effort)));assert.equal(job.config.timeoutMs,240_000);assert.ok(job.config.reservation<=180_000);
  await historicalJobEvidence(job,delivered.runtime.run);
 }
 const acceptedAuthor=authors.find(job=>job.id===delivered.loop.references.authorJobId)!;
 assert.ok(acceptedAuthor);assert.equal(acceptedAuthor.error,null);assert.ok(acceptedAuthor.result);
 const authored=await modelProof(acceptedAuthor.proofs,'/result.json');assert.equal(authored.result.threadId,acceptedAuthor.threadId);assert.equal(authored.result.usage,acceptedAuthor.usage);assert.deepEqual(authored.result.value,acceptedAuthor.result);assert.deepEqual(authored.output,acceptedAuthor.result);

 assert.ok(final.approved&&final.evaluation?.complete);const proposal=delivered.verification.proposals.find(p=>p.id===final.proposalId)!;const approved=delivered.verification.jobs.find(j=>j.id===proposal.reviewId)!;assert.equal(approved.kind,'review');assert.equal(approved.approved,true);assert.ok(approved.modelStarted&&approved.usage>0&&approved.controls.length>=2&&approved.controls.every(c=>c.passed));
 const reviewed=await modelProof(approved.proofs,'/definition-review/result.json');assert.equal(reviewed.result.usage,approved.usage);assert.deepEqual(reviewed.output,{verdict:reviewed.result.verdict,reason:reviewed.result.reason,observations:reviewed.result.observations});assert.ok(authors.every(a=>a.threadId!==reviewed.result.threadId),'Actual author and reviewer threads must differ');
 const allExecutions=await rpc<any[]>('execution',{type:'list'});assert.equal(allExecutions.filter(e=>e.id===initial.id).length,1);assert.equal(allExecutions.filter(e=>e.runtimeBinding?.runtimeId===runtimeId).length,2,'Original and revised executions only, no service-restart duplicate');for(const execution of allExecutions){assert.ok(execution.stopConfirmed&&execution.usage&&execution.usage.totalTokens>0);assert.equal(execution.usageStatus,'reported');assert.ok(execution.threadId&&execution.turnId);assert.equal((await inspectProcess(execution.identity)).status,'stopped');
  const events:any[]=[];let after=0;while(after<execution.lastEventSeq){const page=await rpc<any[]>('execution',{type:'events',executionId:execution.id,after});assert.ok(page.length);for(const event of page){assert.ok(event.seq>after&&event.seq<=execution.lastEventSeq);after=event.seq;events.push(event);}}
  const terminal=events.filter(e=>e.kind==='codex-event'&&e.payload?.raw?.method==='turn/completed'&&e.payload.raw.params.threadId===execution.threadId&&e.payload.raw.params.turn.id===execution.turnId);assert.equal(terminal.length,1);assert.equal(terminal[0].payload.raw.params.turn.status,execution.terminalStatus);
  const usages=events.filter(e=>e.kind==='codex-event'&&e.payload?.tokenUsage);assert.ok(usages.length);assert.equal(usages.at(-1).payload.tokenUsage.total.totalTokens,execution.usage.totalTokens);
  if(execution.state==='completed'){assert.equal(execution.error,null);assert.equal(terminal[0].payload.raw.params.turn.status,'completed');assert.equal(terminal[0].payload.raw.params.turn.items.filter((i:{type:string})=>i.type==='agentMessage').at(-1)?.text,execution.message);}
  await save('actual-execution-events-'+execution.id,{execution,events});
 }
 for(const job of delivered.verification.jobs){assert.ok(job.stopConfirmed&&!job.usageUnknown);for(const [path,digest]of Object.entries(job.proofs))assert.equal(sha(await readFile(path)),digest);for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');}
 const finalConversation=await inspect();assert.equal(finalConversation.messages.filter(m=>m.commandId===commandId).length,1);assert.equal(finalConversation.active.session.jobs.filter(j=>j.purpose==='followup').length,1);assert.equal(finalConversation.active.run.contract.version,revised.active.run.contract.version);assert.equal(finalConversation.budget.limit,1_600_000);assert.equal(finalConversation.budget.reserved,0);
 for(const criterion of admitted.session.proposal!.criteria)assert.deepEqual(finalConversation.active.session.proposal!.criteria.find(c=>c.id===criterion.id),criterion);
 const ledger=delivered.runtime.run;assert.equal(ledger.budget.limit,1_600_000);assert.equal(ledger.budget.verificationReserve,300_000);assert.ok(ledger.attempts.every(a=>a.settled&&a.actual!==null));assert.equal(ledger.budget.spent,ledger.attempts.reduce((sum,a)=>sum+a.actual!,0));assert.ok(ledger.budget.spent<=ledger.budget.limit);assert.ok(ledger.operations.every(o=>o.status==='confirmed')&&ledger.leases.every(l=>l.released));
 const billing=[...finalConversation.active.session.jobs.map(j=>({attemptId:j.attemptId,usage:j.usage,reservation:j.config.reservation})),...delivered.jobs.map(j=>({attemptId:j.attemptId,usage:j.usage,reservation:j.config.reservation})),...delivered.verification.jobs.map(j=>({attemptId:j.attemptId,usage:j.usage,reservation:j.config.reservation})),...allExecutions.filter(e=>e.runId===ledger.id).map(e=>({attemptId:e.attemptId,usage:e.usage.totalTokens,reservation:e.reservation}))];
 assert.equal(new Set(billing.map(b=>b.attemptId)).size,billing.length);
 for(const charged of billing){const attempt=ledger.attempts.find(a=>a.id===charged.attemptId);assert.ok(attempt?.settled);assert.equal(attempt.actual,charged.usage);assert.equal(attempt.reservation,charged.reservation);}
 assert.equal(ledger.budget.spent,billing.reduce((sum,b)=>sum+b.usage!,0));assert.equal(finalConversation.budget.spent,ledger.budget.spent);
 await save('accepted',{delivered,allExecutions,conversation:await inspect(),services});
});
