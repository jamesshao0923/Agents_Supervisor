import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {startService} from '../../apps/supervisor/server.js';
import {request} from '../../apps/cli/client.js';
import {readOwnership} from '../../packages/runtime/worker-ownership.js';
import {inspectProcess,terminateProcess,type ProcessIdentity} from '../../packages/process-control/index.js';
import type {Request,Run} from '../../packages/contracts/p1.js';
import type {ExecutionEvent,ExecutionRecord} from '../../packages/contracts/p2.js';
import type {RuntimeOperation,RuntimeRecord} from '../../packages/contracts/p3.js';
import type {GoalInspection,ReasoningJob} from '../../packages/contracts/p5.js';
import type {ConversationInspection} from '../../packages/contracts/p6-actions.js';

const execute=promisify(execFile);
type Event={kind:string;value?:any;payload?:any};
type RuntimeInspection={runtime:RuntimeRecord;operations:RuntimeOperation[];run:Run};
async function until<T>(read:()=>Promise<T>,done:(value:T)=>boolean,ms:number):Promise<T>{
  const deadline=Date.now()+ms;
  for(;;){const value=await read();if(done(value))return value;if(Date.now()>deadline)throw Error('Native public research live observation deadline exceeded');await delay(250);}
}
function notification(event:Event):any{
  const value=event.value??event.payload;
  if(value?.raw?.method)return value.raw;
  if(value?.method)return value;
  if(typeof value?.line==='string'){try{return JSON.parse(value.line);}catch{return null;}}
  return null;
}
function nativeWeb(events:Event[]):any[]{
  return events.map(notification).filter(value=>value?.method==='item/completed'&&value.params?.item?.type==='webSearch').map(value=>value.params.item);
}
async function jobEvents(job:ReasoningJob,review=false):Promise<Event[]>{
  const path=Object.keys(job.proofs).find(path=>path.endsWith('/events.jsonl')&&path.includes('-review/')===review);
  assert.ok(path,'Real planner event proof is required');
  const bytes=await readFile(path,'utf8');assert.equal(createHash('sha256').update(bytes).digest('hex'),job.proofs[path]);
  return bytes.trim().split('\n').map(line=>JSON.parse(line));
}
function officialUrl(value:unknown):boolean{if(typeof value!=='string')return false;try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='nodejs.org'&&url.pathname.endsWith('/fs.html');}catch{return false;}}
function assertLivePolicy(events:Event[],prefix:'reasoner'|'execution'):void{
  const policy=events.find(event=>event.kind===prefix+'-tool-policy');assert.ok(policy);const tools=policy.value??policy.payload;
  assert.equal(tools.webSearch,'live');assert.equal(tools.indexedMaterialReader,false);
  if(prefix==='execution')assert.equal(tools.frozenMaterialResearch,false);
  for(const key of ['apps','plugins','mcp','subagents','approvals'])assert.equal(tools[key],false);
  const thread=events.find(event=>event.kind===prefix+'-thread-policy');assert.ok(thread);const options=thread.value??thread.payload;
  assert.equal(options.config.web_search,'live');assert.equal(options.approvalPolicy,'never');assert.equal(options.sandbox,prefix==='reasoner'?'read-only':'workspace-write');
  const process=events.find(event=>event.kind==='process-intent'&&(event.value?.kind==='reasoner'||prefix==='execution'));
  assert.ok(process);const intent=prefix==='reasoner'?process.value.intent:process.payload;assert.ok(intent.args.includes('web_search="live"'));
  if(prefix==='reasoner'){
    assert.equal(tools.commands,false);assert.equal(tools.localFiles,false);
    const forbidden=['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentSpawn'];
    assert.ok(!events.map(notification).some(value=>['item/started','item/completed'].includes(value?.method)&&forbidden.includes(value.params?.item?.type)),'Public research planner must remain isolated from write, command, MCP and agent tools');
  }
}

test('live IPC public research clarifies then uses native search without host material configuration and executes a small sourced report',{timeout:620_000},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-native-web-'))),data=join(root,'data'),workspace=join(root,'project');await mkdir(workspace);
  await execute('git',['init','--quiet'],{cwd:workspace,timeout:5000});
  await execute('git',['-c','user.name=Supervisor Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Native research live baseline'],{cwd:workspace,timeout:5000});
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','native-web-research-'+randomUUID());await mkdir(evidence,{recursive:true});
  const model=process.env.SUPERVISOR_LIVE_MODEL??'gpt-6-astra',owned:ProcessIdentity[]=[];
  let service=await startService(data);
  const call=async<T>(payload:Omit<Request,'id'>):Promise<T>=>{const response=await request(data,{...payload,id:randomUUID()} as Request);assert.ok(response.ok,response.ok?'':response.error);return response.value as T;};
  t.after(async()=>{
    // Collect only this fixture's IPC-owned execution identities, including an
    // execution still running when an assertion/observation deadline fails.
    try{for(const execution of await call<ExecutionRecord[]>({method:'execution',action:{type:'list'}} as Omit<Request,'id'>))if(execution.identity)owned.push(execution.identity as ProcessIdentity);}catch{}
    await service.close();
    const worker=await readOwnership(data);if(worker?.identity)owned.push(worker.identity);
    for(const identity of owned)if((await inspectProcess(identity)).status==='verified')await terminateProcess(identity);
    const stopped=await Promise.all(owned.map(async identity=>({identity,inspection:await inspectProcess(identity)})));
    await writeFile(join(evidence,'cleanup.json'),JSON.stringify(stopped,null,2));assert.ok(stopped.every(item=>item.inspection.status==='stopped'));
    await cp(root,join(evidence,'runtime'),{recursive:true});t.diagnostic(JSON.stringify({root,evidence}));
  });
  await writeFile(join(evidence,'environment.json'),JSON.stringify({root,data,workspace,model,effort:'low',hostResearchConfiguration:null},null,2));
  const initial=await call<GoalInspection>({method:'orchestration',action:{type:'start',commandId:randomUUID(),workspace,goal:'I need a small report using public web research. The topic and deliverable are still undecided. Ask me what to research and what local report to produce before planning execution. Do not guess the topic or start execution.',model,effort:'low',reservation:100_000,timeoutMs:120_000,tokenLimit:null,verificationReserve:30_000,maxContextChars:200_000}} as Omit<Request,'id'>);
  const clarified=await until(()=>call<GoalInspection>({method:'orchestration',action:{type:'inspect',sessionId:initial.session.id}} as Omit<Request,'id'>),value=>value.session.phase!=='thinking',150_000);
  await writeFile(join(evidence,'clarified.json'),JSON.stringify(clarified,null,2));owned.push(...clarified.session.jobs.flatMap(job=>job.identities));
  assert.equal(clarified.session.phase,'clarifying',clarified.session.error??JSON.stringify(clarified.session.proposal));
  assert.ok(clarified.session.proposal!.questions.length>0);assert.equal(clarified.session.runtimeId,null);assert.equal(clarified.session.research,undefined);
  const initialEvents=await jobEvents(clarified.session.jobs[0]!);assertLivePolicy(initialEvents,'reasoner');
  await writeFile(join(evidence,'initial-events.json'),JSON.stringify(initialEvents,null,2));
  const conversation=await call<ConversationInspection>({method:'conversation',action:{type:'forSession',sessionId:initial.session.id}} as Omit<Request,'id'>);
  const text='The report topic is Node.js fs.readFile text decoding, for a developer learning its API. Use native public web search NOW while planning: search the official nodejs.org filesystem documentation, then open the discovered HTTPS fs.html page with native web search/open so its actual URL and contents are observed. Do not rely only on remembered URLs. Use this source to plan a tiny local report. The implementation must also use native web search and open official documentation, then create exactly report.json and report.test.mjs. report.json must be a JSON object with api="fs.readFile", encoding="utf8", resultType="string", one sourceUrl holding the actual official HTTPS fs.html URL, and a nonempty factual summary. report.test.mjs must use node:assert/strict and node:fs to read report.json and assert each exact field, official HTTPS nodejs.org fs.html source URL, and nonempty summary. Use exactly one implementation step for both files. Acceptance must include source evidence for the actual official HTTPS URL and a command criterion targeting report.test.mjs. No UI, dependencies, deployment, or external write actions. This supplies the requested topic and local deliverable; proceed with the plan and implementation. Final delivery still requires Supervisor independent verification.';
  const action={type:'send' as const,conversationId:conversation.conversation.id,commandId:randomUUID(),kind:'change' as const,text};
  await call({method:'conversation',action} as Omit<Request,'id'>);
  const inspect=()=>call<ConversationInspection>({method:'conversation',action:{type:'inspect',conversationId:conversation.conversation.id}} as Omit<Request,'id'>);
  const applied=await until(inspect,value=>['applied','failed','clarifying'].includes(value.messages.at(-1)?.state??''),300_000);
  await writeFile(join(evidence,'applied.json'),JSON.stringify(applied,null,2));owned.push(...applied.active.session.jobs.flatMap(job=>job.identities));
  assert.equal(applied.messages.at(-1)!.state,'applied',JSON.stringify(applied.messages.at(-1)));
  assert.equal(applied.conversation.id,conversation.conversation.id);assert.equal(applied.active.session.id,initial.session.id);assert.equal(applied.messages.length,1);
  assert.equal(applied.active.session.research,undefined);assert.equal(applied.active.session.proposal!.decision,'ready');assert.deepEqual(applied.active.session.proposal!.questions,[]);
  const proposal=applied.active.session.proposal!;
  assert.ok(proposal.criteria.every(criterion=>criterion.kind!=='material'),'Ordinary public search must not manufacture host material criteria');
  const sources=proposal.criteria.filter(criterion=>criterion.kind==='source');assert.ok(sources.length>0);assert.ok(sources.every(criterion=>officialUrl(criterion.target)));
  assert.ok(proposal.criteria.some(criterion=>criterion.kind==='command'&&criterion.target==='report.test.mjs'));assert.equal(proposal.steps.length,1);
  const followup=applied.active.session.jobs.findLast(job=>job.purpose==='followup')!;
  assert.equal(followup.followupResult!.decision,'revise');assert.equal(followup.followupResult!.proposal!.decision,'ready');
  const plannerEvents=await jobEvents(followup),plannerSearch=nativeWeb(plannerEvents);
  await writeFile(join(evidence,'planner-events.json'),JSON.stringify(plannerEvents,null,2));
  assert.ok(plannerSearch.some(item=>item.action?.type==='search'),'Actual planner native search completion is required');
  assert.ok(plannerSearch.some(item=>item.action?.type==='openPage'&&officialUrl(item.action.url)),'Actual planner native opening of official source is required');
  assert.ok(plannerEvents.some(event=>event.kind==='reasoner-input'&&event.value.webSearch==='live'));
  assertLivePolicy(plannerEvents,'reasoner');
  for(const source of sources)assert.ok(plannerSearch.some(item=>item.action?.url&&new URL(item.action.url).pathname===new URL(source.target).pathname),'Acceptance URL must match a source the planner actually opened');
  const receipts=(followup.context as {acceptanceReview:{approved:boolean};callReceipts:{threadId:string;usage:number;stopConfirmed:boolean}[]});
  assert.ok(receipts.acceptanceReview.approved);assert.equal(receipts.callReceipts.length,2);assert.notEqual(receipts.callReceipts[0]!.threadId,receipts.callReceipts[1]!.threadId);
  assert.ok(receipts.callReceipts.every(receipt=>receipt.threadId&&receipt.stopConfirmed&&receipt.usage>0));
  const reviewEvents=await jobEvents(followup,true);await writeFile(join(evidence,'review-events.json'),JSON.stringify(reviewEvents,null,2));
  for(const kind of ['reasoner-input','reasoner-tool-policy'])assert.equal(reviewEvents.find(event=>event.kind===kind)?.value.webSearch,'disabled');
  assert.equal(reviewEvents.find(event=>event.kind==='reasoner-thread-policy')?.value.config.web_search,'disabled');
  assert.ok(reviewEvents.find(event=>event.kind==='process-intent'&&event.value?.kind==='reasoner')?.value.intent.args.includes('web_search="disabled"'));
  assert.equal(nativeWeb(reviewEvents).length,0,'Independent authorization review must retain isolated, frozen-input reasoning');
  const reviewPrompt=reviewEvents.find(event=>event.kind==='reasoner-input')?.value.prompt as string;
  assert.ok(reviewPrompt.includes('discoveryEvidence'));
  for(const source of sources)assert.ok(reviewPrompt.includes(source.target),'Reviewer must receive actually observed source URLs');
  assert.ok(reviewPrompt.includes('Observed native web call metadata'));
  for(const job of applied.active.session.jobs){assert.equal(job.stopConfirmed,true);assert.ok(job.usage!==null&&job.usage>0);for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');}
  assert.ok(applied.active.session.runtimeId);
  const runtime=await until(()=>call<RuntimeInspection>({method:'runtime',action:{type:'inspect',runtimeId:applied.active.session.runtimeId!}} as Omit<Request,'id'>),value=>['awaiting-verification','blocked','cancelled'].includes(value.runtime.phase),150_000);
  await writeFile(join(evidence,'runtime.json'),JSON.stringify(runtime,null,2));
  assert.equal(runtime.runtime.phase,'awaiting-verification',runtime.runtime.error??JSON.stringify(runtime.operations));
  assert.equal(runtime.operations.length,1);assert.equal(runtime.operations[0]!.step.kind,'codex');assert.ok(runtime.operations[0]!.executionId);
  const execution=await call<ExecutionRecord>({method:'execution',action:{type:'inspect',executionId:runtime.operations[0]!.executionId!}} as Omit<Request,'id'>);
  if(execution.identity)owned.push(execution.identity as ProcessIdentity);
  assert.equal(execution.state,'completed',execution.error??execution.message);assert.equal(execution.stopConfirmed,true);assert.equal(execution.usageStatus,'reported');assert.ok(execution.usage&&execution.usage.totalTokens>0);assert.ok(execution.threadId&&execution.turnId);assert.equal((await inspectProcess(execution.identity as ProcessIdentity)).status,'stopped');
  const executionEvents:ExecutionEvent[]=[];let after=0;
  for(;;){const page=await call<ExecutionEvent[]>({method:'execution',action:{type:'events',executionId:execution.id,after}} as Omit<Request,'id'>);executionEvents.push(...page);if(page.length<500)break;after=page.at(-1)!.seq;}
  await writeFile(join(evidence,'execution.json'),JSON.stringify(execution,null,2));await writeFile(join(evidence,'execution-events.json'),JSON.stringify(executionEvents,null,2));
  const executorSearch=nativeWeb(executionEvents);assert.ok(executorSearch.some(item=>item.action?.type==='search'),'Actual ordinary executor native search completion is required');
  assertLivePolicy(executionEvents,'execution');
  assert.ok(executorSearch.some(item=>item.action?.type==='openPage'&&officialUrl(item.action.url)));
  const report=JSON.parse(await readFile(join(workspace,'report.json'),'utf8'));
  assert.equal(report.api,'fs.readFile');assert.equal(report.encoding,'utf8');assert.equal(report.resultType,'string');assert.ok(officialUrl(report.sourceUrl));assert.ok(typeof report.summary==='string'&&report.summary.trim());
  assert.ok(executorSearch.some(item=>item.action?.url&&new URL(item.action.url).pathname===new URL(report.sourceUrl).pathname));
  await execute(process.execPath,['report.test.mjs'],{cwd:workspace,timeout:10_000});
  const before=await inspect();assert.notEqual(before.active.run.status,'succeeded');assert.equal(before.budget.reserved,0);assert.equal(before.budget.spent,before.active.run.attempts.reduce((sum,attempt)=>sum+(attempt.actual??0),0));
  await service.close();service=await startService(data);
  const reopened=await call<ConversationInspection>({method:'conversation',action} as Omit<Request,'id'>);
  assert.equal(reopened.conversation.id,before.conversation.id);assert.deepEqual(reopened.messages,before.messages);assert.equal(reopened.budget.spent,before.budget.spent);assert.equal(reopened.active.session.jobs.length,before.active.session.jobs.length);
  await writeFile(join(evidence,'reopened.json'),JSON.stringify(reopened,null,2));
  await writeFile(join(evidence,'summary.json'),JSON.stringify({model,effort:'low',conversationId:conversation.conversation.id,sessionId:initial.session.id,hostResearchConfiguration:null,plannerNativeSearch:plannerSearch,executorNativeSearch:executorSearch,sourceTargets:sources.map(source=>source.target),report,knownTokens:before.budget.spent,executionState:execution.state,runtimePhase:runtime.runtime.phase,deliveryClaim:false,limits:'Tests real planning, independent revision review and execution; does not run P4 independent source/report verification or validate a broad research synthesis.'},null,2));
});
