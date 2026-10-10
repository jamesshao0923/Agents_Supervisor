import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../../apps/supervisor/server.js';
import { request } from '../../apps/cli/client.js';
import type { ExecutionAction, ExecutionRecord, ExecutionEvent, ExecutorCapabilities } from '../../packages/contracts/p2.js';
import type { Run } from '../../packages/contracts/p1.js';
import { inspectProcess, type ProcessIdentity } from '../../packages/process-control/index.js';

const execute=promisify(execFile);
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
async function fixture(t:TestContext,label:string) {
  const directory=await mkdtemp(join(tmpdir(),'sv-live-'));
  const workspace=join(directory,'project'); await mkdir(workspace);
  await execute('git',['init','--quiet'],{cwd:workspace});
  await execute('git',['-c','user.name=Supervisor Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Live fixture baseline'],{cwd:workspace});
  const data=join(directory,'data'); const service=await startService(data);
  async function action<T>(action:ExecutionAction):Promise<T> {
    const response=await request(data,{id:randomUUID(),method:'execution',action});
    assert.equal(response.ok,true,JSON.stringify(response));return response.value as T;
  }
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'), 'artifacts',label+'-'+randomUUID());
  await mkdir(evidence,{recursive:true});
  t.after(async()=>{
    await service.close();
    await cp(directory,join(evidence,'runtime'),{recursive:true});
    t.diagnostic(JSON.stringify({evidence,directory}));
  });
  const capabilities=await action<ExecutorCapabilities>({type:'capabilities'});
  const model=capabilities.models.find(m=>m.id===(process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol'));
  assert.ok(model,'Explicit live model must be advertised by the actual account');
  await writeFile(join(evidence,'capabilities.json'),JSON.stringify(capabilities,null,2));
  async function start(prompt:string,images?:string[]):Promise<ExecutionRecord> {
    return action({type:'start',commandId:randomUUID(),workspace,prompt,model:model!.id,effort:'medium',timeoutMs:110_000,tokenLimit:170_000,reservation:150_000,verificationReserve:20_000,...(images?{images}:{})});
  }
  async function until(id:string,predicate:(record:ExecutionRecord)=>boolean,ms=115_000):Promise<ExecutionRecord> {
    const end=Date.now()+ms;
    while(Date.now()<end){const record=await action<ExecutionRecord>({type:'inspect',executionId:id});if(predicate(record))return record;await delay(200);}
    await action({type:'cancel',executionId:id});throw new Error('Live observation deadline expired');
  }
  async function events(id:string) { const all:ExecutionEvent[]=[];let after=0;while(true){const page=await action<ExecutionEvent[]>({type:'events',executionId:id,after});all.push(...page);if(page.length<500)break;after=page.at(-1)!.seq;}return all; }
  async function stopped(record:ExecutionRecord) {
    assert.equal(record.stopConfirmed,true);assert.ok(record.identity);
    assert.equal((await inspectProcess(record.identity as ProcessIdentity)).status,'stopped');
    const trajectory=await events(record.id);
    await writeFile(join(evidence,'trajectory.json'),JSON.stringify(trajectory,null,2));
    await writeFile(join(evidence,'execution.json'),JSON.stringify(record,null,2));
    return trajectory;
  }
  return {workspace,data,evidence,capabilities,action,start,until,events,stopped};
}

test('live Codex repairs an isolated TypeScript project with immutable independent build assertions', {timeout:130_000}, async t=>{
  const f=await fixture(t,'code'); await mkdir(join(f.workspace,'src'));
  const source='export function discountedPrice(amount: number, percent: number): number { return amount * percent; }\n';
  const check="import assert from 'node:assert/strict';import {discountedPrice} from './build/price.js';assert.equal(discountedPrice(200,25),150);assert.equal(discountedPrice(80,0),80);assert.equal(discountedPrice(30,100),0);assert.throws(()=>discountedPrice(-1,5),RangeError);assert.throws(()=>discountedPrice(1,101),RangeError);assert.throws(()=>discountedPrice(Infinity,1),RangeError);assert.throws(()=>discountedPrice(1,NaN),RangeError);console.log('independent assertions passed');\n";
  await writeFile(join(f.workspace,'src/price.ts'),source);
  await writeFile(join(f.workspace,'package.json'),'{"type":"module"}\n');
  await writeFile(join(f.workspace,'assertions.mjs'),check);
  const compiler=resolve('node_modules/typescript/bin/tsc');
  const build=()=>execute(process.execPath,[compiler,'src/price.ts','--target','es2022','--module','nodenext','--strict','--outDir','build','--types','node','--typeRoots',resolve('node_modules/@types')],{cwd:f.workspace,timeout:15_000});
  await build(); await assert.rejects(execute(process.execPath,['assertions.mjs'],{cwd:f.workspace,timeout:5000}));
  await writeFile(join(f.evidence,'before.json'),JSON.stringify({source:digest(source),acceptance:digest(check),criteria:'0<=percent<=100; finite nonnegative amount; RangeError otherwise; amount*(1-percent/100)'}));
  const started=await f.start('Fix ONLY src/price.ts. discountedPrice(amount, percent) returns amount*(1-percent/100). Both arguments must be finite; amount must be >=0; percent must be between 0 and 100 inclusive; invalid input throws RangeError. Do not modify package.json or assertions.mjs. No dependencies, no subagents, no network. Keep implementation simple and report changes.');
  const record=await f.until(started.id,r=>r.stopConfirmed);
  const trajectory=await f.stopped(record);
  assert.equal(record.state,'completed',record.error??record.message);
  assert.ok(record.threadId&&record.turnId);assert.equal(record.usageStatus,'reported');assert.ok(record.usage!.totalTokens>0);assert.ok(record.artifactId);
  assert.equal(digest(await readFile(join(f.workspace,'assertions.mjs'))),digest(check),'Executor cannot weaken verifier');
  assert.notEqual(await readFile(join(f.workspace,'src/price.ts'),'utf8'),source);
  await build();const result=await execute(process.execPath,['assertions.mjs'],{cwd:f.workspace,timeout:5000});
  await writeFile(join(f.evidence,'independent-build.log'),result.stdout);
  const response=await request(f.data,{id:randomUUID(),method:'query',query:{type:'run',projectId:record.projectId,runId:record.runId}});
  assert.equal(response.ok,true);const run=response.value as Run;
  assert.notEqual(run.status,'succeeded','Execution return is not independent product acceptance');assert.equal(run.budget.spent,record.usage!.totalTokens);
  assert.ok(trajectory.find(e=>e.kind==='codex-raw'));assert.ok(!trajectory.some(e=>e.kind==='codex-raw' && (e.payload as {message?:{method?:string}}).message?.method==='mcpServer/startupStatus/updated'),'P2 must not inherit unrelated MCP servers');assert.ok(trajectory.find(e=>e.kind==='workspace-captured'));
  t.diagnostic(JSON.stringify({threadId:record.threadId,turnId:record.turnId,tokens:record.usage!.totalTokens,sourceDigest:digest(await readFile(join(f.workspace,'src/price.ts')))}));
});

test('live Codex cancellation stops an actual started turn and keeps cancellation after reconnect', {timeout:130_000}, async t=>{
  const f=await fixture(t,'cancel');
  const started=await f.start('Use your command tool once to run node -e "setInterval(()=>{},1000)" in this workspace, waiting for 90 seconds. Do not create any files or do other work. This is an intentional cancellation integration test.');
  const running=await f.until(started.id,r=>r.turnId!==null||r.stopConfirmed,40_000);
  assert.equal(running.stopConfirmed,false,JSON.stringify(running));
  // Independent IPC connections mimic a disconnected/reconnected UI; no prompt replay.
  const seen=await f.action<ExecutionRecord[]>({type:'list'});assert.equal(seen.filter(r=>r.id===started.id).length,1);
  await f.action({type:'cancel',executionId:started.id});
  const record=await f.until(started.id,r=>r.stopConfirmed,20_000);await f.stopped(record);
  assert.equal(record.state,'cancelled');assert.equal(record.cancelRequested,true);
  const reread=await f.action<ExecutionRecord>({type:'inspect',executionId:record.id});assert.equal(reread.state,'cancelled');
});

test('live Codex image input recognizes the captured Supervisor desktop without text substitutes', {timeout:130_000}, async t=>{
  const screenshot=resolve(process.env.SUPERVISOR_LIVE_SCREENSHOT??'.supervisor-dev/p2-ui/empty-workspace.png');
  assert.ok((await stat(screenshot)).isFile(),'Capture the actual Supervisor window before the live image gate');
  const f=await fixture(t,'vision');assert.equal(f.capabilities.imageInput,true);
  const image=join(f.workspace,'supervisor-window.png');await cp(screenshot,image);
  await writeFile(join(f.evidence,'image-input.json'),JSON.stringify({source:screenshot,digest:digest(await readFile(image)),capturedApplication:'Supervisor Electron desktop'}));
  const started=await f.start('Inspect only the attached screenshot. Identify the application name and at least two visible button labels, then state whether it is an empty workspace or already has execution cards. Do not read project files, do not use OCR commands or any tools; use image input directly. Reply briefly in Chinese.',[image]);
  const record=await f.until(started.id,r=>r.stopConfirmed);await f.stopped(record);
  assert.equal(record.state,'completed',record.error??record.message);
  assert.match(record.message,/Supervisor/i);assert.match(record.message,/新任务|创建第一个任务/);assert.match(record.message,/重新连接后台|断开界面|执行工作台/);
  assert.ok(record.usage&&record.usage.totalTokens>0);t.diagnostic(JSON.stringify({imageDigest:digest(await readFile(image)),answer:record.message}));
});
