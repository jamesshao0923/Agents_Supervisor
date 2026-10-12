import {VerificationProofReader} from '../../packages/verification/proof-reader.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {indexedWorkflowFixture,fixtureProposal} from '../helpers/indexed-workflow-fixture.js';
import {actualIndexedRefreshFollowup} from '../helpers/indexed-refresh-followup.js';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {VerificationController} from '../../packages/verification/controller.js';
import {ExecutionManager} from '../../packages/execution/manager.js';
import {ResearchRuntimeActivity} from '../../packages/runtime/research-activity.js';
import {captureMaterialBinding,readMaterialBinding} from '../../packages/verification/material.js';
import {captureCandidate,canonical,digest,environmentFingerprint} from '../../packages/verification/candidate.js';
import {createEnvironmentScope} from '../../packages/verification/scoped-environment.js';
import {acceptanceAuthoringContextDigest,type AcceptanceAuthoringContext} from '../../packages/orchestration/acceptance-authoring.js';
import {captureControlEvolutionContext,referencedIndexedHistoryEvolutionAuthorInput,controlEvolutionAuthoringSchema,controlEvolutionContextDigest,materializeControlEvolutionBundle,type ControlEvolutionBundle} from '../../packages/orchestration/acceptance-authoring-v2.js';
import {SupervisionReasoningRunner} from '../../packages/orchestration/supervision-reasoning.js';
import {CodexReasonerAdapter} from '../../packages/orchestration/reasoner.js';
import {controlSpecimenKey} from '../../packages/verification/control-bootstrap.js';
import {inspectProcess,type ProcessIdentity} from '../../packages/process-control/index.js';
import type {Proposal,VerificationJob,FrozenPlan,Delivery} from '../../packages/verification/records.js';
import type {RuntimeRecord} from '../../packages/contracts/p3.js';

// Ordinary actual FS/SQLite/managed-Node lifecycle. Every model interpretation,
// author reply and token count is explicit synthetic protocol, never provider
// semantic or efficiency evidence. No exchange/tamper/fault injection occurs.
async function files(root:string):Promise<Record<string,string>>{
 const out:Record<string,string>={};for(const e of await readdir(root,{withFileTypes:true})){
  const p=join(root,e.name);if(e.isDirectory())Object.assign(out,await files(p));else out[p]=digest(await readFile(p));
 }return out;
}
async function producer(f:Awaited<ReturnType<typeof indexedWorkflowFixture>>,r:RuntimeRecord,n:number,sharedDeadline:number){
 const activity=new ResearchRuntimeActivity(f.store,f.data),owner='indexed-refresh-'+n;
 const acquire=f.store.runtime.claim(r.id,owner)!;await activity.acquire(acquire,owner);
 const op=f.store.runtime.claim(r.id,owner)!;
 await activity.prepare(op.id,owner);
 const integration=await f.store.runtime.prepareIntegrationInputs(op.id,owner);assert.equal(integration,null);
 const input=f.store.runtime.researchInput(op.id)!;
 assert.equal(input.package.schemaVersion,2);assert.ok(input.package.indexed);assert.equal(input.package.context.index.inputs.length,5);
 const report=fixtureProposal(input.package.context),quote=(await readFile(f.source,'utf8')).trimEnd();
 report.citations.find(c=>c.materialId==='original')!.quote=quote;report.citations.find(c=>c.materialId==='original')!.end=quote.length;
 await writeFile(join(f.root,'fixture-reply.json'),JSON.stringify({kind:'producer',value:report}));
 f.store.runtime.markStarted(op.id,owner);const manager=new ExecutionManager(f.store,f.data);
 let id:string|undefined;
 try{const execution=await manager.startBound(f.store.runtime.executionInput(op.id,owner),f.store.runtime.binding(op.id,owner));id=execution.id;
  while(!f.store.executionGet(id).stopConfirmed&&Date.now()<sharedDeadline)await new Promise(r=>setTimeout(r,25));
  const actual=f.store.executionGet(id);assert.equal(actual.state,'completed',actual.error??'producer incomplete');assert.equal(actual.stopConfirmed,true);assert.equal(actual.usageStatus,'reported');assert.equal((await inspectProcess(actual.identity as ProcessIdentity)).status,'stopped');
 }finally{await manager.close({cancel:false});}
 f.store.runtime.report(op.id,owner,{messageId:'indexed-refresh-result-'+n,outcome:'confirmed',result:{executionId:id}});
 return {op,input,report,binding:await captureMaterialBinding(f.store,f.data,op.id),executionId:id!};
}

test('P8-INDEXED-REFRESH-I01 sealed grouped predecessor indexed original epochs survive two same-input refreshes through full independent P4 and reopened third seal',{timeout:660000},async t=>{
 const began=Date.now(),sharedDeadline=began+660000,archiveRoot=join(process.env.SUPERVISOR_EVIDENCE_DIR??join(process.cwd(),'.supervisor-dev','indexed-refresh-evidence'),String(began));
 const f=await indexedWorkflowFixture(t,undefined,undefined,{timestampSyntheticEvents:true,archiveRoot,preserveOriginalRoot:true},{indexedGroups:true});
 assert.equal(f.groupExecutions.length,2);assert.equal(f.context.contract.version,2);
 const conversation=f.store.conversations.ensureForGoal(f.runtime.runId),initialContract=structuredClone(f.context.contract),initialChecks=structuredClone(f.store.goals.get(f.runtime.runId).proposal!.criteria);
 const groupedInput=f.store.runtime.researchInput(f.store.runtime.currentOperations(f.runtime.id).find(o=>o.step.kind==='codex'&&o.step.research)!.id)!.package;
 assert.equal(groupedInput.groups!.groups.length,2);assert.equal(groupedInput.indexed!.view.allowedMaterialIds.length,5);
 const initialHistory=canonical({proposal:f.store.verification.get('proposal',f.proposal.id),review:f.store.verification.get('job',f.proposal.reviewId!),final:f.store.verification.get('job',f.final.id),delivery:f.delivery,input:groupedInput});
 const oldFiles=await files(f.proposal.bundle.root);let previous=f.proposal,previousRuntime=f.runtime,lastDelivery=f.delivery;
 const records:unknown[]=[];
 for(let n=1;n<=2;n++){
  const message=f.store.conversations.receive({conversationId:conversation.id,commandId:'indexed-refresh-'+n,source:'user',kind:'change',text:'Refresh original from the same path; retain all five input identities and every original question, check and cutoff.'});
  const child=f.store.goals.createContinuation(conversation.id,'indexed-round-'+n),prior=f.store.runtime.inspect(previousRuntime.id).run.contract;
  const applied=await actualIndexedRefreshFollowup(f,child.session.id,message.id,prior,child.session.proposal!,{decision:'revise',response:'Refresh only original source bytes.',proposal:structuredClone(child.session.proposal!),retiredCriterionIds:[],retirementSources:[],criterionChanges:[],sourceRefresh:{materialIds:['original'],sources:[{messageId:message.id,quote:message.text}]}});
  const runtime=f.store.runtime.get(applied.session.runtimeId!);assert.deepEqual(applied.run.contract.criteria,initialContract.criteria);assert.deepEqual(applied.session.proposal!.criteria,initialChecks);assert.equal(f.store.conversations.message(message.id).state,'applied');
  await writeFile(f.source,'The refreshed document '+n+' describes a bounded read-only tool.\n');
  const current=await producer(f,runtime,n,sharedDeadline),source=await readMaterialBinding(current.binding),root=join(f.root,'indexed-round-'+n);await mkdir(root);
  const candidate=await captureCandidate(f.workspace,join(root,'author-candidate')),scope=await createEnvironmentScope(f.data,runtime);
  const acceptance:AcceptanceAuthoringContext={contract:applied.run.contract,criteria:applied.session.proposal!.criteria,candidate:{workspace:f.workspace,digest:candidate.digest,files:await Promise.all(Object.keys(candidate.files).map(async path=>{const content=await readFile(join(candidate.tree,path),'utf8');return{path,content,sha256:digest(content)};}))},environment:{...await environmentFingerprint(scope),scope},failureContext:null,previousSpec:null,workflowMode:'native-host-v1',materials:applied.session.proposal!.criteria.map(c=>({target:c.target,binding:current.binding,evidence:{context:source.input.context,indexed:source.input.indexed!}}))};
  const base=f.store.verificationLineage.captureBase(runtime.projectId,runtime.runId),history=f.store.controlQualification.loadHistory(previous.id),refresh=f.store.controlQualification.sourceRefreshContext(base,current.binding,history)!;
  assert.equal(refresh.historicalEpochs.every(e=>!!e.indexed),true);assert.equal(refresh.generation.entries.length,5);assert.equal(refresh.generation.entries.filter(e=>!e.selected).every(e=>e.state==='current'),true);
  const evolution=await captureControlEvolutionContext({current:acceptance,base,transitions:base.transitionIds.map(id=>f.store.verificationLineage.transition(id)),history,sourceRefresh:refresh});
  const oldCase=previous.spec.cases.filter(c=>(c.status??'active')==='active').sort((a,b)=>b.revision-a.revision)[0]!,currentCase={...structuredClone(oldCase),revision:oldCase.revision+1,verifier:{kind:'material' as const,version:'indexed-refresh-'+n,claimFile:'research-report/report.json',binding:current.binding,timeoutMs:15000}};
  const bad=structuredClone(current.report);bad.claims[0]!.text='The document describes an unbounded write tool.';
  const frontier=history.manifest!.entries.filter(e=>e.disposition==='current').map(e=>history.specimens.find(s=>canonical(s.revision.ref)===canonical(e.specimen))!.revision),positive=frontier.find(s=>s.kind==='positive-full')!,negative=frontier.find(s=>s.kind==='negative')!;
  const assets:ControlEvolutionBundle['assets']={contextDigest:acceptanceAuthoringContextDigest(acceptance),spec:{schemaVersion:1,contractVersion:applied.run.contract.version,standardsVersion:'indexed-refresh-'+n,obligations:structuredClone(previous.spec.obligations),cases:[...structuredClone(previous.spec.cases),currentCase],controls:[{id:'good-current',workspace:'good-current',expect:'passed',mustFail:[]},{id:'bad-current',workspace:'bad-current',expect:'failed',mustFail:['faithful-meaning']}],moduleDependencies:{meaning:[]}},verifierFiles:[],controls:[{id:'good-current',files:[{path:'research-report/report.json',content:JSON.stringify(current.report)}]},{id:'bad-current',files:[{path:'research-report/report.json',content:JSON.stringify(bad)}]}],coverageExplanation:structuredClone(f.bundle.coverageExplanation),researchWorkflow:{schemaVersion:1,mappings:structuredClone(f.bundle.researchWorkflow!.mappings)}};
  const bundle:ControlEvolutionBundle={contextDigest:controlEvolutionContextDigest(evolution),assets,plan:{controlPlan:[{controlId:'good-current',kind:'positive-full',predecessorKey:controlSpecimenKey(positive.ref)},{controlId:'bad-current',kind:'negative',predecessorKey:controlSpecimenKey(negative.ref)}],historyPlan:frontier.map(s=>({specimenKey:controlSpecimenKey(s.ref),successorControlId:s.kind==='positive-full'?'good-current':'bad-current',retireObligationIds:[]})),evolutionExplanation:'Keep every original immutable historical fault and produce valid-current-citation witnesses for the same semantic defect.'}};
  const loop=f.store.supervision.attach({commandId:'indexed-author-loop-'+n,runtimeId:runtime.id,config:f.config,limits:{maxRepairs:0,maxReasoningCalls:4,maxDurationMs:600000,maxContextChars:200000}});
  const author=f.store.supervision.beginJob({commandId:'indexed-author-'+n,loopId:loop.id,expectedRevision:loop.revision,purpose:'acceptance-authoring',context:referencedIndexedHistoryEvolutionAuthorInput({acceptance,candidate,evolution})});
  await writeFile(join(f.root,'fixture-reply.json'),JSON.stringify({kind:'author',value:bundle}));
  const reasoner=new SupervisionReasoningRunner(f.store,f.data,new CodexReasonerAdapter());let completed;
  try{completed=await reasoner.run(author.id);}finally{await reasoner.close();}
  assert.equal(completed.error,null);assert.equal(completed.stopConfirmed,true);assert.equal(completed.result!==null,true);
  const material=await materializeControlEvolutionBundle({privateRoot:join(f.data,'supervision','authoring'),jobId:author.id,context:evolution,bundle:completed.result});
  const p=await f.p4.dispatch({type:'propose',commandId:'indexed-propose-'+n,runtimeId:runtime.id,specPath:material.assets.specPath,controlDeclarationPath:material.declarationPath,controlAuthorJobId:author.id,researchAuthorJobId:author.id}) as Proposal;
  const finished=async(action:Parameters<VerificationController['dispatch']>[0])=>{let job=await f.p4.dispatch(action) as VerificationJob;const until=sharedDeadline;while(job.status==='running'){assert.ok(Date.now()<until,'actual V2 observer elapsed');await new Promise(r=>setTimeout(r,25));job=f.store.verification.get('job',job.id);}assert.equal(job.approved,true,job.error??JSON.stringify(job));assert.equal(job.stopConfirmed,true);assert.equal(job.usageUnknown,false);return job;};
  const review=await finished({type:'review',commandId:'indexed-review-'+n,proposalId:p.id,...f.config}),qualification=f.store.controlQualification.qualificationForReview(review.id);
  assert.equal(qualification.execution.evaluation.qualified,true);assert.equal(qualification.execution.pairs.length,qualification.assembled.matrix.rows.length);assert.ok(qualification.assembled.matrix.rows.some(r=>r.context?.role==='historical'));
  const epochs=qualification.assembled.matrix.sourceRefresh!.context.historicalEpochs;assert.ok(epochs.some(e=>e.originalProposalId===f.proposal.id));if(n===2)assert.ok(epochs.some(e=>e.originalProposalId===previous.id));
  await f.p4.dispatch({type:'publish',commandId:'indexed-publish-'+n,proposalId:p.id,reviewId:review.id});
  const plan=await f.p4.dispatch({type:'freeze',commandId:'indexed-freeze-'+n,runtimeId:runtime.id,mode:'final'}) as FrozenPlan;
  const final=await finished({type:'run',commandId:'indexed-final-'+n,planId:plan.id,...f.config});assert.equal(final.evaluation!.complete,true);assert.equal(final.approvalScope,'research-artifact');
  const delivery=await f.p4.dispatch({type:'deliver',commandId:'indexed-deliver-'+n,jobId:final.id}) as Delivery;assert.notEqual(delivery.id,lastDelivery.id);assert.equal(f.store.runtime.inspect(runtime.id).run.status,'succeeded');
  const reopened=new SupervisorStore(f.data),reader=new VerificationController(reopened,f.data);try{await new VerificationProofReader(reopened).assertReviewedProposal(reopened.verification.get('proposal',p.id));await new VerificationProofReader(reopened).assertJob(reopened.verification.get('job',final.id));await reopened.researchWorkflow.assertCommittedCurrent(delivery);}finally{await reader.close();reopened.close();}
  for(const job of [review,final])for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');
  records.push({runtimeId:runtime.id,producerId:current.executionId,authorId:author.id,proposalId:p.id,reviewId:review.id,finalId:final.id,deliveryId:delivery.id,epochs:epochs.map(e=>({digest:e.digest,proposalId:e.originalProposalId,observedAt:e.observedAt})),qualificationDigest:qualification.digest});
  previous=f.store.verification.get('proposal',p.id);previousRuntime=runtime;lastDelivery=delivery;
 }
 assert.equal(f.store.conversations.rounds(conversation.id).length,3);assert.deepEqual(await files(f.proposal.bundle.root),oldFiles);assert.equal(canonical({proposal:f.store.verification.get('proposal',f.proposal.id),review:f.store.verification.get('job',f.proposal.reviewId!),final:f.store.verification.get('job',f.final.id),delivery:f.delivery,input:groupedInput}),initialHistory);
 const budget=f.store.conversations.budget(conversation.id);assert.equal(budget.reserved,0);assert.ok(f.store.runtime.list().every(r=>f.store.runtime.inspect(r.id).run.attempts.every(a=>a.settled)));assert.ok(budget.spent<=budget.limit!);
 await writeFile(join(f.root,'indexed-refresh-complete.json'),JSON.stringify({scope:'actual component with explicit synthetic protocol, not provider or P8 stage gate',root:f.root,data:f.data,records,budget},null,2));
});
