import {assertLegacyControlReviewEvidence} from './legacy-review-evidence.js';
import {parseEnvironmentScope,assertEnvironmentCwd} from './scoped-environment.js';
import {assertMobileJob,assertMobileFinalBinding} from './mobile-proof-reader.js';
import {assertFullstackJob} from './fullstack-proof.js';
import {assertMaterialsCurrent} from './material.js';
import {readFile} from 'node:fs/promises';
import type {SupervisorStore} from '../persistence/store.js';
import {inspectProcess,type ProcessIdentity} from '../process-control/index.js';
import {assertCandidate,canonical,digest,environmentFingerprint} from './candidate.js';
import {assertDefinition} from './definition.js';
import {evaluateVerification,selectInstances} from './rules.js';
import {assertSourcesCurrent} from './source.js';
import type {VerificationJob,Proposal,FrozenPlan} from './records.js';
function ensure(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
async function allStopped(identities:ProcessIdentity[]):Promise<boolean>{for(let i=0;i<identities.length;i+=4){const checks=await Promise.all(identities.slice(i,i+4).map(inspectProcess));if(checks.some(c=>c.status!=='stopped'))return false;}return true;}
/** Extracted existing P4 current qualification checks; no caller verdict authority. */
export class VerificationProofReader {
 constructor(private readonly store:Pick<SupervisorStore,'verification'|'runtime'|'conversations'|'controlQualification'|'verificationLineage'|'executionList'>){}
 private get repo(){return this.store.verification;}
  private assertQuietWorkspace(workspace:string):void {
    for(const runtime of this.store.runtime.list().filter(r=>overlap(r.workspace,workspace)))ensure(!this.store.conversations.hasPendingForRun(runtime.projectId,runtime.runId),'Pending follow-up must be resolved before verification publication');
    ensure(this.store.runtime.list().filter(r=>overlap(r.workspace,workspace)).every(r=>['cancelled','awaiting-verification'].includes(r.phase)&&this.store.runtime.currentOperations(r.id).every(o=>['confirmed','cancelled'].includes(o.state))),'Workspace has unresolved runtime work');
    ensure(this.store.executionList().filter(e=>overlap(e.workspace,workspace)).every(e=>e.stopConfirmed),'Workspace has an active writer');
  }
  async assertJob(job:VerificationJob):Promise<void> {
    if(job.environmentScope){parseEnvironmentScope(job.environmentScope,job);for(const intent of job.intents)if(intent.args.includes('app-server')){ensure(intent.cwd===job.environmentScope.workspace,'Scoped review model cwd differs from admitted workspace');await assertEnvironmentCwd(job.environmentScope,intent.cwd);}}
    ensure(job.environmentDigest===(await environmentFingerprint(job.environmentScope)).digest,'Verifier review or execution environment changed');
    ensure(job.status==='finished'&&job.stopConfirmed&&!job.usageUnknown&&Object.keys(job.proofs).length>0,'Missing completed verifier evidence');
    ensure(this.repo.run(job.projectId,job.runId).attempts.find(a=>a.id===job.attemptId)?.settled,'Verification usage unsettled');
    for(const [path,hash]of Object.entries(job.proofs))ensure(digest(await readFile(path))===hash,'Verification evidence changed');
    await assertMobileJob(job);
    const proposal=this.repo.get('proposal',job.proposalId),candidates=job.kind==='verification'?[this.repo.get('plan',job.planId!).candidate]:proposal.bundle.controls.map(c=>c.candidate);await assertFullstackJob(job,proposal.spec,candidates);
    ensure(job.intents.length===job.identities.length,'Verifier intent has no stop identity');ensure(await allStopped(job.identities),'Old verification process is still active');
  }
  async assertReviewedProposal(proposal:Proposal):Promise<void> {
    ensure(proposal.reviewId&&proposal.reviewEnvironmentDigest,'Published catalog lacks independently reviewed environment');
    const review=this.repo.get('job',proposal.reviewId);
    ensure(review.kind==='review'&&review.proposalId===proposal.id&&review.approved&&!review.error&&review.environmentDigest===proposal.reviewEnvironmentDigest,'Published catalog has no valid independent approval');
      if(this.store.verificationLineage.bindingForProposal(proposal.id).definitionFormat==='legacy-v1')assertLegacyControlReviewEvidence({dataDir:this.repo.dataDirectory(),proposal,review});
    ensure(canonical(review.environmentScope??null)===canonical(proposal.environmentScope??null),'Published review scope differs');await this.assertJob(review);await assertSourcesCurrent(review.sources);await assertMaterialsCurrent(review.materials??[]);
    if(this.store.verificationLineage.bindingForProposal(proposal.id).definitionFormat==='qualified-v2')this.store.controlQualification.assertPublicationBinding({proposalId:proposal.id,reviewId:review.id});
  }
  async current(plan:FrozenPlan,job:VerificationJob,refresh=false):Promise<void> {
    const proposal=this.repo.get('proposal',plan.proposalId);ensure(canonical(plan.environmentScope??null)===canonical(job.environmentScope??null)&&canonical(plan.environmentScope??null)===canonical(proposal.environmentScope??null),'Verification scopes differ');await this.assertReviewedProposal(proposal);this.assertQuietWorkspace(plan.candidate.root);this.repo.assertNoVerificationWriter(plan.candidate.root);ensure(this.repo.headForRun(plan.projectId,plan.runId)?.id===plan.proposalId,'Published verification catalog changed');
    ensure(plan.contractDigest===proposal.contractDigest,'Plan differs from independently reviewed task contract');ensure(digest(canonical(this.repo.run(plan.projectId,plan.runId).contract))===plan.contractDigest,'Contract changed');ensure((await environmentFingerprint(plan.environmentScope)).digest===plan.environmentDigest,'Verifier environment changed');
    await assertCandidate(plan.candidate);await assertDefinition(proposal.spec,proposal.bundle);await this.assertJob(job);await assertSourcesCurrent(job.sources,refresh);await assertMaterialsCurrent(job.materials??[],refresh);
    assertMobileFinalBinding(plan,job,proposal);
    ensure(evaluateVerification(proposal.spec,plan.selection,job.results).complete,'Current evidence does not satisfy all necessary instances');
  }

 async finalJob(jobId:string):Promise<{job:VerificationJob;plan:FrozenPlan;proposal:Proposal}>{
 const job=this.repo.get('job',jobId);ensure(job.kind==='verification'&&job.planId&&job.approved&&!job.error&&job.identities.length>0,'Actual approved final verification job required');
 const plan=this.repo.get('plan',job.planId),proposal=this.repo.get('proposal',plan.proposalId);
 ensure(plan.selection.mode==='final'&&plan.selection.completeScope&&canonical(plan.selection)===canonical(selectInstances(proposal.spec,{mode:'final'})),'Exact complete final selection required');
 await this.current(plan,job);return {job,plan,proposal};
 }
}
