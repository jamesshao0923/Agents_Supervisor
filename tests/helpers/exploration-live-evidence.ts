import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {VerificationJob} from '../../packages/verification/records.js';
import {verificationDirectory} from '../../packages/verification/scoped-environment.js';
import type {ExplorationCandidate} from '../../packages/contracts/p7-exploration.js';
import type {ExplorationTier} from '../../packages/contracts/p7-scheduler.js';
import type {ScheduledPlan} from '../../packages/contracts/p7-dispatch.js';
import type {SupervisionJob} from '../../packages/contracts/p6-supervision.js';
import type {Run} from '../../packages/contracts/p1.js';
import {runtimeCanonical} from '../../packages/persistence/runtime.js';
import {authorWireInput,type PresentedAuthorInput} from '../../packages/orchestration/author-presentation.js';
import {inspectProcess} from '../../packages/process-control/index.js';

export const sha = (value:string|Uint8Array):string => createHash('sha256').update(value).digest('hex');
const bases = ['uncertain','exploratory','supported','strong'];
const thresholds = {low:3,medium:2,high:1,unlimited:0};

/** Expected policy sets over the SAME actual proposal, not new scores or authority. */
export function tierCandidateIds(plan:ScheduledPlan,candidates:readonly ExplorationCandidate[],tier:ExplorationTier):string[] {
  const eligible=new Set(candidates.filter(c=>Math.min(bases.indexOf(c.quality),bases.indexOf(c.value))>=thresholds[tier]).map(c=>c.id));
  for(const candidate of candidates){
    const task=plan.tasks.find(task=>task.node.id===candidate.id);
    assert.ok(task&&!task.node.required);
    assert.equal(task.node.admission.quality,candidate.quality);
    assert.equal(task.node.admission.value,candidate.value);
  }
  // An unstarted optional prerequisite below the tier is not promoted.
  for(let changed=true;changed;){
    changed=false;
    for(const task of plan.tasks.filter(task=>!task.node.required)){
      if(eligible.has(task.node.id)&&task.node.dependencies.some(id=>plan.tasks.some(dep=>dep.node.id===id&&!dep.node.required)&&!eligible.has(id))){
        eligible.delete(task.node.id);changed=true;
      }
    }
  }
  return [...eligible].sort();
}

export function assertFourTierStimulus(candidates:readonly ExplorationCandidate[]):void {
  assert.ok(candidates.length>=4&&candidates.length<=7,'Coverage insufficient: actual planner must supply bounded candidates spanning all four thresholds; never fill or relabel its JSON');
  assert.deepEqual([...new Set(candidates.map(c=>Math.min(bases.indexOf(c.quality),bases.indexOf(c.value))))].sort(),[0,1,2,3],
    'Coverage insufficient: actual model rationale must expose each threshold, without host replacement or inferred quality calibration');
}

/** Exact retained provider transcript; this helper never creates model evidence. */
export async function actualModelCompletion(proofs:Record<string,string>) {
  const paths=Object.keys(proofs).filter(path=>path.endsWith('/result.json'));
  assert.equal(paths.length,1,'One exact owned model result is required');
  return readModelCompletion(proofs,paths[0]!);
}

/** Exact P4 definition-review directory derived from the durable review Run scope.
 * Command control result files stay in the full proof inventory unchanged. */
export async function actualReviewModelCompletion(dataDir:string,job:VerificationJob) {
  assert.equal(job.kind,'review');assert.equal(job.status,'finished');assert.equal(job.approved,true);
  assert.equal(job.error,null);assert.equal(job.modelStarted,true);assert.equal(job.stopConfirmed,true);assert.equal(job.usageUnknown,false);
  const resultPath=join(verificationDirectory(dataDir,job),'definition-review','result.json');
  assert.ok(Object.hasOwn(job.proofs,resultPath),'The exact own definition-review result must be in this review proof inventory');
  const actual=await readModelCompletion(job.proofs,resultPath);
  assert.equal(actual.result.usage,job.usage);
  return actual;
}

async function readModelCompletion(proofs:Record<string,string>,resultPath:string) {
  const directory=resultPath.slice(0,-'result.json'.length);
  const outputPath=directory+'output.txt',eventsPath=directory+'events.jsonl';
  for(const path of [resultPath,outputPath,eventsPath]){assert.ok(proofs[path]);assert.equal(sha(await readFile(path)),proofs[path]);}
  const result=JSON.parse(await readFile(resultPath,'utf8'));
  assert.ok(result.threadId&&result.turnId);
  assert.equal(result.modelStarted,true);assert.equal(result.stopConfirmed,true);
  assert.ok(Number.isSafeInteger(result.usage)&&result.usage>0);
  const raw=await readFile(outputPath,'utf8'),events=(await readFile(eventsPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const terminal=events.filter(event=>event.kind==='codex-event'&&event.value?.raw?.method==='turn/completed').map(event=>event.value.raw.params);
  assert.equal(terminal.length,1);assert.equal(terminal[0].threadId,result.threadId);assert.equal(terminal[0].turn.id,result.turnId);assert.equal(terminal[0].turn.status,'completed');
  assert.equal(terminal[0].turn.items.filter((item:{type:string})=>item.type==='agentMessage').at(-1)?.text,raw);
  const messages=events.filter(event=>event.kind==='codex-event'&&event.value?.raw?.method==='item/completed').map(event=>event.value.raw.params)
    .filter(params=>params.threadId===result.threadId&&params.turnId===result.turnId&&params.item?.type==='agentMessage');
  assert.equal(messages.at(-1)?.item.text,raw);
  return {result,raw,output:JSON.parse(raw),events};
}

/** A legitimate historical failure needs fees/ownership/terminal evidence, not success. */
export async function historicalAuthor(job:SupervisionJob,run:Run):Promise<void> {
  assert.equal(job.status,'finished');assert.equal(job.stopConfirmed,true);
  assert.ok(job.usage!==null&&Number.isSafeInteger(job.usage)&&job.usage>=0&&job.usage<=job.config.reservation);
  assert.equal(job.inputDigest,sha(runtimeCanonical(job.input)));
  const attempt=run.attempts.find(a=>a.id===job.attemptId);assert.ok(attempt?.settled);
  assert.equal(attempt.purpose,'reasoning');assert.equal(attempt.nodeId,'@supervisor');
  assert.equal(attempt.actual,job.usage);assert.equal(attempt.reservation,job.config.reservation);
  assert.equal(job.completionDigest,sha(runtimeCanonical({usage:job.reportedUsage??job.usage,stopConfirmed:job.stopConfirmed,error:job.error,proofs:job.proofs,threadId:job.threadId,result:job.result})));
  assert.equal(job.identities.length,job.intents.length);
  for(const identity of job.identities){assert.ok(job.intents.some(i=>i.operationId===identity.operationId&&i.ownerToken===identity.ownerToken));assert.equal((await inspectProcess(identity)).status,'stopped');}
  for(const [path,digest]of Object.entries(job.proofs))assert.equal(sha(await readFile(path)),digest);
  const paths=Object.keys(job.proofs).filter(path=>path.endsWith('/result.json'));
  if(!paths.length){assert.equal(job.modelStarted,false);assert.equal(job.usage,0);assert.equal(job.threadId,null);assert.equal(job.identities.length,0);assert.ok(job.error);assert.equal(job.result,null);return;}
  assert.equal(paths.length,1);
  const directory=paths[0]!.slice(0,-'result.json'.length),eventsPath=directory+'events.jsonl';assert.ok(job.proofs[eventsPath]);
  const result=JSON.parse(await readFile(paths[0]!,'utf8')),events=(await readFile(eventsPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const wire=authorWireInput(job.input as PresentedAuthorInput,job.purpose),inputs=events.filter(e=>e.kind==='reasoner-input');
  assert.equal(inputs.length,1);assert.equal(inputs[0].value.id,job.id);assert.equal(inputs[0].value.prompt,wire.prompt);assert.deepEqual(inputs[0].value.outputSchema,wire.outputSchema);
  assert.equal(inputs[0].value.model,job.config.model);assert.equal(inputs[0].value.effort,job.config.effort);
  assert.equal(result.modelStarted,job.modelStarted);assert.equal(result.stopConfirmed,true);assert.equal(result.threadId,job.threadId);
  if(!job.modelStarted){assert.equal(job.usage,0);assert.ok(result.usage===null||result.usage===0);assert.equal(result.turnId,null);assert.ok(job.error);assert.equal(job.result,null);return;}
  assert.ok(result.threadId&&result.turnId);assert.equal(result.usage,job.usage);
  const terminal=events.filter(e=>e.kind==='codex-event'&&e.value?.raw?.method==='turn/completed'&&e.value.raw.params.threadId===result.threadId&&e.value.raw.params.turn.id===result.turnId);
  assert.equal(terminal.length,1);assert.ok(['completed','failed','interrupted'].includes(terminal[0].value.raw.params.turn.status));
  const usage=events.filter(e=>e.kind==='codex-event'&&e.value?.tokenUsage);assert.ok(usage.length);assert.equal(usage.at(-1).value.tokenUsage.total.totalTokens,job.usage);
  if(job.error)assert.equal(job.result,null);else assert.deepEqual(job.result,result.value);
}
