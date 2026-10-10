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
import type { VerificationSpec } from '../../packages/contracts/p4.js';
import type { Delivery,FrozenPlan,Proposal,VerificationAction,VerificationJob } from '../../packages/verification/records.js';

const execute=promisify(execFile);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const initialGoal='创建最小 Node.js ESM 工程，不联网、不安装依赖，产物只有 math.mjs 与 math.test.mjs。math.mjs 命名导出 sum(a,b)：两个参数都是有限 number 时返回 a+b，否则抛真正 TypeError。math.test.mjs 仅静态导入 node:assert/strict 和 ./math.mjs，用实际断言检查 sum(2,3)=5、sum(-1,1)=0，并对两个参数位置分别传入 NaN、Infinity、-Infinity、字符串时断言 TypeError。测试必须能发现相应错误实现；独立验收会实际直接运行测试，也会通过 ESM 导入同一测试并注入受控错误模块核对其断言。不得依据 import.meta、模块 URL 或直接运行/导入方式改变或省略断言；不得动态导入，两文件不能有其他静态依赖。允许以后在这两个文件增加新函数并保留 sum 全部行为。当前计划恰好一个实现步骤和一条 command 验收 criterion，id=sum、target=math.test.mjs，description/checks 完整表达以上 sum 行为与实际测试要求。不要提问，实际创建两文件并运行 node math.test.mjs；完成实施不是独立交付。';
const addition='现在明确追加新工作：在同一 math.mjs 增加命名导出 multiply(a,b)，有限 number 返回 a*b，否则抛真正 TypeError；math.test.mjs 增加 multiply(3,4)=12、multiply(-2,3)=-6，以及两个参数位置的 NaN、Infinity、-Infinity、字符串 TypeError 断言，并能检测错误乘法实现。保留 sum 全部行为与原验收 criterion 的 id、description、kind、target、checks 逐字不变，不退役任何条款。只增加一条 command criterion id=multiply、target=math.test.mjs；仍只这两个文件和一个实现步骤，保留先前测试依赖/导入限制。开始实施新增乘法，并在最终交付前独立验收。';

/** Same real command-verifier protocol and import-hook mutation technique used by P4/P5 live tests.
 * The positive/negative controls are declared test specimens; the delivered candidate itself is
 * produced by actual Codex planning/execution and never seeded into a succeeded ledger. */
const checker=String.raw`
import assert from 'node:assert/strict';
import { readFile,writeFile,readdir } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { randomUUID,createHash } from 'node:crypto';
const candidate=process.argv[2],parameters=JSON.parse(process.argv[3]),name=parameters.function;
const names=['sum','multiply'],obligationId=parameters.obligation;
const samples={sum:[[2,3,5],[-1,1,0]],multiply:[[3,4,12],[-2,3,-6]]};
const strict='if(typeof a!=="number"||typeof b!=="number"||!Number.isFinite(a)||!Number.isFinite(b))throw new TypeError("Finite numbers required");';
const expression={sum:'a+b',multiply:'a*b'};
const sourceFor=override=>names.map(fn=>'export function '+fn+'(a,b){'+(fn===name?override:strict+'return '+expression[fn]+';')+'}').join('\n');
const trace=[];
async function candidateTest(source,entryMode){
  const moduleUrl=pathToFileURL(join(candidate,'math.mjs')),canonicalTestUrl=pathToFileURL(join(candidate,'math.test.mjs')),testUrl=new URL(canonicalTestUrl);testUrl.searchParams.set('independentCase',randomUUID());
  let strictImported=false,error;const cacheKey=randomUUID(),instrumentation=[],originalArgv=process.argv;
  // Cache identity is separate from the metadata visible to the candidate. The
  // query token is a verifier detail, not a restriction on permitted URL usage.
  // Exercise both direct-entry and ordinary-import main semantics; the actual
  // uninstrumented CLI entry is independently executed by candidateEntries.
  const hook=registerHooks({
    resolve(specifier,context,next){if(specifier==='node:assert/strict'&&context.parentURL&&new URL(context.parentURL).pathname===testUrl.pathname)strictImported=true;const resolved=next(specifier,context),url=new URL(resolved.url);if(url.pathname===moduleUrl.pathname){url.searchParams.set('independentCase',cacheKey);return {...resolved,url:url.href};}return resolved;},
    load(url,context,next){
      const path=new URL(url).pathname,isModule=path===moduleUrl.pathname,isTest=path===testUrl.pathname;if(!isModule&&!isTest)return next(url,context);
      const loaded=isModule&&source!==null?{format:'module',shortCircuit:true,source}:next(url,context);
      const original=typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source).toString('utf8'),canonicalUrl=isTest?canonicalTestUrl.href:moduleUrl.href;
      const prefix='import.meta.url='+JSON.stringify(canonicalUrl)+';import.meta.main='+String(isTest&&entryMode)+';\n';
      // Preserve a legal hashbang before inserting ordinary ESM statements.
      const firstLine=original.match(/^#![^\n]*(?:\n|$)/)?.[0]??'',instrumented=firstLine+prefix+original.slice(firstLine.length);
      const sha=value=>createHash('sha256').update(value).digest('hex');
      instrumentation.push({cacheUrl:url,canonicalUrl,main:isTest&&entryMode,prefix,originalSourceDigest:sha(original),instrumentedSourceDigest:sha(instrumented)});
      return {...loaded,source:instrumented};
    }
  });
  process.argv=entryMode?[process.execPath,join(candidate,'math.test.mjs')]:originalArgv;
  try{await import(testUrl.href);}catch(caught){error=caught;}finally{process.argv=originalArgv;hook.deregister();}
  return {error,strictImported,instrumentation};
}
async function verify(){
  assert.deepEqual((await readdir(candidate)).sort(),['math.mjs','math.test.mjs']);
  const ts=(await import(pathToFileURL(process.env.SUPERVISOR_VERIFY_TYPESCRIPT_MODULE).href)).default;
  for(const filename of ['math.mjs','math.test.mjs']){
    const source=await readFile(join(candidate,filename),'utf8'),file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert.equal(file.parseDiagnostics.length,0);
    function visit(node){
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier){assert.ok(ts.isStringLiteral(node.moduleSpecifier));assert.ok(filename==='math.test.mjs'&&['node:assert/strict','./math.mjs'].includes(node.moduleSpecifier.text));}
      assert.ok(!(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword),'No dynamic loading');ts.forEachChild(node,visit);
    }visit(file);
  }
  const module=await import(pathToFileURL(join(candidate,'math.mjs')).href);assert.equal(typeof module[name],'function');
  for(const [a,b,expected] of samples[name])assert.equal(module[name](a,b),expected);
  for(const value of [NaN,Infinity,-Infinity,'2','',undefined,null,true,false,[],{},2n]){assert.throws(()=>module[name](value,1),TypeError);assert.throws(()=>module[name](1,value),TypeError);}
  const variants=[{id:'original',source:null}];
  for(const [a,b,expected] of samples[name])variants.push({id:'wrong-result-'+a+'-'+b,source:sourceFor(strict+'if(a==='+a+'&&b==='+b+')return '+(expected+1)+';return '+expression[name]+';')});
  for(const position of ['a','b'])for(const [label,predicate] of [['NaN','Number.isNaN('+position+')'],['Infinity',position+'===Infinity'],['negative-Infinity',position+'===-Infinity'],['string','typeof '+position+'==="string"']]){
    variants.push({id:'accept-'+label+'-'+position,source:sourceFor('if('+predicate+')return 123;'+strict+'return '+expression[name]+';')});
    variants.push({id:'wrong-exception-'+label+'-'+position,source:sourceFor('if('+predicate+')throw new RangeError("Wrong exception");'+strict+'return '+expression[name]+';')});
    variants.push({id:'forged-TypeError-'+label+'-'+position,source:sourceFor('if('+predicate+'){const error=new Error("Wrong exception");error.name="TypeError";throw error;}'+strict+'return '+expression[name]+';')});
  }
  for(const entryMode of [true,false])for(const variant of variants){const mode=entryMode?'direct-entry':'ordinary-import',observed=await candidateTest(variant.source,entryMode);const detected=observed.strictImported&&(variant.id==='original'?observed.error===undefined:observed.error instanceof assert.AssertionError);trace.push({id:variant.id,mode,detected,instrumentation:observed.instrumentation,error:observed.error===undefined?null:String(observed.error)});assert.ok(detected,'Actual candidate assertions must detect '+variant.id+' in '+mode+' mode');}
}
let error;try{await verify();}catch(caught){error=String(caught);}
await writeFile(join(dirname(process.env.SUPERVISOR_VERIFY_REPORT),'mutation-trace.json'),JSON.stringify(trace,null,2));
await writeFile(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks:[{obligationId,verdict:error?'failed':'passed',reason:error||'Actual arithmetic, invalid-input, direct-entry and candidate-test mutation assertions passed.'}]}));
process.exitCode=error?1:0;
`;

function controlModule(names:string[],correct:boolean):string{return names.map(name=>`export function ${name}(a,b){${correct?'if(typeof a!=="number"||typeof b!=="number"||!Number.isFinite(a)||!Number.isFinite(b))throw new TypeError("finite numbers");return '+(name==='sum'?'a+b':'a*b')+';':'return 999;'}}`).join('\n');}
function controlTests(names:string[]):string{return `import assert from 'node:assert/strict';import {${names.join(',')}} from './math.mjs';\n`+names.map(name=>`${name==='sum'?'assert.equal(sum(2,3),5);assert.equal(sum(-1,1),0);':'assert.equal(multiply(3,4),12);assert.equal(multiply(-2,3),-6);'}for(const value of [NaN,Infinity,-Infinity,'2']){assert.throws(()=>${name}(value,1),TypeError);assert.throws(()=>${name}(1,value),TypeError);}`).join('\n');}

// One bounded scenario; no conditional skips or fixture delivery substitutes. A
// second full P4 delivery is required, not an optional success-path shortcut.
// Scope: these fixed math control specimens intentionally know both exports in
// advance. This verifies terminal accounting and immutable P4 inheritance for
// this additive scenario; it does not establish general control compatibility
// with arbitrary future requirements, which needs a separate product design.
test('P6 terminal inquiries charge real conversation usage without changing delivered records then independently deliver a linked additive round',{timeout:600_000},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-p6-terminal-live-'))),data=join(root,'data'),workspace=join(root,'project');await mkdir(workspace);
  await execute('git',['init','--quiet'],{cwd:workspace});await execute('git',['-c','user.name=Supervisor Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Terminal inquiry live baseline'],{cwd:workspace});
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','p6-terminal-'+randomUUID());await mkdir(evidence,{recursive:true});
  const deadline=Date.now()+570_000,model=process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol',effort=process.env.SUPERVISOR_LIVE_EFFORT??'low';
  const config={model,effort,reservation:140_000,timeoutMs:120_000},verificationConfig={model,effort,reservation:180_000,timeoutMs:120_000};
  let store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),orchestration=new OrchestrationController(store,data,runtime),conversation=new ConversationController(store,data,runtime),verification=new VerificationController(store,data);
  async function close(){await conversation.close();await orchestration.close();await verification.close();await runtime.close();const owner=await readOwnership(data);if(owner?.identity)assert.equal((await terminateProcess(owner.identity)).stopped,true);store.close();}
  async function save(name:string,value:unknown){await writeFile(join(evidence,name+'.json'),JSON.stringify(value,null,2));}
  async function until<T>(read:()=>T|Promise<T>,done:(value:T)=>boolean,label:string):Promise<T>{for(;;){const value=await read();if(done(value))return value;if(Date.now()>deadline){await save('deadline-'+label,value);throw new Error('Terminal live overall observation deadline: '+label);}await delay(150);}}
  t.after(async()=>{try{await save('final-conversations',store.conversations.list().map(value=>store.conversations.inspect(value.id)));}finally{await close();await cp(root,join(evidence,'runtime'),{recursive:true});t.diagnostic(JSON.stringify({evidence,root}));}});
  await verification.initialize();await orchestration.initialize();await conversation.initialize();
  const started=await orchestration.dispatch({type:'start',commandId:randomUUID(),workspace,goal:initialGoal,tokenLimit:1_600_000,verificationReserve:300_000,...config}) as GoalInspection;
  const ready=await until(()=>store.goals.inspect(started.session.id),value=>value.session.phase!=='thinking','initial-plan');await save('initial-plan',ready);
  assert.equal(ready.session.phase,'ready',ready.session.error??JSON.stringify(ready.session.proposal));assert.deepEqual(ready.session.proposal!.criteria.map(c=>c.id),['sum']);assert.equal(ready.session.proposal!.steps.length,1);
  const admitted=await orchestration.dispatch({type:'admit',commandId:randomUUID(),sessionId:ready.session.id,expectedRevision:ready.session.revision}) as GoalInspection;
  const initialRuntime=admitted.session.runtimeId!,conversationId=store.conversations.ensureForGoal(admitted.session.id).id;
  const inspect=()=>conversation.dispatch({type:'inspect',conversationId}) as Promise<ConversationInspection>;
  async function waitExecution(id:string){const result=await until(()=>store.runtime.inspect(id),value=>['awaiting-verification','blocked','cancelled'].includes(value.runtime.phase),'execution-'+id);await save('execution-'+id,result);assert.equal(result.runtime.phase,'awaiting-verification',result.runtime.error??JSON.stringify(result.operations));await execute(process.execPath,['math.test.mjs'],{cwd:workspace,timeout:10000});return result;}
  await waitExecution(initialRuntime);
  async function v<T>(action:VerificationAction):Promise<T>{return await verification.dispatch(action) as T;}
  async function finished(job:VerificationJob){const result=await until(()=>v<VerificationJob>({type:'job',jobId:job.id}),value=>value.status==='finished','verification-'+job.id);await save(job.id,result);assert.equal(result.stopConfirmed,true,result.error??'Stop missing');assert.equal(result.usageUnknown,false);assert.ok(result.identities.length);for(const identity of result.identities)assert.equal((await inspectProcess(identity)).status,'stopped');return result;}
  async function deliver(id:string,names:string[],round:number){
    const goal=store.goals.inspect(id),criteria=goal.session.proposal!.criteria;assert.deepEqual(criteria.map(c=>c.id).sort(),[...names].sort());
    const bundle=join(root,'definition-'+round),good=join(root,'good'),bad=join(root,'bad'),empty=join(root,'correct-module-empty-tests'),metadata=join(root,'harmless-metadata'),mainOnly=join(root,'main-only-assertions');await mkdir(bundle);
    // Published controls remain byte-identical across both rounds. The valid
    // specimen already includes the allowed additive export; each round tests
    // only its admitted obligations, and the delivered candidate is separate.
    if(round===1){await mkdir(good);await mkdir(bad);await mkdir(empty);await mkdir(metadata);await mkdir(mainOnly);
      await writeFile(join(good,'math.mjs'),controlModule(['sum','multiply'],true));await writeFile(join(good,'math.test.mjs'),controlTests(['sum','multiply']));
      await writeFile(join(metadata,'math.mjs'),'const moduleMetadata={url:import.meta.url,main:import.meta.main};void moduleMetadata;\n'+controlModule(['sum','multiply'],true));
      await writeFile(join(metadata,'math.test.mjs'),controlTests(['sum','multiply'])+'\nconst metadata={url:import.meta.url,main:import.meta.main};console.log(JSON.stringify(metadata));\n');
      await writeFile(join(mainOnly,'math.mjs'),controlModule(['sum','multiply'],true));
      const fullTest=controlTests(['sum','multiply']),importsEnd=fullTest.indexOf('\n')+1;
      await writeFile(join(mainOnly,'math.test.mjs'),fullTest.slice(0,importsEnd)+'if(import.meta.main){\n'+fullTest.slice(importsEnd)+'\n}\n');
      await writeFile(join(empty,'math.mjs'),controlModule(['sum','multiply'],true));await writeFile(join(empty,'math.test.mjs'),'// Correct module but vacuous candidate tests.\n');
      await writeFile(join(bad,'math.mjs'),controlModule(['sum','multiply'],false));await writeFile(join(bad,'math.test.mjs'),'// Deliberately empty negative-control assertions.\n');
    }
    await writeFile(join(bundle,'math-verifier.mjs'),checker);
    const spec:VerificationSpec={schemaVersion:1,contractVersion:goal.run.contract.version,standardsVersion:'terminal-math-v'+round,obligations:criteria.map(c=>({id:'obligation-'+c.id,criterionId:c.id,expectation:[c.description,...c.checks].join('\n'),required:true,applicable:true})),cases:criteria.map(c=>({id:'verify-'+c.id,revision:1,obligationIds:['obligation-'+c.id],parameters:[{function:c.id,obligation:'obligation-'+c.id}],modules:['math'],replaces:[],defectRefs:['WRONG-ARITHMETIC','INVALID-INPUT-ACCEPTED','VACUOUS-CANDIDATE-TEST'],verifier:{kind:'command',version:'terminal-math-v2-metadata-compatible',entry:'math-verifier.mjs',files:['math-verifier.mjs'],candidateEntries:['math.test.mjs'],timeoutMs:15000}})),controls:[{id:'known-correct',workspace:good,expect:'passed',mustFail:[]},{id:'harmless-metadata',workspace:metadata,expect:'passed',mustFail:[]},{id:'main-only-assertions',workspace:mainOnly,expect:'failed',mustFail:['obligation-sum']},{id:'known-wrong-and-empty-tests',workspace:bad,expect:'failed',mustFail:['obligation-sum']},{id:'correct-module-empty-tests',workspace:empty,expect:'failed',mustFail:['obligation-sum']}],moduleDependencies:{}};
    // The sum case, implementation bytes and controls are preserved exactly;
    // round two only adds the multiply obligation and case under new standards.
    const previous=store.verification.head(goal.run.projectId);
    if(previous){for(const oldCase of previous.spec.cases)assert.deepEqual(spec.cases.find(item=>item.id===oldCase.id&&item.revision===oldCase.revision),oldCase);assert.deepEqual(spec.controls,previous.spec.controls);for(const obligation of previous.spec.obligations)assert.deepEqual(spec.obligations.find(item=>item.id===obligation.id),obligation);}
    const specPath=join(bundle,'spec.json');await writeFile(specPath,JSON.stringify(spec,null,2));
    const proposal=await v<Proposal>({type:'propose',commandId:randomUUID(),runtimeId:goal.session.runtimeId!,specPath});
    const review=await finished(await v<VerificationJob>({type:'review',commandId:randomUUID(),proposalId:proposal.id,...verificationConfig}));assert.equal(review.approved,true,review.error??JSON.stringify(review.controls));assert.equal(review.modelStarted,true);assert.ok(review.usage>0);assert.ok(review.controls.every(control=>control.passed));
    for(const controlId of ['known-wrong-and-empty-tests','correct-module-empty-tests','main-only-assertions'])for(const obligation of spec.obligations)assert.ok(review.controls.find(control=>control.id===controlId)!.results.some(result=>result.executionStatus==='executed'&&result.checks.some(check=>check.obligationId===obligation.id&&check.verdict==='failed')));
    const metadataControl=review.controls.find(control=>control.id==='harmless-metadata')!;assert.ok(metadataControl.passed&&metadataControl.results.every(result=>result.executionStatus==='executed'&&result.checks.every(check=>check.verdict==='passed')),'Harmless metadata must pass actual controls');
    const mainControl=review.controls.find(control=>control.id==='main-only-assertions')!;assert.ok(mainControl.results.every(result=>result.checks.some(check=>check.reason.includes('in ordinary-import mode'))),'Main-only tests must fail actual imported-mode mutation assertions');
    const emptyControl=review.controls.find(control=>control.id==='correct-module-empty-tests')!;assert.ok(emptyControl.results.every(result=>result.checks.some(check=>check.reason.includes('Actual candidate assertions must detect original'))),'Correct-module negative control fails actual assertion-presence checks, not arithmetic');
    await v<Proposal>({type:'publish',commandId:randomUUID(),proposalId:proposal.id,reviewId:review.id});
    const plan=await v<FrozenPlan>({type:'freeze',commandId:randomUUID(),runtimeId:goal.session.runtimeId!,mode:'final'});assert.equal(plan.selection.completeScope,true);
    const checked=await finished(await v<VerificationJob>({type:'run',commandId:randomUUID(),planId:plan.id,...verificationConfig}));assert.equal(checked.approved,true,checked.error??JSON.stringify(checked.results));assert.equal(checked.evaluation?.complete,true);assert.equal(checked.results.length,names.length);
    const delivery=await v<Delivery>({type:'deliver',commandId:randomUUID(),jobId:checked.id});assert.equal(store.goals.inspect(id).run.status,'succeeded');await save('delivery-'+round,{spec,proposal,review,plan,checked,delivery});return delivery;
  }
  const firstDelivery=await deliver(admitted.session.id,['sum'],1);
  // This is a read-only snapshot of rows produced by actual controllers, never a
  // direct database mutation or a fabricated completion/delivery fixture.
  function historicalBytes(){const db=new DatabaseSync(join(data,'supervisor.sqlite'),{readOnly:true});try{return JSON.stringify({run:db.prepare('SELECT * FROM runs WHERE project_id=? AND id=?').get(admitted.run.projectId,admitted.run.id),goal:db.prepare('SELECT * FROM goal_sessions WHERE id=?').get(admitted.session.id),runtime:db.prepare('SELECT * FROM runtime_runs WHERE id=?').get(initialRuntime),checkpoints:db.prepare('SELECT * FROM runtime_checkpoints WHERE runtime_id=? ORDER BY rowid').all(initialRuntime),deliveries:db.prepare("SELECT * FROM verification_records WHERE kind='delivery' AND run_id=? ORDER BY rowid").all(admitted.run.id)});}finally{db.close();}}
  const baselineBytes=historicalBytes(),baseline=await inspect();await save('delivered-baseline',baseline);
  async function assertAssessment(job:TerminalAssessmentJob){assert.equal(job.status,'finished');assert.equal(job.settled,true);assert.equal(job.stopConfirmed,true);assert.equal(job.modelStarted,true);assert.ok(job.usage!==null&&job.usage>0);assert.ok(job.identities.length);assert.ok(Object.keys(job.proofs).length);for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');for(const [path,digest] of Object.entries(job.proofs))assert.equal(hash(await readFile(path)),digest);}
  for(const [kind,text] of [['question','现在交付了什么？只解释已完成记录，不要修改要求或启动新工作。'],['unclassified','我只是了解一下当前已交付内容与预算支出，没有追加工作要求。']] as const){
    const commandId=randomUUID();await conversation.dispatch({type:'send',conversationId,commandId,kind,text});await conversation.dispatch({type:'send',conversationId,commandId,kind,text});
    const state=await until(inspect,value=>['answered','failed','clarifying'].includes(value.messages.find(m=>m.commandId===commandId)!.state),'terminal-'+kind);await save('terminal-'+kind,state);
    assert.equal(state.messages.find(m=>m.commandId===commandId)!.state,'answered',JSON.stringify(state.messages));assert.equal(state.messages.filter(m=>m.commandId===commandId).length,1);assert.equal(state.rounds.length,1);assert.equal(state.conversation.activeRunId,admitted.run.id);assert.equal(historicalBytes(),baselineBytes);await assertAssessment(state.assessmentJobs.at(-1)!);
    assert.equal(state.budget.spent,baseline.budget.spent+state.assessmentJobs.reduce((sum,job)=>sum+job.usage!,0));assert.equal(state.budget.reserved,0);
  }
  const beforeRestart=await inspect();await save('before-restart',beforeRestart);await close();
  store=new SupervisorStore(data);runtime=new LocalRuntimeAdapter(store,data);orchestration=new OrchestrationController(store,data,runtime);conversation=new ConversationController(store,data,runtime);verification=new VerificationController(store,data);await verification.initialize();await orchestration.initialize();await conversation.initialize();await conversation.scan();
  assert.deepEqual(await inspect(),beforeRestart,'Restart must not replay finished terminal model work');assert.equal(historicalBytes(),baselineBytes);await save('after-restart',await inspect());
  const changeCommand=randomUUID();await conversation.dispatch({type:'send',conversationId,commandId:changeCommand,kind:'unclassified',text:addition});
  const changed=await until(inspect,value=>['applied','failed','clarifying'].includes(value.messages.find(m=>m.commandId===changeCommand)!.state),'terminal-continuation');await save('additive-applied',changed);
  assert.equal(changed.messages.find(m=>m.commandId===changeCommand)!.state,'applied',JSON.stringify(changed.messages));assert.equal(changed.rounds.length,2);assert.notEqual(changed.active.run.id,admitted.run.id);assert.equal(changed.rounds[1]!.predecessorDeliveryId,firstDelivery.id);assert.equal(historicalBytes(),baselineBytes);
  const assessment=changed.assessmentJobs.at(-1)!;await assertAssessment(assessment);assert.equal(assessment.result?.decision,'continue');assert.equal(assessment.promotion?.childRunId,changed.active.run.id);
  assert.equal(changed.active.run.budget.limit,baseline.budget.limit-baseline.budget.spent-changed.budget.reasoningSpent,'Child authorization deducts all terminal calls including its intent assessment');assert.equal(changed.active.run.budget.verificationReserve,admitted.run.budget.verificationReserve);
  for(const criterion of baseline.active.session.proposal!.criteria)assert.deepEqual(changed.active.session.proposal!.criteria.find(next=>next.id===criterion.id),criterion,'Old criteria must remain byte-for-byte equivalent');
  const replanning=changed.active.session.jobs.find(job=>job.followupResult?.decision==='revise')!;assert.ok((replanning.context as {acceptanceReview?:{approved:boolean}}).acceptanceReview?.approved);assert.ok(Object.keys(replanning.proofs).some(path=>path.includes('-review')));
  await waitExecution(changed.active.session.runtimeId!);await execute(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';import {sum,multiply} from './math.mjs';assert.equal(sum(17,4),21);assert.equal(multiply(9,7),63);for(const f of [sum,multiply])for(const v of [NaN,Infinity,-Infinity,'2']){assert.throws(()=>f(v,1),TypeError);assert.throws(()=>f(1,v),TypeError);}"],{cwd:workspace,timeout:10000});
  const secondDelivery=await deliver(changed.active.session.id,['sum','multiply'],2),final=await inspect();assert.notEqual(secondDelivery.id,firstDelivery.id);assert.equal(historicalBytes(),baselineBytes);assert.equal(final.rounds.length,2);assert.equal(final.budget.reserved,0);
  assert.equal(final.budget.spent,final.budget.rounds.reduce((sum,round)=>sum+round.spent,0)+final.budget.reasoningSpent);assert.ok(final.budget.spent<final.budget.limit);assert.equal(final.budget.reasoningSpent,final.assessmentJobs.reduce((sum,job)=>sum+job.usage!,0));await save('final-two-deliveries',{firstDelivery,secondDelivery,final,historicalRowsUnchanged:true});
});
