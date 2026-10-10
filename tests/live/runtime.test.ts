import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../../apps/supervisor/server.js';
import { request } from '../../apps/cli/client.js';
import type { RuntimeAction, RuntimeRecord, RuntimeStep } from '../../packages/contracts/p3.js';
import type { ExecutionRecord, ExecutorCapabilities } from '../../packages/contracts/p2.js';
import type { Run } from '../../packages/contracts/p1.js';
import { readOwnership, workerAlive } from '../../packages/runtime/worker-ownership.js';
import { captureProcessMember, inspectProcess, terminateProcess, type ProcessIdentity } from '../../packages/process-control/index.js';
const execute=promisify(execFile);
async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,ms=150_000):Promise<T>{const end=Date.now()+ms;for(;;){const v=await read();if(accept(v))return v;if(Date.now()>end)throw new Error('Real runtime live condition timed out');await delay(150);}}
async function fixture(t:TestContext,label:string) {
  const root=await mkdtemp(join(tmpdir(),'sv-p3live-')),data=join(root,'data'),workspace=join(root,'project');await mkdir(workspace);
  await execute('git',['init','--quiet'],{cwd:workspace});await execute('git',['-c','user.name=Supervisor Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Live durable baseline'],{cwd:workspace});
  let service=await startService(data);
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts',label+'-'+randomUUID());await mkdir(evidence,{recursive:true});
  async function action<T>(action:RuntimeAction):Promise<T>{const result=await request(data,{id:randomUUID(),method:'runtime',action});assert.equal(result.ok,true,JSON.stringify(result));return result.value as T;}
  const response=await request(data,{id:randomUUID(),method:'execution',action:{type:'capabilities'}});assert.equal(response.ok,true,JSON.stringify(response));const caps=response.value as ExecutorCapabilities;
  const model=caps.models.find(x=>x.id===(process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol'));assert.ok(model?.reasoningEfforts.includes('medium'));
  await writeFile(join(evidence,'capabilities.json'),JSON.stringify(caps,null,2));
  const codex=(id:string,prompt:string):RuntimeStep=>({id,kind:'codex',prompt,model:model!.id,effort:'medium',reservation:150_000,timeoutMs:115_000});
  async function executions(){const r=await request(data,{id:randomUUID(),method:'execution',action:{type:'list'}});assert.equal(r.ok,true);return r.value as ExecutionRecord[];}
  t.after(async()=>{delete process.env.SUPERVISOR_RUNTIME_FAULT;await service.close();const own=await readOwnership(data);if(own?.identity){if(own.worker)try{process.kill(own.worker.pid,'SIGCONT');}catch{}await terminateProcess(own.identity);}await cp(root,join(evidence,'runtime'),{recursive:true});t.diagnostic(JSON.stringify({evidence,root}));});
  return {root,data,workspace,evidence,action,codex,executions,async restart(){await service.close();service=await startService(data);}};
}
test('live durable Codex recovers completed receipt after worker death then waits and continues with cumulative budget', {timeout:290_000}, async t=>{
  const f=await fixture(t,'durable-continuation');
  process.env.SUPERVISOR_RUNTIME_FAULT='before-report';
  const started=await f.action<RuntimeRecord>({type:'submit',commandId:randomUUID(),workspace:f.workspace,goal:'Produce two independently checked local artifacts with an explicit input boundary',tokenLimit:340_000,verificationReserve:20_000,steps:[
    f.codex('first','Create ONLY first.txt with exactly the text alpha followed by one newline. Use the filesystem; no network or subagents.'),
    {id:'approval',kind:'input',prompt:'Provide the second file content'},
    f.codex('second','Read the Supervisor durable inputs approval value. Create ONLY second.txt containing that value followed by one newline. Do not modify first.txt. No network or subagents.')
  ]});
  delete process.env.SUPERVISOR_RUNTIME_FAULT;
  const fault=await until(async()=>{try{return JSON.parse(await readFile(join(f.data,'runtime-worker-fault.json'),'utf8')) as {pid:number;operationId:string};}catch{return null;}},v=>v!==null);
  const before=await f.executions();assert.equal(before.length,1);assert.equal(before[0]!.state,'completed');assert.equal(before[0]!.stopConfirmed,true);assert.ok(before[0]!.usage!.totalTokens>0);assert.equal(await readFile(join(f.workspace,'first.txt'),'utf8'),'alpha\n');
  process.kill(fault!.pid,'SIGKILL');await until(()=>captureProcessMember(fault!.pid),v=>v===null,10_000);
  await f.restart();
  await until(()=>f.action<RuntimeRecord[]>({type:'list'}),items=>items.find(r=>r.id===started.id)?.phase==='waiting-input',30_000);
  const recovered=await f.executions();assert.equal(recovered.length,1,'Completed activity must not invoke another Codex turn');assert.equal(recovered[0]!.turnId,before[0]!.turnId);
  const firstInspection=await f.action<{runtime:RuntimeRecord;run:Run}>({type:'inspect',runtimeId:started.id});assert.equal(firstInspection.run.budget.spent,before[0]!.usage!.totalTokens);assert.equal(firstInspection.run.attempts.length,1);
  const owner=await readOwnership(f.data);assert.ok(owner&&await workerAlive(owner));await f.restart();assert.equal((await readOwnership(f.data))!.owner,owner.owner,'Service reconnect must preserve live worker');
  const input={type:'input' as const,runtimeId:started.id,commandId:randomUUID(),stepId:'approval',text:'beta'};await f.action(input);await f.action(input);
  await until(()=>f.action<RuntimeRecord[]>({type:'list'}),items=>items.find(r=>r.id===started.id)?.phase==='awaiting-verification');
  const records=await f.executions();assert.equal(records.length,2);assert.equal(new Set(records.map(r=>r.runId)).size,1);assert.ok(records.every(r=>r.state==='completed'&&r.stopConfirmed&&r.error===null));
  assert.equal(await readFile(join(f.workspace,'first.txt'),'utf8'),'alpha\n');assert.equal(await readFile(join(f.workspace,'second.txt'),'utf8'),'beta\n');
  const final=await f.action<{runtime:RuntimeRecord;run:Run;checkpoints:unknown[]}>({type:'inspect',runtimeId:started.id});assert.equal(final.run.budget.spent,records.reduce((n,r)=>n+r.usage!.totalTokens,0));assert.equal(final.run.attempts.length,3);assert.notEqual(final.run.status,'succeeded');assert.equal(final.runtime.cursor,3);assert.ok(final.checkpoints.length>=4);
  await writeFile(join(f.evidence,'inspection.json'),JSON.stringify(final,null,2));await writeFile(join(f.evidence,'executions.json'),JSON.stringify(records,null,2));
});
test('live durable cancellation reaches actual Codex writer and never resumes on service restart', {timeout:150_000}, async t=>{
  const f=await fixture(t,'durable-cancel');
  const r=await f.action<RuntimeRecord>({type:'submit',commandId:randomUUID(),workspace:f.workspace,goal:'Validate actual runtime cancellation',tokenLimit:170_000,verificationReserve:20_000,steps:[f.codex('write','Use your command tool to run node -e "setInterval(()=>{},1000)" and wait 90 seconds. No files, no other work, no network or subagents. This is a bounded cancellation test.')]});
  const records=await until(()=>f.executions(),xs=>xs.some(e=>e.turnId!==null||e.stopConfirmed),50_000);assert.equal(records[0]!.stopConfirmed,false);
  await f.action({type:'cancel',runtimeId:r.id,commandId:randomUUID()});
  const stopped=await until(()=>f.executions(),xs=>xs.length===1&&xs[0]!.stopConfirmed,30_000);assert.equal(stopped[0]!.state,'cancelled');assert.equal((await inspectProcess(stopped[0]!.identity as ProcessIdentity)).status,'stopped');
  await f.restart();const final=await f.action<{runtime:RuntimeRecord;run:Run}>({type:'inspect',runtimeId:r.id});assert.equal(final.runtime.phase,'cancelled');assert.equal(final.run.status,'cancelled');assert.equal((await f.executions()).length,1);
  await writeFile(join(f.evidence,'cancellation.json'),JSON.stringify({final,execution:stopped[0],cancelledAt:new Date().toISOString()},null,2));
});
