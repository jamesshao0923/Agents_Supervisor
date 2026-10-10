import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RuntimeRecord } from '../contracts/p3.js';
import { SupervisorStore } from '../persistence/store.js';
import { inspectProcess, terminateProcess, type ProcessIdentity } from '../process-control/index.js';
import { assertCandidate, canonical, captureCandidate, digest, environmentFingerprint } from './candidate.js';
import { assertDefinition, captureDefinition, validateBundleChange } from './definition.js';
import { evaluateVerification, selectInstances, validateSpecChange } from './rules.js';
import { definitionReviewPrompt, executeInstances, reviewModel, type EngineContext } from './engine.js';
import { assertSourcesCurrent } from './source.js';
import type { Delivery, FrozenPlan, ModelConfig, Proposal, VerificationAction, VerificationJob } from './records.js';
function ensure(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
function parseAction(value:unknown):VerificationAction {
  ensure(value&&typeof value==='object'&&!Array.isArray(value),'Invalid verification action');const o=value as Record<string,unknown>;
  const fields:Record<string,string[]>={propose:['commandId','runtimeId','specPath'],review:['commandId','proposalId','model','effort','reservation','timeoutMs'],publish:['commandId','proposalId','reviewId'],freeze:['commandId','runtimeId','mode','changedModules'],run:['commandId','planId','model','effort','reservation','timeoutMs'],deliver:['commandId','jobId'],cancel:['jobId'],job:['jobId'],status:['runtimeId']};
  ensure(typeof o.type==='string'&&fields[o.type],'Unknown verification action');const keys=fields[o.type]!;
  ensure(Object.keys(o).every(k=>k==='type'||keys.includes(k)),'Unknown verification action field');
  for(const key of keys.filter(k=>!['changedModules','reservation','timeoutMs'].includes(k)))ensure(typeof o[key]==='string'&&(o[key] as string).trim()&&(o[key] as string).length<=4096&&!(o[key] as string).includes('\0'),'Invalid verification '+key);
  if(o.type==='freeze'){ensure(['final','impact'].includes(String(o.mode)),'Invalid verification mode');if(o.changedModules!==undefined)ensure(Array.isArray(o.changedModules)&&o.changedModules.every(x=>typeof x==='string'&&x.length>0),'Invalid changed modules');}
  if(o.type==='review'||o.type==='run'){ensure(Number.isSafeInteger(o.reservation)&&Number(o.reservation)>0,'Invalid model reservation');ensure(Number.isSafeInteger(o.timeoutMs)&&Number(o.timeoutMs)>=1000&&Number(o.timeoutMs)<=3600000,'Invalid model timeout');}
  return structuredClone(o) as unknown as VerificationAction;
}
async function proofHashes(root:string):Promise<Record<string,string>> {const out:Record<string,string>={};async function visit(path:string){for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isSymbolicLink())throw new Error('Verification evidence contains symlink');if(e.isDirectory())await visit(p);else if(e.isFile())out[p]=digest(await readFile(p));else throw new Error('Unsupported evidence file');}}await visit(root);return out;}
// Bound concurrent read-only process inspections. Each still observes its own
// complete identity and 250 ms quiet window; large plans do not multiply UI latency serially.
async function allStopped(identities:ProcessIdentity[]):Promise<boolean> {
  for(let i=0;i<identities.length;i+=4){const checks=await Promise.all(identities.slice(i,i+4).map(identity=>inspectProcess(identity)));if(checks.some(check=>check.status!=='stopped'))return false;}return true;
}
export class VerificationController {
  private readonly pending=new Map<string,{abort:AbortController;promise:Promise<void>}>();
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private readonly store:SupervisorStore,private readonly dataDir:string){}
  private get repo(){return this.store.verification;}
  async initialize():Promise<void> {
    for(const job of this.repo.list('job').filter(j=>j.status==='running')) {
      let stopped=job.intents.length===job.identities.length;
      for(const identity of job.identities)try{stopped=(await terminateProcess(identity)).stopped&&stopped;}catch{stopped=false;}
      job.error='Service interrupted independent verification; original frozen plan retained; rerun requires confirmed stop and settled usage. '+(stopped?'Old processes stopped.':'Old process stop unresolved.');
      job.usageUnknown=job.usageUnknown||job.modelStarted;job.approved=false;this.finish(job,stopped);
    }
  }
  cancelRuntime(runtimeId:string):void {for(const [id,active]of this.pending)if(this.repo.get('job',id).runtimeId===runtimeId)active.abort.abort();}
  async dispatch(value:unknown):Promise<unknown> {const action=parseAction(value);const next=this.queue.then(()=>this.handle(action));this.queue=next.catch(()=>{});return next;}
  private assertQuietWorkspace(workspace:string):void {
    ensure(this.store.runtime.list().filter(r=>overlap(r.workspace,workspace)).every(r=>['cancelled','awaiting-verification'].includes(r.phase)&&this.store.runtime.operations(r.id).every(o=>['confirmed','cancelled'].includes(o.state))),'Workspace has unresolved runtime work');
    ensure(this.store.executionList().filter(e=>overlap(e.workspace,workspace)).every(e=>e.stopConfirmed),'Workspace has an active writer');
  }
  private async writers(runtime:RuntimeRecord,ownJob?:string):Promise<void> {
    ensure(runtime.phase==='awaiting-verification'&&!runtime.cancelled&&!runtime.paused,'Workflow must finish all required steps before verification');
    for(const r of this.store.runtime.list().filter(r=>overlap(r.workspace,runtime.workspace)))ensure(['awaiting-verification','cancelled'].includes(r.phase)&&this.store.runtime.operations(r.id).every(o=>['confirmed','cancelled'].includes(o.state)),'Overlapping workspace has unresolved workflow work');
    for(const e of this.store.executionList().filter(e=>overlap(e.workspace,runtime.workspace))) {
      ensure(e.stopConfirmed,'Execution writer has not stopped');
      if(e.identity)ensure((await inspectProcess(e.identity as ProcessIdentity)).status==='stopped','Old execution process is still active');
    }
    ensure(!this.repo.list('job').some(j=>j.id!==ownJob&&(j.status==='running'||!j.stopConfirmed)&&overlap(j.workspace,runtime.workspace)),'Workspace has active verification');
    const run=this.repo.run(runtime.projectId,runtime.runId);
    ensure(run.attempts.every(a=>a.id===ownJob||a.status!=='running'&&a.settled),'Run has active or unsettled attempts');
    ensure(run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released||l.attemptId===ownJob),'Run has unresolved effects or leases');
  }
  private async handle(action:VerificationAction):Promise<unknown> {
    if(action.type==='job')return this.repo.get('job',action.jobId);
    if(action.type==='status')return this.status(action.runtimeId);
    if(action.type==='cancel'){this.pending.get(action.jobId)?.abort.abort();return this.repo.get('job',action.jobId);}
    const prior=this.repo.receipt(action.commandId,action);if(prior!==undefined)return prior;
    if(action.type==='propose') {
      const runtime=this.store.runtime.get(action.runtimeId);await this.writers(runtime);
      const id='proposal-'+randomUUID(),directory=join(this.dataDir,'verification',id),run=this.repo.run(runtime.projectId,runtime.runId);
      ensure(isAbsolute(action.specPath),'Spec path must be absolute');
      const {spec,bundle}=await captureDefinition(action.specPath,directory);const previous=this.repo.head(runtime.projectId);validateSpecChange(previous?.spec??null,spec,run.contract);
      validateBundleChange(previous,{spec,bundle});
      const candidate=await captureCandidate(runtime.workspace,join(directory,'candidate'));
      const proposal:Proposal={id,runtimeId:runtime.id,projectId:runtime.projectId,runId:runtime.runId,baseVersion:this.repo.head(runtime.projectId)?.version??0,version:null,spec,bundle,candidate,contractDigest:digest(canonical(run.contract)),status:'proposed',createdAt:new Date().toISOString()};
      const snapshot=this.store.managedSnapshot(canonical(candidate));
      return this.repo.transaction(()=>{this.assertQuietWorkspace(runtime.workspace);this.repo.assertNoVerificationWriter(runtime.workspace);this.repo.insert('proposal',proposal);this.repo.artifact(run.projectId,run.id,{id,...snapshot,contractVersion:run.contract.version});this.repo.remember(action.commandId,action,proposal);return proposal;});
    }
    if(action.type==='publish') {
      const proposal=this.repo.get('proposal',action.proposalId),review=this.repo.get('job',action.reviewId);
      ensure(review.kind==='review'&&review.proposalId===proposal.id&&review.status==='finished'&&review.approved&&!review.error,'Publication requires actual independent approved review');
      await this.assertJob(review);await assertDefinition(proposal.spec,proposal.bundle);await assertCandidate(proposal.candidate);
      ensure(digest(canonical(this.repo.run(proposal.projectId,proposal.runId).contract))===proposal.contractDigest,'Contract changed after review');
      proposal.reviewId=review.id;proposal.reviewEnvironmentDigest=review.environmentDigest;
      return this.repo.transaction(()=>{this.repo.publish(proposal);this.repo.remember(action.commandId,action,proposal);return proposal;});
    }
    if(action.type==='freeze') {
      const runtime=this.store.runtime.get(action.runtimeId);await this.writers(runtime);const proposal=this.repo.head(runtime.projectId);ensure(proposal?.version,'Publish a reviewed verification catalog first');await this.assertReviewedProposal(proposal);await assertDefinition(proposal.spec,proposal.bundle);
      const run=this.repo.run(runtime.projectId,runtime.runId);ensure(proposal.contractDigest===digest(canonical(run.contract)),'Published verification catalog was reviewed for a different task contract; submit and review a definition for this goal');validateSpecChange(null,proposal.spec,run.contract);
      const id='plan-'+randomUUID(),candidate=await captureCandidate(runtime.workspace,join(this.dataDir,'verification',id));
      const plan:FrozenPlan={id,runtimeId:runtime.id,projectId:runtime.projectId,runId:runtime.runId,proposalId:proposal.id,catalogVersion:proposal.version,candidate,contractDigest:digest(canonical(run.contract)),definitionDigest:proposal.bundle.digest,environmentDigest:(await environmentFingerprint()).digest,selection:selectInstances(proposal.spec,{mode:action.mode,...(action.changedModules?{changedModules:action.changedModules}:{})}),createdAt:new Date().toISOString()};
      const snapshot=this.store.managedSnapshot(canonical(candidate));
      return this.repo.transaction(()=>{this.assertQuietWorkspace(runtime.workspace);this.repo.assertNoVerificationWriter(runtime.workspace);this.repo.insert('plan',plan);this.repo.artifact(run.projectId,run.id,{id,...snapshot,contractVersion:run.contract.version});this.repo.remember(action.commandId,action,plan);return plan;});
    }
    if(action.type==='review'||action.type==='run') {
      const plan=action.type==='run'?this.repo.get('plan',action.planId):null;
      const proposal=this.repo.get('proposal',plan?.proposalId??(action as Extract<VerificationAction,{type:'review'}>).proposalId),runtime=this.store.runtime.get(plan?.runtimeId??proposal.runtimeId);
      await this.writers(runtime);await assertDefinition(proposal.spec,proposal.bundle);await assertCandidate(plan?.candidate??proposal.candidate);
      const run=this.repo.run(runtime.projectId,runtime.runId);ensure(!['succeeded','cancelled','paused'].includes(run.status),'Run is terminal or paused');
      ensure(digest(canonical(run.contract))===(plan?.contractDigest??proposal.contractDigest),'Frozen contract changed');
      if(plan){ensure(plan.contractDigest===proposal.contractDigest,'Frozen plan does not match the independently reviewed task contract');ensure(plan.environmentDigest===(await environmentFingerprint()).digest,'Frozen verifier environment changed');}
      const id='verify-'+randomUUID(),config:ModelConfig={model:action.model,effort:action.effort,reservation:action.reservation,timeoutMs:action.timeoutMs};
      const environmentDigest=(await environmentFingerprint()).digest;
      const job:VerificationJob={id,environmentDigest,runtimeId:runtime.id,projectId:runtime.projectId,runId:runtime.runId,workspace:runtime.workspace,kind:action.type==='review'?'review':'verification',proposalId:proposal.id,planId:plan?.id??null,request:action,status:'running',attemptId:id,config,startedAt:new Date().toISOString(),finishedAt:null,intents:[],identities:[],usage:0,modelStarted:false,usageUnknown:false,results:[],controls:[],evaluation:null,approved:false,stopConfirmed:false,error:null,proofs:{},sources:[]};
      this.repo.transaction(()=>{this.assertQuietWorkspace(runtime.workspace);this.repo.assertNoVerificationWriter(runtime.workspace);this.repo.act(run.projectId,run.id,{type:'startAttempt',attemptId:id,nodeId:run.nodes.at(-1)!.id,contractVersion:run.contract.version,reservation:config.reservation,purpose:'verification',resources:['verification:'+runtime.workspace]});this.repo.insert('job',job);this.repo.remember(action.commandId,action,job);});
      const abort=new AbortController(),promise=this.execute(job,proposal,plan,abort.signal).finally(()=>this.pending.delete(id));this.pending.set(id,{abort,promise});return job;
    }
    const job=this.repo.get('job',action.jobId);ensure(job.kind==='verification'&&job.planId&&job.status==='finished'&&job.approved&&job.evaluation?.complete,'Delivery requires a complete actual verification');
    const plan=this.repo.get('plan',job.planId);await this.current(plan,job,true);await this.writers(this.store.runtime.get(job.runtimeId));
    const delivery:Delivery={id:'delivery-'+randomUUID(),jobId:job.id,planId:plan.id,runtimeId:job.runtimeId,projectId:job.projectId,runId:job.runId,candidateDigest:plan.candidate.digest,definitionDigest:plan.definitionDigest,createdAt:new Date().toISOString(),path:join(this.dataDir,'verification',job.id,'delivery.json')};
    await writeFile(delivery.path,JSON.stringify(delivery,null,2));
    return this.repo.transaction(()=>{
      this.repo.assertNoVerificationWriter(job.workspace);this.assertQuietWorkspace(job.workspace);const run=this.repo.run(job.projectId,job.runId);ensure(run.artifact?.id===plan.id,'Delivery artifact is no longer this frozen plan');
      for(const criterion of run.contract.criteria.filter(c=>c.required))this.repo.act(run.projectId,run.id,{type:'recordEvidence',evidence:{id:delivery.id+':'+criterion.id,criterionId:criterion.id,contractVersion:run.contract.version,artifactDigest:run.artifact.digest,verdict:'passed',verifierVersion:'p4:'+plan.definitionDigest}});
      this.repo.act(run.projectId,run.id,{type:'complete'});this.repo.insert('delivery',delivery);this.repo.remember(action.commandId,action,delivery);return delivery;
    });
  }
  private async execute(job:VerificationJob,proposal:Proposal,plan:FrozenPlan|null,signal:AbortSignal):Promise<void> {
    const output=join(this.dataDir,'verification',job.id),context:EngineContext={job,signal,output,save:()=>this.repo.update('job',job),eligible:()=>{const runtime=this.store.runtime.get(job.runtimeId),run=this.repo.run(job.projectId,job.runId);ensure(!runtime.cancelled&&!runtime.paused,'Runtime cancelled or dispatch paused');ensure(run.attempts.find(a=>a.id===job.id)?.status==='running'&&digest(canonical(run.contract))===(plan?.contractDigest??proposal.contractDigest),'Verification attempt qualification changed');}};let stopped=false;
    try {
      await mkdir(output,{recursive:true});
      if(job.kind==='review') {
        const selection=selectInstances(proposal.spec,{mode:'final'});
        for(const control of proposal.spec.controls){const candidate=proposal.bundle.controls.find(c=>c.id===control.id)!.candidate;const results=await executeInstances(context,proposal.spec,proposal.bundle,candidate,selection.instances,'control-'+digest(control.id));const evaluated=evaluateVerification(proposal.spec,selection,results);
          const passed=control.expect==='passed'?evaluated.complete:results.every(r=>r.executionStatus==='executed')&&control.mustFail.every(id=>results.some(r=>r.checks.some(c=>c.obligationId===id&&c.verdict==='failed')));
          job.controls.push({id:control.id,passed,results});context.save();}
        ensure(job.controls.every(c=>c.passed),'Verifier did not classify the known good/bad controls correctly');
        const prompt=await definitionReviewPrompt(proposal.spec,proposal.bundle,this.repo.head(proposal.projectId),this.repo.run(job.projectId,job.runId).contract,job.controls);
        const review=await reviewModel(context,prompt,proposal.candidate.tree,join(output,'definition-review'));job.approved=review.verdict==='passed';if(!job.approved)job.error='Independent definition review: '+review.reason;
      }else {
        job.results=await executeInstances(context,proposal.spec,proposal.bundle,plan!.candidate,plan!.selection.instances,'candidate');
        job.evaluation=evaluateVerification(proposal.spec,plan!.selection,job.results);job.approved=job.evaluation.passed;
      }
      await assertDefinition(proposal.spec,proposal.bundle);await assertCandidate(plan?.candidate??proposal.candidate);
      ensure(job.environmentDigest===(await environmentFingerprint()).digest,'Environment changed during verification');
      ensure(!signal.aborted,'Verification cancelled');
    }catch(error){job.error=String(error);job.approved=false;}
    try {stopped=job.intents.length===job.identities.length&&await allStopped(job.identities);
      ensure(stopped,'Verifier process stop unresolved');await writeFile(join(output,'report.json'),JSON.stringify({results:job.results,controls:job.controls,evaluation:job.evaluation,error:job.error},null,2));job.proofs=await proofHashes(output);
    }catch(error){job.error=(job.error??'')+' '+String(error);job.approved=false;}
    this.finish(job,stopped);
  }
  private finish(job:VerificationJob,stopped:boolean):void {
    job.stopConfirmed=stopped;job.status='finished';job.finishedAt=new Date().toISOString();job.approved=job.approved&&stopped&&!job.usageUnknown&&!job.error;
    this.repo.transaction(()=>{const run=this.repo.run(job.projectId,job.runId),attempt=run.attempts.find(a=>a.id===job.attemptId)!;
      if(attempt.status==='running')this.repo.act(job.projectId,job.runId,{type:'finishAttempt',attemptId:job.attemptId,outcome:job.approved?'succeeded':'failed'});
      if(!job.usageUnknown&&!attempt.settled)this.repo.act(job.projectId,job.runId,{type:'settleAttempt',attemptId:job.attemptId,actual:job.usage});
      if(stopped)this.repo.act(job.projectId,job.runId,{type:'releaseLease',attemptId:job.attemptId,resource:'verification:'+job.workspace});
      this.repo.update('job',job);
    });
  }
  private async assertJob(job:VerificationJob):Promise<void> {
    ensure(job.environmentDigest===(await environmentFingerprint()).digest,'Verifier review or execution environment changed');
    ensure(job.status==='finished'&&job.stopConfirmed&&!job.usageUnknown&&Object.keys(job.proofs).length>0,'Missing completed verifier evidence');
    ensure(this.repo.run(job.projectId,job.runId).attempts.find(a=>a.id===job.attemptId)?.settled,'Verification usage unsettled');
    for(const [path,hash]of Object.entries(job.proofs))ensure(digest(await readFile(path))===hash,'Verification evidence changed');
    ensure(job.intents.length===job.identities.length,'Verifier intent has no stop identity');ensure(await allStopped(job.identities),'Old verification process is still active');
  }
  private async assertReviewedProposal(proposal:Proposal):Promise<void> {
    ensure(proposal.reviewId&&proposal.reviewEnvironmentDigest,'Published catalog lacks independently reviewed environment');
    const review=this.repo.get('job',proposal.reviewId);
    ensure(review.kind==='review'&&review.proposalId===proposal.id&&review.approved&&!review.error&&review.environmentDigest===proposal.reviewEnvironmentDigest,'Published catalog has no valid independent approval');
    await this.assertJob(review);await assertSourcesCurrent(review.sources);
  }
  private async current(plan:FrozenPlan,job:VerificationJob,refresh=false):Promise<void> {
    const proposal=this.repo.get('proposal',plan.proposalId);await this.assertReviewedProposal(proposal);this.assertQuietWorkspace(plan.candidate.root);this.repo.assertNoVerificationWriter(plan.candidate.root);ensure(this.repo.head(plan.projectId)?.id===plan.proposalId,'Published verification catalog changed');
    ensure(plan.contractDigest===proposal.contractDigest,'Plan differs from independently reviewed task contract');ensure(digest(canonical(this.repo.run(plan.projectId,plan.runId).contract))===plan.contractDigest,'Contract changed');ensure((await environmentFingerprint()).digest===plan.environmentDigest,'Verifier environment changed');
    await assertCandidate(plan.candidate);await assertDefinition(proposal.spec,proposal.bundle);await this.assertJob(job);await assertSourcesCurrent(job.sources,refresh);
    ensure(evaluateVerification(proposal.spec,plan.selection,job.results).complete,'Current evidence does not satisfy all necessary instances');
  }
  async status(runtimeId:string):Promise<unknown> {
    this.store.runtime.get(runtimeId);const deliveries=this.repo.list('delivery',runtimeId),latest=deliveries.at(-1);let current=false,reason=latest?'':'No accepted delivery';
    if(latest)try{await this.current(this.repo.get('plan',latest.planId),this.repo.get('job',latest.jobId));current=true;}catch(error){reason=String(error);}
    return {proposals:this.repo.list('proposal',runtimeId),plans:this.repo.list('plan',runtimeId),jobs:this.repo.list('job',runtimeId),deliveries,currentDelivery:{current,reason,delivery:latest??null}};
  }
  async close():Promise<void>{for(const active of this.pending.values())active.abort.abort();await Promise.all([...this.pending.values()].map(p=>p.promise));}
}
