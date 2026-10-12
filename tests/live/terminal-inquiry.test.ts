import {SupervisionController} from '../../packages/orchestration/supervision-controller.js';
import type {SupervisionInspection} from '../../packages/contracts/p6-supervision-actions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,realpath,writeFile,readFile,cp } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID,createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { OrchestrationController } from '../../packages/orchestration/controller.js';
import { ConversationController } from '../../packages/orchestration/conversation-controller.js';
import { VerificationController } from '../../packages/verification/controller.js';
import { LocalRuntimeAdapter } from '../../packages/runtime/index.js';
import { readOwnership } from '../../packages/runtime/worker-ownership.js';
import { inspectProcess,terminateProcess } from '../../packages/process-control/index.js';
import type { GoalInspection } from '../../packages/contracts/p5.js';
import type { ConversationInspection } from '../../packages/contracts/p6-actions.js';
import type { TerminalAssessmentJob } from '../../packages/contracts/p6.js';
import type { Delivery } from '../../packages/verification/records.js';

const execute=promisify(execFile);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const initialGoal='创建最小 Node.js ESM 工程，不联网、不安装依赖，产物只有 math.mjs 与 math.test.mjs。math.mjs 命名导出 sum(a,b)：两个参数都是有限 number 时返回 a+b，否则抛真正 TypeError。math.test.mjs 仅静态导入 node:assert/strict 和 ./math.mjs，用实际断言检查 sum(2,3)=5、sum(-1,1)=0，并对两个参数位置分别传入 NaN、Infinity、-Infinity、字符串时断言 TypeError。测试必须能发现相应错误实现；独立验收会实际直接运行测试，也会通过 ESM 导入同一测试并注入受控错误模块核对其断言。不得依据 import.meta、模块 URL 或直接运行/导入方式改变或省略断言；不得动态导入，两文件不能有其他静态依赖。允许以后在这两个文件增加新函数并保留 sum 全部行为。当前计划恰好一个实现步骤和一条 command 验收 criterion，id=sum、target=math.test.mjs，description/checks 完整表达以上 sum 行为与实际测试要求。不要提问，实际创建两文件并运行 node math.test.mjs；完成实施不是独立交付。澄清原有约束：允许读取或打印 import.meta.url/import.meta.main 等无害元数据；禁止的是据此改变或省略断言，不得把这条误写成一律禁止读取元数据。';
const addition='现在明确追加新工作：在同一 math.mjs 增加命名导出 multiply(a,b)，有限 number 返回 a*b，否则抛真正 TypeError；math.test.mjs 增加 multiply(3,4)=12、multiply(-2,3)=-6，以及两个参数位置的 NaN、Infinity、-Infinity、字符串 TypeError 断言，并能检测错误乘法实现。保留 sum 全部行为与原验收 criterion 的 id、description、kind、target、checks 逐字不变，不退役任何条款。只增加一条 command criterion id=multiply、target=math.test.mjs；仍只这两个文件和一个实现步骤，保留先前测试依赖/导入限制。开始实施新增乘法，并在最终交付前独立验收。';

async function modelProof(proofs:Record<string,string>,suffix:string){
  const resultPaths=Object.keys(proofs).filter(p=>p.endsWith(suffix));assert.equal(resultPaths.length,1);
  const path=resultPaths[0]!,directory=path.slice(0,-'result.json'.length),outputPath=directory+'output.txt',eventsPath=directory+'events.jsonl';
  assert.ok(proofs[outputPath]&&proofs[eventsPath]);
  for(const file of [path,outputPath,eventsPath])assert.equal(hash(await readFile(file)),proofs[file]);
  const result=JSON.parse(await readFile(path,'utf8'));
  assert.ok(typeof result.threadId==='string'&&result.threadId.length>0);assert.ok(typeof result.turnId==='string'&&result.turnId.length>0);
  assert.equal(result.modelStarted,true);assert.equal(result.stopConfirmed,true);assert.ok(Number.isSafeInteger(result.usage)&&result.usage>0);
  const raw=await readFile(outputPath,'utf8'),events=(await readFile(eventsPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const completed=events.filter(event=>event.kind==='codex-event'&&event.value?.raw?.method==='turn/completed').map(event=>event.value.raw.params);
  assert.equal(completed.length,1);assert.equal(completed[0].threadId,result.threadId);assert.equal(completed[0].turn.id,result.turnId);assert.equal(completed[0].turn.status,'completed');
  assert.equal(completed[0].turn.items.filter((item:{type:string})=>item.type==='agentMessage').at(-1)?.text,raw);
  const messages=events.filter(event=>event.kind==='codex-event'&&event.value?.raw?.method==='item/completed').map(event=>event.value.raw.params).filter(params=>params.threadId===result.threadId&&params.turnId===result.turnId&&params.item?.type==='agentMessage');
  assert.equal(messages.at(-1)?.item.text,raw);return {result,output:JSON.parse(raw)};
}

// This scenario uses product acceptance authoring for both actual deliveries.
// The v35 hand-authored verifier rejection remains a failed historical run.
test('P6 terminal inquiries charge real conversation usage without changing delivered records then independently deliver a linked additive round',{timeout:3_540_000},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-p6-terminal-live-'))),data=join(root,'data'),workspace=join(root,'project');await mkdir(workspace);
  await execute('git',['init','--quiet'],{cwd:workspace});await execute('git',['-c','user.name=Supervisor Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Terminal inquiry live baseline'],{cwd:workspace});
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','p6-terminal-'+randomUUID());await mkdir(evidence,{recursive:true});
  const deadline=Date.now()+3_480_000,model=process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol',effort=process.env.SUPERVISOR_LIVE_EFFORT??'low';
  const config={model,effort,reservation:140_000,timeoutMs:240_000},verificationConfig={model,effort,reservation:180_000,timeoutMs:240_000};
  let store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),orchestration=new OrchestrationController(store,data,runtime),conversation=new ConversationController(store,data,runtime),verification=new VerificationController(store,data),supervision=new SupervisionController(store,data,runtime,verification);
  async function close(){
    const errors:unknown[]=[];
    for(const stop of [()=>supervision.close(),()=>conversation.close(),()=>orchestration.close(),()=>verification.close(),()=>runtime.close()])try{await stop();}catch(error){errors.push(error);}
    try{const owner=await readOwnership(data);if(owner?.identity)assert.equal((await terminateProcess(owner.identity)).stopped,true);}catch(error){errors.push(error);}
    store.close();if(errors.length)throw new AggregateError(errors,'Terminal controller cleanup failed');
  }
  async function save(name:string,value:unknown){await writeFile(join(evidence,name+'.json'),JSON.stringify(value,null,2));}
  async function until<T>(read:()=>T|Promise<T>,done:(value:T)=>boolean,label:string):Promise<T>{for(;;){const value=await read();if(done(value))return value;if(Date.now()>deadline){await save('deadline-'+label,value);throw new Error('Terminal live overall observation deadline: '+label);}await delay(150);}}
  t.after(async()=>{
    const errors:string[]=[];const safe=async(name:string,fn:()=>Promise<unknown>)=>{try{await fn();}catch(error){errors.push(name+': '+String(error));}};
    await safe('cancel unfinished runtime',async()=>{for(const record of store.runtime.list()){const state=store.runtime.inspect(record.id);if(state.run.status!=='succeeded')await runtime.dispatch({type:'cancel',commandId:randomUUID(),runtimeId:record.id});}});
    await safe('save final conversations',()=>save('final-conversations',store.conversations.list().map(value=>store.conversations.inspect(value.id))));
    await safe('close controllers and worker',close);
    await safe('archive runtime',()=>cp(root,join(evidence,'runtime'),{recursive:true}));
    await save('cleanup-errors',errors);t.diagnostic(JSON.stringify({evidence,root}));assert.deepEqual(errors,[]);
  });
  await verification.initialize();await orchestration.initialize();await conversation.initialize();await supervision.initialize();
  const started=await orchestration.dispatch({type:'start',commandId:randomUUID(),workspace,goal:initialGoal,tokenLimit:1_600_000,verificationReserve:300_000,...config}) as GoalInspection;
  const ready=await until(()=>store.goals.inspect(started.session.id),value=>value.session.phase!=='thinking','initial-plan');await save('initial-plan',ready);
  assert.equal(ready.session.phase,'ready',ready.session.error??JSON.stringify(ready.session.proposal));assert.deepEqual(ready.session.proposal!.criteria.map(c=>c.id),['sum']);assert.equal(ready.session.proposal!.steps.length,1);
  const admitted=await orchestration.dispatch({type:'admit',commandId:randomUUID(),sessionId:ready.session.id,expectedRevision:ready.session.revision}) as GoalInspection;
  const initialRuntime=admitted.session.runtimeId!,conversationId=store.conversations.ensureForGoal(admitted.session.id).id;
  const inspect=()=>conversation.dispatch({type:'inspect',conversationId}) as Promise<ConversationInspection>;
  async function waitExecution(id:string){const result=await until(()=>store.runtime.inspect(id),value=>['awaiting-verification','blocked','cancelled'].includes(value.runtime.phase),'execution-'+id);await save('execution-'+id,result);assert.equal(result.runtime.phase,'awaiting-verification',result.runtime.error??JSON.stringify(result.operations));await execute(process.execPath,['math.test.mjs'],{cwd:workspace,timeout:10000});return result;}
  await waitExecution(initialRuntime);
  async function deliver(id:string,names:string[],round:number):Promise<Delivery>{
    const goal=store.goals.inspect(id);
    assert.deepEqual(goal.session.proposal!.criteria.map(c=>c.id).sort(),[...names].sort());
    const contract=JSON.stringify(goal.run.contract);
    const attached=await supervision.dispatch({type:'attach',commandId:randomUUID(),runtimeId:goal.session.runtimeId!,config:verificationConfig,limits:{maxRepairs:0,maxReasoningCalls:4,maxDurationMs:720_000,maxContextChars:200_000}}) as SupervisionInspection;
    const final=await until(()=>supervision.dispatch({type:'inspect',loopId:attached.loop.id}) as Promise<SupervisionInspection>,v=>v.loop.stopped||['complete','blocked'].includes(v.loop.phase),'automatic-delivery-'+round);
    await save('automatic-delivery-'+round,final);
    assert.equal(final.loop.phase,'complete',final.loop.reason??'Automatic verification did not complete');
    assert.equal(final.runtime.run.status,'succeeded');
    assert.equal(JSON.stringify(final.runtime.run.contract),contract,'Automatic verification cannot change the admitted business requirements');
    const authors=final.jobs.filter(j=>j.purpose==='acceptance-authoring');
    assert.ok(authors.length>0,'Each delivery needs actual product acceptance authoring');
    for(const job of final.jobs){
      assert.equal(job.status,'finished');assert.equal(job.stopConfirmed,true);assert.equal(job.modelStarted,true);assert.ok(job.usage!==null&&job.usage>0);
      for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');
      assert.ok(Object.keys(job.proofs).length>0);assert.ok(job.identities.length);assert.ok(typeof job.threadId==='string'&&job.threadId.length>0);for(const [path,digest]of Object.entries(job.proofs))assert.equal(hash(await readFile(path)),digest);
      const actual=await modelProof(job.proofs,'/result.json');assert.equal(actual.result.threadId,job.threadId);assert.equal(actual.result.usage,job.usage);assert.deepEqual(actual.result.value,job.result);if(!job.error)assert.deepEqual(actual.output,job.result);
    }
    const deliveries=store.verification.list('delivery').filter(d=>d.projectId===goal.run.projectId&&d.runId===goal.run.id);
    assert.equal(deliveries.length,1);const delivery=deliveries[0]!;
    const checked=store.verification.get('job',delivery.jobId);
    const plan=store.verification.get('plan',checked.planId!);
    const proposal=store.verification.get('proposal',checked.proposalId);
    const review=store.verification.get('job',proposal.reviewId!);
    assert.equal(checked.kind,'verification');assert.equal(plan.selection.mode,'final');assert.equal(checked.approved,true);assert.equal(checked.evaluation?.complete,true);assert.equal(plan.selection.completeScope,true);
    assert.equal(review.approved,true);assert.equal(review.modelStarted,true);assert.ok(review.usage>0);const reviewed=await modelProof(review.proofs,'/definition-review/result.json');assert.deepEqual(reviewed.output,{verdict:reviewed.result.verdict,reason:reviewed.result.reason,observations:reviewed.result.observations});assert.equal(reviewed.result.usage,review.usage);assert.ok(authors.every(a=>a.threadId!==reviewed.result.threadId),'Nonempty actual author and reviewer threads must differ');
    assert.ok(checked.evaluation!.obligations.every(o=>o.satisfied));assert.equal(final.runtime.run.attempts.every(a=>a.settled),true);assert.equal(final.runtime.run.operations.every(o=>o.status==='confirmed'),true);assert.equal(final.runtime.run.leases.every(l=>l.released),true);
    for(const job of [review,checked]){
      assert.equal(job.status,'finished');assert.equal(job.stopConfirmed,true);assert.equal(job.usageUnknown,false);
      for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');
      for(const [path,digest]of Object.entries(job.proofs))assert.equal(hash(await readFile(path)),digest);
    }
    await save('delivery-'+round,{proposal,review,plan,checked,delivery});return delivery;
  }
  const firstDelivery=await deliver(admitted.session.id,['sum'],1);
  // This is a read-only snapshot of rows produced by actual controllers, never a
  // direct database mutation or a fabricated completion/delivery fixture.
  function historicalBytes(){const db=new DatabaseSync(join(data,'supervisor.sqlite'),{readOnly:true});try{return JSON.stringify({run:db.prepare('SELECT * FROM runs WHERE project_id=? AND id=?').get(admitted.run.projectId,admitted.run.id),goal:db.prepare('SELECT * FROM goal_sessions WHERE id=?').get(admitted.session.id),runtime:db.prepare('SELECT * FROM runtime_runs WHERE id=?').get(initialRuntime),checkpoints:db.prepare('SELECT * FROM runtime_checkpoints WHERE runtime_id=? ORDER BY rowid').all(initialRuntime),verification:db.prepare("SELECT * FROM verification_records WHERE run_id=? ORDER BY rowid").all(admitted.run.id)});}finally{db.close();}}
  const baselineBytes=historicalBytes(),baseline=await inspect();await save('delivered-baseline',baseline);
  async function assertAssessment(job:TerminalAssessmentJob){assert.equal(job.status,'finished');assert.equal(job.settled,true);assert.equal(job.stopConfirmed,true);assert.equal(job.modelStarted,true);assert.ok(job.usage!==null&&job.usage>0);assert.ok(job.identities.length);assert.ok(Object.keys(job.proofs).length);for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');for(const [path,digest] of Object.entries(job.proofs))assert.equal(hash(await readFile(path)),digest);}
  for(const [kind,text] of [['question','现在交付了什么？只解释已完成记录，不要修改要求或启动新工作。'],['unclassified','我只是了解一下当前已交付内容与预算支出，没有追加工作要求。']] as const){
    const commandId=randomUUID();await conversation.dispatch({type:'send',conversationId,commandId,kind,text});await conversation.dispatch({type:'send',conversationId,commandId,kind,text});
    const state=await until(inspect,value=>['answered','failed','clarifying'].includes(value.messages.find(m=>m.commandId===commandId)!.state),'terminal-'+kind);await save('terminal-'+kind,state);
    assert.equal(state.messages.find(m=>m.commandId===commandId)!.state,'answered',JSON.stringify(state.messages));assert.equal(state.messages.filter(m=>m.commandId===commandId).length,1);assert.equal(state.rounds.length,1);assert.equal(state.conversation.activeRunId,admitted.run.id);assert.equal(historicalBytes(),baselineBytes);await assertAssessment(state.assessmentJobs.at(-1)!);
    assert.equal(state.budget.spent,baseline.budget.spent+state.assessmentJobs.reduce((sum,job)=>sum+job.usage!,0));assert.equal(state.budget.reserved,0);
  }
  const beforeRestart=await inspect();await save('before-restart',beforeRestart);await close();
  store=new SupervisorStore(data);runtime=new LocalRuntimeAdapter(store,data);orchestration=new OrchestrationController(store,data,runtime);conversation=new ConversationController(store,data,runtime);verification=new VerificationController(store,data);supervision=new SupervisionController(store,data,runtime,verification);await verification.initialize();await orchestration.initialize();await conversation.initialize();await supervision.initialize();await conversation.scan();
  assert.deepEqual(await inspect(),beforeRestart,'Restart must not replay finished terminal model work');assert.equal(historicalBytes(),baselineBytes);await save('after-restart',await inspect());
  const changeCommand=randomUUID();await conversation.dispatch({type:'send',conversationId,commandId:changeCommand,kind:'unclassified',text:addition});
  const changed=await until(inspect,value=>['applied','failed','clarifying'].includes(value.messages.find(m=>m.commandId===changeCommand)!.state),'terminal-continuation');await save('additive-applied',changed);
  assert.equal(changed.messages.find(m=>m.commandId===changeCommand)!.state,'applied',JSON.stringify(changed.messages));assert.equal(changed.rounds.length,2);assert.notEqual(changed.active.run.id,admitted.run.id);assert.equal(changed.rounds[1]!.predecessorDeliveryId,firstDelivery.id);assert.equal(historicalBytes(),baselineBytes);
  const assessment=changed.assessmentJobs.at(-1)!;await assertAssessment(assessment);assert.equal(assessment.result?.decision,'continue');assert.equal(assessment.promotion?.childRunId,changed.active.run.id);
  assert.equal(changed.active.run.budget.limit,baseline.budget.limit!-baseline.budget.spent-changed.budget.reasoningSpent,'Child authorization deducts all terminal calls including its intent assessment');assert.equal(changed.active.run.budget.verificationReserve,admitted.run.budget.verificationReserve);
  for(const criterion of baseline.active.session.proposal!.criteria)assert.deepEqual(changed.active.session.proposal!.criteria.find(next=>next.id===criterion.id),criterion,'Old criteria must remain byte-for-byte equivalent');
  const replanning=changed.active.session.jobs.find(job=>job.followupResult?.decision==='revise')!;assert.ok((replanning.context as {acceptanceReview?:{approved:boolean}}).acceptanceReview?.approved);assert.ok(Object.keys(replanning.proofs).some(path=>path.includes('-review')));
  await waitExecution(changed.active.session.runtimeId!);await execute(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';import {sum,multiply} from './math.mjs';assert.equal(sum(17,4),21);assert.equal(multiply(9,7),63);for(const f of [sum,multiply])for(const v of [NaN,Infinity,-Infinity,'2']){assert.throws(()=>f(v,1),TypeError);assert.throws(()=>f(1,v),TypeError);}"],{cwd:workspace,timeout:10000});
  const secondDelivery=await deliver(changed.active.session.id,['sum','multiply'],2),final=await inspect();assert.notEqual(secondDelivery.id,firstDelivery.id);assert.equal(historicalBytes(),baselineBytes);assert.equal(final.rounds.length,2);assert.equal(final.budget.reserved,0);
  assert.equal(final.budget.spent,final.budget.rounds.reduce((sum,round)=>sum+round.spent,0)+final.budget.reasoningSpent);assert.ok(final.budget.spent<final.budget.limit!);assert.equal(final.budget.reasoningSpent,final.assessmentJobs.reduce((sum,job)=>sum+job.usage!,0));await save('final-two-deliveries',{firstDelivery,secondDelivery,final,historicalRowsUnchanged:true});
});
