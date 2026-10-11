import {resolveAuthorBundle,assertAuthorExpansionProof,patchInput,authorPatchSchema} from '../../packages/orchestration/author-result-patch.js';
import {assertLiveMaintenance} from './supervision-loop-maintenance-checker.js';
import {assertAuthorRouteChain} from './supervision-loop-route-checker.js';
import {readRoutingCapabilities} from '../../packages/orchestration/supervision-routing-capabilities.js';
import {selectAcceptanceAuthorRoute,expectedAuthorRouteConfig} from '../../packages/orchestration/acceptance-authoring-route.js';
import {parseReasonerOutput,ReasonerSchemaError} from '../../packages/orchestration/reasoner-schema.js';
import {diagnoseAcceptanceAuthoringResult,type AcceptanceAuthoringContext} from '../../packages/orchestration/acceptance-authoring.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,realpath,writeFile,readFile,cp } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID,createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { runtimeCanonical } from '../../packages/persistence/runtime.js';
import { parseInspectionResult, type FrozenInspectionInput, type MonitorEvent } from '../../packages/contracts/p6-monitor.js';
import { OrchestrationController } from '../../packages/orchestration/controller.js';
import { SupervisionController } from '../../packages/orchestration/supervision-controller.js';
import { VerificationController } from '../../packages/verification/controller.js';
import { LocalRuntimeAdapter } from '../../packages/runtime/index.js';
import { readOwnership } from '../../packages/runtime/worker-ownership.js';
import { inspectProcess,terminateProcess,type ProcessIdentity } from '../../packages/process-control/index.js';
import { assertCandidate,canonical } from '../../packages/verification/candidate.js';
import type { GoalInspection,ReasoningJob } from '../../packages/contracts/p5.js';
import type { SupervisionInspection } from '../../packages/contracts/p6-supervision-actions.js';
import type { SupervisionJob } from '../../packages/contracts/p6-supervision.js';
import type { VerificationJob } from '../../packages/verification/records.js';
import type { ExecutionRecord } from '../../packages/contracts/p2.js';

const execute=promisify(execFile);
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const goal='创建最小 Node.js ESM 工程，不联网、不安装依赖。result.mjs 命名导出 increment(value)：value 是有限 number 时返回 value+1；其他所有输入（包括 NaN、Infinity、-Infinity、字符串、null、undefined、布尔值、对象）抛真正 TypeError。result.test.mjs 使用 Node 的真实断言，静态导入 increment，检查 increment(2)=3、increment(-2)=-1、increment(0)=1、increment(0.5)=1.5，及上述非法输入 TypeError；运行 node result.test.mjs 必须真实执行这些断言并以非零退出检测错误加法。产物是这两个文件，不需要其他功能。当前计划恰好一个 Codex 实现步骤、一条 command 验收 criterion，id=increment、target=result.test.mjs，description/checks 完整表达上述行为和真实测试要求。不要提问；创建文件并实际运行 node result.test.mjs。实施完成后仍须独立验收才能交付。';
const externalBehavior="import assert from 'node:assert/strict';import {increment} from './result.mjs';for(const [value,expected] of [[2,3],[-2,-1],[0,1],[0.5,1.5],[17,18]])assert.equal(increment(value),expected);for(const value of [NaN,Infinity,-Infinity,'2',null,undefined,true,false,{},[]])assert.throws(()=>increment(value),TypeError);";
// An explicit, traceable fault in product bytes, not a change to its requirements,
// verifier, execution ledger, controller state or completion receipt.
const injected="export function increment(value){if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError('finite number required');return value+2;}\n";

// This case uses default production Codex adapters throughout. The harness only
// observes product APIs, exercises external Node behavior and injects one fault.
// No seeded verification specification/approval, direct repair action, manual
// scan, fake timer or conditional skip can substitute for the autonomous loop.
test('P6-LOOP-L01 real autonomous supervision authors reviews rejects repairs and delivers one immutable contract',{timeout:2_640_000},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-p6-loop-live-'))),data=join(root,'data'),workspace=join(root,'project');await mkdir(workspace);
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','p6-supervision-loop-'+randomUUID());await mkdir(evidence,{recursive:true});
  // Observe existing maximum planning + initial execution + supervision durations.
  // Product deadlines, allocations and all acceptance assertions remain unchanged.
  const deadline=Date.now()+600_000+600_000+1_320_000;
  const config={model:process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol',effort:process.env.SUPERVISOR_LIVE_EFFORT??'low',reservation:150_000,timeoutMs:600_000};
  let store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),orchestration=new OrchestrationController(store,data,runtime),verification=new VerificationController(store,data),supervision=new SupervisionController(store,data,runtime,verification);
  let runtimeId:string|undefined,loopId:string|undefined,sessionId:string|undefined,observation=0;
  const proofDigests:Record<string,string>={};
  async function save(name:string,value:unknown){await writeFile(join(evidence,name+'.json'),JSON.stringify(value,null,2));}
  async function proofs(values:Record<string,string>){assert.ok(Object.keys(values).length,'Real proof files are required');for(const [path,digest] of Object.entries(values)){assert.equal(sha(await readFile(path)),digest,'Raw proof changed: '+path);if(proofDigests[path])assert.equal(proofDigests[path],digest);proofDigests[path]=digest;}}
  async function stopped(identities:ProcessIdentity[]){assert.ok(identities.length,'A claimed model call requires actual process identities');for(const identity of identities)assert.equal((await inspectProcess(identity)).status,'stopped','Actual process must have stopped');}
  async function reasoning(job:ReasoningJob|SupervisionJob,rejectedSchema=false){assert.equal(job.status,'finished');if(rejectedSchema)assert.ok(job.error,'Only a proof-bound schema-rejected author may retain an error');else assert.equal(job.error,null);assert.equal(job.modelStarted,true);assert.equal(job.stopConfirmed,true);assert.ok(job.usage!==null&&job.usage>0&&job.usage<=job.config.reservation);assert.equal(job.intents.length,job.identities.length);await stopped(job.identities);await proofs(job.proofs);assert.ok(Object.keys(job.proofs).some(path=>path.endsWith('reasoner.stdout.log')),'Raw Codex stdout is retained');}
  async function execution(record:ExecutionRecord){assert.equal(record.state,'completed',record.error??record.message);assert.equal(record.stopConfirmed,true);assert.equal(record.cancelRequested,false);assert.equal(record.turnIntent,true);assert.equal(record.usageStatus,'reported');assert.ok(record.usage&&record.usage.totalTokens>0&&record.usage.totalTokens<=record.reservation);assert.ok(record.identity);await stopped([record.identity as ProcessIdentity]);const events=store.executionEvents(record.id,0);assert.ok(events.some(event=>event.kind==='codex-raw'),'Actual execution raw protocol is retained');await save('execution-'+record.id,{record,events,rawEventsDigest:sha(canonical(events))});return canonical({record,events});}
  async function checked(job:VerificationJob){assert.equal(job.status,'finished');assert.equal(job.error,null,'Transport/tool failure cannot substitute for product rejection');assert.equal(job.stopConfirmed,true);assert.equal(job.usageUnknown,false);if(job.kind==='review'){assert.equal(job.modelStarted,true);assert.ok(job.usage>0&&job.usage<=job.config.reservation);}else{assert.equal(job.modelStarted,false,'Deterministic command verification must not claim an extra model call');assert.equal(job.usage,0);}assert.equal(job.intents.length,job.identities.length);await stopped(job.identities);await proofs(job.proofs);}
  async function until<T>(read:()=>T|Promise<T>,done:(value:T)=>boolean,label:string):Promise<T>{for(;;){const value=await read();if(done(value))return value;if(Date.now()>deadline){await save('deadline-'+label,value);throw new Error('Supervision live observation deadline: '+label);}await delay(150);}}
  t.after(async()=>{
    // Preserve failures and partially completed attempts as well as success. No
    // cleanup mutation is represented as acceptance evidence.
    try{await save('final-observation',{goal:sessionId?store.goals.inspect(sessionId):null,supervision:loopId?await supervision.dispatch({type:'inspect',loopId}):null,executions:store.executionList(),proofDigests});}
    finally{try{await supervision.close();await orchestration.close();await verification.close();await runtime.close();const owner=await readOwnership(data);if(owner?.identity)assert.equal((await terminateProcess(owner.identity)).stopped,true);}finally{store.close();await cp(root,join(evidence,'runtime'),{recursive:true});t.diagnostic(JSON.stringify({evidence,root}));}}
  });
  await execute('git',['init','--quiet'],{cwd:workspace});await execute('git',['-c','user.name=Supervisor Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Autonomous supervision live baseline'],{cwd:workspace});
  await verification.initialize();await orchestration.initialize();await supervision.initialize();
  await save('scenario',{goal,config,limits:{maxRepairs:3,maxReasoningCalls:12,maxDurationMs:1_320_000,maxContextChars:200_000},tokenLimit:1_600_000,verificationReserve:300_000,scope:'Real same-contract repair, original full pass, mandatory regression maintenance, V2 qualification and independent review, actual bad/good fault replay, new full pass and delivery. No changed-contract or full P6 release claim.'});
  const started=await orchestration.dispatch({type:'start',commandId:randomUUID(),workspace,goal,tokenLimit:1_600_000,verificationReserve:300_000,maxContextChars:200_000,...config}) as GoalInspection;sessionId=started.session.id;
  const ready=await until(()=>store.goals.inspect(sessionId!),value=>value.session.phase!=='thinking','planning');await save('ready',ready);assert.equal(ready.session.phase,'ready',ready.session.error??JSON.stringify(ready.session.proposal));assert.equal(ready.session.proposal!.steps.length,1);assert.deepEqual(ready.session.proposal!.criteria.map(c=>({id:c.id,kind:c.kind,target:c.target})),[{id:'increment',kind:'command',target:'result.test.mjs'}]);for(const job of ready.session.jobs)await reasoning(job);
  const admitted=await orchestration.dispatch({type:'admit',commandId:randomUUID(),sessionId,expectedRevision:ready.session.revision}) as GoalInspection;runtimeId=admitted.session.runtimeId!;assert.ok(runtimeId);
  const contractBytes=canonical(admitted.run.contract),criteriaBytes=canonical(admitted.session.proposal!.criteria);
  await writeFile(join(evidence,'admitted-contract.json'),contractBytes);await writeFile(join(evidence,'admitted-criteria.json'),criteriaBytes);
  const initial=await until(()=>store.runtime.inspect(runtimeId!),value=>['awaiting-verification','blocked','cancelled'].includes(value.runtime.phase),'initial-execution');await save('initial-execution',initial);assert.equal(initial.runtime.phase,'awaiting-verification',initial.runtime.error??JSON.stringify(initial.operations));assert.equal(initial.runtime.definition.steps.length,1);assert.equal(initial.runtime.definition.steps[0]!.kind,'codex');assert.ok(initial.operations.every(operation=>operation.state==='confirmed'));
  const initialExecutions=store.executionList().filter(record=>record.runId===admitted.run.id);assert.equal(initialExecutions.length,1);const initialReceipt=await execution(initialExecutions[0]!);
  await execute(process.execPath,['result.test.mjs'],{cwd:workspace,timeout:10_000});await execute(process.execPath,['--input-type=module','-e',externalBehavior],{cwd:workspace,timeout:10_000});
  const before=await readFile(join(workspace,'result.mjs')),testBefore=await readFile(join(workspace,'result.test.mjs'));await writeFile(join(evidence,'result-before.mjs'),before);await writeFile(join(evidence,'result-before.test.mjs'),testBefore);
  await writeFile(join(workspace,'result.mjs'),injected);await writeFile(join(evidence,'result-injected.mjs'),injected);
  const diff=await execute('git',['diff','--no-index','--',join(evidence,'result-before.mjs'),join(evidence,'result-injected.mjs')]).then(value=>value.stdout,error=>{assert.equal(error.code,1);return String(error.stdout);});await writeFile(join(evidence,'fault-injection.diff'),diff);
  await save('fault-injection',{file:'result.mjs',beforeDigest:sha(before),afterDigest:sha(injected),unchangedTestDigest:sha(testBefore),contractDigest:sha(contractBytes),reason:'Inject finite input wrong arithmetic while preserving TypeError validation.'});assert.notEqual(sha(before),sha(injected));
  await assert.rejects(execute(process.execPath,['result.test.mjs'],{cwd:workspace,timeout:10_000}),'Actual candidate tests must reject this injected behavior');await assert.rejects(execute(process.execPath,['--input-type=module','-e',externalBehavior],{cwd:workspace,timeout:10_000}));assert.equal(canonical(store.runtime.inspect(runtimeId).run.contract),contractBytes);
  assert.equal(store.verification.headForRun(admitted.run.projectId,admitted.run.id),null,'No manual specification precedes product authoring');
  const attached=await supervision.dispatch({type:'attach',commandId:randomUUID(),runtimeId,config,limits:{maxRepairs:3,maxReasoningCalls:12,maxDurationMs:1_320_000,maxContextChars:200_000}}) as SupervisionInspection;loopId=attached.loop.id;await save('attached',attached);assert.equal(attached.capabilities.scanIntervalMs,2_000);assert.equal(attached.capabilities.healthIntervalMs,10_000);assert.equal(attached.capabilities.modelMonitoring,true); // Capability availability only; this case does not establish three real 300-second inspection windows.
  let lastFingerprint='',failedBytes:string|undefined,failedId:string|undefined,publishedBytes:string|undefined;
  const preservedJobs=new Map<string,string>(),preservedMaintenance=new Set<string>(),preservedStages=new Set<string>();
  let previousSpent=0;
  const final=await until(async()=>{
    const state=await supervision.dispatch({type:'inspect',loopId:loopId!}) as SupervisionInspection;
    assert.equal(canonical(state.runtime.run.contract),contractBytes,'The original full contract must remain unchanged throughout repair');assert.equal(canonical(store.goals.inspect(sessionId!).session.proposal!.criteria),criteriaBytes);
    assert.ok(state.runtime.run.budget.spent>=previousSpent,'Charged usage cannot decrease across maintenance');
    previousSpent=state.runtime.run.budget.spent;
    for(const job of [...state.jobs,...state.verification.jobs]){
      if(job.status!=='finished')continue;
      const bytes=canonical(job),previous=preservedJobs.get(job.id);
      if(previous)assert.equal(bytes,previous,'Previously settled job changes during maintenance: '+job.id);
      else{preservedJobs.set(job.id,bytes);await save('finished-job-'+job.id,job);if(Object.keys(job.proofs).length)await proofs(job.proofs);}
    }
    if(state.controlMaintenance){
      const record=state.controlMaintenance,key=sha(canonical(record));
      if(!preservedMaintenance.has(key)){preservedMaintenance.add(key);await save('maintenance-'+record.status+'-'+key,record);}
    }
    for(const review of state.verification.jobs.filter(job=>job.kind==='review')){
      for(const stage of store.controlQualification.stagesForReview(review.id)){
        const key=review.id+'-'+stage.sequence+'-'+stage.payloadDigest;
        if(!preservedStages.has(key)){preservedStages.add(key);await save('qualification-stage-'+key,stage);}
      }
      const replay=store.controlMaintenance.replayForReview(review.id);
      if(replay){const key='replay-'+review.id+'-'+replay.digest;if(!preservedStages.has(key)){preservedStages.add(key);await save(key,replay);}}
    }
    const fingerprint=canonical({phase:state.loop.phase,revision:state.loop.revision,jobs:state.jobs.map(j=>[j.id,j.status]),verification:state.verification.jobs.map(j=>[j.id,j.status]),steps:state.runtime.runtime.definition.steps.length});
    if(fingerprint!==lastFingerprint){lastFingerprint=fingerprint;await save('observation-'+String(++observation).padStart(3,'0'),state);}
    const failure=state.verification.jobs.find(job=>job.kind==='verification'&&job.status==='finished'&&!job.approved);
    if(failure&&!failedBytes){await checked(failure);assert.ok(failure.evaluation&&!failure.evaluation.complete);assert.ok(failure.results.length&&failure.results.every(result=>result.executionStatus==='executed'));assert.ok(failure.results.some(result=>result.checks.some(check=>check.verdict==='failed')));failedId=failure.id;failedBytes=canonical(failure);const plan=state.verification.plans.find(item=>item.id===failure.planId)!;const head=store.verification.get('proposal',plan.proposalId);assert.equal(head.status,'published');assert.equal(plan.proposalId,head.id);publishedBytes=canonical(head);await assertCandidate(plan.candidate,false);assert.equal(await readFile(join(plan.candidate.tree,'result.mjs'),'utf8'),injected);await save('original-failed-verification',{failure,plan,head});}
    return state;
  },state=>state.loop.stopped||['complete','blocked'].includes(state.loop.phase),'autonomous-loop');
  await save('completed-loop',final);assert.equal(final.loop.phase,'complete',final.loop.reason??JSON.stringify(final));assert.equal(final.loop.paused,false);assert.equal(final.loop.stopped,false);assert.equal(final.runtime.run.status,'succeeded');assert.ok(failedId&&failedBytes&&publishedBytes,'A real failed verification must precede successful delivery');assert.equal(final.loop.repairCount,1,'One injected defect should require exactly one appended repair');
  const maintenance=final.controlMaintenance;assert.ok(maintenance,'A real same-contract repair requires one bounded maintenance receipt');
  assert.equal(maintenance.status,'complete');assert.equal(maintenance.basis.necessity,'required-regression');
  const originalPublished=JSON.parse(publishedBytes) as import('../../packages/verification/records.js').Proposal;
  assert.equal(canonical(store.verification.get('proposal',originalPublished.id)),publishedBytes,'Original published standard is never rewritten');
  const published=store.verification.headForRun(admitted.run.projectId,admitted.run.id)!;
  assert.notEqual(published.id,originalPublished.id);assert.equal(published.id,maintenance.proposalId);
  assert.equal(final.verification.proposals.filter(proposal=>proposal.status==='published').length,2,'Original standard and exactly one maintained successor');
  await assertCandidate(published.candidate,false);
  assert.equal(canonical(store.verification.get('job',failedId)),failedBytes,'Failed job results/proofs remain immutable');const failedPlan=store.verification.get('plan',store.verification.get('job',failedId).planId!);await assertCandidate(failedPlan.candidate,false);assert.equal(await readFile(join(failedPlan.candidate.tree,'result.mjs'),'utf8'),injected);
  const allAuthors=final.jobs.filter(job=>job.purpose==='acceptance-authoring'),maintenanceAuthors=allAuthors.filter(job=>job.id===maintenance.authorJobId),authors=allAuthors.filter(job=>job.id!==maintenance.authorJobId),diagnoses=final.jobs.filter(job=>job.purpose==='diagnosis'),inspections=final.jobs.filter(job=>job.purpose==='inspection'),workflowJobs=final.jobs.filter(job=>job.purpose!=='inspection');
  assert.ok(authors.length>=1&&authors.length<=3,'At most one schema/semantic replacement plus one independent review reconstruction');assert.equal(diagnoses.length,1);assert.equal(maintenanceAuthors.length,1);assert.equal(workflowJobs.length,authors.length+2);assert.equal(final.jobs.length,workflowJobs.length+inspections.length);assert.equal(final.loop.reasoningCount,workflowJobs.length+inspections.length);const authorRoutes=store.authorRouting.routes(final.loop.id);for(const job of workflowJobs)await reasoning(job,authorRoutes.some(route=>route.rejection.previousJobId===job.id&&route.rejection.kind==='schema'));
  const authorInput=(job:SupervisionJob)=>job.input as {outputSchema:Record<string,unknown>;context:{acceptance:AcceptanceAuthoringContext;candidate:unknown;authorFeedback?:{previousJobId:string;inputDigest:string;rejection:import('../../packages/contracts/p6-author-routing.js').AuthorRejection}}};
  // Preserve raw model output; only the host resolver can expand a proof-bound patch.
  const authoredBundle=(job:SupervisionJob)=>{
    assertAuthorExpansionProof(job,id=>store.supervision.job(id),data);
    return resolveAuthorBundle(job,id=>store.supervision.job(id),data).bundle;
  };
  assert.equal(final.loop.references.authorJobId,maintenance.authorJobId);
  const finalAuthor=authors.find(job=>!authorRoutes.some(route=>route.rejection.previousJobId===job.id))!;assert.ok(finalAuthor);assert.equal(finalAuthor.error,null);assert.equal(diagnoseAcceptanceAuthoringResult(authoredBundle(finalAuthor),authorInput(finalAuthor).context.acceptance),null,'Published author must satisfy all original semantic checks');
  assert.equal(authorRoutes.length,authors.length-1,'Every replacement has exactly one immutable route and no extra route');
  assertAuthorRouteChain(authors,authorRoutes,finalAuthor.id);
  assert.ok(authorRoutes.filter(route=>route.rejection.kind==='review').length<=1,'Review reconstruction is independently bounded once');
  assert.ok(authorRoutes.filter(route=>route.rejection.kind!=='review').length<=1,'Schema/semantic regeneration remains bounded once');
  const replacements=new Set(authorRoutes.map(route=>route.nextJobId));assert.equal(replacements.size,authorRoutes.length);
  assert.equal(authors.filter(job=>!replacements.has(job.id)).length,1,'One original author, no orphan author jobs');
  for(const route of authorRoutes){
    const original=authors.find(job=>job.id===route.rejection.previousJobId)!,nextAuthor=authors.find(job=>job.id===route.nextJobId)!;assert.ok(original&&nextAuthor);
    const feedback=authorInput(nextAuthor).context.authorFeedback;
    assert.ok(feedback);assert.equal(feedback.previousJobId,original.id);assert.equal(feedback.inputDigest,original.inputDigest);if(route.rejection.kind!=='review')assert.deepEqual(feedback.rejection,route.rejection);else{assert.equal(feedback.rejection.kind,'review');assert.equal(feedback.rejection.message,route.rejection.message);assert.deepEqual(feedback.rejection.raw,route.rejection.raw);}assert.equal(route.rejection.previousJobId,original.id);assert.equal(route.rejection.jobDigest,sha(runtimeCanonical(original)));assert.equal(route.nextJobId,nextAuthor.id);assert.equal(route.nextInputDigest,nextAuthor.inputDigest);assert.equal(route.contractDigest,sha(contractBytes));assert.deepEqual(route.baseline,original.config);assert.deepEqual(route.selected,nextAuthor.config);assert.equal(nextAuthor.config.reservation,original.config.reservation);if(route.schemaVersion===1){assert.equal(nextAuthor.config.timeoutMs,original.config.timeoutMs);}else{assert.equal(route.schemaVersion,2);assert.deepEqual(nextAuthor.config,expectedAuthorRouteConfig(route));assert.ok(nextAuthor.config.timeoutMs<=original.config.timeoutMs);assert.equal(route.authorization.absoluteDeadlineMs,Date.parse(final.loop.createdAt)+final.loop.limits.maxDurationMs);}assert.notDeepEqual(nextAuthor.config,original.config,'Actual recovery changes quality or depth within the same allocation');assert.notEqual(nextAuthor.threadId,original.threadId,'Real replacement uses a new independent context');
    assert.equal(sha(await readFile(route.rejection.rawOutputPath)),route.rejection.rawOutputDigest);assert.deepEqual(JSON.parse(await readFile(route.rejection.rawOutputPath,'utf8')),route.rejection.raw);await proofs(original.proofs);await proofs(nextAuthor.proofs);
    const raw=await readFile(route.rejection.rawOutputPath,'utf8');
    assert.equal(route.policyDigest,sha(runtimeCanonical(route.policy)));
    const capabilities=readRoutingCapabilities(data,route.capabilities);
    await stopped([route.capabilities.identity]);await proofs({[route.capabilities.proofPath]:route.capabilities.proofDigest,[route.capabilities.snapshotPath]:route.capabilities.snapshotDigest});
    if(route.schemaVersion===1){assert.deepEqual(route.selected,selectAcceptanceAuthorRoute(capabilities,route.baseline,route.policy));}else{assert.deepEqual(route.selected,expectedAuthorRouteConfig({...route,capabilities:{...route.capabilities,capabilities}}));}
    const capabilityAge=Date.parse(route.createdAt)-Date.parse(capabilities.checkedAt);assert.ok(capabilityAge>=0&&capabilityAge<=route.policy.capabilityMaxAgeMs);
    assert.equal(route.rejection.schemaDigest,sha(runtimeCanonical(authorInput(original).outputSchema)));assert.equal(route.rejection.proofsDigest,sha(runtimeCanonical(original.proofs)));
    const resultPaths=Object.keys(original.proofs).filter(path=>path.endsWith('/result.json')),eventPaths=Object.keys(original.proofs).filter(path=>path.endsWith('/events.jsonl'));assert.equal(resultPaths.length,1);assert.equal(eventPaths.length,1);
    const transportResult=JSON.parse(await readFile(resultPaths[0]!,'utf8')),events=(await readFile(eventPaths[0]!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const completed=events.filter(event=>event.kind==='codex-event'&&event.value?.raw?.method==='turn/completed').map(event=>event.value.raw.params);assert.equal(completed.length,1);assert.equal(completed[0].threadId,original.threadId);assert.equal(completed[0].turn.id,transportResult.turnId);assert.equal(completed[0].turn.status,'completed');assert.equal(completed[0].turn.items.filter((item:{type:string})=>item.type==='agentMessage').at(-1)?.text,raw);
    assert.equal(transportResult.usage,original.usage);assert.equal(transportResult.threadId,original.threadId);assert.equal(transportResult.stopConfirmed,true);assert.equal(transportResult.modelStarted,true);
    if(route.rejection.kind==='semantic'){assert.equal(original.error,null);assert.deepEqual(route.rejection.raw,original.result);const diagnostic=diagnoseAcceptanceAuthoringResult(authoredBundle(original),authorInput(original).context.acceptance);assert.ok(diagnostic);assert.equal(route.rejection.message,diagnostic.message);}
    else if(route.rejection.kind==='schema'){assert.equal(route.rejection.kind,'schema');assert.equal(original.result,null);assert.equal(original.error,route.rejection.message);assert.equal(transportResult.value,null);assert.deepEqual(transportResult.outputRejection,{schemaVersion:1,kind:'schema',rawOutputDigest:route.rejection.rawOutputDigest,message:route.rejection.message});assert.throws(()=>parseReasonerOutput(raw,authorInput(original).outputSchema),error=>error instanceof ReasonerSchemaError&&error.message===route.rejection.message);}
    else {assert.equal(route.rejection.kind,'review');assert.equal(original.error,null);assert.equal(diagnoseAcceptanceAuthoringResult(authoredBundle(original),authorInput(original).context.acceptance),null);assert.deepEqual(route.rejection.raw,original.result);const rejected=route.rejection.review!;assert.ok(rejected);const projected=feedback.rejection as unknown as {rawOutputDigest:string;authorProofsDigest:string;review:{classification:string;proposalId:string;proposalDigest:string;baseDigest:string;candidateDigest:string;definitionDigest:string;reviewId:string;reviewDigest:string;proofsDigest:string;usage:number;stopConfirmed:boolean;controls:unknown;diagnostics:unknown;independentReview:unknown}};assert.equal(projected.rawOutputDigest,route.rejection.rawOutputDigest);assert.equal(projected.authorProofsDigest,route.rejection.proofsDigest);const expectedModelReview=rejected.independentReview?{verdict:rejected.independentReview.verdict,reason:rejected.independentReview.reason,observations:rejected.independentReview.observations,usage:rejected.independentReview.usage,threadId:rejected.independentReview.threadId,turnId:rejected.independentReview.turnId}:null;assert.deepEqual(projected.review,{classification:rejected.classification,proposalId:rejected.proposalId,proposalDigest:rejected.proposalDigest,baseDigest:rejected.baseDigest,candidateDigest:rejected.candidateDigest,definitionDigest:rejected.definitionDigest,reviewId:rejected.review.id,reviewDigest:sha(runtimeCanonical(rejected.review)),proofsDigest:sha(runtimeCanonical(rejected.review.proofs)),usage:rejected.review.usage,stopConfirmed:rejected.review.stopConfirmed,controls:rejected.review.controls.map(control=>({id:control.id,passed:control.passed,results:control.results.map(({proofFiles:_paths,...result})=>result)})),diagnostics:rejected.diagnostics,independentReview:expectedModelReview});const actual=store.verification.get('job',rejected.review.id);assert.equal(canonical(actual),canonical(rejected.review),'Original rejected review remains byte-equivalent to receipt');assert.equal(actual.approved,false);assert.equal(actual.status,'finished');assert.ok(actual.error);assert.equal(actual.stopConfirmed,true);assert.equal(actual.usageUnknown,false);assert.ok(actual.usage>=0&&actual.usage<=actual.config.reservation);assert.equal(actual.intents.length,actual.identities.length);await stopped(actual.identities);await proofs(actual.proofs);assert.equal(actual.proposalId,rejected.proposalId);const proposal=store.verification.get('proposal',rejected.proposalId);assert.equal(proposal.status,'proposed');assert.equal(proposal.version,null);assert.equal(proposal.contractDigest,sha(contractBytes));assert.equal(proposal.bundle.digest,rejected.definitionDigest);assert.equal(proposal.candidate.digest,rejected.candidateDigest);assert.equal(store.verificationLineage.bindingForProposal(proposal.id).proposalDigest,rejected.proposalDigest);const reviewAttempt=final.runtime.run.attempts.find(attempt=>attempt.id===actual.attemptId);assert.ok(reviewAttempt);assert.equal(reviewAttempt.purpose,'verification');assert.equal(reviewAttempt.settled,true);assert.equal(reviewAttempt.status,'failed');assert.equal(reviewAttempt.actual,actual.usage);assert.equal(reviewAttempt.reservation,actual.config.reservation);await assertCandidate(proposal.candidate,false);if(rejected.classification==='control-rejected'){assert.equal(actual.modelStarted,false);assert.equal(actual.usage,0);assert.ok(actual.controls.some(control=>!control.passed));}else{assert.equal(rejected.classification,'definition-rejected');assert.equal(actual.modelStarted,true);assert.ok(actual.usage>0);assert.ok(actual.controls.every(control=>control.passed));assert.ok(rejected.independentReview&&['failed','unknown'].includes(rejected.independentReview.verdict));}await save('retained-rejected-review-'+actual.id,{route,proposal,actual});}
    const patch=patchInput(nextAuthor.input);
    if(patch){
      assert.equal(route.schemaVersion,2,'Patch recovery requires the bounded V2 route');
      assert.ok(['semantic','review'].includes(route.rejection.kind),'Schema-invalid bundles retain full recovery');
      assert.equal(patch.context.authorPatch!.base.jobId,original.id);
      assert.equal(patch.context.authorPatch!.base.inputDigest,original.inputDigest);
      assert.deepEqual(authorInput(nextAuthor).outputSchema,authorPatchSchema(patch.context.authorPatch!.base));
      // Exact actual base, raw patch, expanded bundle and receipt are all re-read.
      authoredBundle(nextAuthor);
    }else{
      assert.deepEqual(authorInput(nextAuthor).outputSchema,authorInput(original).outputSchema);
    }
assert.deepEqual(authorInput(nextAuthor).context.acceptance,authorInput(original).context.acceptance);assert.deepEqual(authorInput(nextAuthor).context.candidate,authorInput(original).context.candidate);if(route.rejection.kind!=='review')assert.equal(authorInput(original).context.authorFeedback,undefined);await save('bounded-author-regeneration-'+route.id,{original,nextAuthor,route});
  }
  if(!authorRoutes.length)assert.equal(authorInput(finalAuthor).context.authorFeedback,undefined);
  const monitor=final.monitor;assert.ok(monitor,'Enabled monitoring must expose its durable inspection state');
  assert.deepEqual(monitor.jobs,inspections,'Every durable inspection remains visible; no inspection cost or failed record is filtered away');
  assert.equal(monitor.envelope?.activeJobId??null,null,'A completed loop cannot retain an unresolved inspection');
  // Wall-clock inspection may legitimately run while the repair writer crosses
  // a monitor window. It never replaces the author, diagnosis or P4 assertions.
  for(const job of inspections){
    assert.equal(job.status,'finished');assert.equal(job.stopConfirmed,true);assert.ok(job.usage!==null&&Number.isSafeInteger(job.usage)&&job.usage>=0&&job.usage>=job.observedUsage&&job.usage<=job.config.reservation);
    assert.equal(job.loopId,final.loop.id);assert.equal(job.runtimeId,runtimeId);assert.equal(job.projectId,final.runtime.run.projectId);assert.equal(job.runId,final.runtime.run.id);assert.equal(job.contractVersion,final.runtime.run.contract.version);assert.equal(job.contractDigest,sha(runtimeCanonical(final.runtime.run.contract)));
    const attempt=final.runtime.run.attempts.find(value=>value.id===job.attemptId);assert.ok(attempt);assert.equal(attempt.purpose,'inspection');assert.equal(attempt.settled,true);assert.notEqual(attempt.status,'running');assert.equal(attempt.actual,job.usage);assert.equal(attempt.reservation,job.config.reservation);assert.ok(final.runtime.run.operations.some(operation=>operation.id===job.id&&operation.attemptId===job.attemptId&&operation.status==='confirmed'));assert.ok(final.runtime.run.leases.filter(lease=>lease.attemptId===job.attemptId).every(lease=>lease.released));
    assert.equal(job.intents.length,job.identities.length);assert.equal(new Set(job.identities.map(identity=>identity.operationId)).size,job.identities.length);for(const identity of job.identities)assert.ok(job.intents.some(intent=>intent.operationId===identity.operationId&&intent.ownerToken===identity.ownerToken));if(job.identities.length)await stopped(job.identities);
    if(job.modelStarted){assert.ok(job.identities.length);await proofs(job.proofs);}else{assert.equal(job.usage,0,'No model turn must not report billed tokens');if(Object.keys(job.proofs).length)await proofs(job.proofs);}
    assert.equal(job.inputDigest,sha(runtimeCanonical(job.input)));assert.equal(job.completionDigest,sha(runtimeCanonical({usage:job.usage,stopConfirmed:job.stopConfirmed,error:job.error,proofs:job.proofs,threadId:job.threadId,result:job.result})));
    const input=job.input as FrozenInspectionInput;assert.equal(input.context.binding.loopId,final.loop.id);assert.equal(input.context.binding.runtimeId,runtimeId);assert.equal(input.context.binding.contractDigest,job.contractDigest);assert.equal(input.context.binding.snapshotDigest,sha(runtimeCanonical(input.context.snapshot)));
    const dispositions:MonitorEvent[]=monitor.events.filter(event=>event.kind==='disposition'&&event.jobId===job.id);assert.equal(dispositions.length,1,'Inspection has one immutable completion disposition');const disposition=dispositions[0]!.record.disposition;assert.ok(disposition&&['applied','failed','discarded-stale-contract','discarded-inactive','discarded-pending-followup','discarded-by-runner'].includes(disposition));assert.ok(dispositions[0]!.record.reason?.trim());
    if(disposition==='applied'){await reasoning(job);assert.equal(attempt.status,'succeeded');parseInspectionResult(job.result,input.context.snapshot.evidence.map(item=>item.id));}
    else{assert.notEqual(disposition,'unknown','Unknown inspection usage or stop cannot accompany complete');await save('non-applied-inspection-'+job.id,{job,attempt,disposition:dispositions[0]});}
  }
  const diagnosisInput=diagnoses[0]!.input as {context:{failure:{jobId:string;proofs:Record<string,string>}}};assert.equal(diagnosisInput.context.failure.jobId,failedId);assert.deepEqual(diagnosisInput.context.failure.proofs,store.verification.get('job',failedId).proofs);assert.equal((diagnoses[0]!.result as {decision:string}).decision,'repair');
  const reviews=final.verification.jobs.filter(job=>job.kind==='review'),acceptedReviews=reviews.filter(job=>job.approved);
  assert.equal(reviews.length,2+authorRoutes.filter(route=>route.rejection.kind==='review').length);
  assert.equal(acceptedReviews.length,2);
  assert.deepEqual(reviews.filter(job=>!job.approved).map(job=>job.id).sort(),authorRoutes.filter(route=>route.rejection.kind==='review').map(route=>route.rejection.review!.review.id).sort(),'Every rejected original review has its exact bounded reconstruction receipt');
  assert.equal(final.verification.proposals.length,reviews.length);
  const originalReview=acceptedReviews.find(job=>job.proposalId===originalPublished.id)!;assert.ok(originalReview);
  await checked(originalReview);assert.ok(originalReview.controls.length>=2&&originalReview.controls.every(control=>control.passed));
  assert.ok(originalPublished.spec.controls.some(control=>control.expect==='passed'));assert.ok(originalPublished.spec.controls.some(control=>control.expect==='failed'));
  for(const control of originalReview.controls)assert.ok(control.results.length&&control.results.every(result=>result.executionStatus==='executed'));
  const verifications=final.verification.jobs.filter(job=>job.kind==='verification');assert.equal(verifications.length,3);
  for(const job of verifications){
    await checked(job);const plan=store.verification.get('plan',job.planId!),definition=store.verification.get('proposal',job.proposalId);
    assert.equal(plan.proposalId,definition.id);assert.equal(plan.catalogVersion,definition.version);assert.equal(plan.definitionDigest,definition.bundle.digest);assert.equal(plan.selection.completeScope,true);await assertCandidate(plan.candidate,false);
  }
  const oldPass=verifications.find(job=>job.id===maintenance.basis.baselinePassJobId)!;
  assert.ok(oldPass?.approved&&oldPass.evaluation?.complete);assert.equal(oldPass.proposalId,originalPublished.id);
  assert.equal(verifications.filter(job=>job.proposalId===originalPublished.id).length,2,'Repair first reruns the exact original published definition');
  const passed=verifications.find(job=>job.id===maintenance.finalJobId)!;assert.ok(passed?.approved&&passed.evaluation?.complete);assert.equal(passed.proposalId,published.id);
  assert.ok(passed.results.every(result=>result.executionStatus==='executed'&&result.checks.every(check=>check.verdict==='passed')));
  assert.notEqual(store.verification.get('plan',passed.planId!).candidate.digest,failedPlan.candidate.digest);
  assert.equal(final.verification.deliveries.length,1);const delivery=final.verification.deliveries[0]!;
  assert.equal(delivery.jobId,passed.id);assert.equal(delivery.planId,passed.planId);assert.equal(delivery.candidateDigest,store.verification.get('plan',passed.planId!).candidate.digest);await assertCandidate(store.verification.get('plan',passed.planId!).candidate);
  await assertLiveMaintenance({store,final,original:originalPublished,failedId,oldPass,passed,proofs,checked,save});
  assert.equal(final.runtime.runtime.definition.steps.length,2);assert.deepEqual(final.runtime.runtime.definition.steps.slice(0,1),initial.runtime.definition.steps);assert.equal(final.runtime.runtime.definition.steps[1]!.kind,'codex');assert.ok(final.runtime.runtime.definition.steps[1]!.id.startsWith('repair-1-'));for(const operation of initial.operations)assert.deepEqual(final.runtime.operations.find(item=>item.id===operation.id),operation);assert.ok(final.runtime.operations.every(operation=>operation.state==='confirmed'));assert.ok(final.runtime.checkpoints.every(checkpoint=>checkpoint.valid));
  const executions=store.executionList().filter(record=>record.runId===admitted.run.id);assert.equal(executions.length,2);for(const record of executions)await execution(record);assert.equal(canonical({record:store.executionGet(initialExecutions[0]!.id),events:store.executionEvents(initialExecutions[0]!.id,0)}),initialReceipt,'Original actual execution receipt/raw events remain unchanged');
  await execute(process.execPath,['result.test.mjs'],{cwd:workspace,timeout:10_000});await execute(process.execPath,['--input-type=module','-e',externalBehavior],{cwd:workspace,timeout:10_000});
  const run=final.runtime.run;assert.ok(run.attempts.every(attempt=>attempt.settled&&attempt.actual!==null&&attempt.status!=='running'));assert.equal(run.budget.spent,run.attempts.reduce((total,attempt)=>total+attempt.actual!,0));assert.ok(run.budget.spent>0&&run.budget.spent<run.budget.limit);assert.ok(run.operations.every(operation=>operation.status==='confirmed'));assert.ok(run.leases.every(lease=>lease.released));
  for(const [path,digest] of Object.entries(proofDigests))assert.equal(sha(await readFile(path)),digest,'Previously observed raw evidence survives repair');
  const listed=await supervision.dispatch({type:'list'}) as SupervisionInspection[];assert.equal(listed.length,1);assert.deepEqual(listed[0],final);
  // Reopen the real SQLite state. Completed work must not dispatch another model,
  // repeat pair commands, republish or bill after process/controller recovery.
  const deliveryStatus=await verification.status(runtimeId!) as {currentDelivery:{assessment:{historicalEvidenceIntact:boolean;issues:unknown[]}}};
  assert.equal(deliveryStatus.currentDelivery.assessment.historicalEvidenceIntact,true,JSON.stringify(deliveryStatus.currentDelivery.assessment.issues));
  await save('delivered-history',deliveryStatus);
  const beforeRestart=canonical({jobs:final.jobs,verificationJobs:final.verification.jobs,deliveries:final.verification.deliveries,maintenance,budget:run.budget});
  await supervision.close();await orchestration.close();await verification.close();await runtime.close();store.close();
  store=new SupervisorStore(data);runtime=new LocalRuntimeAdapter(store,data);orchestration=new OrchestrationController(store,data,runtime);verification=new VerificationController(store,data);supervision=new SupervisionController(store,data,runtime,verification);
  await verification.initialize();await orchestration.initialize();await supervision.initialize();await supervision.scan();
  const reopened=supervision.inspect(loopId!);assert.equal(reopened.loop.phase,'complete');
  assert.equal(canonical({jobs:reopened.jobs,verificationJobs:reopened.verification.jobs,deliveries:reopened.verification.deliveries,maintenance:reopened.controlMaintenance,budget:reopened.runtime.run.budget}),beforeRestart);
  await save('reopened-no-replay',reopened);
  await save('acceptance',{contractDigest:sha(contractBytes),criteriaDigest:sha(criteriaBytes),originalPublishedHeadDigest:sha(publishedBytes),publishedHeadDigest:sha(canonical(published)),maintenance,failedJobId:failedId,passedJobId:passed.id,delivery,actualModelCalls:{planning:ready.session.jobs.filter(job=>job.modelStarted).length,execution:executions.filter(record=>record.turnIntent).length,supervision:final.jobs.filter(job=>job.modelStarted).length,verification:final.verification.jobs.filter(job=>job.modelStarted).length},proofDigests,budget:run.budget,scope:'Real automatic same-contract repair followed by required regression maintenance and independent qualified-v2 publication/full delivery. This single real scenario is not full P6 or generic dedup acceptance.'});
});
