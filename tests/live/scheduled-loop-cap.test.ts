import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,readFile,writeFile,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {ResultPackage} from '../../packages/workspace/result-package.js';
import {setTimeout as delay} from 'node:timers/promises';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {OrchestrationController} from '../../packages/orchestration/controller.js';
import {LocalRuntimeAdapter} from '../../packages/runtime/index.js';
import {ScheduledRuntimeWorker} from '../../packages/runtime/scheduled-worker.js';
import {readOwnership} from '../../packages/runtime/worker-ownership.js';
import {inspectProcess,terminateProcess,type ProcessIdentity} from '../../packages/process-control/index.js';
import {canonical,environmentFingerprint} from '../../packages/verification/candidate.js';
import {goalIterationTree} from '../../packages/orchestration/goal-loop-admission.js';
import {programNodes} from '../../packages/orchestration/loop-program.js';
import type {GoalInspection} from '../../packages/contracts/p5.js';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

// Separate user scenario, not a weakened replacement of L01. Target4 deliberately
// cannot be reached by three valid +1 occurrences. This must stop, not deliver.
const capGoal=`Create an offline bounded Node data workflow with exactly the original templates increment, report-a, report-b. The increment template writes only state.json with exactly one scalar integer field value. Its first actual occurrence without predecessor writes {"value":1}; each later occurrence reads the latest host-supplied immutable predecessor state package and writes previous value+1 exactly once. Do not loop inside a task, jump values, edit prior results, use network or install dependencies. Use a nested strategy: root sequence of outer loop, then parallel(report-a,report-b). The outer loop body is an inner loop whose body is the sole increment template leaf. The inner loop until uses increment/state.json/value atLeast1, with iterations1,nodes1,tokens150000,durationMs900000,unchangedIterations1: it yields after its one actual increment in each outer iteration. The outer until uses the same increment/state.json/value atLeast4, with iterations3,nodes3,tokens450000,durationMs900000,unchangedIterations1. Both loops must appear in the actual P5 iteration proposal; every task template appears exactly once. The outer strategy is deliberately capped before its numeric target: three real increments reach1,2,3 and the iteration cap must block before a fourth dispatch. Do not lower target4, increase any limit or claim that value3 is success. Numeric yield never grants business acceptance. Both report templates depend on increment; report-a would read state.json and write only report-a.json={"label":"a","value":4}, and report-b would independently write only report-b.json={"label":"b","value":4}, but neither may run until the outer target actually yields. Explicit declared file scopes: increment writes state.json; report-a reads state.json and writes report-a.json; report-b reads state.json and writes report-b.json; resources[] and no unknown scopes. Preserve all dependencies. Do not add an integration/verification template: the host has its own protected final integration, which must not execute after this cap. Keep one original command criterion id=loop-cap,target=result.test.mjs containing the complete target4, exact +1 progression, nested bounds, dependency/file/no-network requirements and no-false-delivery rule; every template references it. No questions, permission escalation or self-approval. This request tests a real bounded strategy that must report its unmet target transparently rather than fabricate completion.`;

test('P7-LOOP-L02 actual nested Codex iterations reach original cap without fourth dispatch or false delivery and remain stopped after reopen',{timeout:1_740_000},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-p7-loop-cap-live-'))),data=join(root,'data'),workspace=join(root,'project');
 await mkdir(workspace);
 const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','p7-loop-cap-'+randomUUID());await mkdir(evidence,{recursive:true});
 const deadline=Date.now()+1_680_000;
 const config={model:process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol',effort:process.env.SUPERVISOR_LIVE_EFFORT??'low',reservation:150_000,timeoutMs:600_000};
 let store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),orchestration=new OrchestrationController(store,data,runtime,undefined,{graphAdmission:{tier:'low',maxActive:2,maxNodes:8,maxDepth:2,maxDurationMs:1_320_000}});
 let runtimeId:string|undefined,sessionId:string|undefined,schedulerId:string|undefined,observerWorker:ScheduledRuntimeWorker|undefined;
 const save=async(name:string,value:unknown)=>writeFile(join(evidence,name+'.json'),JSON.stringify(value,null,2));
 function events(id:string){const result:ReturnType<SupervisorStore['executionEvents']>=[];let after=0;for(;;){const page=store.executionEvents(id,after);result.push(...page);if(page.length<500)return result;after=page.at(-1)!.seq;}}
 async function until<T>(read:()=>T|Promise<T>,done:(value:T)=>boolean,label:string){for(;;){const value=await read();if(done(value))return value;if(Date.now()>=deadline){await save('deadline-'+label,value);throw Error('Actual nested cap observation deadline: '+label);}await delay(150);}}
 async function stopWorker(){const owner=await readOwnership(data);if(owner?.identity){const result=await terminateProcess(owner.identity);assert.equal(result.stopped,true);assert.equal((await inspectProcess(owner.identity)).status,'stopped');}}
 function snapshot(){return {goal:sessionId?store.goals.inspect(sessionId):null,runtime:runtimeId?store.runtime.inspect(runtimeId):null,source:schedulerId?store.scheduledLoops.source(schedulerId):null,state:schedulerId?store.scheduledLoops.inspect(schedulerId):null,decisions:schedulerId?store.scheduledLoops.decisions(schedulerId):[],budgets:schedulerId?store.scheduledLoops.budgets(schedulerId):[],claims:schedulerId?store.scheduler.claims(schedulerId):[],executions:store.executionList().map(record=>({record,events:events(record.id)})),deliveries:store.verification.list('delivery')};}
 t.after(async()=>{const errors:string[]=[];const safe=async(fn:()=>unknown|Promise<unknown>)=>{try{await fn();}catch(error){errors.push(String(error));}};
  await safe(()=>save('final-before-cleanup',snapshot()));await safe(()=>observerWorker?.close());await safe(()=>orchestration.close());
  if(runtimeId&&store.runtime.inspect(runtimeId).run.status!=='succeeded')await safe(()=>runtime.dispatch({type:'cancel',commandId:randomUUID(),runtimeId:runtimeId!}));
  await safe(()=>runtime.close());await safe(stopWorker);
  await safe(async()=>{const stops=[];for(const execution of store.executionList())if(execution.identity){const identity=execution.identity as ProcessIdentity;const actual=await inspectProcess(identity);if(actual.status!=='stopped')assert.equal((await terminateProcess(identity)).stopped,true);const final=await inspectProcess(identity);stops.push({executionId:execution.id,actual,final});assert.equal(final.status,'stopped');}await save('actual-cleanup-stops',stops);});
  await safe(()=>save('final-after-cleanup',snapshot()));await safe(()=>store.close());await safe(()=>cp(root,join(evidence,'runtime'),{recursive:true}));await save('cleanup-errors',errors);t.diagnostic(JSON.stringify({root,evidence}));assert.deepEqual(errors,[]);
 });
 await save('environment-preflight',await environmentFingerprint());
 await save('scenario',{goal:capGoal,config,tokenLimit:1_600_000,verificationReserve:300_000,graph:{maxActive:2,maxNodes:8,maxDepth:2,maxDurationMs:1_320_000},observerMs:1_680_000,scope:'Actual provider nested yield and original iteration-cap stop, not fake P4 acceptance'});
 await orchestration.initialize();
 const started=await orchestration.dispatch({type:'start',commandId:randomUUID(),workspace,goal:capGoal,tokenLimit:1_600_000,verificationReserve:300_000,maxContextChars:200_000,...config}) as GoalInspection;sessionId=started.session.id;
 const ready=await until(()=>store.goals.inspect(sessionId!),s=>s.session.phase!=='thinking','planning');await save('planning',ready);
 assert.equal(ready.session.phase,'ready',ready.session.error??canonical(ready));const proposal=ready.session.proposal!;
 assert.deepEqual(proposal.steps.map(step=>step.id).sort(),['increment','report-a','report-b']);assert.deepEqual(proposal.criteria.map(c=>({id:c.id,kind:c.kind,target:c.target})),[{id:'loop-cap',kind:'command',target:'result.test.mjs'}]);
 assert.ok(proposal.iteration);const tree=goalIterationTree(proposal.iteration);assert.equal(tree.kind,'sequence');
 const nodes=programNodes(tree),loops=nodes.filter(n=>n.kind==='loop');assert.equal(loops.length,2);
 const outer=loops.find(n=>n.until.atLeast===4)!,inner=loops.find(n=>n.until.atLeast===1)!;assert.ok(outer&&inner);assert.equal(outer.body.id,inner.id);assert.equal(inner.body.kind,'task');
 assert.deepEqual(outer.until,{taskId:'increment',path:'state.json',field:'value',atLeast:4});assert.deepEqual(inner.until,{taskId:'increment',path:'state.json',field:'value',atLeast:1});
 assert.deepEqual(outer.limits,{iterations:3,nodes:3,tokens:450000,durationMs:900000,unchangedIterations:1});assert.deepEqual(inner.limits,{iterations:1,nodes:1,tokens:150000,durationMs:900000,unchangedIterations:1});assert.ok(nodes.some(n=>n.kind==='parallel'&&n.children.length===2));
 for(const job of ready.session.jobs){assert.equal(job.status,'finished');assert.equal(job.error,null);assert.equal(job.modelStarted,true);assert.equal(job.stopConfirmed,true);assert.ok(job.usage!==null&&job.usage>0&&job.usage<=job.config.reservation);assert.ok(job.identities.length&&Object.keys(job.proofs).length);for(const id of job.identities)assert.equal((await inspectProcess(id)).status,'stopped');for(const [p,digest]of Object.entries(job.proofs))assert.equal(sha(await readFile(p)),digest);}
 const admitted=await orchestration.dispatch({type:'admit',commandId:randomUUID(),sessionId,expectedRevision:ready.session.revision}) as GoalInspection;runtimeId=admitted.session.runtimeId!;assert.ok(admitted.session.graphAdmission?.loop?.decision.allowed);schedulerId=admitted.session.graphAdmission!.policy.schedulerId;
 const source=store.scheduledLoops.source(schedulerId)!,sourceBytes=canonical(source),contractBytes=canonical(admitted.run.contract),criteriaBytes=canonical(proposal.criteria);assert.equal(source.templatePlan.limits.maxDepth,2);await save('admitted',snapshot());
 const terminal=await until(()=>{const actual=snapshot();assert.equal(canonical(actual.source),sourceBytes);assert.equal(canonical(actual.runtime!.run.contract),contractBytes);assert.equal(canonical(actual.goal!.session.proposal!.criteria),criteriaBytes);return actual;},s=>s.runtime!.run.status==='cancelled'||s.runtime!.runtime.phase==='blocked'||s.runtime!.runtime.phase==='awaiting-verification','actual-nested-cap');await save('cap-observed',terminal);
 const state=terminal.state!,decisions=terminal.decisions,outerFrames=state.frames.filter(f=>f.nodeId===outer.id),innerFrames=state.frames.filter(f=>f.nodeId===inner.id);
 assert.equal(outerFrames.length,1);assert.equal(outerFrames[0]!.state,'blocked');assert.equal(outerFrames[0]!.reason,'Iteration cap reached without yield');assert.equal(state.frames.find(f=>f.key===state.rootKey)!.state,'blocked');
 assert.equal(innerFrames.length,3);assert.ok(innerFrames.every(f=>f.state==='yielded'&&f.ancestry.includes(outerFrames[0]!.key)));
 assert.deepEqual(decisions.filter(d=>d.loopId===outerFrames[0]!.key).map(d=>({ordinal:d.ordinal,decision:d.decision,value:d.value})),[{ordinal:1,decision:'continue',value:1},{ordinal:2,decision:'continue',value:2},{ordinal:3,decision:'blocked',value:3}]);
 assert.deepEqual(decisions.filter(d=>innerFrames.some(f=>f.key===d.loopId)).map(d=>({ordinal:d.ordinal,decision:d.decision,value:d.value})),[{ordinal:1,decision:'yield',value:1},{ordinal:1,decision:'yield',value:2},{ordinal:1,decision:'yield',value:3}]);
 const settled=await until(()=>store.runtime.inspect(runtimeId!),s=>s.run.attempts.every(a=>a.settled)&&s.run.operations.every(o=>o.status==='confirmed')&&s.run.leases.every(l=>l.released),'cap-accounting');
 assert.equal(settled.runtime.phase,'blocked');assert.equal(settled.run.status,'blocked');assert.equal(store.scheduler.get(schedulerId).fence,'held');
 const claims=store.scheduler.claims(schedulerId),executions=store.executionList();assert.equal(claims.length,3);assert.equal(executions.length,3,'Only three real increments, no reports or final integration');assert.ok(claims.every(c=>c.loopIds.length===2));
 const scope={projectId:admitted.run.projectId,runId:admitted.run.id},ledger=store.taskResults.inspect(scope);assert.equal(ledger.heads.length,3);assert.equal(ledger.versions.length,3);assert.ok(ledger.versions.every(v=>v.state==='submitted'&&v.verification===null));
 const packages:Array<{claim:(typeof claims)[number];head:(typeof ledger.heads)[number];value:number;sha256:string;pack:ResultPackage}>=[];
 for(const claim of claims){const head=ledger.heads.find(h=>h.taskId===claim.taskId)!;assert.ok(head);const pack=store.taskResults.readPublished({...scope,ref:head.ref,minimumState:'submitted'});const bytes=await readFile(join(pack.directory,'files','state.json'));const value=JSON.parse(bytes.toString());assert.deepEqual(Object.keys(value),['value']);packages.push({claim,head,value:value.value,sha256:sha(bytes),pack});}
 packages.sort((a,b)=>a.value-b.value);assert.deepEqual(packages.map(p=>p.value),[1,2,3]);assert.equal(packages[0]!.claim.inputBindings.length,0);
 for(let i=1;i<3;i++)assert.ok(packages[i]!.claim.inputBindings.some(b=>canonical(b.result)===canonical(packages[i-1]!.head.ref)),'Nested next occurrence consumes actual prior package');
 for(const d of decisions){assert.ok(d.resultRefs.length>0);for(const ref of d.resultRefs)assert.ok(ledger.versions.some(v=>canonical(v.ref)===canonical(ref)));}
 for(const e of executions){assert.equal(e.state,'completed',e.error??e.message);assert.equal(e.stopConfirmed,true);assert.equal(e.usageStatus,'reported');assert.ok(e.usage&&e.usage.totalTokens>0&&e.usage.totalTokens<=e.reservation);assert.equal(e.turnIntent,true);assert.ok(e.threadId&&e.turnId&&e.identity);assert.equal((await inspectProcess(e.identity as ProcessIdentity)).status,'stopped');const raw=events(e.id);assert.ok(raw.some(event=>event.kind==='codex-raw'));const attempt=settled.run.attempts.find(a=>a.id===e.attemptId)!;assert.equal(attempt.actual,e.usage.totalTokens);assert.equal(attempt.settled,true);assert.ok(e.candidateSnapshot);assert.equal(sha(await readFile(e.candidateSnapshot.path)),e.candidateSnapshot.digest);await save('execution-'+e.id,{execution:e,events:raw});}
 for(const budget of store.scheduledLoops.budgets(schedulerId)){assert.equal(budget.unknown,false);assert.equal(budget.reserved,0);assert.ok(budget.spent>0&&budget.spent<=budget.limit!);assert.ok(budget.generatedNodes<=budget.maxNodes&&budget.iteration<=budget.maxIterations);}
 assert.equal(settled.run.budget.limit!,1_600_000);assert.equal(settled.run.budget.verificationReserve,300_000);assert.equal(settled.run.budget.spent,settled.run.attempts.reduce((n,a)=>n+a.actual!,0));assert.ok(settled.run.budget.spent<settled.run.budget.limit!);assert.ok(settled.run.budget.futureExecution);assert.equal(settled.run.artifact,null);assert.equal(store.verification.list('job').length,0);assert.equal(store.verification.list('delivery').length,0);assert.equal(store.supervision.list().length,0);
 const audit=new DatabaseSync(join(data,'supervisor.sqlite'),{readOnly:true});
 let schedulerEvents:unknown[],loopEvents:Array<{kind:string;record:string}>;
 try{schedulerEvents=audit.prepare('SELECT seq,kind,record FROM scheduled_events WHERE scheduler_id=? ORDER BY seq').all(schedulerId);loopEvents=audit.prepare('SELECT kind,record FROM scheduled_loop_events WHERE scheduler_id=? ORDER BY rowid').all(schedulerId) as typeof loopEvents;}finally{audit.close();}
 assert.ok(loopEvents.some(event=>event.kind==='advanced'&&JSON.parse(event.record).decisions.some((decision:{loopId:string;decision:string;ordinal:number;value:number})=>decision.loopId===outerFrames[0]!.key&&decision.decision==='blocked'&&decision.ordinal===3&&decision.value===3)),'Durable original loop decision binds cap to actual third sealed result');
 await save('sealed-cap-evidence',{packages,decisions,iterations:store.scheduledLoops.iterations(schedulerId),budgets:store.scheduledLoops.budgets(schedulerId),schedulerEvents,loopEvents,snapshot:snapshot()});
 // Reopen and drive the SAME real scheduler once. A regression that dispatches a
 // fourth model must fail this case; no substitute manager or fabricated result.
 await orchestration.close();await runtime.close();await stopWorker();const before=canonical({claims:store.scheduler.claims(schedulerId),executions:store.executionList(),decisions:store.scheduledLoops.decisions(schedulerId),run:store.runtime.inspect(runtimeId).run});store.close();
 store=new SupervisorStore(data);runtime=new LocalRuntimeAdapter(store,data);orchestration=new OrchestrationController(store,data,runtime);
 observerWorker=new ScheduledRuntimeWorker(store,data,'cap-reopen-'+randomUUID());await observerWorker.initialize();await observerWorker.tick();
 assert.equal(canonical({claims:store.scheduler.claims(schedulerId),executions:store.executionList(),decisions:store.scheduledLoops.decisions(schedulerId),run:store.runtime.inspect(runtimeId).run}),before,'Reopen must not create a fourth claim, reset fee history or replay work');
 assert.equal(store.verification.list('delivery').length,0);assert.equal(store.verification.list('job').length,0);await observerWorker.close();observerWorker=undefined;
 await save('accepted-negative-stop',{snapshot:snapshot(),authority:'Expected bounded stop only: original target4 unmet, no P4 or delivery, not a successfully completed user goal'});
});
