import {withinTokenReservation} from '../contracts/token-policy.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, sep, join, basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SupervisionRoutingPolicy, RoutingCapabilities, SupervisionProgressRound, SupervisionRouteReceipt } from '../contracts/p6-routing.js';
import type { SupervisionJob } from '../contracts/p6-supervision.js';
import { applyAction } from '../domain/index.js';
import { safeMonitorJSON } from '../contracts/p6-monitor.js';
import { SupervisionRepository } from './supervision.js';
import { RuntimeRepository, runtimeCanonical as canonical } from './runtime.js';
import { VerificationRepository } from './verification.js';
import { ConversationRepository } from './conversations.js';
import { assertDefinition } from '../verification/definition.js';
import { evaluateVerification, selectInstances } from '../verification/rules.js';
import { assertCandidate, canonical as verificationCanonical, scanCandidate, exclusions } from '../verification/candidate.js';
import type { ExecutionRecord } from '../contracts/p2.js';
import { inspectProcess, type ProcessIdentity } from '../process-control/index.js';
import { readRoutingCapabilities } from '../orchestration/supervision-routing-capabilities.js';
import { routeModel, updateNoProgress, createNoProgressState, REASONING_EFFORTS, type ProgressObservation, type ReasoningEffort } from '../orchestration/loop-policy.js';

export { SUPERVISION_ROUTING_MIGRATION_SQL } from './schema13.js';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const hash=(v:unknown)=>sha(canonical(v));
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function ensure(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
function integer(v:number,min=0){ensure(Number.isSafeInteger(v)&&v>=min,'Invalid routing integer');}
export function validateRoutingPolicy(input:SupervisionRoutingPolicy):SupervisionRoutingPolicy {
  safeMonitorJSON(input);ensure(Object.keys(input).sort().join(',')==='blockAfter,capabilityMaxAgeMs,diagnoseAfter,firstFailureEffort,models,preference,repeatedFailureEffort,schemaVersion,version'&&input.schemaVersion===1&&input.preference==='quality-first'&&typeof input.version==='string'&&input.version.trim()&&input.version.length<=200,'Invalid host routing policy');
  integer(input.diagnoseAfter,2);integer(input.blockAfter,input.diagnoseAfter+1);integer(input.capabilityMaxAgeMs,1000);ensure(input.capabilityMaxAgeMs<=3600000,'Capability freshness bound too large');
  ensure(REASONING_EFFORTS.includes(input.firstFailureEffort)&&REASONING_EFFORTS.includes(input.repeatedFailureEffort)&&REASONING_EFFORTS.indexOf(input.repeatedFailureEffort)>=REASONING_EFFORTS.indexOf(input.firstFailureEffort),'Invalid policy effort');
  ensure(input.models.length>0&&input.models.length<=128&&new Set(input.models.map(m=>m.id)).size===input.models.length,'Invalid policy model table');
  for(const m of input.models){ensure(Object.keys(m).sort().join(',')==='id,qualityRank'&&typeof m.id==='string'&&m.id.trim()&&m.id.length<=200,'Policy accepts exact model identifiers only');integer(m.qualityRank);}
  return structuredClone(input);
}
function frozenFiles(directory:string):Record<string,string>{
 const root=realpathSync(directory),files:Record<string,string>={};let bytes=0;
 const walk=(dir:string):void=>{for(const name of readdirSync(dir).sort()){if(exclusions.includes(name))continue;const path=join(dir,name),info=lstatSync(path);ensure(!info.isSymbolicLink(),'Routing candidate has an unsupported symlink');if(info.isDirectory())walk(path);else{ensure(info.isFile(),'Routing candidate file is unsupported');bytes+=info.size;ensure(bytes<=256*1024*1024&&Object.keys(files).length<10000,'Routing candidate exceeds bounded capacity');files[relative(root,path).split(sep).join('/')]=createHash('sha256').update(readFileSync(path)).update('\0executable:'+String(info.mode&0o111)).digest('hex');}}};walk(root);return files;
}
export interface BeginRoutedDiagnosis {commandId:string;loopId:string;failureJobId:string;capabilities:RoutingCapabilities;input:unknown}
export class SupervisionRoutingRepository {
  private readonly supervision:SupervisionRepository;private readonly runtime:RuntimeRepository;private readonly verification:VerificationRepository;private readonly policy:SupervisionRoutingPolicy;
  /** Policy is host-owned constructor configuration, never part of model JSON or IPC. */
  constructor(private readonly db:DatabaseSync,private readonly dataDir:string,policy:SupervisionRoutingPolicy){this.supervision=new SupervisionRepository(db);this.runtime=new RuntimeRepository(db);this.verification=new VerificationRepository(db);this.policy=validateRoutingPolicy(policy);}
  transaction<T>(body:()=>T):T{return this.supervision.transaction(body);}
  private policyBinding(loopId:string){const row=this.db.prepare('SELECT record FROM supervision_routing_policies WHERE loop_id=?').get(loopId);if(row)ensure(row.record===canonical(this.policy),'Routing policy changed for an existing loop; explicit migration required');else this.db.prepare('INSERT INTO supervision_routing_policies(loop_id,record) VALUES (?,?)').run(loopId,canonical(this.policy));}
  rounds(loopId:string):SupervisionProgressRound[]{this.supervision.get(loopId);return this.db.prepare('SELECT record FROM supervision_progress_rounds WHERE loop_id=? ORDER BY rowid').all(loopId).map(r=>JSON.parse(String(r.record)) as SupervisionProgressRound);}
  routes(loopId:string):SupervisionRouteReceipt[]{this.supervision.get(loopId);return this.db.prepare('SELECT record FROM supervision_routes WHERE loop_id=? ORDER BY rowid').all(loopId).map(r=>JSON.parse(String(r.record)) as SupervisionRouteReceipt);}
  private proofs(proofs:Record<string,string>){const root=realpathSync(this.dataDir),entries=Object.entries(proofs);ensure(entries.length>0&&entries.length<=2048,'Missing bounded actual verification proofs');let bytes=0;
    for(const [path,digest]of entries){const actual=realpathSync(path),info=lstatSync(path),suffix=relative(root,actual);ensure(path===actual&&isAbsolute(path)&&info.isFile()&&!info.isSymbolicLink()&&suffix&&!isAbsolute(suffix)&&suffix!=='..'&&!suffix.startsWith('..'+sep),'Verification proof escaped routing data root');bytes+=info.size;ensure(bytes<=64*1024*1024&&sha(readFileSync(path))===digest,'Verification proof changed or exceeds capacity');}}
  private actual(loopId:string,jobId:string){
    const loop=this.supervision.get(loopId),job=this.verification.get('job',jobId),plan=this.verification.get('plan',job.planId!),proposal=this.verification.get('proposal',plan.proposalId),{run}=this.runtime.inspect(loop.runtimeId);
    ensure(job.kind==='verification'&&job.runtimeId===loop.runtimeId&&job.projectId===loop.projectId&&job.runId===loop.runId&&job.status==='finished'&&job.stopConfirmed&&!job.usageUnknown&&!job.error&&Number.isSafeInteger(job.usage)&&job.usage>=0&&withinTokenReservation(run.budget.limit,job.usage,job.config.reservation),'Progress requires a finished known actual product verification');
    ensure(plan.runtimeId===loop.runtimeId&&plan.runId===loop.runId&&plan.projectId===loop.projectId&&job.planId===plan.id&&job.proposalId===proposal.id&&proposal.status==='published'&&plan.contractDigest===sha(verificationCanonical(run.contract))&&proposal.contractDigest===plan.contractDigest&&hash(run.contract)===loop.contractDigest&&plan.definitionDigest===proposal.bundle.digest&&job.environmentDigest===plan.environmentDigest,'Progress contract/definition/environment binding changed');
    const attempt=run.attempts.find(a=>a.id===job.attemptId);ensure(attempt?.purpose==='verification'&&attempt.settled&&attempt.status!=='running'&&attempt.actual===job.usage&&attempt.reservation===job.config.reservation&&attempt.contractVersion===run.contract.version&&run.leases.every(l=>l.attemptId!==attempt.id||l.released),'Progress usage is not actually settled');
    ensure(job.intents.length===job.identities.length&&new Set(job.identities.map(i=>i.operationId)).size===job.identities.length&&job.identities.every(i=>job.intents.some(t=>t.operationId===i.operationId&&t.ownerToken===i.ownerToken)),'Progress process history is unresolved');
    ensure(job.identities.length>0,'Progress has no actual verifier process');
    ensure(same(plan.selection,selectInstances(proposal.spec,{mode:'final'}))&&plan.selection.completeScope&&job.results.length===plan.selection.instances.length&&new Set(job.results.map(r=>r.instanceId)).size===job.results.length,'No-progress rounds require exact complete final selection');
    for(const instance of plan.selection.instances){const result=job.results.find(r=>r.instanceId===instance.id);ensure(result?.executionStatus==='executed'&&result.checks.length===instance.obligationIds.length&&new Set(result.checks.map(c=>c.obligationId)).size===result.checks.length&&instance.obligationIds.every(id=>result.checks.some(c=>c.obligationId===id&&['passed','failed','not-applicable'].includes(c.verdict))),'Unknown, incomplete or tooling result cannot count as product progress');}
    ensure(same(job.evaluation,evaluateVerification(proposal.spec,plan.selection,job.results)),'Actual verification evaluation changed');this.proofs(job.proofs);
    const reports=Object.keys(job.proofs).filter(path=>basename(path)==='report.json'&&same(JSON.parse(readFileSync(path,'utf8')),{results:job.results,controls:job.controls,evaluation:job.evaluation,error:job.error}));ensure(reports.length===1,'Progress lacks its exact original aggregate verification report');
    ensure(job.results.every(r=>(r.proofFiles??[]).length>0&&(r.proofFiles??[]).every(path=>Object.hasOwn(job.proofs,path))),'Progress result proof references are missing');
    const normalized=plan.selection.instances.map(i=>({id:i.id,caseId:i.caseId,revision:i.revision,parameters:i.parameters,checks:job.results.find(r=>r.instanceId===i.id)!.checks.map(c=>({obligationId:c.obligationId,verdict:c.verdict})).sort((a,b)=>a.obligationId.localeCompare(b.obligationId))})).sort((a,b)=>a.id.localeCompare(b.id));
    const required=proposal.spec.obligations.filter(o=>o.required&&o.applicable),failed=required.filter(o=>normalized.some(r=>r.checks.some(c=>c.obligationId===o.id&&c.verdict==='failed'))).map(o=>o.id).sort();
    const verification=run.contract.criteria.filter(c=>c.required).map(c=>{const obligations=required.filter(o=>o.criterionId===c.id);ensure(obligations.length>0,'Progress has uncovered original criteria');const checks=normalized.map(i=>({...i,checks:i.checks.filter(x=>obligations.some(o=>o.id===x.obligationId))})).filter(i=>i.checks.length);const outcome=checks.some(i=>i.checks.some(x=>x.verdict==='failed'))?'failed' as const:'passed' as const;return {criterionId:c.id,outcome,evidenceDigest:hash(checks)};});
    const observation:ProgressObservation={failureFingerprints:failed.map(id=>hash({obligation:required.find(o=>o.id===id),instances:normalized.filter(i=>i.checks.some(c=>c.obligationId===id))})),passedRequiredCriteria:verification.filter(v=>v.outcome==='passed').map(v=>v.criterionId),verification,artifacts:Object.entries(plan.candidate.files).map(([path,digest])=>({path,digest}))};
    return {loop,job,plan,proposal,run,observation,failed};
  }
  async observeVerification(loopId:string,jobId:string):Promise<SupervisionProgressRound>{
    ensure(!this.db.isTransaction,'Progress physical check cannot hold caller transaction');
    const existing=this.rounds(loopId).find(r=>r.verificationJobId===jobId);if(existing)return existing;
    const before=this.actual(loopId,jobId);ensure(before.loop.references.verificationJobId===jobId,'Only the current actual verification can create a new progress round');await assertDefinition(before.proposal.spec,before.proposal.bundle);await assertCandidate(before.plan.candidate,false);for(const identity of before.job.identities)ensure((await inspectProcess(identity)).status==='stopped','Verifier is not physically stopped');
    const candidateFiles=await scanCandidate(before.plan.candidate.tree);
    return this.transaction(()=>{const existing=this.rounds(loopId).find(r=>r.verificationJobId===jobId);if(existing)return existing;this.policyBinding(loopId);const now=this.actual(loopId,jobId);ensure(hash(now.job)===hash(before.job)&&same(now.plan,before.plan)&&same(candidateFiles,now.plan.candidate.files)&&same(frozenFiles(now.plan.candidate.tree),now.plan.candidate.files),'Progress evidence changed across physical check');
      const previous=this.rounds(loopId).filter(r=>r.contractDigest===now.loop.contractDigest).at(-1),decision=updateNoProgress(previous?.decision.state??createNoProgressState(),now.observation,this.policy);
      const record:SupervisionProgressRound={id:'progress-'+sha(jobId).slice(0,24),loopId,contractDigest:now.loop.contractDigest,verificationJobId:jobId,jobDigest:hash(now.job),planDigest:hash(now.plan),candidateDigest:now.plan.candidate.digest,observation:now.observation,policyDigest:hash(this.policy),decision,recordedAt:new Date().toISOString()};this.db.prepare('INSERT INTO supervision_progress_rounds(id,loop_id,contract_digest,job_id,record) VALUES (?,?,?,?,?)').run(record.id,loopId,record.contractDigest,jobId,canonical(record));return record;});
  }
  /** Read exact actual job/candidate/proofs outside a transaction, then reserve through beginDiagnosis. */
  async assertFailureBoundary(loopId:string,jobId:string):Promise<void>{
    const value=this.actual(loopId,jobId);this.supervision.assertEligible(loopId);ensure(value.failed.length>0,'Routing requires an actual necessary product failure');
    ensure(value.run.attempts.every(a=>a.settled&&a.status!=='running')&&value.run.operations.every(o=>o.status==='confirmed')&&value.run.leases.every(l=>l.released),'Routing requires settled original attempts and resolved effects');
    const workspace=this.runtime.get(value.loop.runtimeId).workspace,overlap=(a:string)=>a===workspace||a.startsWith(workspace+sep)||workspace.startsWith(a+sep);
    const executions=this.db.prepare('SELECT record FROM executions').all().map(r=>JSON.parse(String(r.record)) as ExecutionRecord).filter(e=>overlap(e.workspace));
    const verifiers=this.verification.list('job').filter(j=>overlap(j.workspace)),reasoners=this.supervision.jobs(loopId);
    ensure(executions.every(e=>e.stopConfirmed&&e.usageStatus==='reported'&&e.usage!==null&&['completed','failed','cancelled','interrupted'].includes(e.state))&&verifiers.every(j=>j.status==='finished'&&j.stopConfirmed&&!j.usageUnknown)&&reasoners.every(j=>j.status==='finished'&&j.stopConfirmed&&j.usage!==null),'Routing has unresolved workspace/model accounting');
    await assertDefinition(value.proposal.spec,value.proposal.bundle);await assertCandidate(value.plan.candidate);for(const identity of [...executions.flatMap(e=>e.identity?[e.identity as ProcessIdentity]:[]),...verifiers.flatMap(j=>j.identities),...reasoners.flatMap(j=>j.identities)])ensure((await inspectProcess(identity)).status==='stopped','A routed boundary process remains physically active');
    ensure(hash(this.actual(loopId,jobId).job)===hash(value.job),'Failure changed during physical boundary check');
  }
  beginDiagnosis(input:BeginRoutedDiagnosis):{receipt:SupervisionRouteReceipt;job:SupervisionJob}{return this.transaction(()=>{
    safeMonitorJSON(input.input);ensure(typeof input.commandId==='string'&&input.commandId.trim()&&input.commandId.length<=200,'Invalid route command');
    const prior=this.db.prepare('SELECT request,record FROM supervision_routes WHERE command_id=?').get(input.commandId);if(prior){ensure(prior.request===canonical(input),'Conflicting route commandId');const receipt=JSON.parse(String(prior.record)) as SupervisionRouteReceipt;return {receipt,job:this.supervision.job(receipt.reasoningJobId)};}
    this.policyBinding(input.loopId);ensure(!this.routes(input.loopId).some(r=>r.failureJobId===input.failureJobId),'Failure already has a routed diagnosis; recover its original job');
    const value=this.actual(input.loopId,input.failureJobId),loop=value.loop;this.supervision.assertEligible(loop.id);ensure(value.failed.length>0&&loop.phase==='verifying'&&loop.references.verificationJobId===value.job.id,'Route does not bind the current actual product failure');
    const runtime=this.runtime.get(loop.runtimeId);ensure(!runtime.paused&&!runtime.cancelled&&runtime.phase==='awaiting-verification','Route requires a safe original execution boundary');
    ensure(!new ConversationRepository(this.db).hasPendingForRun(loop.projectId,loop.runId),'Pending follow-up prevents routing');
    ensure(same(frozenFiles(value.plan.candidate.tree),value.plan.candidate.files)&&same(frozenFiles(value.plan.candidate.root),value.plan.candidate.files),'Routing candidate differs from actual failure evidence');
    const round=this.rounds(loop.id).find(r=>r.verificationJobId===value.job.id);ensure(round&&round.jobDigest===hash(value.job)&&round.planDigest===hash(value.plan),'Routing lacks the exact deduplicated actual failure round');ensure(!round.decision.exhausted,'Bounded repeated product failures exhausted the no-progress policy');
    const actual=readRoutingCapabilities(this.dataDir,input.capabilities),age=Date.now()-Date.parse(actual.checkedAt);ensure(age>=0&&age<=this.policy.capabilityMaxAgeMs,'Routing capability snapshot is stale or from the future');
    const promptInput=input.input as {prompt?:unknown;outputSchema?:unknown;context?:unknown};ensure(Object.keys(promptInput).sort().join(',')==='context,outputSchema,prompt'&&typeof promptInput.prompt==='string'&&promptInput.prompt.trim()&&canonical(input.input).length+6000<=loop.limits.maxContextChars&&promptInput.prompt.length+canonical(promptInput.outputSchema).length<=loop.limits.maxContextChars,'Complete routing context exceeds maxContextChars or has invalid shape; no truncation');
    const context=promptInput.context as {failure?:{kind?:string;jobId?:string;planId?:string;failedObligationIds?:string[]};acceptance?:{contract?:unknown};candidate?:{digest?:string;files?:unknown}};
    ensure(context?.failure?.kind==='verification'&&context.failure.jobId===value.job.id&&context.failure.planId===value.plan.id&&same([...(context.failure.failedObligationIds??[])].sort(),value.failed)&&same(context.acceptance?.contract,value.run.contract)&&context.candidate?.digest===value.plan.candidate.digest&&same(context.candidate.files,value.plan.candidate.files),'Routed prompt does not bind original failure, full contract and candidate');
    const baseline=this.routes(loop.id).filter(r=>r.contractDigest===loop.contractDigest).at(-1)?.selected??loop.config,baselineModel=this.policy.models.find(m=>m.id===baseline.model);ensure(baselineModel&&REASONING_EFFORTS.includes(baseline.effort as ReasoningEffort),'Original model/effort has no explicit host preference');
    const requested=round.decision.diagnosisDue?this.policy.repeatedFailureEffort:this.policy.firstFailureEffort,effort=REASONING_EFFORTS[Math.max(REASONING_EFFORTS.indexOf(requested),REASONING_EFFORTS.indexOf(baseline.effort as ReasoningEffort))]!;
    const capabilities=actual.models.filter(m=>m.inputModalities.includes('text')&&this.policy.models.some(p=>p.id===m.id)).map(m=>({id:m.id,available:true,qualityRank:this.policy.models.find(p=>p.id===m.id)!.qualityRank,supportedEfforts:m.reasoningEfforts as ReasoningEffort[]}));
    // Use the actual pure domain budget gate, not a model-supplied budgetAllowed flag.
    applyAction(value.run,{type:'startAttempt',attemptId:'routing-budget-check-'+sha(input.commandId).slice(0,24),nodeId:'@supervisor',contractVersion:value.run.contract.version,purpose:'reasoning',reservation:loop.config.reservation,resources:[]});
    const decision=routeModel({capabilities,complexity:'complex',purpose:'diagnosis',requiredEffort:effort,minimumQualityRank:baselineModel.qualityRank,current:{model:baseline.model,effort:baseline.effort as ReasoningEffort},safeBoundary:true,budgetAllowed:true});ensure(decision.action==='select'&&decision.selection,'No advertised model/effort meets the host quality policy: '+decision.reason);
    // Unknown token capacity remains unknown. Only the existing hard character
    // bound is enforced; this does not claim automatic context expansion.
    const selected={...loop.config,...decision.selection};ensure(selected.reservation===loop.config.reservation&&selected.timeoutMs===loop.config.timeoutMs,'Routing cannot enlarge a model budget or deadline');
    const capRecord=this.db.prepare('SELECT record FROM supervision_routing_capabilities WHERE id=?').get(input.capabilities.id);if(capRecord)ensure(capRecord.record===canonical(input.capabilities),'Capability receipt conflict');else this.db.prepare('INSERT INTO supervision_routing_capabilities(id,record) VALUES (?,?)').run(input.capabilities.id,canonical(input.capabilities));
    const job=this.supervision.beginJob({commandId:input.commandId+':job',loopId:loop.id,expectedRevision:loop.revision,purpose:'diagnosis',context:input.input,config:selected});
    const receipt:SupervisionRouteReceipt={id:'route-'+sha(input.commandId).slice(0,24),commandId:input.commandId,loopId:loop.id,contractDigest:loop.contractDigest,failureJobId:value.job.id,progressRoundId:round.id,policy:structuredClone(this.policy),policyDigest:hash(this.policy),capabilityId:input.capabilities.id,capabilityDigest:hash(input.capabilities),inputDigest:hash(input.input),baseline,selected,decision,reason:'supervisor-quality-policy-after-product-failure',reasoningJobId:job.id,createdAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO supervision_routes(id,command_id,loop_id,failure_job_id,request,record) VALUES (?,?,?,?,?,?)').run(receipt.id,input.commandId,loop.id,value.job.id,canonical(input),canonical(receipt));
    const current=this.supervision.get(loop.id);this.supervision.update(loop.id,current.revision,{phase:'diagnosing',references:{...current.references,diagnosisJobId:job.id}});return {receipt,job};
  });}
}
