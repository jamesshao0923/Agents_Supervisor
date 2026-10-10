import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import type {SupervisorStore} from '../../packages/persistence/store.js';
import type {SupervisionInspection} from '../../packages/contracts/p6-supervision-actions.js';
import type {Proposal,VerificationJob} from '../../packages/verification/records.js';
import {assertCandidate,canonical,digest} from '../../packages/verification/candidate.js';
import {selectInstances} from '../../packages/verification/rules.js';

/** Assertion-only live evidence reader. Never seeds, authors, repairs or publishes. */
export async function assertLiveMaintenance(input:{
  store:SupervisorStore;final:SupervisionInspection;original:Proposal;
  failedId:string;oldPass:VerificationJob;passed:VerificationJob;
  proofs:(values:Record<string,string>)=>Promise<void>;
  checked:(job:VerificationJob)=>Promise<void>;
  save:(name:string,value:unknown)=>Promise<void>;
}):Promise<void>{
  const {store,final,original,failedId,oldPass,passed,proofs,checked,save}=input;
  const maintenance=final.controlMaintenance!;
  assert.equal(maintenance.basis.policy,'same-contract-regression-v1');
  assert.equal(maintenance.basis.contractDigest,original.contractDigest);
  assert.equal(maintenance.basis.contractVersion,original.spec.contractVersion);
  assert.equal(maintenance.basis.base.baseProposalId,original.id);
  assert.deepEqual(maintenance.basis.base.transitionIds,[],'Same-contract maintenance has no authority to change requirements');
  assert.equal(maintenance.basis.baselinePassJobId,oldPass.id);
  assert.equal(maintenance.basis.baselinePassPlanId,oldPass.planId);
  const successor=store.verification.get('proposal',maintenance.proposalId!);
  assert.equal(successor.spec.standardsVersion,original.spec.standardsVersion);
  assert.deepEqual(successor.spec.obligations,original.spec.obligations);
  assert.equal(successor.contractDigest,original.contractDigest);
  const binding=store.verificationLineage.bindingForProposal(successor.id);
  assert.equal(binding.definitionFormat,'qualified-v2');assert.equal(binding.base.baseProposalId,original.id);
  assert.deepEqual(binding.base,maintenance.basis.base);
  const oldPlan=store.verification.get('plan',oldPass.planId!),finalPlan=store.verification.get('plan',passed.planId!);
  assert.deepEqual(oldPlan.selection,selectInstances(original.spec,{mode:'final'}));
  assert.deepEqual(finalPlan.selection,selectInstances(successor.spec,{mode:'final'}));
  assert.equal(oldPlan.candidate.digest,maintenance.basis.passingCandidate.digest);
  assert.equal(finalPlan.candidate.digest,oldPlan.candidate.digest,'Maintenance cannot fix product bytes while changing tests');
  await assertCandidate(oldPlan.candidate,false);
  const author=final.jobs.find(job=>job.id===maintenance.authorJobId)!;assert.ok(author?.modelStarted&&author.threadId);
  assert.equal(author.error,null);assert.ok(author.usage!==null&&author.usage>0);
  const review=store.verification.get('job',maintenance.reviewId!);await checked(review);
  assert.equal(review.proposalId,successor.id);assert.ok(review.approved&&review.modelStarted);
  assert.ok(oldPass.finishedAt&&Date.parse(oldPass.finishedAt)<=Date.parse(review.startedAt),'Original full pass precedes independent maintenance review');
  assert.ok(review.finishedAt&&Date.parse(review.finishedAt)<=Date.parse(passed.startedAt),'New final only follows completed independent maintenance review');
  const stages=store.controlQualification.stagesForReview(review.id);
  assert.deepEqual(stages.map(stage=>stage.stage),['bootstrap','matrix-frozen','qualification','independent-review']);
  assert.deepEqual(stages.map(stage=>stage.sequence),[1,2,3,4]);
  const qualification=store.controlQualification.qualificationForReview(review.id);
  assert.equal(qualification.reviewJobId,review.id);assert.equal(qualification.proposalId,successor.id);
  assert.ok(qualification.execution.evaluation.qualified);
  assert.equal(qualification.independentReview.verdict,'passed');
  assert.ok(qualification.independentReview.usage!==null&&qualification.independentReview.usage>0);
  assert.notEqual(qualification.independentReview.threadId,author.threadId,'Review must be a fresh model context');
  assert.equal(qualification.assembled.matrix.transitionIds.length,0);
  assert.ok(qualification.assembled.matrix.rows.some(row=>row.role==='historical-witness'),'Original real negative witnesses stay qualified');
  assert.ok(qualification.assembled.matrix.rows.some(row=>row.role==='current'));
  assert.ok(qualification.execution.evaluation.rows.every(row=>row.qualified));
  await proofs(qualification.proofs);
  const stage=store.controlMaintenance.replayForReview(review.id)!;
  assert.ok(stage&&stage.replays.length>0);store.controlMaintenance.validateReplay(stage,true);
  const payload=store.controlQualification.maintenanceForReview(review.id)!;assert.ok(payload);
  assert.deepEqual(payload.replay,stage);
  assert.equal(stage.proposalId,successor.id);assert.equal(stage.reviewId,review.id);
  const executionPaths=[...new Set(stage.replays.flatMap(pair=>
    [...pair.bad,...pair.good].flatMap(result=>result.proofFiles??[])))].sort();
  assert.deepEqual(Object.keys(stage.executionProofs).sort(),executionPaths,'Immutable stage binds every original bad/good artifact');
  for(const path of executionPaths)assert.equal(stage.executionProofs[path],review.proofs[path],'Mutable job manifest cannot replace original replay evidence');
  await proofs(stage.executionProofs);

  assert.equal(stage.replays.length,maintenance.basis.sources.length);
  assert.deepEqual(stage.replays.map(pair=>pair.defectRef).sort(),maintenance.basis.sources.map(source=>source.defectRef).sort());
  for(const pair of stage.replays){
    const source=maintenance.basis.sources.find(item=>item.defectRef===pair.defectRef)!;
    assert.deepEqual(pair.source,source);assert.equal(source.failureJobId,failedId);
    const failure=store.verification.get('job',source.failureJobId);
    assert.ok(failure.results.some(result=>canonical(result)===canonical(source.result)));
    const failedPlan=store.verification.get('plan',failure.planId!);
    assert.equal(source.candidate.digest,failedPlan.candidate.digest);
    assert.equal(pair.passingCandidate.digest,oldPlan.candidate.digest);
    assert.ok(finalPlan.selection.instances.some(instance=>canonical(instance)===canonical(pair.instance)));
    const detector=successor.spec.cases.find(item=>item.id===pair.instance.caseId&&item.revision===pair.instance.revision)!;
    assert.ok(detector.defectRefs.includes(pair.defectRef),'New final detector retains explicit real fault provenance');
    for(const side of ['bad','good'] as const){
      const observation=review.controls.find(item=>item.id===`maintenance:${pair.id}:${side}`)!;
      assert.ok(observation?.passed);assert.deepEqual(observation.results,pair[side]);
      assert.equal(pair[side].length,1);const result=pair[side][0]!;
      assert.equal(result.instanceId,pair.instance.id);assert.equal(result.executionStatus,'executed');
      assert.deepEqual(result.checks.map(check=>check.obligationId).sort(),[...pair.instance.obligationIds].sort());
      for(const check of result.checks){
        if(side==='good')assert.equal(check.verdict,'passed');
        else if(source.obligationIds.includes(check.obligationId))assert.equal(check.verdict,'failed','An unrelated failure cannot prove this real defect');
        else assert.notEqual(check.verdict,'unknown');
      }
      assert.ok(result.proofFiles?.length);
      await proofs(Object.fromEntries(result.proofFiles!.map(path=>{assert.ok(review.proofs[path]);return [path,review.proofs[path]!];})));
    }
    await assertCandidate(pair.source.candidate,false);await assertCandidate(pair.passingCandidate,false);
    await save('actual-fault-replay-'+pair.id,pair);
  }
  assert.equal(review.controls.filter(row=>row.id.startsWith('maintenance:')).length,2*stage.replays.length);
  for(const [path,file] of Object.entries(oldPlan.candidate.files)){
    const actual=await readFile(join(oldPlan.candidate.tree,path));
    const executable=(await lstat(join(oldPlan.candidate.tree,path))).mode&0o111;
    assert.equal(digest(Buffer.concat([actual,Buffer.from('\0executable:'+String(executable))])),file);
    assert.deepEqual(payload.passingSourceText[path],{content:actual.toString('utf8'),executable});
  }
  assert.deepEqual(Object.keys(payload.passingSourceText).sort(),Object.keys(oldPlan.candidate.files).sort());
  assert.deepEqual(store.controlMaintenance.inheritedSources(successor.id),stage.replays.map(pair=>pair.source).sort((a,b)=>a.defectRef.localeCompare(b.defectRef)));
  await save('maintenance-qualified-chain',{maintenance,original,successor,oldPass,passed,qualification,payload});
}
