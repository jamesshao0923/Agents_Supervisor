import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,readFile,writeFile,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {startService} from '../../apps/supervisor/server.js';
import {request} from '../../apps/cli/client.js';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {OrchestrationController} from '../../packages/orchestration/controller.js';
import {LocalRuntimeAdapter} from '../../packages/runtime/index.js';
import {readOwnership} from '../../packages/runtime/worker-ownership.js';
import {inspectProcess,terminateProcess,type ProcessIdentity} from '../../packages/process-control/index.js';
import {canonical,assertCandidate,environmentFingerprint} from '../../packages/verification/candidate.js';
import {runtimeCanonical} from '../../packages/persistence/runtime.js';
import {futureVerificationFloor} from '../../packages/domain/index.js';
import {assertAuthorWireProof} from '../../packages/orchestration/author-presentation-proofs.js';
import {diagnoseAcceptanceAuthoringResult,type AcceptanceAuthoringContext} from '../../packages/orchestration/acceptance-authoring.js';
import {assertLegacyControlReviewEvidence} from '../../packages/verification/legacy-review-evidence.js';
import {integrationExecutionPrompt,type IntegrationInputBinding} from '../../packages/contracts/p7-integration-inputs.js';
import {assertAuthorRouteChain} from './supervision-loop-route-checker.js';
import {expectedAuthorRouteConfig} from '../../packages/orchestration/acceptance-authoring-route.js';
import {assertAuthorRouteJob,assertAuthorRouteProof} from '../../packages/orchestration/author-route-binding.js';
import {sha,tierCandidateIds,assertFourTierStimulus,actualModelCompletion,actualReviewModelCompletion,historicalAuthor} from '../helpers/exploration-live-evidence.js';
import type {Request} from '../../packages/contracts/p1.js';
import type {GoalInspection} from '../../packages/contracts/p5.js';
import type {ExplorationInspection} from '../../packages/contracts/p7-exploration.js';
import type {ExplorationTier} from '../../packages/contracts/p7-scheduler.js';
import type {SupervisionInspection} from '../../packages/contracts/p6-supervision-actions.js';

const execute=promisify(execFile);
// These are explicit optional investigations, not four Agents or acceptance
// scores. Their actual model predictions are retained, never corrected here.
export const explorationGoal=`Deliver a minimal offline Node ESM arithmetic project with one original required implementation step id=core. math.mjs exports sum(a,b): finite number inputs add; every non-number or nonfinite value at either argument throws TypeError. math.test.mjs uses real node:assert/strict assertions for 2+3=5, -1+1=0, fractional inputs and NaN, Infinity, -Infinity, strings and null at both positions. Execute node math.test.mjs. Keep exactly one command acceptance criterion id=math target=math.test.mjs covering ALL original functional, invalid-input, actual-test and no-dependency/no-network requirements. Do not invent an iteration strategy, verification worker or integration template; the host adds final integration and independent full P4 remains mandatory. Declare core reads=[] and writes only math.mjs and math.test.mjs; resources=[].
Separately propose optional supplemental investigations in exploration, never turn them into required steps or necessary acceptance criteria. Four concrete independent purposes are available: (1) examine sum commutativity for finite pairs and document actual local examples, a directly relevant high-evidence/high-value property; (2) compare the supplied finite-boundary examples with Number.MAX_VALUE to document a plausible local robustness limitation without altering the required TypeError input contract; (3) examine a speculative relation between signed zero and downstream display, an exploratory idea whose relevance/value is not established; (4) examine an uncorroborated suggestion that arbitrary finite decimal inputs could form a useful exact-money primitive, which is an uncertain lead, never an approved financial claim. These are qualitative evidence/value stimuli, not commanded model scores or independently verified facts. Judge quality and value honestly using the supported uncertain/exploratory/supported/strong vocabulary and cite exact original message quotes; do not invent grounds or promote a weak lead merely to fit a grade. Missing distinct grounds must remain visible instead of fabricated coverage. For each purpose you choose, propose an independent candidate with no optional dependencies, relatedCriterionIds=[math], reads only math.mjs and math.test.mjs, and writes only exploration/<its-id>/files as a canonical tree path with no trailing slash. No external resources, network access, external tools or changes to core files are authorized; ordinary local file reads and Node checks of the declared core inputs are allowed. Each actual optional task writes finding.json inside its own declared exploration/<its-id>/files directory with its question, actual local observations, conclusion, limitations and exact references. Supplemental submissions are untrusted analyses, never votes or independent acceptance. Final integration must read every actually submitted core and optional package, retain the submitted math.mjs bytes, retain all original tests/requirements and may include the supplemental files. Below-tier unstarted investigations may be omitted with a visible host reason; no required behavior may disappear. No artificial delays, installation, publication, self-approval or clarification is needed.`;

test('P7-EXPLORE-L01 real P5 candidates traverse four tiers retain active work and independently deliver every required criterion',{timeout:3_360_000},async t=>{
  const root=await realpath(await mkdtemp('/tmp/sv-p7-tier-')),data=join(root,'d'),workspace=join(root,'project');await mkdir(workspace);
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','p7-exploration-'+randomUUID());await mkdir(evidence,{recursive:true});
  const began=Date.now(),end=began+3_240_000;
  const config={model:process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol',effort:process.env.SUPERVISOR_LIVE_EFFORT??'low',reservation:150_000,timeoutMs:600_000};
  const graphOptions={tier:'low' as const,maxActive:2,maxNodes:8,maxDepth:1,maxDurationMs:1_320_000};
  const store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),orchestration=new OrchestrationController(store,data,runtime,undefined,{graphAdmission:graphOptions});
  let service:Awaited<ReturnType<typeof startService>>|undefined,sessionId:string|undefined,runtimeId:string|undefined,schedulerId:string|undefined,loopId:string|undefined;
  const retained:Record<string,string>={},tierObservations:unknown[]=[];
  const save=(name:string,value:unknown)=>writeFile(join(evidence,name+'.json'),JSON.stringify(value,null,2));
  function events(id:string){const values:ReturnType<SupervisorStore['executionEvents']>=[];let after=0;for(;;){const page=store.executionEvents(id,after);values.push(...page);if(page.length<500)return values;after=page.at(-1)!.seq;}}
  async function proofs(values:Record<string,string>){assert.ok(Object.keys(values).length);for(const [path,digest]of Object.entries(values)){assert.equal(sha(await readFile(path)),digest,path);if(retained[path])assert.equal(retained[path],digest);retained[path]=digest;}}
  async function rpc<T>(method:string,action?:unknown):Promise<T>{const response=await request(data,{id:randomUUID(),method,...(action===undefined?{}:{action})} as Request);if(!response.ok)throw Error(response.error);return response.value as T;}
  async function until<T>(read:()=>T|Promise<T>,done:(v:T)=>boolean,label:string):Promise<T>{for(;;){const v=await read();if(done(v))return v;if(Date.now()>=end){await save('deadline-'+label,v);throw Error('Exploration observer deadline: '+label);}await delay(100);}}
  function state(){return store.runtime.inspect(runtimeId!);}
  function immutableWindow(){const s=state();return canonical({contract:s.run.contract,budget:s.run.budget,attempts:s.run.attempts,operations:s.run.operations,leases:s.run.leases,plan:store.scheduler.get(schedulerId!).plan,claims:store.scheduler.claims(schedulerId!),results:store.taskResults.inspect({projectId:s.run.projectId,runId:s.run.id})});}
  t.after(async()=>{
    const errors:string[]=[],safe=async(name:string,fn:()=>unknown|Promise<unknown>)=>{try{await fn();}catch(error){errors.push(name+': '+String(error));}};
    await safe('original state',()=>save('final-before-cleanup',{goal:sessionId?store.goals.inspect(sessionId):null,runtime:runtimeId?state():null,scheduler:schedulerId?store.scheduler.get(schedulerId):null,tier:schedulerId?store.scheduler.exploration(schedulerId):null,supervision:loopId?store.supervision.get(loopId):null,jobs:loopId?store.supervision.jobs(loopId):[],executions:store.executionList().map(record=>({record,events:events(record.id)})),verification:store.verification.list('job'),deliveries:store.verification.list('delivery'),tierObservations,retained}));
    if(runtimeId&&state().run.status!=='succeeded')await safe('cancel incomplete task',()=>runtime.dispatch({type:'cancel',commandId:randomUUID(),runtimeId:runtimeId!}));
    await safe('service close',async()=>{await service?.close();service=undefined;});await safe('planner close',()=>orchestration.close());await safe('runtime close',()=>runtime.close());
    await safe('owned physical stop',async()=>{
      const ownership=await readOwnership(data),identities=new Map<string,ProcessIdentity>();
      const collect=(value:unknown):void=>{if(!value||typeof value!=='object')return;const v=value as Record<string,unknown>;if(v.version===1&&v.ownerToken&&v.startIdentity&&v.pid)identities.set(String(v.operationId),v as unknown as ProcessIdentity);for(const child of Object.values(v))collect(child);};
      collect(ownership);collect(store.executionList());collect(store.goals.list());collect(store.verification.list('job'));if(loopId)collect(store.supervision.jobs(loopId));
      const stops=[];for(const identity of identities.values()){const observed=await inspectProcess(identity);if(observed.status!=='stopped')await terminateProcess(identity);const actual=await inspectProcess(identity);stops.push({identity,observed,actual});assert.equal(actual.status,'stopped');}await save('actual-cleanup-stops',stops);
      // Physical cleanup cannot invent usage or refund unresolved reservations.
      if(runtimeId){const run=state().run;for(const attempt of run.attempts.filter(a=>!a.settled)){assert.equal(attempt.actual,null);assert.ok(attempt.reservation>0);}await save('original-final-ledger',run);}
    });
    await safe('store close',()=>store.close());await safe('archive complete original root',()=>cp(root,join(evidence,'runtime'),{recursive:true}));await save('cleanup-errors',errors);t.diagnostic(JSON.stringify({root,evidence}));assert.deepEqual(errors,[]);
  });
  await save('scenario',{goal:explorationGoal,config,graphOptions,tokenLimit:1_600_000,verificationReserve:300_000,maxContextChars:200_000,observerMs:3_240_000,testMs:3_360_000,speedupClaim:false,nativeResearchSupported:false});
  await save('environment-preflight',await environmentFingerprint());await orchestration.initialize();
  // Open the real public tier API before work. Its idle P5 controller owns no
  // running job: the configured actual controller below supplies L01 host caps.
  service=await startService(data);
  const capabilities=await rpc<any>('execution',{type:'capabilities'});assert.ok(capabilities.models.some((m:any)=>m.id===config.model&&m.reasoningEfforts.includes(config.effort)));await save('actual-installed-capabilities',capabilities);
  const started=await orchestration.dispatch({type:'start',commandId:randomUUID(),workspace,goal:explorationGoal,tokenLimit:1_600_000,verificationReserve:300_000,maxContextChars:200_000,...config}) as GoalInspection;sessionId=started.session.id;
  const ready=await until(()=>store.goals.inspect(sessionId!),v=>v.session.phase!=='thinking','actual-P5-candidates');await save('actual-planning',ready);
  assert.equal(ready.session.phase,'ready',ready.session.error??canonical(ready));const proposal=ready.session.proposal!;
  assert.equal(proposal.decision,'ready');assert.equal(proposal.iteration,null);assert.equal(proposal.steps.length,1);assert.equal(proposal.steps[0]!.id,'core');
  assert.deepEqual(proposal.criteria.map(c=>({id:c.id,kind:c.kind,target:c.target})),[{id:'math',kind:'command',target:'math.test.mjs'}]);
  assert.ok(!ready.session.research);const candidates=proposal.exploration??[];assertFourTierStimulus(candidates);
  const requiredStepIds=new Set(proposal.steps.map(step=>step.id));
  for(const candidate of candidates){
    assert.equal(new Set(candidate.dependencies).size,candidate.dependencies.length,'Optional dependencies must be unique');
    for(const dependency of candidate.dependencies){assert.notEqual(dependency,candidate.id,'Optional task cannot depend on itself');assert.ok(requiredStepIds.has(dependency),'Optional dependencies may name only actual required P5 steps');}
    assert.deepEqual(candidate.relatedCriterionIds,['math']);assert.ok(candidate.qualityReason.trim()&&candidate.valueReason.trim());for(const source of candidate.sources){const message=ready.session.messages.find(m=>m.id===source.messageId);assert.ok(message&&source.quote&&message.text.includes(source.quote));}}
  for(const job of ready.session.jobs){assert.equal(job.status,'finished');assert.equal(job.error,null);assert.equal(job.stopConfirmed,true);assert.ok(job.usage!==null&&job.usage>0&&job.usage<=job.config.reservation);const actual=await actualModelCompletion(job.proofs);assert.deepEqual(actual.output,job.proposal);assert.deepEqual(actual.result.value,job.proposal);assert.equal(actual.result.threadId,job.threadId);assert.equal(actual.result.usage,job.usage);await proofs(job.proofs);for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');}
  const originalProposal=canonical(proposal),admitted=await orchestration.dispatch({type:'admit',commandId:randomUUID(),sessionId,expectedRevision:ready.session.revision,explorationTier:'low'}) as GoalInspection;
  runtimeId=admitted.session.runtimeId!;schedulerId=admitted.session.graphAdmission!.policy.schedulerId;assert.ok(runtimeId&&schedulerId);
  const plan=store.scheduler.get(schedulerId).plan,planBytes=canonical(plan),contractBytes=canonical(admitted.run.contract),criteriaBytes=canonical(proposal.criteria);
  assert.equal(plan.limits.maxActive,2);assert.equal(plan.limits.maxNodes,8);assert.equal(plan.limits.maxDepth,1);assert.equal(plan.limits.deadlineMs-Date.parse(admitted.session.graphAdmission!.preparation.request.seed.createdAt),1_320_000);
  assert.equal(plan.tasks.filter(task=>task.node.required).length,1);assert.equal(plan.tasks.find(task=>task.node.required)!.node.id,'core');assert.equal(plan.tasks.filter(task=>!task.node.required).length,candidates.length);
  for(const task of plan.tasks.filter(task=>!task.node.required)){
    assert.ok(task.node.dependencies.includes('core'),'Every installed optional task must retain the actual required core input');
    assert.equal(new Set(task.node.dependencies).size,task.node.dependencies.length,'Installed dependencies must be unique');
    for(const dependency of task.node.dependencies){assert.notEqual(dependency,task.node.id);assert.ok(requiredStepIds.has(dependency),'Installed optional tasks cannot depend on optional or unknown nodes');}
  }
  for(const task of plan.tasks){assert.equal(task.step.model,config.model);assert.equal(task.step.effort,config.effort);assert.equal(task.step.reservation,150_000);assert.equal(task.step.timeoutMs,600_000);}
  const sets=Object.fromEntries((['low','medium','high','unlimited'] as const).map(tier=>[tier,tierCandidateIds(plan,candidates,tier)])) as Record<ExplorationTier,string[]>;
  assert.ok(sets.low.length<sets.medium.length&&sets.medium.length<sets.high.length&&sets.high.length<sets.unlimited.length,'Real frozen candidate dependency closure must actually exercise all four boundaries');
  await save('admitted',{admitted,plan,sets,claim:'Model quality/value are predictions, never calibrated semantic facts or success'});
  const core=await until(async()=>{
    const coreExecution=store.executionList().find(e=>e.runId===admitted.run.id&&e.scheduledBinding&&store.scheduler.claimGet(e.scheduledBinding.claimId).taskId==='core');
    if(coreExecution&&['completed','failed','cancelled','unknown'].includes(coreExecution.state))throw Error('Coverage insufficient: core ended before same-input four-tier observation');
    if(!coreExecution?.turnId||coreExecution.stopConfirmed||!coreExecution.identity)return null;
    return (await inspectProcess(coreExecution.identity as ProcessIdentity)).status==='verified'?coreExecution:null;
  },v=>v!==null,'actual-active-core');assert.ok(core);await save('actual-active-core',core);
  const sameWindow=immutableWindow();
  async function setTier(tier:ExplorationTier){
    for(let attempt=0;attempt<5;attempt++){
      const observed=await rpc<ExplorationInspection>('exploration',{type:'inspect',schedulerId});assert.equal(observed.canChangeTier,true);
      const action={type:'set-tier' as const,commandId:randomUUID(),schedulerId:schedulerId!,expected:observed.expected,tier};
      const response=await request(data,{id:randomUUID(),method:'exploration',action});await save('tier-command-'+action.commandId,{action,response});
      if(response.ok)return {action,value:response.value as ExplorationInspection};
      if(!response.error.includes('CAS'))throw Error(response.error);
    }
    throw Error('Coverage insufficient: current CAS window changed repeatedly; no fabricated transition');
  }
  for(const tier of ['low','medium','high','unlimited','low'] as const){
    assert.equal(immutableWindow(),sameWindow,'The same core, budget/reservations, source refs and optional-unstarted window must remain exact');
    assert.equal(store.scheduler.claims(schedulerId).filter(c=>c.taskId!=='core').length,0);
    const changed=await setTier(tier);assert.equal(changed.value.tier,tier);assert.ok(changed.value.decision);
    const actual=changed.value.decision.nodes.filter(n=>plan.tasks.some(task=>task.node.id===n.taskId&&!task.node.required)&&n.admitted).map(n=>n.taskId).sort();assert.deepEqual(actual,sets[tier]);
    assert.equal(changed.value.decision.nodes.find(n=>n.taskId==='core')!.admitted,true,'Required core is preserved at every tier');assert.equal(changed.value.counts.active,1);
    assert.equal(immutableWindow(),sameWindow);assert.equal(canonical(store.scheduler.get(schedulerId).plan),planBytes);
    const repeated=await rpc<ExplorationInspection>('exploration',changed.action);assert.deepEqual(repeated,changed.value,'Same command is exact-once, including original CAS');
    const stale=await request(data,{id:randomUUID(),method:'exploration',action:{...changed.action,commandId:randomUUID()}});assert.equal(stale.ok,false);if(!stale.ok)assert.match(stale.error,/CAS/);
    tierObservations.push({tier,action:changed.action,response:changed.value,exactInputDigest:sha(sameWindow)});
  }
  await save('four-tier-same-input',tierObservations);
  await setTier('unlimited');
  const broader=await until(async()=>{
    if(['blocked','cancelled'].includes(state().runtime.phase))throw Error(state().runtime.error??'Graph stopped before real wider-tier work');
    const execution=store.executionList().find(e=>e.runId===admitted.run.id&&e.scheduledBinding&&!sets.low.includes(store.scheduler.claimGet(e.scheduledBinding.claimId).taskId)&&store.scheduler.claimGet(e.scheduledBinding.claimId).taskId!=='core'&&e.turnId&&!e.stopConfirmed);
    if(!execution?.identity)return null;return (await inspectProcess(execution.identity as ProcessIdentity)).status==='verified'?execution:null;
  },v=>v!==null,'real-optional-active');assert.ok(broader?.scheduledBinding);
  const claim=store.scheduler.claimGet(broader.scheduledBinding.claimId),claimBytes=canonical(claim),before=state(),attemptBefore=before.run.attempts.find(a=>a.id===claim.attemptId)!;
  assert.equal(attemptBefore.settled,false);assert.equal(attemptBefore.actual,null);assert.equal(attemptBefore.reservation,150_000);assert.ok(!sets.low.includes(claim.taskId));
  const physicalBefore=await inspectProcess(broader.identity as ProcessIdentity);assert.equal(physicalBefore.status,'verified');const lower=await setTier('low');
  const afterLower=state();assert.equal(canonical(store.scheduler.claimGet(claim.id)),claimBytes);assert.deepEqual(afterLower.run.attempts.find(a=>a.id===claim.attemptId),attemptBefore);
  assert.equal(afterLower.run.budget.spent,before.run.budget.spent);assert.equal(futureVerificationFloor(afterLower.run),futureVerificationFloor(before.run));
  const stillActive=store.executionGet(broader.id);assert.equal(stillActive.stopConfirmed,false);assert.equal(stillActive.cancelRequested,false);assert.equal(stillActive.threadId,broader.threadId);assert.equal(stillActive.turnId,broader.turnId);assert.equal((await inspectProcess(stillActive.identity as ProcessIdentity)).status,'verified');
  await save('real-active-lowering',{before,execution:broader,physicalBefore,claim,action:lower.action,response:lower.value,after:afterLower,afterExecution:stillActive});
  const workerBefore=await readOwnership(data);assert.ok(workerBefore?.identity);await service.close();service=undefined;service=await startService(data);
  assert.deepEqual((await readOwnership(data))?.identity,workerBefore.identity,'Actual service reopen must retain worker rather than reissue branch turn');
  const reopened=await rpc<ExplorationInspection>('exploration',{type:'inspect',schedulerId});assert.equal(reopened.tier,'low');assert.equal(canonical(store.scheduler.get(schedulerId).plan),planBytes);assert.equal(canonical(store.scheduler.claimGet(claim.id)),claimBytes);
  assert.equal(store.executionList().filter(e=>e.scheduledBinding?.claimId===claim.id).length,1);assert.equal(store.executionGet(broader.id).threadId,broader.threadId);assert.equal(store.executionGet(broader.id).turnId,broader.turnId);assert.ok(state().run.budget.spent>=before.run.budget.spent);
  await save('actual-service-reopen',{reopened,workerBefore,workerAfter:await readOwnership(data)});
  const integrated=await until(()=>state(),v=>['awaiting-verification','blocked','cancelled'].includes(v.runtime.phase),'final-integration');await save('actual-integrated',integrated);
  assert.equal(integrated.runtime.phase,'awaiting-verification',integrated.runtime.error??'');assert.notEqual(integrated.run.status,'succeeded');assert.equal(canonical(integrated.run.contract),contractBytes);assert.equal(canonical(store.goals.inspect(sessionId).session.proposal),originalProposal);
  assert.equal(store.scheduler.get(schedulerId).state,'drained');assert.equal(store.scheduler.get(schedulerId).fence,'released');const completion=await rpc<ExplorationInspection>('exploration',{type:'inspect',schedulerId});assert.equal(completion.canChangeTier,false);assert.ok(completion.completion);
  const claims=store.scheduler.claims(schedulerId),ledger=store.taskResults.inspect({projectId:admitted.run.projectId,runId:admitted.run.id}),executions=store.executionList().filter(e=>e.runId===admitted.run.id);
  assert.equal(ledger.heads.length,claims.length);assert.equal(ledger.versions.length,claims.length);assert.ok(ledger.versions.every(v=>v.state==='submitted'&&v.verification===null));assert.ok(ledger.heads.some(h=>h.taskId===claim.taskId));assert.equal(executions.length,claims.length+1);
  const packaged=[];for(const head of ledger.heads){const pack=store.taskResults.readPublished({projectId:admitted.run.projectId,runId:admitted.run.id,ref:head.ref,minimumState:'submitted'}),actualClaim=claims.find(c=>c.taskId===head.taskId)!;assert.ok(actualClaim);const version=ledger.versions.find(v=>canonical(v.ref)===canonical(head.ref))!;assert.equal(version.manifest.attemptId,actualClaim.attemptId);for(const artifact of version.manifest.artifacts)assert.equal(sha(await readFile(join(pack.directory,'files',artifact.relativePath))),artifact.digest);packaged.push({head,pack,manifest:version.manifest,claim:actualClaim});}
  for(const omitted of completion.completion.unperformedOptional){assert.ok(!claims.some(c=>c.taskId===omitted.taskId));assert.ok(omitted.reason.trim());assert.ok(plan.tasks.some(task=>task.node.id===omitted.taskId&&!task.node.required));}
  assert.ok(store.scheduler.operations(schedulerId).every(o=>o.state==='confirmed'));assert.ok(store.scheduler.leases().every(l=>l.state==='released'));
  const corePackage=packaged.find(p=>p.head.taskId==='core')!;assert.equal(await readFile(join(corePackage.pack.directory,'files','math.mjs'),'utf8'),await readFile(join(workspace,'math.mjs'),'utf8'));
  await execute(process.execPath,['math.test.mjs'],{cwd:workspace,timeout:10000});
  await execute(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';import{sum}from './math.mjs';assert.equal(sum(2,3),5);assert.equal(sum(-1,1),0);assert.equal(sum(0.5,0.25),0.75);for(const bad of [NaN,Infinity,-Infinity,'3',null]){assert.throws(()=>sum(bad,1),TypeError);assert.throws(()=>sum(1,bad),TypeError);}"],{cwd:workspace,timeout:10000});
  for(const execution of executions){
    assert.equal(execution.state,'completed',execution.error??execution.message);assert.equal(execution.error,null);assert.equal(execution.stopConfirmed,true);assert.equal(execution.usageStatus,'reported');assert.ok(execution.usage&&execution.usage.totalTokens>0&&execution.usage.totalTokens<=execution.reservation);
    assert.equal((await inspectProcess(execution.identity as ProcessIdentity)).status,'stopped');const actualEvents=events(execution.id),terminal=actualEvents.filter(e=>e.kind==='codex-event'&&(e.payload as any).raw?.method==='turn/completed').map(e=>(e.payload as any).raw.params);
    assert.equal(terminal.length,1);assert.equal(terminal[0].threadId,execution.threadId);assert.equal(terminal[0].turn.id,execution.turnId);assert.equal(terminal[0].turn.status,'completed');assert.equal(terminal[0].turn.items.filter((item:{type:string})=>item.type==='agentMessage').at(-1)?.text,execution.message);
    const usage=actualEvents.filter(e=>e.kind==='codex-event'&&(e.payload as any).tokenUsage);assert.equal((usage.at(-1)!.payload as any).tokenUsage.total.totalTokens,execution.usage.totalTokens);
    const attempt=integrated.run.attempts.find(a=>a.id===execution.attemptId)!;assert.ok(attempt.settled);assert.equal(attempt.actual,execution.usage.totalTokens);assert.equal(attempt.reservation,execution.reservation);
    if(execution.scheduledBinding){assert.ok(execution.candidateSnapshot);assert.equal(sha(await readFile(execution.candidateSnapshot.path)),execution.candidateSnapshot.digest);}await save('actual-execution-'+execution.id,{execution,events:actualEvents});
  }
  const integration=executions.find(e=>e.runtimeBinding)!;assert.ok(integration);
  const integrationId='integration-'+sha(canonical({schedulerId,planDigest:store.scheduler.get(schedulerId).planDigest,runtimeId,integrationNodeId:plan.integrationNodeId}));
  const indexPath=join(workspace,'.supervisor','integration-inputs',integrationId,'manifest.json'),indexBytes=await readFile(indexPath);
  const inputReceipt=JSON.parse(indexBytes.toString()) as {runtimeId:string;planDigest:string;contractDigest:string;inputs:{binding:IntegrationInputBinding['inputBindings'][number];directory:string;manifest:any}[]};
  assert.equal(inputReceipt.runtimeId,runtimeId);assert.equal(inputReceipt.planDigest,store.scheduler.get(schedulerId).planDigest);assert.equal(inputReceipt.contractDigest,sha(contractBytes));
  assert.deepEqual(inputReceipt.inputs.map(item=>item.binding.dependencyNodeId),plan.tasks.filter(task=>claims.some(c=>c.taskId===task.node.id)).map(task=>task.node.id));
  const binding:IntegrationInputBinding={schemaVersion:1,id:integrationId,schedulerId,runtimeId,integrationNodeId:plan.integrationNodeId,projectId:admitted.run.projectId,runId:admitted.run.id,planDigest:store.scheduler.get(schedulerId).planDigest,contractVersion:admitted.run.contract.version,contractDigest:sha(contractBytes),workspace,inputBindings:inputReceipt.inputs.map(item=>item.binding)};
  const framing=integrationExecutionPrompt('',binding),references='\nFrozen references: ',prefix=framing.slice(0,framing.lastIndexOf(references)+references.length),offset=integration.prompt.lastIndexOf('\n\nHost-provided final integration inputs:\n');
  assert.ok(offset>=0);assert.equal(integration.prompt.slice(offset,offset+prefix.length),prefix);assert.deepEqual(JSON.parse(integration.prompt.slice(offset+prefix.length)),binding.inputBindings);
  for(const item of inputReceipt.inputs){const version=ledger.versions.find(v=>canonical(v.ref)===canonical(item.binding.result))!;assert.ok(version);assert.deepEqual(item.manifest,version.manifest);assert.equal(sha(canonical(item.manifest)),item.binding.result.manifestDigest);for(const artifact of version.manifest.artifacts)assert.equal(sha(await readFile(join(indexPath,'..',item.directory,artifact.relativePath))),artifact.digest);}
  const frozenExecutionBytes=canonical(executions.map(e=>({execution:e,events:events(e.id)})));await save('submitted-and-final-inputs',{packaged,ledger,completion,inputReceipt,integration});
  const attached=await rpc<SupervisionInspection>('supervision',{type:'attach',commandId:randomUUID(),runtimeId,config,limits:{maxRepairs:0,maxReasoningCalls:12,maxDurationMs:1_320_000,maxContextChars:200_000}});loopId=attached.loop.id;
  const delivered=await until(()=>rpc<SupervisionInspection>('supervision',{type:'inspect',loopId}),v=>v.loop.stopped||['complete','blocked'].includes(v.loop.phase),'automatic-independent-P4');await save('actual-delivered',delivered);
  assert.equal(delivered.loop.phase,'complete',delivered.loop.reason??'');assert.equal(delivered.loop.repairCount,0);assert.equal(delivered.runtime.run.status,'succeeded');assert.equal(canonical(delivered.runtime.run.contract),contractBytes);assert.equal(canonical(store.goals.inspect(sessionId).session.proposal!.criteria),criteriaBytes);assert.equal(canonical(store.scheduler.get(schedulerId).plan),planBytes);
  assert.equal(canonical(store.executionList().filter(e=>e.runId===admitted.run.id).map(e=>({execution:e,events:events(e.id)}))),frozenExecutionBytes,'P4 must retain original execution events/results');
  const authors=delivered.jobs.filter(j=>j.purpose==='acceptance-authoring'),routes=store.authorRouting.routes(loopId),current=authors.find(j=>j.id===delivered.loop.references.authorJobId)!;assert.ok(current);assert.equal(current.error,null);assertAuthorRouteChain(authors,routes,current.id);
  for(const job of delivered.jobs){assert.equal(job.purpose,'acceptance-authoring');await historicalAuthor(job,delivered.runtime.run);await proofs(job.proofs);}
  const authorInput=current.input as {context:{acceptance:AcceptanceAuthoringContext}};assert.equal(diagnoseAcceptanceAuthoringResult(current.result,authorInput.context.acceptance),null);const authorProof=await actualModelCompletion(current.proofs);assert.deepEqual(authorProof.output,current.result);assert.deepEqual(authorProof.result.value,current.result);assert.equal(authorProof.result.threadId,current.threadId);assert.equal(authorProof.result.usage,current.usage);assertAuthorWireProof(current,join(data,'supervision-reasoning',sha(current.id)));
  for(const route of routes){const previous=authors.find(j=>j.id===route.rejection.previousJobId)!,next=authors.find(j=>j.id===route.nextJobId)!;assert.ok(previous&&next);assert.equal(route.nextInputDigest,next.inputDigest);assert.equal(route.contractDigest,sha(contractBytes));assert.equal(route.rejection.jobDigest,sha(runtimeCanonical(previous)));assert.equal(route.rejection.inputDigest,previous.inputDigest);assert.equal(sha(await readFile(route.rejection.rawOutputPath)),route.rejection.rawOutputDigest);assert.equal(next.config.reservation,previous.config.reservation);
    assert.deepEqual(route.baseline,previous.config);assert.deepEqual(route.selected,next.config);
    assertAuthorRouteJob(route,next,delivered.loop);
    if(route.schemaVersion===1){
      assert.equal(next.config.timeoutMs,previous.config.timeoutMs);
    }else{
      assert.equal(route.schemaVersion,2);
      assert.deepEqual(next.config,expectedAuthorRouteConfig(route));
      assert.ok(next.config.timeoutMs<=previous.config.timeoutMs);
      assert.equal(route.authorization.absoluteDeadlineMs,Date.parse(delivered.loop.createdAt)+delivered.loop.limits.maxDurationMs);
      if(next.modelStarted)assertAuthorRouteProof(route,next,join(data,'supervision-reasoning',sha(next.id)));
    }
}
  const head=store.verification.headForRun(admitted.run.projectId,admitted.run.id)!;assert.ok(head);await assertCandidate(head.candidate,false);
  const review=delivered.verification.jobs.find(j=>j.kind==='review'&&j.approved)!;assert.ok(review&&review.modelStarted&&!review.error);assert.equal(review.proposalId,head.id);assert.equal(review.stopConfirmed,true);assert.equal(review.usageUnknown,false);
  assert.deepEqual(review.controls.map(c=>c.id).sort(),head.spec.controls.map(c=>c.id).sort());assert.ok(review.controls.length>=2&&review.controls.every(c=>c.passed&&c.results.length&&c.results.every(r=>r.executionStatus==='executed')));assert.ok(head.spec.controls.some(c=>c.expect==='passed')&&head.spec.controls.some(c=>c.expect==='failed'));
  assertLegacyControlReviewEvidence({dataDir:data,proposal:head,review});
  const reviewProof=await actualReviewModelCompletion(data,review);assert.equal(reviewProof.output.verdict,'passed');assert.deepEqual(reviewProof.output,{verdict:reviewProof.result.verdict,reason:reviewProof.result.reason,observations:reviewProof.result.observations});assert.equal(reviewProof.result.usage,review.usage);assert.notEqual(reviewProof.result.threadId,authorProof.result.threadId);assert.ok(executions.every(e=>e.threadId!==reviewProof.result.threadId&&e.threadId!==authorProof.result.threadId));
  const final=delivered.verification.jobs.find(j=>j.kind==='verification'&&j.approved)!;assert.ok(final?.planId);assert.equal(final.error,null);assert.equal(final.stopConfirmed,true);assert.equal(final.usageUnknown,false);assert.equal(final.evaluation?.complete,true);assert.ok(final.results.length&&final.results.every(r=>r.executionStatus==='executed'&&r.checks.every(c=>c.verdict==='passed'||c.verdict==='not-applicable')));
  const finalPlan=store.verification.get('plan',final.planId);assert.equal(finalPlan.selection.mode,'final');assert.equal(finalPlan.selection.completeScope,true);assert.deepEqual(finalPlan.selection.excludedCaseIds,[]);assert.equal(finalPlan.proposalId,head.id);assert.equal(finalPlan.definitionDigest,head.bundle.digest);assert.equal(finalPlan.contractDigest,sha(contractBytes));await assertCandidate(finalPlan.candidate);
  assert.equal(delivered.verification.deliveries.length,1);const delivery=delivered.verification.deliveries[0]!;assert.equal(delivery.jobId,final.id);assert.equal(delivery.planId,finalPlan.id);assert.equal(delivery.candidateDigest,finalPlan.candidate.digest);assert.equal(delivery.definitionDigest,finalPlan.definitionDigest);
  for(const job of delivered.verification.jobs){assert.equal(job.status,'finished');assert.equal(job.stopConfirmed,true);assert.equal(job.usageUnknown,false);assert.ok(job.usage>=0&&job.usage<=job.config.reservation);await proofs(job.proofs);for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');const a=delivered.runtime.run.attempts.find(a=>a.id===job.attemptId)!;assert.ok(a.settled);assert.equal(a.actual,job.usage);}
  const run=delivered.runtime.run;assert.equal(run.budget.limit,1_600_000);assert.equal(run.budget.verificationReserve,300_000);assert.ok(run.attempts.every(a=>a.settled&&a.actual!==null));assert.equal(run.budget.spent,run.attempts.reduce((sum,a)=>sum+a.actual!,0));assert.ok(run.budget.spent>0&&run.budget.spent<=run.budget.limit);assert.ok(run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released));
  const billing=[...ready.session.jobs.map(j=>({attemptId:j.attemptId,usage:j.usage})),...executions.map(e=>({attemptId:e.attemptId,usage:e.usage!.totalTokens})),...delivered.jobs.map(j=>({attemptId:j.attemptId,usage:j.usage})),...delivered.verification.jobs.map(j=>({attemptId:j.attemptId,usage:j.usage}))];assert.equal(new Set(billing.map(b=>b.attemptId)).size,billing.length);assert.equal(run.attempts.length,billing.length);assert.equal(run.budget.spent,billing.reduce((sum,b)=>sum+b.usage!,0));for(const item of billing)assert.equal(run.attempts.find(a=>a.id===item.attemptId)!.actual,item.usage);
  for(const [path,digest]of Object.entries(retained))assert.equal(sha(await readFile(path)),digest);
  await save('acceptance',{delivery,head,budget:run.budget,billing,tierObservations,completion,actualAttemptedOptional:claims.filter(c=>c.taskId!=='core').map(c=>c.taskId),elapsedMs:Date.now()-began,independentReview:reviewProof.output,efficiencyClaim:false,qualityCalibrationClaim:false,nativeResearchSupported:false});
});
