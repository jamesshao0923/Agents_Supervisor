import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { OrchestrationController } from '../../packages/orchestration/controller.js';
import { LocalRuntimeAdapter } from '../../packages/runtime/index.js';
import { ExecutionManager } from '../../packages/execution/manager.js';
import { inspectProcess, terminateProcess, type ProcessIdentity } from '../../packages/process-control/index.js';
import type { GoalInspection } from '../../packages/contracts/p5.js';
import type { ExecutionRecord } from '../../packages/contracts/p2.js';
import type { Run } from '../../packages/contracts/p1.js';

const execute=promisify(execFile);
async function until<T>(read:()=>T|Promise<T>,done:(value:T)=>boolean):Promise<T>{
  const deadline=Date.now()+170_000;
  for(;;){const value=await read();if(done(value))return value;if(Date.now()>deadline)throw new Error('Unlimited token live observation deadline exceeded');await delay(150);}
}

test('live unlimited goal reasoning and direct Codex execution exceed reservation one without cancellation and retain actual accounting',{timeout:380_000},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-live-token-policy-'))),data=join(root,'data'),workspace=join(root,'project');await mkdir(workspace);
  await execute('git',['init','--quiet'],{cwd:workspace,timeout:5000});
  await execute('git',['-c','user.name=Supervisor Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Token policy live baseline'],{cwd:workspace,timeout:5000});
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','token-policy-'+randomUUID());await mkdir(evidence,{recursive:true});
  const store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),orchestration=new OrchestrationController(store,data,runtime),execution=new ExecutionManager(store,data);
  const ownedIdentities:ProcessIdentity[]=[];
  t.after(async()=>{
    await orchestration.close();await execution.close();await runtime.close();
    // Only identities returned by this isolated test's controllers are eligible
    // for cleanup; never terminate discovered or unrelated account processes.
    for(const identity of ownedIdentities)if((await inspectProcess(identity)).status==='verified')await terminateProcess(identity);
    store.close();await cp(root,join(evidence,'runtime'),{recursive:true});t.diagnostic(JSON.stringify({root,evidence}));
  });
  await orchestration.initialize();await execution.initialize();
  const initial=await orchestration.dispatch({type:'start',commandId:randomUUID(),workspace,goal:'Plan one minimal local Node.js task: create result.txt containing exactly TOKEN_POLICY_OK followed by one newline, and create result.test.mjs using node:assert/strict to read result.txt and assert that exact content. No dependencies, no UI, no network, no publication. Use exactly one implementation step for both files and one command acceptance criterion with target result.test.mjs. The task is fully specified; no clarification is needed. Plan only; do not create files or execute the task.',model:'gpt-6-astra',effort:'low',reservation:1,timeoutMs:150_000,tokenLimit:null,verificationReserve:1,maxContextChars:200_000}) as GoalInspection;
  const reasoned=await until(()=>store.goals.inspect(initial.session.id),value=>value.session.phase!=='thinking');
  const job=reasoned.session.jobs[0]!;ownedIdentities.push(...job.identities);
  await writeFile(join(evidence,'goal.json'),JSON.stringify(reasoned,null,2));
  assert.equal(reasoned.session.phase,'ready',reasoned.session.error??JSON.stringify(reasoned.session.proposal));assert.equal(job.error,null);assert.equal(job.stopConfirmed,true);assert.equal(job.modelStarted,true);assert.ok(job.threadId);assert.ok(job.usage!==null&&job.usage>1,'Real main-controller usage must exceed the finite reservation');
  assert.equal(job.config.reservation,1);assert.equal(reasoned.run.budget.limit,null);assert.equal(reasoned.run.budget.spent,job.usage);assert.equal(reasoned.run.attempts[0]!.actual,job.usage);assert.equal(reasoned.run.attempts[0]!.settled,true);assert.notEqual(reasoned.run.status,'cancelled');assert.ok(Object.keys(job.proofs).length>0);assert.ok(job.identities.length>0);
  for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');
  const conversation=store.conversations.forRun(reasoned.run.projectId,reasoned.run.id)!;assert.equal(store.conversations.budget(conversation.id).limit,null);assert.equal(store.conversations.budget(conversation.id).remaining,null);assert.equal(store.conversations.budget(conversation.id).spent,job.usage);

  // A separate actual execution covers P2's observed-usage cancellation path.
  // Its controller performs required advertised-model validation; no additional
  // capabilities/model-discovery call is made by this test.
  const started=await execution.dispatch({type:'start',commandId:randomUUID(),workspace,prompt:'Create exactly one file token-policy-result.txt containing exactly TOKEN_POLICY_OK followed by one newline. Use your command tool to write it once. Do not read unrelated files, install dependencies, use network, create subagents, or do additional work. Reply briefly when done.',model:'gpt-6-astra',effort:'low',reservation:1,timeoutMs:150_000,tokenLimit:null,verificationReserve:1}) as ExecutionRecord;
  const record=await until(()=>store.executionGet(started.id),value=>value.stopConfirmed);
  if(record.identity)ownedIdentities.push(record.identity as ProcessIdentity);
  await writeFile(join(evidence,'execution.json'),JSON.stringify(record,null,2));
  const events=[];let after=0;for(;;){const page=store.executionEvents(record.id,after);events.push(...page);if(page.length<500)break;after=page.at(-1)!.seq;}
  await writeFile(join(evidence,'execution-events.json'),JSON.stringify(events,null,2));
  assert.equal(record.state,'completed',record.error??record.message);assert.equal(record.cancelRequested,false);assert.equal(record.error,null);assert.equal(record.tokenLimit,null);assert.equal(record.reservation,1);assert.equal(record.usageStatus,'reported');assert.ok(record.usage&&record.usage.totalTokens>1,'Real executor reported usage must exceed reservation');assert.ok(record.threadId&&record.turnId);assert.ok(record.identity);assert.equal((await inspectProcess(record.identity as ProcessIdentity)).status,'stopped');
  const bytes=await readFile(join(workspace,'token-policy-result.txt'));assert.equal(bytes.toString('utf8'),'TOKEN_POLICY_OK\n');
  const run=store.query({type:'run',projectId:record.projectId,runId:record.runId}) as Run;assert.equal(run.budget.limit,null);assert.equal(run.budget.spent,record.usage.totalTokens);assert.equal(run.attempts[0]!.actual,record.usage.totalTokens);assert.equal(run.attempts[0]!.settled,true);assert.notEqual(run.status,'cancelled');assert.notEqual(run.status,'succeeded','Execution remains subject to independent product verification');
  assert.ok(events.some(event=>event.kind==='codex-raw'));assert.ok(events.some(event=>event.kind==='workspace-captured'));
  await writeFile(join(evidence,'summary.json'),JSON.stringify({model:'gpt-6-astra',effort:'low',reservation:1,tokenLimit:null,reasoningTokens:job.usage,executionTokens:record.usage.totalTokens,fileDigest:createHash('sha256').update(bytes).digest('hex'),reasoningStopConfirmed:job.stopConfirmed,executionStopConfirmed:record.stopConfirmed},null,2));
});
