import {expandedAuthorInput} from '../orchestration/indexed-history-presentation.js';
import {prepareResearchProofPlan} from './research-workflow.js';
import {readBounded} from '../workspace/research-runtime-files.js';
import {assertLegacyControlReviewEvidence} from './legacy-review-evidence.js';
import {executeMaintenanceReplay} from './control-maintenance-replay.js';
import type {MaintenancePlan} from '../contracts/p6-control-maintenance.js';
import {createEnvironmentScope,verificationDirectory,parseEnvironmentScope} from './scoped-environment.js';
import {createMobileDelivery,assertMobileDelivery} from './mobile-delivery.js';
import {DeliveryOpenSessions} from './delivery-open.js';
import {assertMaterialSpecBindings,assertMaterialsCurrent} from './material.js';
import { VerificationProofReader } from './proof-reader.js';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RuntimeRecord } from '../contracts/p3.js';
import { SupervisorStore } from '../persistence/store.js';
import { inspectProcess, terminateProcess, type ProcessIdentity } from '../process-control/index.js';
import { assertCandidate, canonical, captureCandidate, digest, environmentFingerprint } from './candidate.js';
import { assertDefinition, captureDefinition, validateBundleChange } from './definition.js';
import { currentVerificationCases,evaluateVerification, selectInstances, validateSpecChange } from './rules.js';
import { definitionReviewPrompt, executeDefinitionControls, executeInstances, reviewModel, type EngineContext } from './engine.js';
import { assertSourcesCurrent } from './source.js';
import type { Delivery, FrozenPlan, ModelConfig, Proposal, VerificationAction, VerificationJob } from './records.js';
import type { DeliveryAssessment, DeliveryIssue } from '../contracts/p4-delivery-status.js';
import { assessDeliveryEvidence, invalidateWorkspaceObservation, unavailableDeliveryAssessment, type DeliveryEvidenceSnapshot } from './delivery-status.js';
import { captureControlEvolutionContext, materializeControlEvolutionBundle, type ControlEvolutionAuthoringContext } from '../orchestration/acceptance-authoring-v2.js';
import { SupervisionReasoningRunner } from '../orchestration/supervision-reasoning.js';
import type { Candidate } from './candidate.js';
import { captureControlSpec } from './control-definition.js';
import { prepareControlDraft, assertControlDraft, executeControlBootstrap, assembleQualification } from './control-bootstrap.js';
import { executeQualification } from './control-engine.js';
import { controlQualificationReviewPrompt } from './control-review.js';
import { controlDigest } from './control-rules.js';
import { controlQualificationDigest } from '../persistence/control-qualification.js';
import type { ControlQualificationEvidence } from '../contracts/p4-qualification.js';
function ensure(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
function parseAction(value:unknown):VerificationAction {
  ensure(value&&typeof value==='object'&&!Array.isArray(value),'Invalid verification action');const o=value as Record<string,unknown>;
  const fields:Record<string,string[]>={open:['commandId','deliveryId','caseId','timeoutMs'],'close-open':['sessionId'],'open-session':['sessionId'],propose:['commandId','runtimeId','specPath','controlDeclarationPath','controlAuthorJobId','researchAuthorJobId'],review:['commandId','proposalId','model','effort','reservation','timeoutMs'],publish:['commandId','proposalId','reviewId'],freeze:['commandId','runtimeId','mode','changedModules'],run:['commandId','planId','model','effort','reservation','timeoutMs','futureVerificationAllocationId'],deliver:['commandId','jobId'],cancel:['jobId'],job:['jobId'],status:['runtimeId']};
  ensure(typeof o.type==='string'&&fields[o.type],'Unknown verification action');const keys=fields[o.type]!;
  ensure(Object.keys(o).every(k=>k==='type'||keys.includes(k)),'Unknown verification action field');
  for(const key of keys.filter(k=>!['changedModules','reservation','timeoutMs'].includes(k)&&(!['futureVerificationAllocationId','controlDeclarationPath','controlAuthorJobId','researchAuthorJobId'].includes(k)||o[k]!==undefined)))ensure(typeof o[key]==='string'&&(o[key] as string).trim()&&(o[key] as string).length<=4096&&!(o[key] as string).includes('\0'),'Invalid verification '+key);
  if(o.type==='propose')ensure((o.controlDeclarationPath===undefined)===(o.controlAuthorJobId===undefined),'Control author and declaration must be supplied together');
  if(o.type==='freeze'){ensure(['final','impact'].includes(String(o.mode)),'Invalid verification mode');if(o.changedModules!==undefined)ensure(Array.isArray(o.changedModules)&&o.changedModules.every(x=>typeof x==='string'&&x.length>0),'Invalid changed modules');}
  if(o.type==='open')ensure(Number.isSafeInteger(o.timeoutMs)&&Number(o.timeoutMs)>=1000&&Number(o.timeoutMs)<=600000,'Invalid open session timeout');
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
  private closing=false;
  private readonly openSessions:DeliveryOpenSessions;
  constructor(private readonly store:SupervisorStore,private readonly dataDir:string){this.openSessions=new DeliveryOpenSessions(join(dataDir,'delivery-open'));}
  private get repo(){return this.store.verification;}
  async initialize():Promise<void> {
    await this.openSessions.initialize();
    for(const job of this.repo.list('job').filter(j=>j.status==='running')) {
      let stopped=job.intents.length===job.identities.length;
      for(const identity of job.identities)try{stopped=(await terminateProcess(identity)).stopped&&stopped;}catch{stopped=false;}
      job.error='Service interrupted independent verification; original frozen plan retained; rerun requires confirmed stop and settled usage. '+(stopped?'Old processes stopped.':'Old process stop unresolved.');
      job.usageUnknown=job.usageUnknown||job.modelStarted;job.approved=false;this.finish(job,stopped);
    }
  }
  cancelRuntime(runtimeId:string):void {for(const [id,active]of this.pending)if(this.repo.get('job',id).runtimeId===runtimeId)active.abort.abort();}
  async dispatch(value:unknown):Promise<unknown> {const action=parseAction(value);const next=this.queue.then(()=>this.handle(action));this.queue=next.catch(()=>{});return next;}
  private assertFinalAllocationPlan(plan:FrozenPlan):void {
    ensure(plan.selection.mode==='final'&&plan.selection.completeScope,'Future verification allocation requires a complete final plan');
    const run=this.repo.run(plan.projectId,plan.runId),head=this.repo.headForRun(plan.projectId,plan.runId);
    ensure(run.artifact?.id===plan.id&&head?.id===plan.proposalId&&head.version===plan.catalogVersion,'Future verification allocation requires the current artifact and published catalog');
    ensure(digest(canonical(run.contract))===plan.contractDigest,'Future verification allocation contract changed');
  }
  private assertQuietWorkspace(workspace:string):void {
    for(const runtime of this.store.runtime.list().filter(r=>overlap(r.workspace,workspace)))ensure(!this.store.conversations.hasPendingForRun(runtime.projectId,runtime.runId),'Pending follow-up must be resolved before verification publication');
    ensure(this.store.runtime.list().filter(r=>overlap(r.workspace,workspace)).every(r=>['cancelled','awaiting-verification'].includes(r.phase)&&this.store.runtime.currentOperations(r.id).every(o=>['confirmed','cancelled'].includes(o.state))),'Workspace has unresolved runtime work');
    ensure(this.store.executionList().filter(e=>overlap(e.workspace,workspace)).every(e=>e.stopConfirmed),'Workspace has an active writer');
  }
  private async writers(runtime:RuntimeRecord,ownJob?:string):Promise<void> {
    ensure(!this.store.conversations.hasPendingForRun(runtime.projectId,runtime.runId),'Pending follow-up must be resolved before new verification or delivery');
    ensure(runtime.phase==='awaiting-verification'&&!runtime.cancelled&&!runtime.paused,'Workflow must finish all required steps before verification');
    for(const r of this.store.runtime.list().filter(r=>overlap(r.workspace,runtime.workspace)))ensure(['awaiting-verification','cancelled'].includes(r.phase)&&this.store.runtime.currentOperations(r.id).every(o=>['confirmed','cancelled'].includes(o.state)),'Overlapping workspace has unresolved workflow work');
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
    if(action.type==='open-session')return this.openSessions.get(action.sessionId);
    if(action.type==='close-open')return this.openSessions.close(action.sessionId);
    if(action.type==='open'){const prior=this.repo.receipt(action.commandId,action);ensure(prior===undefined||canonical(prior)===canonical({sessionId:'open-'+digest(action.commandId)}),'Open receipt differs');const delivery=this.repo.get('delivery',action.deliveryId),assessment=await this.deliveryAssessment(delivery);ensure(assessment.historicalEvidenceIntact===true,'Historical delivered evidence is not intact');const plan=this.repo.get('plan',delivery.planId),proposal=this.repo.get('proposal',plan.proposalId);const instance=plan.selection.instances.find(i=>i.caseId===action.caseId);const definition=proposal.spec.cases.find(c=>c.id===instance?.caseId&&c.revision===instance.revision);ensure(definition?.verifier.kind==='fullstack','Only the delivered fixed Node application ABI can open');if(prior===undefined)this.repo.transaction(()=>this.repo.remember(action.commandId,action,{sessionId:'open-'+digest(action.commandId)}));return this.openSessions.open(action,plan.candidate,definition.verifier.entry);}
    if(action.type==='job')return this.repo.get('job',action.jobId);
    if(action.type==='status')return this.status(action.runtimeId);
    if(action.type==='cancel'){this.pending.get(action.jobId)?.abort.abort();return this.repo.get('job',action.jobId);}
    const prior=this.repo.receipt(action.commandId,action);if(prior!==undefined){if(action.type==='deliver'&&(prior as Delivery).researchProofPlanDigest)return this.exportResearchDelivery(action.commandId,action);return prior;}
    if(action.type==='propose') {
      if(action.controlDeclarationPath)return this.proposeControl(action);
      const runtime=this.store.runtime.get(action.runtimeId);await this.writers(runtime);
      const environmentScope=await createEnvironmentScope(this.dataDir,runtime),id='proposal-'+randomUUID(),directory=verificationDirectory(this.dataDir,{...runtime,id,environmentScope}),run=this.repo.run(runtime.projectId,runtime.runId);
      ensure(isAbsolute(action.specPath),'Spec path must be absolute');
      const base=this.store.verificationLineage.captureBase(runtime.projectId,runtime.runId),previous=base.baseProposalId?this.repo.get('proposal',base.baseProposalId):null;
      const {spec,bundle}=await captureDefinition(action.specPath,directory);
      let nativePlan:import('../contracts/p4-research-workflow.js').ResearchProofPlan|undefined;
      if(this.store.researchWorkflow.requires(runtime.id)) {
        ensure(action.researchAuthorJobId,'Native research proposal requires its actual frozen author/mapping');
        const author=await new SupervisionReasoningRunner(this.store,this.dataDir).run(action.researchAuthorJobId);
        const context=(expandedAuthorInput(author.input) as {context:{acceptance:import('../orchestration/acceptance-authoring.js').AcceptanceAuthoringContext}}).context.acceptance;
        ensure(context.workflowMode==='native-host-v1'&&author.runtimeId===runtime.id,
          'Native mapping author belongs to another Run/role');
        nativePlan=prepareResearchProofPlan(context.criteria,run.contract,spec,
          (author.result as {researchWorkflow:import('../contracts/p4-research-workflow.js').ResearchWorkflowDeclaration}).researchWorkflow);
      } else ensure(!action.researchAuthorJobId,'Native workflow mapping requires an admitted research scope');
      validateSpecChange(previous?.spec??null,spec,run.contract);
      validateBundleChange(previous,{spec,bundle});await assertMaterialSpecBindings(this.store,this.dataDir,runtime.id,spec.cases.flatMap(c=>c.verifier.kind==='material'?[c.verifier]:c.verifier.kind==='source'&&c.verifier.binding?[{kind:'material' as const,version:c.verifier.version,claimFile:c.verifier.claimFile,binding:c.verifier.binding,timeoutMs:c.verifier.timeoutMs}]:[]));
      const candidate=await captureCandidate(runtime.workspace,join(directory,'candidate'));
      const proposal:Proposal={id,...(nativePlan?{researchProofPlanDigest:nativePlan.digest}:{}),environmentScope,runtimeId:runtime.id,projectId:runtime.projectId,runId:runtime.runId,baseVersion:previous?.version??0,version:null,spec,bundle,candidate,contractDigest:digest(canonical(run.contract)),status:'proposed',createdAt:new Date().toISOString()};
      const snapshot=this.store.managedSnapshot(canonical(candidate));
      return this.repo.transaction(()=>{
        this.assertQuietWorkspace(runtime.workspace);
        this.repo.assertNoVerificationWriter(runtime.workspace);
        this.repo.insert('proposal',proposal);
        this.store.verificationLineage.bindProposal({commandId:'bind:'+action.commandId,
          proposalId:proposal.id,base,definitionFormat:'legacy-v1'});
        if(nativePlan)this.store.researchWorkflow.bindProposal({proposalId:proposal.id,
          authorJobId:action.researchAuthorJobId!,proofPlan:nativePlan});
        this.repo.artifact(run.projectId,run.id,{id,...snapshot,contractVersion:run.contract.version});
        this.repo.remember(action.commandId,action,proposal);
        return proposal;
      });
    }
    if(action.type==='publish') {
      const proposal=this.repo.get('proposal',action.proposalId),review=this.repo.get('job',action.reviewId);
      ensure(review.kind==='review'&&review.proposalId===proposal.id&&review.status==='finished'&&review.approved&&!review.error,'Publication requires actual independent approved review');
      if(this.repo.researchProofPlanDigest(proposal.id))this.store.researchWorkflow.assertMappingReview(proposal,review);
      if(this.store.verificationLineage.bindingForProposal(proposal.id).definitionFormat==='legacy-v1')assertLegacyControlReviewEvidence({dataDir:this.repo.dataDirectory(),proposal,review});
      await this.assertJob(review);await assertMaterialsCurrent(review.materials??[]);await assertDefinition(proposal.spec,proposal.bundle);await assertCandidate(proposal.candidate);
      ensure(digest(canonical(this.repo.run(proposal.projectId,proposal.runId).contract))===proposal.contractDigest,'Contract changed after review');
      proposal.reviewId=review.id;proposal.reviewEnvironmentDigest=review.environmentDigest;
      return this.repo.transaction(()=>{ensure(!this.store.conversations.hasPendingForRun(proposal.projectId,proposal.runId),'Pending follow-up prevents publication');this.repo.publish(proposal,action.commandId);this.repo.remember(action.commandId,action,proposal);return proposal;});
    }
    if(action.type==='freeze') {
      const runtime=this.store.runtime.get(action.runtimeId);await this.writers(runtime);const proposal=this.repo.headForRun(runtime.projectId,runtime.runId);ensure(proposal?.version,'Publish a reviewed verification catalog first');await this.assertReviewedProposal(proposal);await assertDefinition(proposal.spec,proposal.bundle);
      const run=this.repo.run(runtime.projectId,runtime.runId);ensure(proposal.contractDigest===digest(canonical(run.contract)),'Published verification catalog was reviewed for a different task contract; submit and review a definition for this goal');validateSpecChange(null,proposal.spec,run.contract);
      const environmentScope=proposal.environmentScope,id='plan-'+randomUUID(),candidate=await captureCandidate(runtime.workspace,verificationDirectory(this.dataDir,{...runtime,id,...(environmentScope?{environmentScope}:{})}));
      const plan:FrozenPlan={id,...(environmentScope?{environmentScope}:{}),runtimeId:runtime.id,projectId:runtime.projectId,runId:runtime.runId,proposalId:proposal.id,catalogVersion:proposal.version,candidate,contractDigest:digest(canonical(run.contract)),definitionDigest:proposal.bundle.digest,environmentDigest:(await environmentFingerprint(environmentScope)).digest,selection:selectInstances(proposal.spec,{mode:action.mode,...(action.changedModules?{changedModules:action.changedModules}:{})}),createdAt:new Date().toISOString()};
      const snapshot=this.store.managedSnapshot(canonical(candidate));
      return this.repo.transaction(()=>{this.assertQuietWorkspace(runtime.workspace);this.repo.assertNoVerificationWriter(runtime.workspace);ensure(this.repo.headForRun(runtime.projectId,runtime.runId)?.id===proposal.id&&digest(canonical(this.repo.run(runtime.projectId,runtime.runId).contract))===plan.contractDigest,'Freeze base changed during capture');this.repo.insert('plan',plan);this.repo.artifact(run.projectId,run.id,{id,...snapshot,contractVersion:run.contract.version});this.repo.remember(action.commandId,action,plan);return plan;});
    }
    if(action.type==='review'||action.type==='run') {
      const plan=action.type==='run'?this.repo.get('plan',action.planId):null;
      if(action.type==='run'&&action.futureVerificationAllocationId)this.assertFinalAllocationPlan(plan!);
      const proposal=this.repo.get('proposal',plan?.proposalId??(action as Extract<VerificationAction,{type:'review'}>).proposalId),runtime=this.store.runtime.get(plan?.runtimeId??proposal.runtimeId);
      const nativeRole=this.repo.researchProofPlanDigest(proposal.id);if(nativeRole)ensure(proposal.researchProofPlanDigest===nativeRole,'Persisted native research role differs; no new request may be reserved');
      await this.writers(runtime);await assertDefinition(proposal.spec,proposal.bundle);await assertMaterialSpecBindings(this.store,this.dataDir,runtime.id,currentVerificationCases(proposal.spec).filter(c=>(c.status??'active')==='active').flatMap(c=>c.verifier.kind==='material'?[c.verifier]:c.verifier.kind==='source'&&c.verifier.binding?[{kind:'material' as const,version:c.verifier.version,claimFile:c.verifier.claimFile,binding:c.verifier.binding,timeoutMs:c.verifier.timeoutMs}]:[]));await assertCandidate(plan?.candidate??proposal.candidate);
      if(action.type==='review')this.assertReviewBase(proposal);
      const run=this.repo.run(runtime.projectId,runtime.runId);ensure(!['succeeded','cancelled','paused'].includes(run.status),'Run is terminal or paused');
      ensure(digest(canonical(run.contract))===(plan?.contractDigest??proposal.contractDigest),'Frozen contract changed');
      if(plan){ensure(plan.contractDigest===proposal.contractDigest,'Frozen plan does not match the independently reviewed task contract');ensure(plan.environmentDigest===(await environmentFingerprint(plan.environmentScope)).digest,'Frozen verifier environment changed');}
      const id='verify-'+randomUUID(),config:ModelConfig={model:action.model,effort:action.effort,reservation:action.reservation,timeoutMs:action.timeoutMs};
      const environmentScope=plan?.environmentScope??proposal.environmentScope;if(environmentScope)parseEnvironmentScope(environmentScope,{...runtime,dataDir:this.dataDir});if(plan)ensure(canonical(plan.environmentScope??null)===canonical(proposal.environmentScope??null),'Legacy and scoped verification require a new complete review');const environmentDigest=(await environmentFingerprint(environmentScope)).digest;
      const job:VerificationJob={id,...(proposal.researchProofPlanDigest?{researchProofPlanDigest:proposal.researchProofPlanDigest,...(action.type==='run'?{approvalScope:'research-artifact' as const}:{})}:{}),environmentDigest,...(environmentScope?{environmentScope}:{}),runtimeId:runtime.id,projectId:runtime.projectId,runId:runtime.runId,workspace:runtime.workspace,kind:action.type==='review'?'review':'verification',proposalId:proposal.id,planId:plan?.id??null,request:action,status:'running',attemptId:id,config,startedAt:new Date().toISOString(),finishedAt:null,intents:[],identities:[],usage:0,modelStarted:false,usageUnknown:false,results:[],controls:[],evaluation:null,approved:false,stopConfirmed:false,error:null,proofs:{},sources:[]};
      this.repo.transaction(()=>{this.assertQuietWorkspace(runtime.workspace);this.repo.assertNoVerificationWriter(runtime.workspace);if(action.type==='run'&&action.futureVerificationAllocationId)this.assertFinalAllocationPlan(plan!);if(action.type==='review')this.assertReviewBase(proposal);this.repo.act(run.projectId,run.id,{type:'startAttempt',attemptId:id,nodeId:run.nodes.at(-1)!.id,contractVersion:run.contract.version,reservation:config.reservation,purpose:'verification',resources:['verification:'+runtime.workspace],...(action.type==='run'&&action.futureVerificationAllocationId?{futureVerificationAllocationId:action.futureVerificationAllocationId}:{})});this.repo.insert('job',job);this.repo.remember(action.commandId,action,job);});
      const abort=new AbortController(),promise=this.execute(job,proposal,plan,abort.signal).finally(()=>this.pending.delete(id));this.pending.set(id,{abort,promise});return job;
    }
    const job=this.repo.get('job',action.jobId);ensure(job.kind==='verification'&&job.planId&&job.status==='finished'&&job.approved&&job.evaluation?.complete,'Delivery requires a complete actual verification');
    if(job.approvalScope==='research-artifact')return this.deliverResearch(action,job);
    ensure(!this.repo.researchProofPlanDigest(this.repo.get('plan',job.planId).proposalId),'Native research cannot use ordinary delivery');
    const plan=this.repo.get('plan',job.planId);await this.current(plan,job,true);await this.writers(this.store.runtime.get(job.runtimeId));
    const delivery:Delivery={id:'delivery-'+randomUUID(),jobId:job.id,planId:plan.id,runtimeId:job.runtimeId,projectId:job.projectId,runId:job.runId,candidateDigest:plan.candidate.digest,definitionDigest:plan.definitionDigest,createdAt:new Date().toISOString(),path:join(verificationDirectory(this.dataDir,job),'delivery.json')};
    const mobilePackage=await createMobileDelivery(this.dataDir,delivery.id,plan,job);if(mobilePackage)delivery.mobilePackage=mobilePackage;await this.current(plan,job);if(mobilePackage)await assertMobileDelivery(mobilePackage);
    await writeFile(delivery.path,JSON.stringify(delivery,null,2));
    return this.repo.transaction(()=>{
      this.repo.assertNoVerificationWriter(job.workspace);this.assertQuietWorkspace(job.workspace);const run=this.repo.run(job.projectId,job.runId);ensure(run.artifact?.id===plan.id,'Delivery artifact is no longer this frozen plan');ensure(this.repo.headForRun(job.projectId,job.runId)?.id===plan.proposalId&&digest(canonical(run.contract))===plan.contractDigest,'Delivery catalog or contract changed before commit');
      for(const criterion of run.contract.criteria.filter(c=>c.required))this.repo.act(run.projectId,run.id,{type:'recordEvidence',evidence:{id:delivery.id+':'+criterion.id,criterionId:criterion.id,contractVersion:run.contract.version,artifactDigest:run.artifact.digest,verdict:'passed',verifierVersion:'p4:'+plan.definitionDigest}});
      this.repo.act(run.projectId,run.id,{type:'complete'});this.repo.insert('delivery',delivery);this.repo.remember(action.commandId,action,delivery);return delivery;
    });
  }
  private async deliverResearch(action: Extract<VerificationAction, {
      type: 'deliver';
  }>, job: VerificationJob): Promise<Delivery> {
      ensure(!this.closing, 'Research delivery controller closed');
      ensure(!this.store.researchWorkflow.isTransaction(), 'Public research delivery cannot return from an open parent transaction');
      await this.store.researchWorkflow.captureArtifact(job.id);
      await this.writers(this.store.runtime.get(job.runtimeId));
      const plan = this.repo.get('plan', job.planId!), delivery: Delivery = {
          id: 'delivery-' + randomUUID(),
          jobId: job.id,
          planId: plan.id,
          runtimeId: job.runtimeId,
          projectId: job.projectId,
          runId: job.runId,
          candidateDigest: plan.candidate.digest,
          definitionDigest: plan.definitionDigest,
          researchProofPlanDigest: job.researchProofPlanDigest!,
          createdAt: new Date().toISOString(),
          path: join(verificationDirectory(this.repo.dataDirectory(), job), 'delivery.json')
      };
      this.repo.transaction(() => {
          ensure(!this.closing, 'Research delivery controller closed during preflight');
          this.store.researchWorkflow.sealDelivery({
              commandId: action.commandId,
              request: action,
              jobId: job.id,
              delivery
          });
      });
      return this.exportResearchDelivery(action.commandId, action);
  }
  private async exportResearchDelivery(commandId: string, request: unknown): Promise<Delivery> {
      const committed = this.store.researchWorkflow.committed(commandId, request);
      ensure(committed, 'Research delivery has not committed');
      await this.store.researchWorkflow.assertCommittedCurrent(committed.delivery);
      const bytes = JSON.stringify(committed.delivery, null, 2);
      try {
          await writeFile(committed.delivery.path, bytes, {
              flag: 'wx',
              mode: 0o600
          });
      }
      catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
              throw new Error('Research receipt committed; export pending: ' + String(error));
          ensure(readBounded(committed.delivery.path).toString() === bytes, 'Research receipt committed; export conflicts with exact committed bytes');
      }
      return committed.delivery;
  }
  private async proposeControl(action:Extract<VerificationAction,{type:'propose'}>):Promise<Proposal> {
    const runtime=this.store.runtime.get(action.runtimeId);await this.writers(runtime);
    const native=this.store.researchWorkflow.requires(runtime.id);
    ensure(native? action.researchAuthorJobId===action.controlAuthorJobId:!action.researchAuthorJobId,
      'native evolution needs its same actual V2 author/mapping; ordinary proposals cannot assign that role');
    ensure(action.controlAuthorJobId&&action.controlDeclarationPath,'Missing control author declaration');
    const initial=this.store.supervision.job(action.controlAuthorJobId);
    ensure(initial.status==='finished'&&initial.purpose==='acceptance-authoring'&&initial.runtimeId===runtime.id&&initial.projectId===runtime.projectId&&initial.runId===runtime.runId,'Control declaration requires its completed actual author');
    // Finished-only revalidation checks proof bytes, actual process stop and settled
    // accounting. It cannot start a fresh model call for an imported declaration.
    const author=await new SupervisionReasoningRunner(this.store,this.dataDir).run(initial.id);
    const input=expandedAuthorInput(author.input) as {context:{acceptance:unknown;candidate:Candidate;evolution?:ControlEvolutionAuthoringContext}};
    const evolution=input.context.evolution;ensure(evolution,'Author did not generate control evolution');
    ensure(canonical(input.context.acceptance)===canonical(evolution.current),'Author acceptance context differs');
    const privateRoot=resolve(this.dataDir,'supervision','authoring'),declarationPath=join(privateRoot,'.evolution-declarations',author.id+'.json');
    ensure(action.controlDeclarationPath===declarationPath,'Control declaration is not the managed author file');
    const stat=await lstat(declarationPath);ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=8*1024*1024,'Unsafe control declaration');
    const declaration=JSON.parse(await readFile(declarationPath,'utf8')) as {schemaVersion:number;context:unknown;bundle:unknown;assets:unknown};
    ensure(declaration.schemaVersion===1&&canonical(declaration.context)===canonical(evolution)&&canonical(declaration.bundle)===canonical(author.result),'Control declaration differs from actual author output');
    const run=this.repo.run(runtime.projectId,runtime.runId),base=this.store.verificationLineage.captureBase(runtime.projectId,runtime.runId);
    ensure(canonical(base)===canonical(evolution.base)&&author.contractDigest===digest(canonical(run.contract))&&canonical(evolution.current.contract)===canonical(run.contract),'Control author base or contract changed');
    const session=this.store.goals.list().find(value=>value.runtimeId===runtime.id&&value.id===runtime.runId&&value.projectId===runtime.projectId);
    ensure(session?.proposal?.decision==='ready'&&canonical(session.proposal.criteria)===canonical(evolution.current.criteria),'Control author criteria differ from the admitted goal');
    ensure(evolution.current.criteria.length===run.contract.criteria.length&&run.contract.criteria.every(item=>{const criterion=evolution.current.criteria.find(c=>c.id===item.id);return criterion&&item.required&&item.description===[criterion.description,`Acceptance kind: ${criterion.kind}; target: ${criterion.target}`,...criterion.checks].join('\n');}),'Control criteria do not cover the exact admitted contract');
    const history=base.baseProposalId?this.store.controlQualification.loadHistory(base.baseProposalId):{definitions:[],specimens:[],manifest:null,transitions:[]};
    const indexedHistory=canonical((input.context as {authorPresentation?:unknown}).authorPresentation??null)===canonical({schemaVersion:4,kind:'indexed-history-evolution'})||canonical((input.context as {authorPresentation?:unknown}).authorPresentation??null)===canonical({schemaVersion:7,kind:'indexed-history-references'});
    ensure(indexedHistory||!Object.hasOwn(evolution,'sourceRefresh'),'Historical view inventory requires explicit indexed-history presentation');
    const authorRefresh=indexedHistory&&evolution.current.materials?.[0]?.binding?this.store.controlQualification.sourceRefreshContext(base,evolution.current.materials[0].binding,history):null;
    if(indexedHistory)ensure(Object.hasOwn(evolution,'sourceRefresh')===!!authorRefresh&&canonical(authorRefresh??null)===canonical(evolution.sourceRefresh??null),'Author historical/current refresh inventory differs from actual lineage');
    const current=await captureControlEvolutionContext({current:evolution.current,base,transitions:base.transitionIds.map(id=>this.store.verificationLineage.transition(id)),history,...(authorRefresh?{sourceRefresh:authorRefresh}:{}),...(evolution.maintenance?{maintenance:evolution.maintenance}:{}),...(evolution.regression?{regression:evolution.regression}:{})});
    ensure(canonical(current)===canonical(evolution),'Frozen control author history changed');
    ensure(evolution.current.environment.digest===(await environmentFingerprint(evolution.current.environment.scope===undefined?undefined:parseEnvironmentScope(evolution.current.environment.scope,{...runtime,dataDir:this.dataDir}))).digest,'Control author environment changed');
    ensure(input.context.candidate.root===runtime.workspace&&input.context.candidate.digest===evolution.current.candidate.digest&&evolution.current.candidate.workspace===runtime.workspace,'Control candidate belongs to another workspace');
    await assertCandidate(input.context.candidate);
    const materialized=await materializeControlEvolutionBundle({privateRoot,jobId:author.id,context:evolution,bundle:author.result});
    ensure(materialized.assets.specPath===action.specPath&&canonical(materialized.assets)===canonical(declaration.assets),'Control spec differs from materialized actual author assets');
    const environmentScope=await createEnvironmentScope(this.dataDir,runtime),id='proposal-'+randomUUID(),directory=verificationDirectory(this.dataDir,{...runtime,id,environmentScope});
    const target=await captureControlSpec({specPath:action.specPath,directory,contract:run.contract});await assertMaterialSpecBindings(this.store,this.dataDir,runtime.id,currentVerificationCases(target.definition.spec).filter(c=>(c.status??'active')==='active').flatMap(c=>c.verifier.kind==='material'?[c.verifier]:c.verifier.kind==='source'&&c.verifier.binding?[{kind:'material' as const,version:c.verifier.version,claimFile:c.verifier.claimFile,binding:c.verifier.binding,timeoutMs:c.verifier.timeoutMs}]:[]));const candidate=await captureCandidate(runtime.workspace,join(directory,'candidate'));
    ensure(candidate.digest===input.context.candidate.digest,'Candidate changed during control proposal capture');
    const result=author.result as {maintenance?:MaintenancePlan;plan:Parameters<typeof prepareControlDraft>[0]['authoredPlan']};
    const refresh=this.store.controlQualification.sourceRefreshContext(base,target.definition.spec,history);
    const draft=await prepareControlDraft({...(refresh?{sourceRefresh:refresh}:{}),proposalId:id,base,baseDefinition:history.definitions.find(d=>d.definition.definitionDigest===base.baseDefinitionDigest)?.definition??null,target,transitions:current.transitions,history,authoredPlan:result.plan,authorBinding:{jobId:author.id,inputDigest:author.inputDigest,resultDigest:controlDigest(author.result)}});
    const previous=base.baseProposalId?this.repo.get('proposal',base.baseProposalId):null;
    const nativePlan=native?prepareResearchProofPlan(evolution.current.criteria,run.contract,target.definition.spec,(author.result as import('../orchestration/acceptance-authoring-v2.js').ControlEvolutionBundle).assets.researchWorkflow!):undefined;
    const maintenance=evolution.maintenance?this.store.controlMaintenance.forLoop(author.loopId):null;ensure(!evolution.maintenance||maintenance?.authorJobId===author.id,'Maintenance author reservation changed');
    const proposal:Proposal={id,...(nativePlan?{researchProofPlanDigest:nativePlan.digest}:{}),...(maintenance?{maintenanceId:maintenance.id,maintenanceDigest:maintenance.basisDigest}:{}),...((evolution.maintenance||evolution.regression)?{regressionDigest:controlDigest(evolution.maintenance?.basis??evolution.regression)}:{}),environmentScope,runtimeId:runtime.id,projectId:runtime.projectId,runId:runtime.runId,baseVersion:previous?.version??0,version:null,spec:target.definition.spec,bundle:target.bundle,candidate,contractDigest:author.contractDigest,controlDraftDigest:draft.digest,status:'proposed',createdAt:new Date().toISOString()};
    const snapshot=this.store.managedSnapshot(canonical(candidate));await assertCandidate(candidate);await assertDefinition(proposal.spec,proposal.bundle);
    return this.repo.transaction(()=>{this.assertQuietWorkspace(runtime.workspace);this.repo.assertNoVerificationWriter(runtime.workspace);this.repo.insert('proposal',proposal);this.store.verificationLineage.bindProposal({commandId:'bind:'+action.commandId,proposalId:id,base,definitionFormat:'qualified-v2'});this.store.controlQualification.insertDraft({commandId:'draft:'+action.commandId,proposalId:id,draft});if(nativePlan)this.store.researchWorkflow.bindProposal({proposalId:id,authorJobId:author.id,proofPlan:nativePlan});if(maintenance)this.store.controlMaintenance.bindProposal(id,author.id,result.maintenance!);this.repo.artifact(run.projectId,run.id,{id,...snapshot,contractVersion:run.contract.version});this.repo.remember(action.commandId,action,proposal);return proposal;});
  }
  private frozenBaseProposal(proposal:Proposal):Proposal|null {
    const base=this.store.verificationLineage.baseForProposal(proposal.id),previous=base.baseProposalId?this.repo.get('proposal',base.baseProposalId):null;
    ensure(base.target.projectId===proposal.projectId&&base.target.runId===proposal.runId&&base.target.contractDigest===proposal.contractDigest&&base.baseDefinitionDigest===(previous?.bundle.digest??null),'Frozen proposal base differs from stored definition');return previous;
  }
  private assertReviewBase(proposal:Proposal):void {
    this.frozenBaseProposal(proposal);
    ensure(canonical(this.store.verificationLineage.baseForProposal(proposal.id))===canonical(this.store.verificationLineage.captureBase(proposal.projectId,proposal.runId)),'Review base or contract changed; fresh proposal required');
  }
  private async execute(job:VerificationJob,proposal:Proposal,plan:FrozenPlan|null,signal:AbortSignal):Promise<void> {
    const output=verificationDirectory(this.dataDir,job),context:EngineContext={store:this.store,job,signal,output,save:()=>this.repo.update('job',job),eligible:()=>{const runtime=this.store.runtime.get(job.runtimeId),run=this.repo.run(job.projectId,job.runId);ensure(!runtime.cancelled&&!runtime.paused,'Runtime cancelled or dispatch paused');if(job.kind==='review')this.assertReviewBase(proposal);ensure(run.attempts.find(a=>a.id===job.id)?.status==='running'&&digest(canonical(run.contract))===(plan?.contractDigest??proposal.contractDigest),'Verification attempt qualification changed');}};let stopped=false;
    let qualification:Omit<ControlQualificationEvidence,'id'|'schemaVersion'|'proposalId'|'proposalDigest'|'controlDraftDigest'|'reviewJobId'|'environmentDigest'|'proofs'|'digest'>|null=null;
    try {
      await mkdir(output,{recursive:true});
      if(job.kind==='review'&&this.store.verificationLineage.bindingForProposal(proposal.id).definitionFormat==='qualified-v2') {
        qualification=await this.reviewControl(context,proposal);
      }else if(job.kind==='review') {
        await executeDefinitionControls(context,proposal.spec,proposal.bundle);
        const prompt=await definitionReviewPrompt(proposal.spec,proposal.bundle,this.frozenBaseProposal(proposal),this.repo.run(job.projectId,job.runId).contract,job.controls,proposal.researchProofPlanDigest?this.store.researchWorkflow.proposal(proposal.id).proofPlan:undefined);
        const review=await reviewModel(context,prompt,proposal.candidate.tree,join(output,'definition-review'));job.approved=review.verdict==='passed';if(!job.approved)job.error='Independent definition review: '+review.reason;
      }else {
        job.results=await executeInstances(context,proposal.spec,proposal.bundle,plan!.candidate,plan!.selection.instances,'candidate');
        job.evaluation=evaluateVerification(proposal.spec,plan!.selection,job.results);job.approved=job.evaluation.passed;
      }
      await assertDefinition(proposal.spec,proposal.bundle);await assertCandidate(plan?.candidate??proposal.candidate);
      ensure(job.environmentDigest===(await environmentFingerprint(job.environmentScope)).digest,'Environment changed during verification');
      ensure(!signal.aborted,'Verification cancelled');
    }catch(error){job.error=String(error);job.approved=false;}
    try {stopped=job.intents.length===job.identities.length&&await allStopped(job.identities);
      ensure(stopped,'Verifier process stop unresolved');await writeFile(join(output,'report.json'),JSON.stringify({results:job.results,controls:job.controls,evaluation:job.evaluation,error:job.error},null,2));job.proofs=await proofHashes(output);
    }catch(error){job.error=(job.error??'')+' '+String(error);job.approved=false;}
    try {
      this.repo.transaction(()=>{
        this.finish(job,stopped);
        if(qualification&&job.approved){
          const value:Omit<ControlQualificationEvidence,'digest'>={schemaVersion:1,id:'qualification:'+job.id,proposalId:proposal.id,proposalDigest:this.store.verificationLineage.bindingForProposal(proposal.id).proposalDigest,controlDraftDigest:proposal.controlDraftDigest!,reviewJobId:job.id,environmentDigest:job.environmentDigest,...qualification,proofs:job.proofs};
          this.store.controlQualification.recordQualification({commandId:'qualification:'+job.id,reviewId:job.id,evidence:{...value,digest:controlQualificationDigest(value)}});
        }
      });
    }catch(error){
      // A rejected sidecar rolls back publication evidence AND success settlement.
      // Retain the actually consumed usage and original stage files as a failure.
      job.approved=false;job.error='Control evidence finalization failed: '+String(error);
      try{await writeFile(join(output,'report.json'),JSON.stringify({results:job.results,controls:job.controls,evaluation:job.evaluation,error:job.error},null,2));job.proofs=await proofHashes(output);}catch(proofError){job.error+='; '+String(proofError);}
      this.finish(job,stopped);
    }
  }
  private async reviewControl(context:EngineContext,proposal:Proposal){
    const repo=this.store.controlQualification,draft=repo.draftForProposal(proposal.id).draft;
    await assertControlDraft(draft);context.eligible();
    repo.appendReviewStage({commandId:context.job.id+':bootstrap',reviewId:context.job.id,stage:'bootstrap',payload:{draftDigest:draft.digest}});
    const bootstrap=await executeControlBootstrap(context,draft);
    const assembled=await assembleQualification({draft,evidence:bootstrap,reviewJob:this.repo.get('job',context.job.id)});
    repo.appendReviewStage({commandId:context.job.id+':matrix-frozen',reviewId:context.job.id,stage:'matrix-frozen',payload:{bootstrap,assembled}});
    const execution=await executeQualification(context,assembled);
    repo.appendReviewStage({commandId:context.job.id+':qualification',reviewId:context.job.id,stage:'qualification',payload:{execution}});
    ensure(execution.evaluation.qualified&&execution.stopConfirmed,'Control qualification did not preserve all required positive and negative witnesses');
    const maintenance=this.store.controlMaintenance.sourcesForProposal(proposal);
    if(maintenance){const replay=await executeMaintenanceReplay(context,proposal,maintenance.basis,maintenance.plan);this.store.controlMaintenance.appendReplay(replay);}
    const maintenancePayload=this.store.controlMaintenance.reviewPayload(proposal.id,context.job.id);
    const prompt=await controlQualificationReviewPrompt({...assembled,pairs:execution.pairs,materialObservations:context.job.materials??[],...(proposal.researchProofPlanDigest?{researchWorkflow:this.store.researchWorkflow.qualificationReviewContext(proposal.id)}:{}),...(maintenancePayload?{maintenance:maintenancePayload}:{})});
    const independentReview=await reviewModel(context,prompt,proposal.candidate.tree,join(context.output,'definition-review'));
    context.save();context.eligible();
    const reviewPromptDigest=digest(prompt);
    repo.appendReviewStage({commandId:context.job.id+':independent-review',reviewId:context.job.id,stage:'independent-review',payload:{review:independentReview,promptDigest:reviewPromptDigest}});
    context.job.approved=independentReview.verdict==='passed';if(!context.job.approved)context.job.error='Independent control qualification review: '+independentReview.reason;
    return {bootstrap,assembled,execution,independentReview,reviewPromptDigest};
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
  private async assertJob(job:VerificationJob):Promise<void>{return new VerificationProofReader(this.store).assertJob(job);}
  private async assertReviewedProposal(proposal:Proposal):Promise<void>{return new VerificationProofReader(this.store).assertReviewedProposal(proposal);}
  private async current(plan:FrozenPlan,job:VerificationJob,refresh=false):Promise<void>{return new VerificationProofReader(this.store).current(plan,job,refresh);}
  async status(runtimeId:string):Promise<unknown> {
    const runtime=this.store.runtime.get(runtimeId);let catalogHead:{proposalId:string;version:number|null}|null=null,catalogHeadError:string|null=null;try{const head=this.repo.headForRun(runtime.projectId,runtime.runId);if(head)catalogHead={proposalId:head.id,version:head.version};}catch(error){catalogHeadError=String(error);}const deliveries=this.repo.list('delivery',runtimeId),latest=deliveries.at(-1);let current=false,reason=latest?'':'No accepted delivery';
    if(latest)try{if(latest.researchProofPlanDigest)this.store.researchWorkflow.assertCommittedDelivery(latest);await this.current(this.repo.get('plan',latest.planId),this.repo.get('job',latest.jobId));if(latest.mobilePackage)await assertMobileDelivery(latest.mobilePackage);current=true;}catch(error){reason=String(error);}
    const assessment=latest?await this.deliveryAssessment(latest):null;
    return {catalogHead,catalogHeadError,proposals:this.repo.list('proposal',runtimeId),plans:this.repo.list('plan',runtimeId),jobs:this.repo.list('job',runtimeId),deliveries,currentDelivery:{current,reason,delivery:latest??null,assessment}};
  }
  /** Observation only: historical proof and current workspace observations never
   * replace current(), which remains the strict publication/delivery gate. */
  private async deliveryAssessment(delivery:Delivery):Promise<DeliveryAssessment> {
    const checkedAt=new Date().toISOString();
    try {
      const runtime=this.store.runtime.get(delivery.runtimeId),workspace=runtime.workspace;
      const observation=()=>{
        const runtimes=this.store.runtime.list().filter(r=>overlap(r.workspace,workspace)),executions=this.store.executionList().filter(e=>overlap(e.workspace,workspace)),jobs=this.repo.list('job').filter(j=>overlap(j.workspace,workspace));
        const conversation=this.store.conversations.forRun(delivery.projectId,delivery.runId);
        let scopedHead:unknown=null;try{scopedHead=this.store.verificationLineage.headForRun(delivery.projectId,delivery.runId);}catch(error){scopedHead={unresolved:String(error)};}
        const quiet=runtimes.every(r=>['cancelled','awaiting-verification'].includes(r.phase)&&!this.store.conversations.hasPendingForRun(r.projectId,r.runId)&&this.store.runtime.currentOperations(r.id).every(o=>['confirmed','cancelled'].includes(o.state)))&&executions.every(e=>e.stopConfirmed)&&jobs.every(j=>j.status==='finished'&&j.stopConfirmed);
        return {quiet,token:canonical({runtimes,executions,jobs,conversation,scopedHead,run:this.repo.run(delivery.projectId,delivery.runId)})};
      };
      const before=observation();
      const snapshot=this.repo.transaction(()=>{
        const run=this.repo.run(delivery.projectId,delivery.runId),plan=this.repo.get('plan',delivery.planId),proposal=this.repo.get('proposal',plan.proposalId),verification=this.repo.get('job',delivery.jobId);
        ensure(proposal.reviewId,'Historical proposal lacks review record');const review=this.repo.get('job',proposal.reviewId);
        const conversation=this.store.conversations.forRun(delivery.projectId,delivery.runId),round=conversation?this.store.conversations.rounds(conversation.id).find(r=>r.runId===delivery.runId)??null:null;
        const scopeIssues:DeliveryIssue[]=[];let head:{proposalId:string}|null=null,definitionFormat:'legacy-v1'|'qualified-v2'|undefined;
        try { const value=this.repo.headForRun(delivery.projectId,delivery.runId);head=value?{proposalId:value.id}:null;definitionFormat=this.store.verificationLineage.bindingForProposal(proposal.id).definitionFormat; }
        catch(error){scopeIssues.push({code:'scope-unresolved',area:'scope',message:String(error)});}
        const result:DeliveryEvidenceSnapshot={delivery,run,runtime,plan,proposal,verification,review,artifact:this.repo.artifactRecord(run.projectId,run.id,plan.id),conversation,round,head,scopeIssues,...(definitionFormat?{definitionFormat}:{})};return result;
      });
      let currentEnvironmentDigest:string|null=null;try{currentEnvironmentDigest=(await environmentFingerprint(snapshot.verification.environmentScope)).digest;}catch{}
      let result=await assessDeliveryEvidence(snapshot,{dataDir:this.dataDir,checkedAt,workspaceRead:before.quiet?'quiet':'busy',currentEnvironmentDigest,qualificationReader:this.store.controlQualification});
      if(delivery.researchProofPlanDigest)try{this.store.researchWorkflow.assertCommittedDelivery(delivery);}catch(error){result.historicalEvidenceIntact=false;result.issues.push({code:'history-evidence-invalid',area:'history',message:'Native research seal unavailable or differs: '+String(error)});}
      if(observation().token!==before.token){result=invalidateWorkspaceObservation(result);result.isActiveRound=null;result.headMatches=null;result.issues.push({code:'scope-unresolved',area:'scope',message:'Task state changed during the read-only evidence observation'});}
      return result;
    }catch(error){return unavailableDeliveryAssessment(delivery,checkedAt,{code:'history-unavailable',area:'history',message:String(error)});}
  }
  async close():Promise<void>{this.closing=true;for(const active of this.pending.values())active.abort.abort();const settled=await Promise.allSettled([this.openSessions.closeAll(),...[...this.pending.values()].map(p=>p.promise)]);const failed=settled.find(value=>value.status==='rejected');if(failed?.status==='rejected')throw failed.reason;}
}
