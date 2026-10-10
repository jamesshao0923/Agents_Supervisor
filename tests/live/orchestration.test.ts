import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readdir,readFile,writeFile,cp,realpath } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash,randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { LocalRuntimeAdapter } from '../../packages/runtime/index.js';
import { OrchestrationController } from '../../packages/orchestration/controller.js';
import { MemoryStore } from '../../packages/context/index.js';
import { inspectProcess,terminateProcess } from '../../packages/process-control/index.js';
import { VerificationController } from '../../packages/verification/controller.js';
import type { VerificationResult,VerificationSpec } from '../../packages/contracts/p4.js';
import type { Delivery,FrozenPlan,Proposal,VerificationAction,VerificationJob } from '../../packages/verification/records.js';
import { readOwnership } from '../../packages/runtime/worker-ownership.js';
import type { GoalInspection,OrchestrationAction } from '../../packages/contracts/p5.js';
const tinyReservedDecodedNames=["require", "eval", "Function", "AsyncFunction", "GeneratorFunction", "process", "globalThis", "global", "module", "exports", "fetch", "WebSocket", "XMLHttpRequest", "EventSource", "Worker", "Deno", "Bun", "Reflect", "Proxy", "constructor", "__proto__", "prototype", "getBuiltinModule", "createRequire", "mainModule", "binding", "_linkedBinding", "dlopen", "_compile", "runInThisContext", "runInNewContext", "compileFunction", "getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getOwnPropertyNames", "defineProperty", "defineProperties", "prepareStackTrace", "captureStackTrace", "getThis", "getFunction", "caller", "callee", "stack", "stackTraceLimit", "toString"];
const broadSumRequest='改为最小 Node.js 本地模块，不需要 UI、颜色或联网。无需进一步提问。我授权在当前目录创建 sum.mjs，导出 sum(a,b)，仅接受有限数字并返回相加结果；非有限数字或非数字抛 TypeError。验收在 sum.test.mjs 使用 node:assert/strict 验证 2+3=5、-1+1=0，以及两个参数位置分别输入 NaN、Infinity、-Infinity 和字符串等非数字时抛 TypeError。sum.test.mjs 本身必须实际执行这些断言并能发现相应错误实现，不能只包含关键词或空断言。只用一个执行步骤创建模块及测试并运行 node sum.test.mjs；独立验收允许在 Node.js 中通过 ESM 导入实际执行同一测试文件，包括用受控错误模块核对这些断言能检测缺陷。不得安装包、网络访问或修改当前目录以外文件。最终产物就是这两个可直接运行的文件。';
const tinySumRequest='本次新场景采用明确的微型标本词法/语法子集，以下全部是事先声明的额外限制，不声称适用于一般 JavaScript：sum.mjs 只能命名导出 sum，不得其他导出，且不得静态导入或再导出；sum.test.mjs 的静态导入/再导出 specifier 解码后仅允许 node:assert/strict 与 ./sum.mjs。两文件须通过固定 TypeScript 6.0.3 的完整 JS parse，任何 parseDiagnostics 均不允许；静态模块 specifier 须为 StringLiteral，不允许 import attributes。每个 Identifier（包括局部绑定、参数、引用和属性标识符）及 AST name/propertyName 的 StringLiteral 或 NoSubstitutionTemplateLiteral 解码后，不得使用以下逐字保留名称：'+JSON.stringify(tinyReservedDecodedNames)+'。同时禁止 import(...)、import.meta、this、with statement、import-equals declaration、export assignment、module declaration、所有 ComputedPropertyName 节点（含解构中的计算键）；ElementAccessExpression 的键只允许 NumericLiteral，或解码后不在上述保留名称表中的 StringLiteral，所有其他键表达式均不允许。两文件不得使用文件系统、源码读取、子进程或网络能力；不得使用上述明确排除的动态加载、反射、stack/函数源码或执行元数据构造，也不能根据直接运行或独立导入来跳过断言。sum.test.mjs 不遍历文件树，文件范围由独立验收负责。\n'+broadSumRequest;
const execute=promisify(execFile);
async function until<T>(fn:()=>T|Promise<T>,ok:(v:T)=>boolean,ms=180000):Promise<T>{const end=Date.now()+ms;for(;;){const x=await fn();if(ok(x))return x;if(Date.now()>end)throw new Error('P5 live observation timed out');await delay(150);}}
test('P5 live Codex clarifies then admits real work and restores a fresh context from text with cumulative budget', {timeout:900000},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-p5-live-'))),data=join(root,'data'),workspace=join(root,'project');await mkdir(workspace);
  await execute('git',['init','--quiet'],{cwd:workspace});await execute('git',['-c','user.name=Supervisor Test','-c','user.email=test@localhost','commit','--allow-empty','-m','P5 baseline'],{cwd:workspace});
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','p5-master-'+randomUUID());await mkdir(evidence,{recursive:true});
  let store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),controller=new OrchestrationController(store,data,runtime);let verification:VerificationController|undefined;await controller.initialize();
  t.after(async()=>{await verification?.close();await controller.close();await runtime.close();const owner=await readOwnership(data);if(owner?.identity)await terminateProcess(owner.identity);store.close();await cp(root,join(evidence,'runtime'),{recursive:true});t.diagnostic(JSON.stringify({evidence,root}));});
  const action=async(a:OrchestrationAction)=>await controller.dispatch(a) as GoalInspection;
  const config={model:process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol',effort:'low',reservation:140000,timeoutMs:150000};
  let x=await action({type:'start',commandId:randomUUID(),workspace,goal:'我想做一个看起来有高级感的应用，目前没有确定业务功能、目标平台和颜色。先帮我明确需求，不要实现。',tokenLimit:1000000,verificationReserve:200000,...config});
  x=await until(()=>store.goals.inspect(x.session.id),v=>v.session.phase!=='thinking');assert.equal(x.session.phase,'clarifying',x.session.error??JSON.stringify(x.session.proposal));assert.ok(x.session.proposal!.questions.length);assert.equal(store.runtime.list().length,0);assert.deepEqual((await readdir(workspace)).filter(p=>!p.startsWith('.')),[]);assert.ok(x.run.budget.spent>0);assert.equal(x.run.admission,'draft');
  const firstThread=x.session.jobs[0]!.threadId;await writeFile(join(evidence,'clarification.json'),JSON.stringify(x,null,2));
  x=await action({type:'answer',commandId:randomUUID(),sessionId:x.session.id,expectedRevision:x.session.revision,text:tinySumRequest});
  x=await until(()=>store.goals.inspect(x.session.id),v=>v.session.phase!=='thinking');assert.equal(x.session.phase,'ready',x.session.error??JSON.stringify(x.session.proposal));assert.ok(x.session.proposal!.criteria.length);assert.equal(store.runtime.list().length,0);assert.deepEqual((await readdir(workspace)).filter(p=>!p.startsWith('.')),[]);assert.notEqual(x.session.jobs.at(-1)!.threadId,firstThread);
  const pre=x.run.budget.spent;await writeFile(join(evidence,'ready.json'),JSON.stringify(x,null,2));
  x=await action({type:'admit',commandId:randomUUID(),sessionId:x.session.id,expectedRevision:x.session.revision});assert.equal(x.run.budget.spent,pre);assert.equal(x.run.admission,'admitted');
  await until(()=>store.runtime.get(x.session.id),v=>v.phase==='awaiting-verification'||v.phase==='blocked',240000);assert.equal(store.runtime.get(x.session.id).phase,'awaiting-verification',JSON.stringify(store.runtime.inspect(x.session.id)));
  const result=await execute(process.execPath,['sum.test.mjs'],{cwd:workspace});assert.equal(result.stderr,'');
  const mod=await import('file://'+join(workspace,'sum.mjs'));assert.equal(mod.sum(2,3),5);assert.equal(mod.sum(-1,1),0);assert.throws(()=>mod.sum(Infinity,2),TypeError);assert.throws(()=>mod.sum('2',3),TypeError);
  const memory=new MemoryStore(workspace,x.session.projectId);let snap=await memory.read();const p=await memory.propose({baseVersion:snap.version,reason:'Record observed failed prior approach and exclude stale style',changes:[{type:'upsert',record:{id:'prior-failure',scope:{level:'project'},kind:'failure',text:'Failure sentinel P5-NUMBER: coercing string input with Number() violated the required TypeError behavior. Preserve strict number validation.',attribution:'explicit',sources:[{kind:'evidence',ref:'acceptance:strict-number'}]}},{type:'upsert',record:{id:'expired-style',scope:{level:'project'},kind:'preference',text:'Use neon orange UI and install a UI package.',attribution:'inferred',sources:[{kind:'model',ref:'old-job'}],validity:{contractVersion:999}}}]});await memory.publish(p.id,p.digest);
  const beforeRestore=store.goals.inspect(x.session.id);await controller.close();await runtime.close();store.close();store=new SupervisorStore(data);runtime=new LocalRuntimeAdapter(store,data);controller=new OrchestrationController(store,data,runtime);await controller.initialize();
  x=await action({type:'restore',commandId:randomUUID(),sessionId:x.session.id,expectedRevision:beforeRestore.session.revision});x=await until(()=>store.goals.inspect(x.session.id),v=>v.session.phase!=='thinking');assert.equal(x.session.phase,'admitted',x.session.error??'restore failed');
  const job=x.session.jobs.at(-1)!;assert.ok(job.proposal);assert.notEqual(job.threadId,firstThread);const response=JSON.stringify(job.proposal);assert.match(response,/TypeError/);assert.match(response,/P5-NUMBER|coerc|强制|类型|字符串/i);assert.match(response,/budget|token|预算|消耗/i);assert.doesNotMatch(response,/neon orange|install a UI package/i);
  const manifest=job.context as {excluded:{id:string;reason:string}[];entries:{id:string}[]};assert.ok(manifest.excluded.some(e=>e.id==='expired-style'));assert.ok(manifest.entries.some(e=>e.id==='prior-failure'));
  assert.equal(x.run.budget.spent,x.run.attempts.reduce((sum,a)=>sum+(a.actual??0),0));assert.ok(x.run.budget.spent>beforeRestore.run.budget.spent);assert.equal(x.run.attempts.filter(a=>a.purpose==='execution').length,store.executionList().length);assert.notEqual(x.run.status,'succeeded');
  await writeFile(join(evidence,'restored.json'),JSON.stringify(x,null,2));
  // Use the actual admitted contract rather than a fabricated independent-acceptance criterion.
  const admitted=store.goals.inspect(x.session.id),criteria=admitted.run.contract.criteria;
  assert.ok(admitted.run.contract.goal.includes('本次新场景采用明确的微型标本词法/语法子集'),'Narrow source restrictions must be explicit in the admitted user contract before checker review');
  assert.ok(criteria.length&&criteria.every(c=>c.required));
  assert.deepEqual(criteria.map(c=>c.id).sort(),admitted.session.proposal!.criteria.map(c=>c.id).sort());
  assert.ok(admitted.session.proposal!.criteria.every(c=>c.kind==='command'&&c.target==='sum.test.mjs'),JSON.stringify(admitted.session.proposal));
  for(const criterion of admitted.session.proposal!.criteria)assert.ok(criteria.find(c=>c.id===criterion.id)?.description.includes(`Acceptance kind: ${criterion.kind}; target: ${criterion.target}`),'Formal contract freezes each generated acceptance kind and target');
  assert.deepEqual((await readdir(workspace)).filter(name=>!['.git','.supervisor'].includes(name)).sort(),['sum.mjs','sum.test.mjs'],'Actual workspace has no installed package or unrelated deliverable');
  const good=join(root,'sum-good-control'),bad=join(root,'sum-bad-control'),empty=join(root,'sum-empty-tests-control'),gaming=join(root,'sum-query-gaming-control'),commentImport=join(root,'sum-comment-import-control'),escapedImport=join(root,'sum-escaped-import-control'),dynamicImport=join(root,'sum-dead-dynamic-import-control'),escapedGood=join(root,'sum-escaped-strict-control'),builtinReference=join(root,'sum-builtin-reference-control'),quotedDestructure=join(root,'sum-quoted-destructure-control'),extraExport=join(root,'sum-extra-export-control'),inverseQuery=join(root,'sum-inverse-query-control'),untypedThrows=join(root,'sum-untyped-throws-control'),bundle=join(root,'sum-verification-definition');
  await Promise.all([good,bad,empty,gaming,commentImport,escapedImport,dynamicImport,escapedGood,builtinReference,quotedDestructure,extraExport,inverseQuery,untypedThrows,bundle].map(path=>mkdir(path)));
  const goodModule='export function sum(a,b){if(typeof a!=="number"||typeof b!=="number"||!Number.isFinite(a)||!Number.isFinite(b))throw new TypeError("Finite numbers required");return a+b;}\n';
  const goodTest='import assert from "node:assert/strict";import {sum} from "./sum.mjs";assert.equal(sum(2,3),5);assert.equal(sum(-1,1),0);for(const invalid of [NaN,Infinity,-Infinity,"1"]){assert.throws(()=>sum(invalid,2),TypeError);assert.throws(()=>sum(2,invalid),TypeError);}\n';
  const emptyTest='import assert from "node:assert/strict";import {sum} from "./sum.mjs";/* Infinity TypeError: words alone prove nothing */assert.ok(true);\n';
  const gamingTest='import assert from "node:assert/strict";import {sum} from "./sum.mjs";const variant=new URL(import.meta.url).searchParams.get("supervisorTestVariant");if(variant&&variant!=="original")throw new assert.AssertionError({message:"Pretend mutant detected without checking sum"});\n';
  await Promise.all([writeFile(join(good,'sum.mjs'),goodModule),writeFile(join(good,'sum.test.mjs'),goodTest),writeFile(join(bad,'sum.mjs'),'export function sum(a,b){return Number(a)*Number(b);}\n'),writeFile(join(bad,'sum.test.mjs'),emptyTest),writeFile(join(bad,'undeclared-package.json'),'{"dependency":"not-authorized"}\n'),writeFile(join(empty,'sum.mjs'),goodModule),writeFile(join(empty,'sum.test.mjs'),emptyTest),writeFile(join(gaming,'sum.mjs'),goodModule),writeFile(join(gaming,'sum.test.mjs'),gamingTest)]);
  const inverseQueryTest=goodTest.replace('assert.equal(sum(2,3),5);','if(import.meta.url.includes("?")){assert.equal(sum(2,3),5);')+'}\n';
  const untypedThrowsTest=goodTest.replaceAll(',TypeError)',')');assert.notEqual(untypedThrowsTest,goodTest);
  await Promise.all([writeFile(join(untypedThrows,'sum.mjs'),goodModule),writeFile(join(untypedThrows,'sum.test.mjs'),untypedThrowsTest)]);
  const scopeControls=[
    {id:'comment-separated-static-filesystem-import',workspace:commentImport,module:goodModule+'import/* separated */{readFile}from/* separated */"node:fs/promises";\n',test:goodTest,expectedImport:'node:fs/promises'},
    {id:'unicode-escaped-static-filesystem-import',workspace:escapedImport,module:goodModule+'import {readFile as extraRead} from "node:\\u0066s/promises";\n',test:goodTest,expectedImport:'node:fs/promises'},
    {id:'dead-branch-dynamic-filesystem-import',workspace:dynamicImport,module:goodModule+'if(false){import/* separated */("node:fs/promises");}\n',test:goodTest,expectedSyntax:'dynamic-import'},
    {id:'dead-branch-process-builtin-reference',workspace:builtinReference,module:goodModule+'if(false){const obtainBuiltin=process["getBuiltinModule"];}\n',test:goodTest,expectedSyntax:'reserved-identifier'},
    {id:'dead-branch-quoted-constructor-destructure',workspace:quotedDestructure,module:goodModule+'if(false){const {"constructor": makeFunction}=sum;}\n',test:goodTest,expectedSyntax:'reserved-quoted-name'},
    {id:'correct-sum-with-unauthorized-extra-export',workspace:extraExport,module:goodModule+'export const extra=true;\n',test:goodTest,expectedExport:'extra'},
    {id:'genuine-assertions-only-for-queried-import',workspace:inverseQuery,module:goodModule,test:inverseQueryTest,expectedSyntax:'execution-metadata'},
  ];
  for(const control of scopeControls)await Promise.all([writeFile(join(control.workspace,'sum.mjs'),control.module),writeFile(join(control.workspace,'sum.test.mjs'),control.test)]);
  const escapedStrictTest=goodTest.replace('node:assert/strict','node:\\u0061ssert/strict')+'// todo: example text\n';
  await Promise.all([writeFile(join(escapedGood,'sum.mjs'),goodModule),writeFile(join(escapedGood,'sum.test.mjs'),escapedStrictTest)]);
  const groups=['normal','invalid','artifacts','scope'] as const;
  const explanations={normal:'sum is exported and returns exactly 5 for (2,3), 0 for (-1,1), 4 for (1.25,2.75), and -9 for (-4,-5).',invalid:'Infinity, -Infinity, NaN and non-numeric values in either argument raise TypeError; string coercion is prohibited.',artifacts:'Both sum.mjs and sum.test.mjs are actual regular ESM files. The independent engine directly executes node sum.mjs and node sum.test.mjs as separately managed read-only processes on the frozen candidate copy: both must actually exit 0 with verified stops and entry digests. The candidate test uses node:assert/strict, passes against the actual module, and must additionally reject precise wrong-result and missing TypeError mutants, including NaN/Infinity/-Infinity/string at both argument positions, via genuine AssertionError when the same test is actually executed through controlled ESM imports. Mutation checks supplement the direct Node entry executions.',scope:'The delivered tree contains exactly sum.mjs and sum.test.mjs, with no packages, unrelated files or imports of network/subprocess/filesystem APIs; runtime control metadata is separately excluded. Fixed TypeScript 6.0.3 parses both full JavaScript files, rejects parse diagnostics, and audits decoded static import and re-export specifiers: sum.mjs has no dependencies and sum.test.mjs permits only node:assert/strict and ./sum.mjs. The actual sum.mjs ESM namespace must expose only the named sum export. The user explicitly predeclared the exact reserved decoded name list for every Identifier, including harmless local bindings, and quoted AST name/propertyName fields, plus the complete disallowed syntax subset and permitted element-access key forms. The checker enforces that exact lexical policy, including dead branches, aliases and destructuring, rather than classifying otherwise unrestricted JavaScript semantically. import.meta and the explicitly reserved stack/source names are excluded by that prior policy. This audit is valid only for the user-declared tiny subset and supplements actual read-only, no-network, no-subprocess Node execution.'};
  const obligations=criteria.flatMap((criterion,index)=>groups.map(group=>({id:`goal-${index+1}-${group}`,criterionId:criterion.id,required:true,applicable:true,expectation:`Preserve the complete admitted criterion verbatim: ${criterion.description}\nNecessary component of the explicitly requested sum deliverable: ${explanations[group]}`})));
  const groupIds=Object.fromEntries(groups.map(group=>[group,obligations.filter(o=>o.id.endsWith('-'+group)).map(o=>o.id)]));
  const verifierSource=`import assert from 'node:assert/strict';
import { readdir,readFile,lstat,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { createHash,randomInt,randomUUID } from 'node:crypto';
const candidate=process.argv[2],parameters=JSON.parse(process.argv[3]);
const groupIds=${JSON.stringify(groupIds)};
assert.ok(Object.hasOwn(groupIds,parameters.group),'Unknown frozen assertion group');
const mutationTrace=[];
async function executeCandidateTests(variant){
  const moduleUrl=pathToFileURL(join(candidate,'sum.mjs'));
  const testUrl=pathToFileURL(join(candidate,'sum.test.mjs'));testUrl.searchParams.set('supervisorExecution',randomUUID());
  const moduleKey=randomUUID();let strictImported=false,error;
  const hook=registerHooks({
    resolve(specifier,context,nextResolve){if(specifier==='node:assert/strict'&&context.parentURL&&new URL(context.parentURL).pathname===testUrl.pathname)strictImported=true;const resolved=nextResolve(specifier,context);const url=new URL(resolved.url);if(url.pathname===moduleUrl.pathname){url.searchParams.set('supervisorExecution',moduleKey);return {...resolved,url:url.href};}return resolved;},
    load(url,context,nextLoad){const parsed=new URL(url);if(parsed.pathname===moduleUrl.pathname&&variant.source!==null)return {format:'module',shortCircuit:true,source:variant.source};return nextLoad(url,context);},
  });
  try{await import(testUrl.href);}catch(observed){error=observed;}finally{hook.deregister();}
  return {error,strictImported};
}
async function verifyTestDetection(){
  const strict='if(typeof a!=="number"||typeof b!=="number"||!Number.isFinite(a)||!Number.isFinite(b))throw new TypeError("Finite numbers required");';
  const variants=[{id:'original',source:null},{id:'wrong-positive-sum',source:'export function sum(a,b){'+strict+'if(a===2&&b===3)return 6;return a+b;}'},{id:'wrong-negative-sum',source:'export function sum(a,b){'+strict+'if(a===-1&&b===1)return 1;return a+b;}'}];
  for(const position of ['a','b'])for(const [name,predicate]of [['NaN','Number.isNaN('+position+')'],['Infinity',position+'===Infinity'],['negative-Infinity',position+'===-Infinity'],['string','typeof '+position+'==="string"']]){
    variants.push({id:'accept-'+name+'-'+position,source:'export function sum(a,b){if('+predicate+')return 123;'+strict+'return a+b;}'});
    variants.push({id:'wrong-RangeError-'+name+'-'+position,source:'export function sum(a,b){if('+predicate+')throw new RangeError("Wrong exception type");'+strict+'return a+b;}'});
    variants.push({id:'forged-TypeError-'+name+'-'+position,source:'export function sum(a,b){if('+predicate+'){const error=new Error("Wrong exception type with forged name");error.name="TypeError";throw error;}'+strict+'return a+b;}'});
  }
  for(let index=variants.length-1;index>0;index--){const other=randomInt(index+1);[variants[index],variants[other]]=[variants[other],variants[index]];}
  for(const variant of variants){
    const {error,strictImported}=await executeCandidateTests(variant);
    const passed=strictImported&&(variant.id==='original'?error===undefined:error instanceof assert.AssertionError);
    mutationTrace.push({id:variant.id,expected:variant.id==='original'?'passes actual assertions':'rejected by actual AssertionError',observed:error===undefined?'passed':String(error),strictImported,detected:passed});
    assert.ok(passed,'Candidate test failed mutation control '+variant.id+': '+JSON.stringify(mutationTrace));
  }
}
const scopeTrace={parser:null,files:[],exports:null};
async function auditScope(){
  assert.deepEqual((await readdir(candidate)).sort(),['sum.mjs','sum.test.mjs']);
  const parserPath=process.env.SUPERVISOR_VERIFY_TYPESCRIPT_MODULE;assert.ok(parserPath,'Fixed read-only TypeScript parser capability is required');
  const ts=(await import(pathToFileURL(parserPath).href)).default;assert.equal(ts.version,'6.0.3');
  scopeTrace.parser={version:ts.version,modulePath:parserPath,moduleDigest:createHash('sha256').update(await readFile(parserPath)).digest('hex')};
  const forbiddenIdentifiers=new Set(${JSON.stringify(tinyReservedDecodedNames)});
  for(const name of ['sum.mjs','sum.test.mjs']){
    const source=await readFile(join(candidate,name),'utf8'),file=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const trace={file:name,sourceDigest:createHash('sha256').update(source).digest('hex'),diagnostics:[],imports:[],forbidden:[]};scopeTrace.files.push(trace);
    const position=start=>{const point=file.getLineAndCharacterOfPosition(start);return {start,line:point.line+1,column:point.character+1};};
    trace.diagnostics=file.parseDiagnostics.map(diagnostic=>({code:diagnostic.code,message:ts.flattenDiagnosticMessageText(diagnostic.messageText,' '),...position(diagnostic.start??0),length:diagnostic.length??0}));
    const allowed=name==='sum.mjs'?[]:['node:assert/strict','./sum.mjs'];
    const reject=(node,syntax,reason)=>trace.forbidden.push({syntax,kind:ts.SyntaxKind[node.kind],text:node.getText(file),...position(node.getStart(file)),end:node.end,reason});
    const recordImport=(node,kind)=>{
      const specifier=node.moduleSpecifier;
      if(!specifier||!ts.isStringLiteral(specifier)){reject(node,'nonliteral-static-specifier','Static dependencies must have literal decoded module specifiers');return;}
      trace.imports.push({kind,specifier:specifier.text,allowed:allowed.includes(specifier.text),...position(specifier.getStart(file)),end:specifier.end});
      if(node.attributes)reject(node,'import-attributes','Import attributes are outside the two-file dependency policy');
    };
    const visit=node=>{
      if(ts.isImportDeclaration(node))recordImport(node,'import');
      if(ts.isExportDeclaration(node)&&node.moduleSpecifier)recordImport(node,'reexport');
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)reject(node,'dynamic-import','Dynamic module loading is forbidden, including unreachable branches');
      if(ts.isMetaProperty(node)&&node.keywordToken===ts.SyntaxKind.ImportKeyword)reject(node,'execution-metadata','Candidate assertions may not branch on import.meta execution context');
      if(ts.isIdentifier(node)&&forbiddenIdentifiers.has(node.text))reject(node,'reserved-identifier','Decoded Identifier is in the user-declared reserved name list, regardless of binding role');
      for(const propertyName of [node.name,node.propertyName])if(propertyName&&(ts.isStringLiteral(propertyName)||ts.isNoSubstitutionTemplateLiteral(propertyName))&&forbiddenIdentifiers.has(propertyName.text))reject(propertyName,'reserved-quoted-name','Decoded quoted name or propertyName is in the user-declared reserved name list');
      if(ts.isElementAccessExpression(node)){
        const key=node.argumentExpression;
        const numeric=key&&ts.isNumericLiteral(key),literalSafe=key&&ts.isStringLiteral(key)&&!forbiddenIdentifiers.has(key.text);
        if(!numeric&&!literalSafe)reject(node,'computed-capability','Opaque or loading-related computed property access is outside the bounded dependency policy');
      }
      if(ts.isComputedPropertyName(node))reject(node,'computed-property','Computed property definitions are outside the bounded dependency policy');
      if(node.kind===ts.SyntaxKind.ThisKeyword||node.kind===ts.SyntaxKind.WithStatement||ts.isImportEqualsDeclaration(node)||ts.isExportAssignment(node)||ts.isModuleDeclaration(node))reject(node,'ambient-or-non-esm-syntax','Ambient receiver scopes or non-ESM module loading syntax are forbidden');
      ts.forEachChild(node,visit);
    };
    visit(file);
  }
  assert.ok(scopeTrace.files.every(file=>file.diagnostics.length===0&&file.imports.every(dependency=>dependency.allowed)&&file.forbidden.length===0),'Actual parsed dependency or loading syntax violates the frozen file scope');
  const actualModule=await import(pathToFileURL(join(candidate,'sum.mjs')).href);scopeTrace.exports=Object.keys(actualModule).sort();assert.deepEqual(scopeTrace.exports,['sum'],'The actual ESM namespace must contain only the required named sum export');
}
const actions={
  normal:async()=>{const mod=await import(pathToFileURL(join(candidate,'sum.mjs')).href);assert.equal(typeof mod.sum,'function');for(const [a,b,expected]of [[2,3,5],[-1,1,0],[1.25,2.75,4],[-4,-5,-9]])assert.equal(mod.sum(a,b),expected);},
  invalid:async()=>{const mod=await import(pathToFileURL(join(candidate,'sum.mjs')).href);for(const value of [Infinity,-Infinity,NaN,'2','',undefined,null,true,false,[],{},2n,Symbol('number')]){assert.throws(()=>mod.sum(value,3),TypeError);assert.throws(()=>mod.sum(2,value),TypeError);}},
  artifacts:async()=>{for(const name of ['sum.mjs','sum.test.mjs'])assert.ok((await lstat(join(candidate,name))).isFile());await verifyTestDetection();},
  scope:auditScope,
};
let verdict='passed',reason='Actual strict '+parameters.group+' assertions passed';
try{await actions[parameters.group]();}catch(error){verdict='failed';reason='Actual strict '+parameters.group+' assertions failed: '+String(error);}
if(parameters.group==='artifacts')reason+='; actual Node ESM mutation trace: '+JSON.stringify(mutationTrace);
if(parameters.group==='scope')reason+='; actual TypeScript AST scope trace: '+JSON.stringify(scopeTrace);
const checks=groupIds[parameters.group].map(obligationId=>({obligationId,verdict,reason}));
await writeFile(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks}));
process.exitCode=verdict==='failed'?1:0;
`;
  await writeFile(join(bundle,'sum-verifier.mjs'),verifierSource);
  const spec:VerificationSpec={schemaVersion:1,contractVersion:admitted.run.contract.version,standardsVersion:'p5-admitted-sum-v4',obligations,cases:groups.map(group=>({id:'sum-'+group,revision:1,obligationIds:groupIds[group]!,parameters:[{group}],modules:['sum'],replaces:[],defectRefs:['WRONG-SUM','STRING-COERCION','UNTESTED-TYPEERROR','VACUOUS-TESTS','UNAUTHORIZED-DELIVERABLE'],verifier:{kind:'command',version:'sum-goal-assertions-v5',entry:'sum-verifier.mjs',files:['sum-verifier.mjs'],timeoutMs:10000,...(group==='artifacts'?{candidateEntries:['sum.mjs','sum.test.mjs']}:{})}})),controls:[{id:'known-correct-sum-and-tests',workspace:good,expect:'passed',mustFail:[]},{id:'known-wrong-sum-type-tests-and-scope',workspace:bad,expect:'failed',mustFail:obligations.map(o=>o.id)},{id:'correct-module-with-vacuous-user-tests',workspace:empty,expect:'failed',mustFail:groupIds.artifacts!},{id:'correct-module-with-query-gaming-tests',workspace:gaming,expect:'failed',mustFail:[...groupIds.artifacts!,...groupIds.scope!]},...scopeControls.map(control=>({id:control.id,workspace:control.workspace,expect:'failed' as const,mustFail:groupIds.scope!})),{id:'unicode-escaped-strict-import-is-allowed',workspace:escapedGood,expect:'passed',mustFail:[]},{id:'genuine-assertions-without-required-exception-type',workspace:untypedThrows,expect:'failed',mustFail:groupIds.artifacts!}],moduleDependencies:{}};
  const specPath=join(bundle,'spec.json');await writeFile(specPath,JSON.stringify(spec,null,2));
  assert.deepEqual([...new Set(spec.obligations.map(o=>o.criterionId))].sort(),criteria.map(c=>c.id).sort(),'Every actual generated criterion retains necessary independent executable coverage');
  const assertDirectEntries=async(results:VerificationResult[],sourceRoot:string)=>{
    const artifacts=results.find(result=>result.checks.some(check=>check.obligationId.endsWith('-artifacts')));assert.ok(artifacts,'Actual artifacts execution result is required');
    const configurations=artifacts.proofFiles?.filter(path=>/\/candidate-entries\/entry-\d+\/configuration\.json$/.test(path))??[];assert.equal(configurations.length,2,'Both frozen candidate entries have actual process configuration evidence');
    const seen:string[]=[];
    for(const path of configurations){
      const configuration=JSON.parse(await readFile(path,'utf8')) as {entry:string;entryDigest:string};assert.ok(['sum.mjs','sum.test.mjs'].includes(configuration.entry));seen.push(configuration.entry);
      assert.equal(configuration.entryDigest,createHash('sha256').update(await readFile(join(sourceRoot,configuration.entry))).digest('hex'),'Direct Node execution is bound to the actual candidate entry bytes');
      const processPath=join(dirname(path),'process.json');assert.ok(artifacts.proofFiles?.includes(processPath));
      const process=JSON.parse(await readFile(processPath,'utf8')) as {exitCode:number|null;stopped:boolean;reason:string};assert.equal(process.exitCode,0);assert.equal(process.stopped,true);assert.equal(process.reason,'completed');
    }
    assert.deepEqual(seen.sort(),['sum.mjs','sum.test.mjs']);
  };
  const readScopeTrace=async(results:VerificationResult[],sourceRoot:string)=>{
    const scope=results.find(result=>result.checks.some(check=>check.obligationId.endsWith('-scope')));assert.ok(scope,'Actual AST scope execution result is required');
    const marker='; actual TypeScript AST scope trace: ',reason=scope.checks[0]!.reason;assert.ok(reason.includes(marker),'Frozen report preserves the actual parser trace');
    const trace=JSON.parse(reason.slice(reason.lastIndexOf(marker)+marker.length)) as {exports:string[]|null;parser:{version:string;modulePath:string;moduleDigest:string};files:{file:string;sourceDigest:string;diagnostics:unknown[];imports:{kind:string;specifier:string;allowed:boolean;start:number;line:number;column:number}[];forbidden:{syntax:string;text:string;start:number;line:number;column:number}[]}[]};
    assert.equal(trace.parser.version,'6.0.3');assert.match(trace.parser.moduleDigest,/^[a-f0-9]{64}$/);assert.deepEqual(trace.files.map(file=>file.file).sort(),['sum.mjs','sum.test.mjs']);
    const parserProofPath=scope.proofFiles?.find(path=>path.endsWith('/parser-runtime.json'));assert.ok(parserProofPath,'Independent engine proof binds the fixed read-only parser');
    const parserProof=JSON.parse(await readFile(parserProofPath,'utf8')) as {version:string;module:string;moduleDigest:string;grant:string};assert.equal(parserProof.version,trace.parser.version);assert.equal(parserProof.module,trace.parser.modulePath);assert.equal(parserProof.moduleDigest,trace.parser.moduleDigest);assert.equal(parserProof.grant,'read-only');
    assert.equal(trace.parser.moduleDigest,createHash('sha256').update(await readFile(parserProof.module)).digest('hex'),'Parser trace is tied to the actual fixed dependency bytes');
    for(const file of trace.files){assert.equal(file.sourceDigest,createHash('sha256').update(await readFile(join(sourceRoot,file.file))).digest('hex'));assert.deepEqual(file.diagnostics,[]);for(const observation of [...file.imports,...file.forbidden]){assert.ok(Number.isSafeInteger(observation.start)&&observation.start>=0);assert.ok(observation.line>=1&&observation.column>=1);}}
    return trace;
  };
  const readMutationTrace=(results:VerificationResult[])=>{
    const artifacts=results.find(result=>result.checks.some(check=>check.obligationId.endsWith('-artifacts')));assert.ok(artifacts);const marker='; actual Node ESM mutation trace: ',reason=artifacts.checks[0]!.reason;assert.ok(reason.includes(marker));
    return JSON.parse(reason.slice(reason.lastIndexOf(marker)+marker.length)) as {id:string;observed:string;strictImported:boolean;detected:boolean}[];
  };
  const beforeVerification=store.goals.inspect(x.session.id).run;
  verification=new VerificationController(store,data);await verification.initialize();
  const verify=async<T>(a:VerificationAction)=>await verification!.dispatch(a) as T;
  const finished=async(j:VerificationJob)=>{const complete=await until(()=>verify<VerificationJob>({type:'job',jobId:j.id}),v=>v.status==='finished',300000);await writeFile(join(evidence,complete.id+'.json'),JSON.stringify(complete,null,2));return complete;};
  const stopped=async(j:VerificationJob)=>{assert.equal(j.stopConfirmed,true,j.error??'Verifier stop unresolved');assert.equal(j.usageUnknown,false);assert.equal(j.intents.length,j.identities.length);assert.ok(j.identities.length);for(const identity of j.identities)assert.equal((await inspectProcess(identity)).status,'stopped');const attempt=store.goals.inspect(x.session.id).run.attempts.find(a=>a.id===j.attemptId)!;assert.equal(attempt.settled,true);assert.equal(attempt.actual,j.usage);assert.equal(j.projectId,x.session.projectId);assert.equal(j.runId,x.session.id);};
  const verificationConfig={model:config.model,effort:'low',reservation:180000,timeoutMs:240000};
  const proposed=await verify<Proposal>({type:'propose',commandId:randomUUID(),runtimeId:x.session.runtimeId!,specPath});assert.equal(proposed.runId,x.session.id);assert.equal(proposed.spec.contractVersion,admitted.run.contract.version);
  const review=await finished(await verify<VerificationJob>({type:'review',commandId:randomUUID(),proposalId:proposed.id,...verificationConfig}));await stopped(review);
  assert.equal(review.approved,true,JSON.stringify({error:review.error,controls:review.controls}));assert.equal(review.controls.length,13);assert.ok(review.controls.every(c=>c.passed));assert.ok(review.modelStarted&&review.usage>0);
  await assertDirectEntries(review.controls.find(c=>c.id==='known-correct-sum-and-tests')!.results,good);
  const positiveMutationTrace=readMutationTrace(review.controls.find(control=>control.id==='known-correct-sum-and-tests')!.results);assert.equal(positiveMutationTrace.length,27);assert.ok(positiveMutationTrace.every(variant=>variant.detected&&variant.strictImported));
  for(const position of ['a','b'])for(const name of ['NaN','Infinity','negative-Infinity','string'])for(const exception of ['wrong-RangeError','forged-TypeError'])assert.ok(positiveMutationTrace.some(variant=>variant.id===exception+'-'+name+'-'+position&&variant.detected),'Actual candidate test rejects wrong exception identity at each invalid-input position');
  const untypedControl=review.controls.find(control=>control.id==='genuine-assertions-without-required-exception-type')!;await assertDirectEntries(untypedControl.results,untypedThrows);
  assert.ok(untypedControl.results.flatMap(result=>result.checks).filter(check=>!check.obligationId.endsWith('-artifacts')).every(check=>check.verdict==='passed'),'Correct module, scope and genuine arithmetic tests cannot compensate for missing TypeError matchers');
  for(const id of groupIds.artifacts!)assert.ok(untypedControl.results.some(result=>result.executionStatus==='executed'&&result.checks.some(check=>check.obligationId===id&&check.verdict==='failed')),id);
  const survivedException=readMutationTrace(untypedControl.results).at(-1)!;assert.ok(survivedException.id.startsWith('wrong-RangeError-')||survivedException.id.startsWith('forged-TypeError-'));assert.equal(survivedException.observed,'passed');assert.equal(survivedException.strictImported,true);assert.equal(survivedException.detected,false,'Genuine untyped assert.throws survives an actual wrong exception mutant and is rejected');
  const vacuous=review.controls.find(c=>c.id==='correct-module-with-vacuous-user-tests')!;
  await assertDirectEntries(vacuous.results,empty);
  assert.ok(vacuous.results.flatMap(r=>r.checks).filter(c=>!c.obligationId.endsWith('-artifacts')).every(c=>c.verdict==='passed'),'Correct module and file scope pass while the actual empty user tests are independently rejected');
  for(const id of groupIds.artifacts!)assert.ok(vacuous.results.some(r=>r.executionStatus==='executed'&&r.checks.some(c=>c.obligationId===id&&c.verdict==='failed')),id);
  const gamingControl=review.controls.find(c=>c.id==='correct-module-with-query-gaming-tests')!;
  await assertDirectEntries(gamingControl.results,gaming);
  assert.ok(gamingControl.results.flatMap(result=>result.checks).filter(check=>!check.obligationId.endsWith('-artifacts')&&!check.obligationId.endsWith('-scope')).every(check=>check.verdict==='passed'),'Old query-aware fake assertions retain correct arithmetic and invalid-input behavior while their test coverage and execution-metadata access are rejected');
  for(const id of groupIds.artifacts!)assert.ok(gamingControl.results.some(result=>result.executionStatus==='executed'&&result.checks.some(check=>check.obligationId===id&&check.verdict==='failed')),id);
  for(const id of groupIds.scope!)assert.ok(gamingControl.results.some(result=>result.executionStatus==='executed'&&result.checks.some(check=>check.obligationId===id&&check.verdict==='failed')),id);
  const gamingTrace=await readScopeTrace(gamingControl.results,gaming);assert.ok(gamingTrace.files.some(file=>file.forbidden.some(syntax=>syntax.syntax==='execution-metadata')));
  for(const fixture of scopeControls){
    const control=review.controls.find(control=>control.id===fixture.id)!;await assertDirectEntries(control.results,fixture.workspace);
    assert.ok(control.results.flatMap(result=>result.checks).filter(check=>!check.obligationId.endsWith('-scope')).every(check=>check.verdict==='passed'),'Each lexical/loading defect independently fails only the AST scope obligation: '+fixture.id);
    for(const id of groupIds.scope!)assert.ok(control.results.some(result=>result.executionStatus==='executed'&&result.checks.some(check=>check.obligationId===id&&check.verdict==='failed')),id);
    const trace=await readScopeTrace(control.results,fixture.workspace);
    if(fixture.expectedImport)assert.ok(trace.files.some(file=>file.imports.some(dependency=>dependency.specifier===fixture.expectedImport&&dependency.allowed===false)),fixture.id+' rejects the actual decoded filesystem specifier');
    if(fixture.expectedSyntax)assert.ok(trace.files.some(file=>file.forbidden.some(syntax=>syntax.syntax===fixture.expectedSyntax)),fixture.id+' records the actual parsed loading syntax');
    if(fixture.expectedExport)assert.deepEqual(trace.exports,['extra','sum'],'Correct sum behavior cannot hide an actual unauthorized ESM namespace export');
  }
  const escapedPositive=review.controls.find(control=>control.id==='unicode-escaped-strict-import-is-allowed')!;await assertDirectEntries(escapedPositive.results,escapedGood);
  assert.ok(escapedPositive.results.every(result=>result.executionStatus==='executed'&&result.checks.every(check=>check.verdict==='passed')),'Legitimate Unicode escape spelling preserves strict import and all executable assertions');
  const escapedTrace=await readScopeTrace(escapedPositive.results,escapedGood);
  assert.ok(escapedTrace.files.some(file=>file.file==='sum.test.mjs'&&file.imports.some(dependency=>dependency.specifier==='node:assert/strict'&&dependency.allowed===true)),'AST allowlist uses the decoded legitimate strict specifier');
  const negative=review.controls.find(c=>c.id==='known-wrong-sum-type-tests-and-scope')!;
  for(const obligation of spec.obligations)assert.ok(negative.results.some(r=>r.executionStatus==='executed'&&r.checks.some(c=>c.obligationId===obligation.id&&c.verdict==='failed')),obligation.id);
  const reviewResultPath=Object.keys(review.proofs).find(path=>path.endsWith('/definition-review/result.json'));assert.ok(reviewResultPath);
  const independent=JSON.parse(await readFile(reviewResultPath,'utf8')) as {threadId:string};assert.ok(independent.threadId);assert.ok(x.session.jobs.every(j=>j.threadId!==independent.threadId));assert.ok(store.executionList().every(e=>e.threadId!==independent.threadId),'Acceptance review runs in a separate actual model context');
  const published=await verify<Proposal>({type:'publish',commandId:randomUUID(),proposalId:proposed.id,reviewId:review.id});assert.equal(published.version,1);
  const plan=await verify<FrozenPlan>({type:'freeze',commandId:randomUUID(),runtimeId:x.session.runtimeId!,mode:'final'});assert.equal(plan.selection.completeScope,true);assert.equal(plan.selection.instances.length,4);
  const checked=await finished(await verify<VerificationJob>({type:'run',commandId:randomUUID(),planId:plan.id,...verificationConfig}));await stopped(checked);assert.equal(checked.approved,true,checked.error??JSON.stringify(checked.results));assert.equal(checked.evaluation?.complete,true);assert.equal(checked.modelStarted,false);assert.equal(checked.usage,0,'Fixed machine assertions create no fabricated model usage');
  await assertDirectEntries(checked.results,workspace);
  await readScopeTrace(checked.results,workspace);
  const delivery=await verify<Delivery>({type:'deliver',commandId:randomUUID(),jobId:checked.id});assert.equal(delivery.runId,x.session.id);
  const delivered=store.goals.inspect(x.session.id).run;
  assert.equal(delivered.status,'succeeded');assert.equal(store.runtime.inspect(x.session.runtimeId!).run.id,delivered.id);assert.equal(store.runtime.inspect(x.session.runtimeId!).run.budget.spent,delivered.budget.spent);
  assert.equal(delivered.budget.spent,beforeVerification.budget.spent+review.usage+checked.usage,'Requirement, execution, restore, definition review and final verification use the same cumulative ledger');
  assert.equal(delivered.budget.spent,delivered.attempts.reduce((sum,a)=>sum+(a.actual??0),0));assert.ok(delivered.attempts.every(a=>a.settled));assert.ok(delivered.leases.every(l=>l.released));
  assert.ok(x.session.jobs.every(j=>delivered.attempts.some(a=>a.id===j.attemptId&&a.purpose==='reasoning'&&a.actual===j.usage)));
  for(const execution of store.executionList())assert.ok(delivered.attempts.some(a=>a.id===execution.attemptId&&a.purpose==='execution'&&a.actual===execution.usage!.totalTokens));
  for(const j of [review,checked])assert.ok(delivered.attempts.some(a=>a.id===j.attemptId&&a.purpose==='verification'&&a.actual===j.usage));
  assert.deepEqual(delivered.evidence.map(e=>e.criterionId).sort(),criteria.map(c=>c.id).sort());
  await writeFile(join(evidence,'shared-ledger-delivery.json'),JSON.stringify({admittedContract:admitted.run.contract,spec,beforeVerification,review,plan,checked,delivery,delivered},null,2));
  // Regression: the prior broad contract permits a legitimate read-only directory assertion.
  // These exact source bytes came from the preserved p5-final-live failed candidate, not a new business-defect fixture.
  const broadWorkspace=join(root,'broad-project'),broadHarmlessWorkspace=join(root,'broad-harmless-local-names'),broadBundle=join(root,'broad-definition');await Promise.all([mkdir(broadWorkspace),mkdir(broadHarmlessWorkspace),mkdir(broadBundle)]);
  const broadLegitimateModule="export function sum(a, b) {\n  if (typeof a !== 'number' || !Number.isFinite(a) ||\n      typeof b !== 'number' || !Number.isFinite(b)) {\n    throw new TypeError('sum requires two finite numbers');\n  }\n\n  return a + b;\n}\n";
  const broadLegitimateTests="import assert from 'node:assert/strict';\nimport { readdir } from 'node:fs/promises';\nimport { fileURLToPath } from 'node:url';\nimport { sum } from './sum.mjs';\n\nassert.equal(sum(2, 3), 5);\nassert.equal(sum(-1, 1), 0);\n\nconst invalidValues = [NaN, Infinity, -Infinity, 'not a number'];\n\nfor (const invalid of invalidValues) {\n  assert.throws(() => sum(invalid, 1), TypeError);\n  assert.throws(() => sum(1, invalid), TypeError);\n}\n\nconst projectDirectory = fileURLToPath(new URL('.', import.meta.url));\nconst moduleFiles = (await readdir(projectDirectory))\n  .filter((name) => name.endsWith('.mjs'))\n  .sort();\n\nassert.deepEqual(moduleFiles, ['sum.mjs', 'sum.test.mjs']);\n";
  await Promise.all([writeFile(join(broadWorkspace,'sum.mjs'),broadLegitimateModule),writeFile(join(broadWorkspace,'sum.test.mjs'),broadLegitimateTests)]);
  assert.equal(createHash('sha256').update(await readFile(join(broadWorkspace,'sum.mjs'))).digest('hex'),'dcfdc573e45c0066b3489105e99bf2c7595d577d7b2340f2579e3c721ebbf4ab');
  assert.equal(createHash('sha256').update(await readFile(join(broadWorkspace,'sum.test.mjs'))).digest('hex'),'b9024c3d921a61e80afad06c7a3a8b5e196e1f6631e17d7e0adec728e928b490');
  const broadDirect=await execute(process.execPath,['sum.test.mjs'],{cwd:broadWorkspace});assert.equal(broadDirect.stderr,'','The original broad-contract candidate genuinely executes all strict assertions and its legitimate read-only tree check');
  const broadHarmlessModule=goodModule.replace('export function sum(a,b){','export function sum(a,b){const constructor=1,prototype=2,toString=3;');
  await Promise.all([writeFile(join(broadHarmlessWorkspace,'sum.mjs'),broadHarmlessModule),writeFile(join(broadHarmlessWorkspace,'sum.test.mjs'),goodTest)]);
  const broadHarmlessDirect=await execute(process.execPath,['sum.test.mjs'],{cwd:broadHarmlessWorkspace});assert.equal(broadHarmlessDirect.stderr,'','Harmless local constructor/prototype/toString names do not invoke any loading or reflection capability under the original broad contract');
  const broadRuntime=await runtime.submit({type:'submit',commandId:randomUUID(),workspace:broadWorkspace,goal:broadSumRequest,tokenLimit:200000,verificationReserve:180000,steps:[{id:'prepared',kind:'input',prompt:'Independently verify the actual broad-contract candidate; do not impose new source restrictions.'}]});
  await runtime.sendInput({type:'input',commandId:randomUUID(),runtimeId:broadRuntime.id,stepId:'prepared',text:'The preserved legitimate two-file candidate is prepared and its Node tests actually passed. Read-only directory checks were not forbidden by this contract.'});
  await until(()=>store.runtime.get(broadRuntime.id),record=>record.phase==='awaiting-verification',20000);assert.equal(store.runtime.operations(broadRuntime.id)[0]?.state,'confirmed');
  const broadBefore=store.runtime.inspect(broadRuntime.id).run;assert.equal(broadBefore.contract.goal,broadSumRequest);assert.notEqual(broadBefore.id,delivered.id);assert.notEqual(broadBefore.projectId,delivered.projectId);assert.equal(broadBefore.budget.spent,0);
  assert.deepEqual(broadBefore.contract.criteria.map(criterion=>criterion.id),['independent-acceptance']);
  const broadGroupIds=Object.fromEntries(groups.map(group=>[group,['broad-'+group]]));
  const broadVerifierSource=verifierSource.replace('const groupIds='+JSON.stringify(groupIds)+';','const groupIds='+JSON.stringify(broadGroupIds)+';');assert.notEqual(broadVerifierSource,verifierSource);
  assert.equal(broadVerifierSource.replace('const groupIds='+JSON.stringify(broadGroupIds)+';','const groupIds='+JSON.stringify(groupIds)+';'),verifierSource,'Regression uses precisely the same narrow checker implementation with only actual obligation IDs remapped');
  await writeFile(join(broadBundle,'sum-verifier.mjs'),broadVerifierSource);
  const broadExpectations={normal:'The required named sum function returns the specified arithmetic results.',invalid:'Nonfinite and nonnumeric inputs at both positions raise TypeError.',artifacts:'The actual two-file Node module and node:assert/strict test execute genuine normal and TypeError assertions, detecting the corresponding wrong implementations.',scope:'Only sum.mjs and sum.test.mjs are delivered, with no packages, network access, or writes outside the selected directory. Legitimate read-only directory checks in the test are allowed because the original user contract contains no prohibition of filesystem imports or import.meta.'};
  const broadSpec:VerificationSpec={schemaVersion:1,contractVersion:broadBefore.contract.version,standardsVersion:'p5-admitted-sum-v2',obligations:groups.map(group=>({id:broadGroupIds[group]![0]!,criterionId:'independent-acceptance',required:true,applicable:true,expectation:broadSumRequest+'\n'+broadExpectations[group]})),cases:spec.cases.map(definition=>({...definition,obligationIds:broadGroupIds[definition.parameters[0]!.group!]!})),controls:[{id:'legitimate-broad-contract-directory-test',workspace:broadWorkspace,expect:'passed',mustFail:[]},{id:'legitimate-broad-harmless-local-names',workspace:broadHarmlessWorkspace,expect:'passed',mustFail:[]},{id:'known-business-defects-under-broad-contract',workspace:bad,expect:'failed',mustFail:groups.map(group=>broadGroupIds[group]![0]!)}],moduleDependencies:{}};
  const broadSpecPath=join(broadBundle,'spec.json');await writeFile(broadSpecPath,JSON.stringify(broadSpec,null,2));
  const broadProposal=await verify<Proposal>({type:'propose',commandId:randomUUID(),runtimeId:broadRuntime.id,specPath:broadSpecPath});assert.equal(broadProposal.runId,broadBefore.id);
  const broadReview=await finished(await verify<VerificationJob>({type:'review',commandId:randomUUID(),proposalId:broadProposal.id,...verificationConfig}));
  assert.equal(broadReview.approved,false);assert.equal(broadReview.modelStarted,false,'Real positive-control rejection stops before independent model review');assert.equal(broadReview.usage,0);assert.equal(broadReview.usageUnknown,false);assert.equal(broadReview.stopConfirmed,true);assert.match(broadReview.error??'',/known good\/bad controls/i);
  assert.equal(broadReview.intents.length,broadReview.identities.length);assert.ok(broadReview.identities.length);for(const identity of broadReview.identities)assert.equal((await inspectProcess(identity)).status,'stopped');
  assert.equal(broadReview.controls.length,3);
  const legitimateControl=broadReview.controls.find(control=>control.id==='legitimate-broad-contract-directory-test')!;assert.equal(legitimateControl.passed,false,'The checker incorrectly rejects a business-valid candidate; the candidate is still labelled positive');
  await assertDirectEntries(legitimateControl.results,broadWorkspace);
  assert.ok(legitimateControl.results.flatMap(result=>result.checks).filter(check=>check.obligationId!=='broad-scope').every(check=>check.verdict==='passed'),'All actual arithmetic, invalid-input and mutation checks accept the legitimate broad candidate');
  assert.ok(legitimateControl.results.some(result=>result.executionStatus==='executed'&&result.checks.some(check=>check.obligationId==='broad-scope'&&check.verdict==='failed')));
  const broadTrace=await readScopeTrace(legitimateControl.results,broadWorkspace);assert.ok(broadTrace.files.some(file=>file.imports.some(dependency=>dependency.specifier==='node:fs/promises'&&dependency.allowed===false)));assert.ok(broadTrace.files.some(file=>file.forbidden.some(syntax=>syntax.syntax==='execution-metadata')));
  const harmlessControl=broadReview.controls.find(control=>control.id==='legitimate-broad-harmless-local-names')!;assert.equal(harmlessControl.passed,false,'The broad-contract positive is rejected by a name-only subset policy; harmless bindings are not business defects');
  await assertDirectEntries(harmlessControl.results,broadHarmlessWorkspace);
  assert.ok(harmlessControl.results.flatMap(result=>result.checks).filter(check=>check.obligationId!=='broad-scope').every(check=>check.verdict==='passed'));
  assert.ok(harmlessControl.results.some(result=>result.executionStatus==='executed'&&result.checks.some(check=>check.obligationId==='broad-scope'&&check.verdict==='failed')));
  const harmlessTrace=await readScopeTrace(harmlessControl.results,broadHarmlessWorkspace);assert.ok(harmlessTrace.files.every(file=>file.imports.every(dependency=>dependency.allowed)));
  for(const name of ['constructor','prototype','toString'])assert.ok(harmlessTrace.files.some(file=>file.file==='sum.mjs'&&file.forbidden.some(syntax=>syntax.syntax==='reserved-identifier'&&syntax.text===name)),'Actual harmless local binding is excluded only by the narrow lexical policy: '+name);
  await assert.rejects(verify({type:'publish',commandId:randomUUID(),proposalId:broadProposal.id,reviewId:broadReview.id}),/actual independent approved review/i);
  const broadAfter=store.runtime.inspect(broadRuntime.id).run,broadAttempt=broadAfter.attempts.find(attempt=>attempt.id===broadReview.attemptId)!;assert.equal(broadAttempt.settled,true);assert.equal(broadAttempt.actual,0);assert.equal(broadAfter.budget.spent,0);assert.ok(broadAfter.leases.every(lease=>lease.released));assert.equal(broadAfter.status,broadBefore.status,'Rejected verifier review does not change the business Run outcome');assert.deepEqual(broadAfter.nodes,broadBefore.nodes,'The legitimate completed implementation is not reclassified as a business failure');assert.equal(broadReview.evaluation,null);assert.equal(store.goals.inspect(x.session.id).run.budget.spent,delivered.budget.spent,'The distinct broad regression does not spend the main Run ledger');
  await writeFile(join(evidence,'broad-contract-checker-rejection.json'),JSON.stringify({originalBroadRequest:broadSumRequest,tinyScenarioRequest:tinySumRequest,broadBefore,broadSpec,broadProposal,broadReview,broadAfter,legitimateCandidate:{moduleDigest:'dcfdc573e45c0066b3489105e99bf2c7595d577d7b2340f2579e3c721ebbf4ab',testsDigest:'b9024c3d921a61e80afad06c7a3a8b5e196e1f6631e17d7e0adec728e928b490'},boundary:'Actual deterministic positive-control rejection before model start; no claim of executed LLM semantic rejection'},null,2));
});
test('P5 live cancellation stops the real master turn and restart never replays or clears unknown usage', {timeout:180000},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-p5-cancel-'))),data=join(root,'data'),workspace=join(root,'project');await mkdir(workspace);
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','p5-cancel-'+randomUUID());await mkdir(evidence,{recursive:true});
  let store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),controller=new OrchestrationController(store,data,runtime);await controller.initialize();
  t.after(async()=>{await controller.close();await runtime.close();store.close();await cp(root,join(evidence,'runtime'),{recursive:true});});
  const x=await controller.dispatch({type:'start',commandId:randomUUID(),workspace,goal:'Design a desktop project-management app. Carefully identify ambiguous workflows, concrete visual styles, acceptance criteria and missing decisions. Do not execute anything.',model:process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol',effort:'medium',reservation:100000,timeoutMs:120000,tokenLimit:200000,verificationReserve:20000}) as GoalInspection;
  const job=x.session.jobs[0]!,events=join(data,'reasoning',job.id,'events.jsonl');
  await until(async()=>{try{return await readFile(events,'utf8');}catch{return '';}},text=>text.includes('reasoner-turn-started'),80000);
  await controller.dispatch({type:'cancel',commandId:randomUUID(),sessionId:x.session.id});
  const ended=await until(()=>store.goals.inspect(x.session.id),v=>v.session.jobs[0]!.status==='finished',40000);assert.equal(ended.session.phase,'cancelled');assert.equal(ended.run.status,'cancelled');assert.equal(ended.session.jobs[0]!.stopConfirmed,true);assert.equal(ended.session.jobs[0]!.modelStarted,true);assert.equal(store.runtime.list().length,0);
  const attempt=ended.run.attempts[0]!;if(ended.session.jobs[0]!.usage===null){assert.equal(attempt.settled,false);assert.equal(attempt.reservation,100000);}else assert.equal(attempt.actual,ended.session.jobs[0]!.usage);
  await controller.close();store.close();store=new SupervisorStore(data);runtime=new LocalRuntimeAdapter(store,data);controller=new OrchestrationController(store,data,runtime);await controller.initialize();assert.deepEqual(store.goals.inspect(x.session.id),ended);await assert.rejects(controller.dispatch({type:'restore',commandId:randomUUID(),sessionId:x.session.id,expectedRevision:ended.session.revision}),/cancelled/);await writeFile(join(evidence,'cancelled.json'),JSON.stringify(ended,null,2));
});
