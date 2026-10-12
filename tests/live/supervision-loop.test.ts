import {validateControlEvolutionBundle,type ControlEvolutionAuthoringContext} from '../../packages/orchestration/acceptance-authoring-v2.js';
import {prepareSuppliedIncrement} from './supervision-loop-supplied-fixture.js';
import {assertLiveMaintenance} from './supervision-loop-maintenance-checker.js';
import {type AcceptanceAuthoringContext} from '../../packages/orchestration/acceptance-authoring.js';
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
const criterion={id:'increment',kind:'command',target:'result.test.mjs',description:'独立验收当前冻结产物的 increment 业务行为、Node 测试命令成功执行及双文件交付范围。',checks:[
  '当前 result.mjs 命名导出 increment(value)，有限 number 返回 JavaScript value+1；实际检查 2、-2、0、0.5 和 17。',
  '当前 increment 对 NaN、Infinity、-Infinity、字符串、null、undefined、布尔值和对象等非有限 number 输入抛真正 TypeError。',
  '对当前冻结产物实际执行 node result.test.mjs，进程成功退出，退出码为 0。',
  '当前冻结交付目录恰好包含 result.mjs 和 result.test.mjs 两个文件。',
]};
const goal='创建最小 Node.js ESM 工程，不联网、不安装依赖，仅交付 result.mjs 和 result.test.mjs。result.mjs 命名导出 increment(value)：有限 number 返回 JavaScript value+1；其他所有输入（包括 NaN、Infinity、-Infinity、字符串、null、undefined、布尔值和对象）抛真正 TypeError。实现步骤创建 Node 测试，检查 2→3、-2→-1、0→1、0.5→1.5 及上述非法输入，并实际运行 node result.test.mjs，保留真实工具调用与退出结果。恰好一个 Codex 实现步骤和一条 command criterion；criterion 必须逐字采用下列 JSON 的 id、kind、target、description 和 checks，不得增加或改写 checks：'+JSON.stringify(criterion)+'。P4 用独立执行验证当前函数业务行为；用户测试命令只要求当前真实成功运行。不联网、不安装依赖是实施指令及宿主权限边界，不作为控制项目历史行为资格；第四 check 只验证当前双文件目录，不证明额外功能排除或通用依赖审计。实现期历史动作不属于正负控制项目资格义务；本场景不要求通用断言触达、静态导入审计、用户测试变异检测质量、隔离变异进程退出证明或形式化 forall 数学证明。实施完成后仍须独立验收才能交付，不要提问。';
const externalBehavior="import assert from 'node:assert/strict';import {increment} from './result.mjs';for(const [value,expected] of [[2,3],[-2,-1],[0,1],[0.5,1.5],[17,18]])assert.equal(increment(value),expected);for(const value of [NaN,Infinity,-Infinity,'2',null,undefined,true,false,{},[]])assert.throws(()=>increment(value),TypeError);";
// An explicit, traceable fault in product bytes, not a change to its requirements,
// verifier, execution ledger, controller state or completion receipt.
const injected="export function increment(value){if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError('finite number required');return value+2;}\n";

// This case uses default production Codex adapters throughout. The harness only
// observes product APIs, exercises external Node behavior and injects one fault.
// Initial fixed user assets still require actual independent P4 qualification.
// No seeded approval, direct repair action, manual
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
  async function reasoning(job:ReasoningJob|SupervisionJob,rejectedSchema=false){assert.equal(job.status,'finished');if(rejectedSchema)assert.ok(job.error,'Only a proof-bound rejected author may retain an error');else assert.equal(job.error,null);assert.equal(job.modelStarted,true);assert.equal(job.stopConfirmed,true);assert.ok(job.usage!==null&&job.usage>0&&job.usage<=job.config.reservation);assert.equal(job.intents.length,job.identities.length);await stopped(job.identities);await proofs(job.proofs);assert.ok(Object.keys(job.proofs).some(path=>path.endsWith('reasoner.stdout.log')),'Raw Codex stdout is retained');}
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
  const ready=await until(()=>store.goals.inspect(sessionId!),value=>value.session.phase!=='thinking','planning');await save('ready',ready);assert.equal(ready.session.phase,'ready',ready.session.error??JSON.stringify(ready.session.proposal));assert.equal(ready.session.proposal!.steps.length,1);assert.deepEqual(ready.session.proposal!.criteria.map(c=>({id:c.id,kind:c.kind,target:c.target})),[{id:'increment',kind:'command',target:'result.test.mjs'}]);assert.deepEqual(ready.session.proposal!.criteria,[criterion],'Planner must preserve the explicit current-only criterion before admission');for(const job of ready.session.jobs)await reasoning(job);
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
  const supplied=await prepareSuppliedIncrement(join(root,'supplied-initial'),admitted.run.contract.version,criterion.checks);await proofs(supplied.files);
  const suppliedProposal=await verification.dispatch({type:'propose',commandId:randomUUID(),runtimeId:runtimeId!,specPath:supplied.specPath}) as import('../../packages/verification/records.js').Proposal;
  assert.equal(suppliedProposal.status,'proposed');assert.deepEqual(suppliedProposal.spec,supplied.spec);assert.equal(suppliedProposal.contractDigest,sha(contractBytes));await assertCandidate(suppliedProposal.candidate,false);
  const dispatchedReview=await verification.dispatch({type:'review',commandId:randomUUID(),proposalId:suppliedProposal.id,...config}) as VerificationJob;
  const suppliedReview=await until(()=>store.verification.get('job',dispatchedReview.id),job=>job.status==='finished','supplied-independent-review');await checked(suppliedReview);assert.equal(suppliedReview.approved,true,suppliedReview.error??JSON.stringify(suppliedReview));assert.equal(suppliedReview.proposalId,suppliedProposal.id);assert.ok(suppliedReview.controls.length===supplied.spec.controls.length&&suppliedReview.controls.every(c=>c.passed));
  await verification.dispatch({type:'publish',commandId:randomUUID(),proposalId:suppliedProposal.id,reviewId:suppliedReview.id});
  assert.equal(store.verification.headForRun(admitted.run.projectId,admitted.run.id)?.id,suppliedProposal.id);await save('supplied-initial-qualified',{assets:supplied,proposal:store.verification.get('proposal',suppliedProposal.id),review:suppliedReview});
  const attached=await supervision.dispatch({type:'attach',commandId:randomUUID(),runtimeId,authoringProtocol:'acceptance-stages-v2',config,limits:{maxRepairs:3,maxReasoningCalls:12,maxDurationMs:1_320_000,maxContextChars:200_000}}) as SupervisionInspection;loopId=attached.loop.id;await save('attached',attached);assert.equal(attached.capabilities.scanIntervalMs,2_000);assert.equal(attached.capabilities.healthIntervalMs,10_000);assert.equal(attached.capabilities.modelMonitoring,true); // Capability availability only; this case does not establish three real 300-second inspection windows.
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
  assert.equal(final.loop.references.authorJobId,maintenance.authorJobId);
  const originalPublished=JSON.parse(publishedBytes) as import('../../packages/verification/records.js').Proposal;
  assert.equal(canonical(store.verification.get('proposal',originalPublished.id)),publishedBytes,'Original published standard is never rewritten');
  const published=store.verification.headForRun(admitted.run.projectId,admitted.run.id)!;
  assert.notEqual(published.id,originalPublished.id);assert.equal(published.id,maintenance.proposalId);
  assert.equal(final.verification.proposals.filter(proposal=>proposal.status==='published').length,2,'Original standard and exactly one maintained successor');
  await assertCandidate(published.candidate,false);
  assert.equal(canonical(store.verification.get('job',failedId)),failedBytes,'Failed job results/proofs remain immutable');const failedPlan=store.verification.get('plan',store.verification.get('job',failedId).planId!);await assertCandidate(failedPlan.candidate,false);assert.equal(await readFile(join(failedPlan.candidate.tree,'result.mjs'),'utf8'),injected);
  const allAuthors=final.jobs.filter(job=>job.purpose==='acceptance-authoring'),maintenanceAuthors=allAuthors.filter(job=>job.id===maintenance.authorJobId),authors=allAuthors,diagnoses=final.jobs.filter(job=>job.purpose==='diagnosis'),inspections=final.jobs.filter(job=>job.purpose==='inspection'),workflowJobs=final.jobs.filter(job=>job.purpose!=='inspection');
  assert.equal(final.loop.authoringProtocol,'acceptance-stages-v2');
  assert.equal(diagnoses.length,1);assert.equal(maintenanceAuthors.length,1);assert.equal(workflowJobs.length,authors.length+1);assert.equal(final.jobs.length,workflowJobs.length+inspections.length);assert.equal(final.loop.reasoningCount,workflowJobs.length+inspections.length);assert.ok(final.loop.reasoningCount<=12);
  const authorRoutes=store.authorRouting.routes(final.loop.id);
  const finalAuthor=maintenanceAuthors[0]!;assert.ok(finalAuthor);
  assert.equal(resolve(published.bundle.root),resolve(join(data,'supervision','authoring',finalAuthor.id)),'Maintained published assets bind the real final author');
  assert.equal(authors.length,1,'Only the real mandatory maintenance author remains; initial assets were supplied');
  assert.equal(authorRoutes.length,0,'This scenario does not claim initial automatic author regeneration');
  assert.ok(authors.every(job=>job.usage!==null));assert.ok(authors.reduce((sum,job)=>sum+job.usage!,0)<=150_000,'Dynamic maintenance author stays inside the original observed allowance');
  for(const job of workflowJobs)await reasoning(job);
  assert.equal(finalAuthor.error,null);
  const maintenanceInput=finalAuthor.input as {context:{acceptance:AcceptanceAuthoringContext;evolution:ControlEvolutionAuthoringContext}};
  assert.ok(maintenanceInput.context.evolution.maintenance);
  assert.deepEqual(maintenanceInput.context.evolution.maintenance.basis,maintenance.basis);
  const maintainedBundle=validateControlEvolutionBundle(finalAuthor.result,maintenanceInput.context.evolution);
  const materializedSpec=structuredClone(maintainedBundle.assets.spec);
  for(const control of materializedSpec.controls)if(maintainedBundle.assets.controls.some(asset=>asset.id===control.id))control.workspace=join(data,'supervision','authoring',finalAuthor.id,'controls',control.id);
  assert.deepEqual(published.spec,materializedSpec,'Maintained published standards bind the strict actual V2 output, changing only host control paths');
  assert.equal(originalPublished.id,suppliedProposal.id,'The original standard is the independently qualified supplied proposal');
  assert.equal(originalPublished.reviewId,suppliedReview.id);
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
  const run=final.runtime.run;assert.ok(run.attempts.every(attempt=>attempt.settled&&attempt.actual!==null&&attempt.status!=='running'));assert.equal(run.budget.spent,run.attempts.reduce((total,attempt)=>total+attempt.actual!,0));assert.ok(run.budget.spent>0&&run.budget.spent<run.budget.limit!);assert.ok(run.operations.every(operation=>operation.status==='confirmed'));assert.ok(run.leases.every(lease=>lease.released));
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
