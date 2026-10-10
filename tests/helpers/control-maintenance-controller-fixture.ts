import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {VerificationController} from '../../packages/verification/controller.js';
import {SupervisionController} from '../../packages/orchestration/supervision-controller.js';
import {LocalRuntimeAdapter} from '../../packages/runtime/index.js';
import {codexStart} from '../../packages/contracts/p3.js';
import type {VerificationSpec} from '../../packages/contracts/p4.js';
import type {VerificationJob,Proposal,FrozenPlan} from '../../packages/verification/records.js';
import {spawnManagedProcess,inspectProcess} from '../../packages/process-control/index.js';
import {writeMaintenanceTransport} from './control-maintenance-transport.js';

// Actual SQLite, production controllers, actual managed Node protocol transport,
// P4 commands and files. All planner/reviewer text and token counts are synthetic
// mechanism fixtures, never an independent model or live product acceptance.
export async function exerciseMaintenance(t:TestContext,mode:'regression'|'dedup'|'reject'='regression'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-maintenance-controller-'))),data=join(root,'data'),workspace=join(root,'workspace'),binary=join(root,'transport.cjs');await mkdir(workspace);await writeFile(join(workspace,'result.json'),'{"value":1}\n');await writeMaintenanceTransport(binary,mode);
 const old=process.env.SUPERVISOR_CODEX_PATH;process.env.SUPERVISOR_CODEX_PATH=binary;
 let store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),verification=new VerificationController(store,data),controller=new SupervisionController(store,data,runtime,verification);
 t.after(async()=>{await controller.close();await verification.close();await runtime.close();store.close();if(old===undefined)delete process.env.SUPERVISOR_CODEX_PATH;else process.env.SUPERVISOR_CODEX_PATH=old;await rm(root,{recursive:true,force:true});});
 const config={model:'maintenance-fixture',effort:'low',reservation:1000,timeoutMs:30000};
 const goal=store.goals.start({type:'start',commandId:'goal',goal:'result.json value must equal 2',tokenLimit:20000,verificationReserve:1000,...config},workspace,'project');
 const ready=store.goals.finish(goal.session.id,goal.session.jobs[0]!.id,job=>{job.usage=0;job.stopConfirmed=true;job.proposal={decision:'ready',summary:'Explicit repository planning fixture',questions:[],facts:[{text:goal.session.goal,origin:'explicit',sourceId:goal.session.messages[0]!.id}],constraints:[],style:[],criteria:[{id:'value',kind:'command',target:'result.json',description:'Value equals two',checks:['result.json value must equal 2']}],steps:[{id:'implement',description:'Implement value',dependencies:[],acceptanceIds:['value']}]};});
 const admitted=store.goals.control({type:'admit',commandId:'admit',sessionId:ready.session.id,expectedRevision:ready.session.revision}),runtimeId=admitted.session.runtimeId!;
 store.runtime.revise({commandId:'fixture-input',runtimeId,expectedContractVersion:admitted.run.contract.version,contract:{...admitted.run.contract,version:admitted.run.contract.version+1},nodes:[{id:'ready',required:true,dependencies:[]}],steps:[{id:'ready',kind:'input',prompt:'Explicit initial implementation fixture'}],reason:'Mechanism planning fixture; no provider implementation claimed'});
 store.runtime.control({type:'input',commandId:'ready',runtimeId,stepId:'ready',text:'Initial incorrect file exists'});const op=store.runtime.claim(runtimeId,'owner')!;store.runtime.report(op.id,'owner',{messageId:'initial',outcome:'confirmed',result:{text:'Initial source fixture'}});
 for(const name of ['good','bad','definition'])await mkdir(join(root,name));await writeFile(join(root,'good/result.json'),'{"value":2}\n');await writeFile(join(root,'bad/result.json'),'{"value":1}\n');
 const checker="import{readFileSync,writeFileSync}from'node:fs';const value=JSON.parse(readFileSync(process.argv[2]+'/result.json','utf8')).value;const pass=value===2;writeFileSync(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks:[{obligationId:'correct',verdict:pass?'passed':'failed',reason:'Actual value '+value+' compared with required 2'}]}));process.exitCode=pass?0:1;";await writeFile(join(root,'definition/check.mjs'),checker);
 const initialContract=structuredClone(store.runtime.inspect(runtimeId).run.contract);
 const spec:VerificationSpec={schemaVersion:1,contractVersion:initialContract.version,standardsVersion:'value-is-two',obligations:[{id:'correct',criterionId:'value',expectation:'result.json value equals 2',required:true,applicable:true}],cases:[{id:'value-case',revision:1,obligationIds:['correct'],parameters:[{}],modules:['value'],replaces:[],defectRefs:['wrong-value'],verifier:{kind:'command',version:'v1',entry:'check.mjs',files:['check.mjs'],timeoutMs:5000}}],controls:[{id:'good',workspace:join(root,'good'),expect:'passed',mustFail:[]},{id:'bad',workspace:join(root,'bad'),expect:'failed',mustFail:['correct']}],moduleDependencies:{value:[]}};if(mode==='dedup')spec.cases.push({...structuredClone(spec.cases[0]!),id:'duplicate-value',defectRefs:['duplicate-wrong-value']});await writeFile(join(root,'definition/spec.json'),JSON.stringify(spec));
 async function finished(id:string){const until=Date.now()+60000;while(Date.now()<until){const job=store.verification.get('job',id);if(job.status==='finished')return job;await new Promise(r=>setTimeout(r,25));}throw Error('Mechanism verifier timeout');}
 const proposal=await verification.dispatch({type:'propose',commandId:'initial-propose',runtimeId,specPath:join(root,'definition/spec.json')}) as Proposal;
 const review=await finished((await verification.dispatch({type:'review',commandId:'initial-review',proposalId:proposal.id,...config}) as VerificationJob).id);assert.equal(review.approved,true,review.error??'');await verification.dispatch({type:'publish',commandId:'initial-publish',proposalId:proposal.id,reviewId:review.id});
 const plan=await verification.dispatch({type:'freeze',commandId:'initial-freeze',runtimeId,mode:'final'}) as FrozenPlan;
 const failure=await finished((await verification.dispatch({type:'run',commandId:'initial-run',planId:plan.id,...config}) as VerificationJob).id);assert.equal(failure.error,null);assert.equal(failure.approved,false);assert.equal(failure.results[0]!.checks[0]!.verdict,'failed');
 let run=store.runtime.inspect(runtimeId).run;store.runtime.appendRepair({commandId:'actual-repair',runtimeId,expectedRevision:run.revision,expectedContractVersion:run.contract.version,reason:'Repair actual product failure while preserving original checker',failureJobId:failure.id,failedObligationIds:['correct'],steps:[{id:'repair',kind:'codex',prompt:'Repair value only',...config}]});
 const repair=store.runtime.claim(runtimeId,'owner')!,execution=store.executionCreate({...codexStart(store.runtime.get(runtimeId),repair),workspace,workspaceKind:'project'},store.runtime.binding(repair.id,'owner')).record;
 const child=await spawnManagedProcess({operationId:execution.id,command:process.execPath,args:['-e',"require('node:fs').writeFileSync('result.json','{\"value\":2}\\n')"],cwd:workspace,timeoutMs:5000,onBeforeSpawn:intent=>{store.executionUpdate(execution.id,{},'actual-node-intent',intent);},onIdentity:identity=>{store.executionUpdate(execution.id,{state:'running',identity,pid:identity.pid},'actual-node-identity',{});}});store.runtime.markStarted(repair.id,'owner');await child.completion;
 store.executionUpdate(execution.id,{state:'completed',stopConfirmed:true,usageStatus:'reported',usage:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0}},'actual-node-repair',{fixture:'No provider execution'},[{type:'finishAttempt',attemptId:execution.id,outcome:'succeeded'},{type:'settleAttempt',attemptId:execution.id,actual:0},{type:'releaseLease',attemptId:execution.id,resource:'workspace:'+workspace},{type:'setOperation',operationId:execution.id,attemptId:execution.id,status:'confirmed'}]);store.runtime.report(repair.id,'owner',{messageId:'repair-node-result',outcome:'confirmed',result:'Actual Node wrote value 2'});
 const loop=store.supervision.attach({commandId:'supervise',runtimeId,config,limits:{maxRepairs:2,maxReasoningCalls:4,maxDurationMs:210000,maxContextChars:200000}});
 const until=Date.now()+200000;while(Date.now()<until){await controller.scan();const current=store.supervision.get(loop.id);if(current.phase==='complete'||current.phase==='blocked')break;await new Promise(r=>setTimeout(r,30));}
 const actual=controller.inspect(loop.id);if(mode==='reject'){assert.equal(actual.loop.phase,'blocked',actual.loop.reason??'');assert.match(actual.loop.reason!,/maintenance review failed/);assert.equal(actual.controlMaintenance?.status,'failed');assert.equal(store.verification.headForRun(actual.loop.projectId,actual.loop.runId)!.version,1);assert.equal(actual.verification.deliveries.length,0);assert.equal(actual.jobs.length,1);assert.equal(actual.runtime.run.budget.spent,12);await assert.rejects(verification.dispatch({type:'deliver',commandId:'cannot-bypass-required-maintenance',jobId:actual.controlMaintenance!.basis.baselinePassJobId}),/maintenance is not fully completed/);assert.equal(store.runtime.futureVerification(runtimeId)?.amount,1000);assert.deepEqual(store.verification.get('job',failure.id),failure);await controller.scan();assert.equal(store.supervision.jobs(loop.id).length,1);return;}assert.equal(actual.loop.phase,'complete',JSON.stringify({reason:actual.loop.reason,maintenance:actual.controlMaintenance,jobs:actual.jobs.map(j=>({error:j.error,result:j.result})),verification:actual.verification.jobs.map(j=>({kind:j.kind,error:j.error}))}));
 assert.deepEqual(actual.runtime.run.contract,initialContract);assert.equal(actual.controlMaintenance?.status,'complete');assert.equal(actual.jobs.filter(j=>j.purpose==='acceptance-authoring').length,1);assert.equal(actual.runtime.run.budget.spent,12,'Only three synthetic model calls were charged: initial review, maintenance author, independent V2 review');
 const head=store.verification.headForRun(actual.loop.projectId,actual.loop.runId)!;assert.equal(head.version,2);assert.equal(store.verificationLineage.bindingForProposal(head.id).definitionFormat,'qualified-v2');assert.equal(head.spec.cases.length,mode==='dedup'?5:2);assert.equal(head.spec.cases.at(-1)!.defectRefs.includes(actual.controlMaintenance!.basis.sources[0]!.defectRef),true);
 const stage=store.controlMaintenance.replayForReview(head.reviewId!)!;assert.deepEqual(store.controlQualification.maintenanceForReview(head.reviewId!)!.passingSourceText,{'result.json':{content:'{\"value\":2}\n',executable:0}});assert.equal(stage.replays.length,mode==='dedup'?2:1);if(mode==='dedup'){const final=store.verification.get('job',actual.controlMaintenance!.finalJobId!);assert.equal(final.results.length,1);assert.equal(store.verification.get('job',actual.controlMaintenance!.basis.baselinePassJobId).results.length,2);assert.ok(stage.replays.every(r=>r.instance.caseId==='merged-value'));}assert.equal(stage.replays[0]!.bad[0]!.checks[0]!.verdict,'failed');assert.equal(stage.replays[0]!.good[0]!.checks[0]!.verdict,'passed');assert.ok(store.controlQualification.qualificationForReview(head.reviewId!).execution.evaluation.qualified);assert.deepEqual(store.verification.get('job',failure.id),failure);
 for(const job of actual.verification.jobs)for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');assert.ok(actual.runtime.run.attempts.every(a=>a.settled));assert.equal(actual.verification.deliveries.length,1);const history=await verification.status(runtimeId) as {currentDelivery:{assessment:{historicalEvidenceIntact:boolean;issues:unknown[]}}};assert.equal(history.currentDelivery.assessment.historicalEvidenceIntact,true,JSON.stringify(history.currentDelivery.assessment.issues));
 await controller.close();await verification.close();await runtime.close();store.close();store=new SupervisorStore(data);runtime=new LocalRuntimeAdapter(store,data);verification=new VerificationController(store,data);controller=new SupervisionController(store,data,runtime,verification);await controller.scan();assert.equal(store.supervision.jobs(loop.id).length,1);assert.equal(store.verification.list('delivery',runtimeId).length,1);assert.equal(store.runtime.inspect(runtimeId).run.budget.spent,12);
 const inherited=store.controlMaintenance.inheritedSources(head.id);assert.deepEqual(inherited,stage.replays.map(r=>r.source).sort((a,b)=>a.defectRef.localeCompare(b.defectRef)));assert.throws(()=>store.controlMaintenance.assertPublication(head.id,failure.id),/replay missing/);
 const approved=store.verification.get('job',head.reviewId!),changed=structuredClone(approved);changed.controls.find(row=>row.id.startsWith('maintenance:'))!.passed=false;store.verification.update('job',changed);assert.throws(()=>store.controlMaintenance.validateReplay(stage,true),/actual job observation|Actual finished verification report differs/);store.verification.update('job',approved);
 const proof=stage.replays[0]!.bad[0]!.proofFiles![0]!,bytes=await readFile(proof);await writeFile(proof,'tampered historical evidence');assert.throws(()=>store.controlMaintenance.inheritedSources(head.id),/proof bytes changed/);await writeFile(proof,bytes);assert.equal(store.controlMaintenance.inheritedSources(head.id).length,stage.replays.length);
 if(mode==='regression'){
  // Actual already-stopped/settled SQLite + raw process files. Updating a mutable
  // job proof SHA must not hide contradictory underlying command evidence.
  const commandResult=stage.replays[0]!.bad[0]!.proofFiles!.find(path=>path.endsWith('/command/result.json'))!;
  assert.ok(commandResult);const commandDirectory=dirname(commandResult);
  const variants:[string,(value:any)=>void,RegExp][]=[
   ['result.json',value=>{value.checks[0].verdict='passed';},/actual report differs|aggregate differs/],
   ['report.json',value=>{value.checks[0].verdict='passed';},/actual report differs/],
   ['result.json',value=>{value.proofFiles=value.proofFiles.slice(1);},/proof inventory differs/],
   ['intent.json',value=>{value.args[value.args.length-1]='{"different":"parameter"}';},/frozen invocation differs/],
   ['intent.json',value=>{value.cwd=workspace;},/frozen invocation differs/],
   ['process.json',value=>{value.exitCode=0;},/process exit conflicts/],
   ['intent.json',value=>{value.args[7]='/tmp/replaced-runtime/command-guard.js';value.args[3]='--allow-fs-read='+value.args[7];},/immutable execution proof differs/],
  ];
  for(const [name,mutate,expected] of variants){
   const path=join(commandDirectory,name),originalBytes=await readFile(path),value=JSON.parse(originalBytes.toString());mutate(value);
   const alteredBytes=Buffer.from(JSON.stringify(value)),alteredJob=structuredClone(approved);
   alteredJob.proofs[path]=createHash('sha256').update(alteredBytes).digest('hex');
   // For invocation variants also forge the mutable job intent consistently, so
   // this tests frozen detector/cwd/parameter binding beyond ownership equality.
   if(name==='intent.json')alteredJob.intents=alteredJob.intents.map(intent=>intent.operationId===value.operationId?value:intent);
   try{
    await writeFile(path,alteredBytes);store.verification.update('job',alteredJob);
    assert.throws(()=>store.controlMaintenance.validateReplay(stage,true),expected);
    assert.throws(()=>store.controlMaintenance.inheritedSources(head.id),expected);
    assert.throws(()=>store.controlMaintenance.assertPublication(head.id,approved.id),expected);
   }finally{await writeFile(path,originalBytes);store.verification.update('job',approved);}
   store.controlMaintenance.validateReplay(stage,true);
   assert.equal(store.controlMaintenance.inheritedSources(head.id).length,stage.replays.length);
  }
 }

}
