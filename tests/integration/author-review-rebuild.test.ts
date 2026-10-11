import {resolveAuthorBundle,assertAuthorExpansionProof} from '../../packages/orchestration/author-result-patch.js';
import {readAuthorReviewRejection} from '../../packages/persistence/author-review-rejection.js';
import {authorWireInput,authorRecoveryInput,AUTHOR_RECOVERY_PRESENTATION_PROMPT_V3,AUTHOR_RECOVERY_PRESENTATION_PROMPT_V4} from '../../packages/orchestration/author-presentation.js';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {assertLegacyControlQualification} from '../../packages/verification/control-qualification-gates.js';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture,capabilities} from './author-review-fixture.js';
import {materializeAcceptanceBundle} from '../../packages/orchestration/acceptance-authoring.js';
import {VerificationController} from '../../packages/verification/controller.js';
import type {Proposal,VerificationJob} from '../../packages/verification/records.js';
import type {SupervisionJob} from '../../packages/contracts/p6-supervision.js';
import {futureVerificationFloor} from '../../packages/domain/index.js';
import {selectAcceptanceAuthorRoute,selectAcceptanceAuthorRouteV2,ACCEPTANCE_AUTHOR_ROUTING_POLICY_V2} from '../../packages/orchestration/acceptance-authoring-route.js';
// The planner JSON and 7-token author receipt are explicitly synthetic; its Node
// ownership/stop and the SQLite ledger are real. P4 control commands below use
// the real controller/engine/permission sandbox and deliberately produce no
// checker report, so all control errors are actual, stopped, zero-model-cost.
async function review(f:Awaited<ReturnType<typeof fixture>>,author:SupervisionJob=f.old,modelReview=false){
 const assets=await materializeAcceptanceBundle({privateRoot:join(f.data,'supervision','authoring'),jobId:author.id,context:f.context,bundle:resolveAuthorBundle(author,id=>f.store.supervision.job(id),f.data).bundle});
 const controller=new VerificationController(f.store,f.data);await controller.initialize();
 try{const proposal=await controller.dispatch({type:'propose',commandId:'propose-'+author.id,runtimeId:f.runtime.id,specPath:assets.specPath}) as Proposal;
 let job=await controller.dispatch({type:'review',commandId:'review-'+author.id,proposalId:proposal.id,model:'must-not-launch-provider',effort:'low',reservation:20,timeoutMs:15000}) as VerificationJob;
 const deadline=Date.now()+15000;while(job.status==='running'){assert.ok(Date.now()<deadline);await delay(25);job=f.store.verification.get('job',job.id);}
 if(modelReview){const errors=Object.keys(job.proofs).filter(p=>p.endsWith('/definition-review/error.json'));assert.equal(errors.length,0,job.error+' '+errors.map(p=>readFileSync(p,'utf8')).join('\n'));}assert.equal(job.approved,false);assert.equal(job.modelStarted,modelReview);assert.equal(job.usage,modelReview?4:0);assert.equal(job.stopConfirmed,true);assert.ok(modelReview?job.controls.every(c=>c.passed):job.controls.every(c=>c.results.some(r=>r.executionStatus==='verifier-error')));
 const loop=f.store.supervision.get(f.loop.id);f.store.supervision.update(loop.id,loop.revision,{phase:'reviewing',references:{authorJobId:author.id,proposalId:proposal.id,reviewId:job.id}});return {proposal,job};
 }finally{await controller.close();}
}
async function request(f:Awaited<ReturnType<typeof fixture>>,job=f.old){return {commandId:'review-rebuild-'+job.id,loopId:f.loop.id,previousJobId:job.id,expectedRevision:f.store.supervision.get(f.loop.id).revision,rejection:await f.repo.assess(f.loop.id,job.id,true),capabilities:await capabilities(f.data)};}
test('P6-AUTHREVIEW-I01 actual P4 command rejection reserves one fresh author atomically and preserves original history across reopen',async t=>{
 const f=await fixture(t,{kind:'valid',calls:5}),oldReview=await review(f),run=f.store.runtime.inspect(f.runtime.id).run;
 f.store.runtime.setFutureVerification({commandId:'protect-p4',runtimeId:f.runtime.id,expectedContractVersion:run.contract.version,expectedRevision:run.revision,allocationId:'final-review-floor',amount:25,reason:'Keep actual final P4 allocation'});
 const input=await request(f),before=f.store.runtime.inspect(f.runtime.id),old=JSON.stringify({author:f.store.supervision.job(f.old.id),proposal:f.store.verification.get('proposal',oldReview.proposal.id),review:f.store.verification.get('job',oldReview.job.id)});
 assert.equal(oldReview.job.controls.length,1,'actual positive failfast must retain only first failed control');assert.equal(oldReview.job.controls[0]!.id,oldReview.proposal.spec.controls[0]!.id);assert.equal(oldReview.job.controls[0]!.passed,false);assert.equal(oldReview.job.modelStarted,false);assert.equal(oldReview.job.usage,0);assert.throws(()=>assertLegacyControlQualification(oldReview.proposal.spec,oldReview.job.controls),/Complete declared control qualification/);assert.throws(()=>f.store.verification.publish(oldReview.proposal,'incomplete-control-cannot-publish'),/review|approved|qualification/i);
 assert.equal(input.rejection.kind,'review');assert.equal(input.rejection.review!.classification,'control-rejected');assert.throws(()=>f.repo.transaction(()=>{f.repo.begin(input);throw Error('parent rollback')}),/parent rollback/);assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.equal(f.repo.routes(f.loop.id).length,0);
 const next=f.repo.begin(input);
 const stored=next.job.input as any,wire=authorWireInput(stored,'acceptance-authoring');
 assert.equal(stored.prompt,AUTHOR_RECOVERY_PRESENTATION_PROMPT_V4);
 assert.deepEqual(stored.context.authorPresentation,{schemaVersion:4,kind:'acceptance-recovery'});
 assert.equal(authorRecoveryInput(stored.context,stored.outputSchema).prompt,AUTHOR_RECOVERY_PRESENTATION_PROMPT_V3,'Explicit legacy creator remains V3');
 assert.deepEqual(stored.context.acceptance,(f.old.input as any).context.acceptance);
 assert.deepEqual(stored.context.candidate,(f.old.input as any).context.candidate);
 assert.deepEqual(stored.context.authorFeedback.rejection.raw,input.rejection.raw);
 assert.deepEqual(stored.context.authorFeedback.rejection.review.diagnostics,input.rejection.review!.diagnostics);
 assert.equal(wire.prompt.split(JSON.stringify(stored.context.authorFeedback.rejection.raw.spec.obligations[0]!.expectation)).length>=2,true);
 assert.ok(JSON.stringify(stored).length+6000<=200000);
 assert.ok(wire.prompt.length+JSON.stringify(wire.outputSchema).length+6000<=200000);
 assert.equal(next.job.config.model,'gpt-6-astra');assert.equal(next.job.config.effort,'high');assert.equal(next.job.config.reservation,f.old.config.reservation);assert.equal(futureVerificationFloor(f.store.runtime.inspect(f.runtime.id).run),25);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,7);assert.equal(f.store.supervision.get(f.loop.id).repairCount,0);assert.equal(f.store.supervision.get(f.loop.id).references.proposalId,undefined);
 assert.equal(JSON.stringify({author:f.store.supervision.job(f.old.id),proposal:f.store.verification.get('proposal',oldReview.proposal.id),review:f.store.verification.get('job',oldReview.job.id)}),old);f.reopen();assert.deepEqual(f.repo.begin(input),next);assert.throws(()=>f.repo.begin({...input,expectedRevision:input.expectedRevision+1}),/Conflicting/);assert.equal(f.store.supervision.jobs(f.loop.id).length,2);
});
test('P6-AUTHREVIEW-I02 changed actual review proof and changed original candidate reject without granting a replacement',async t=>{
 const f=await fixture(t,{kind:'valid'}),r=await review(f),input=await request(f),proof=Object.keys(r.job.proofs).find(p=>p.endsWith('/report.json'))!,bytes=readFileSync(proof);
 // Recomputed report digests do not make forged observations authoritative.
 const forged=async (change:(job:VerificationJob)=>void,pattern:RegExp)=>{const job=structuredClone(r.job);change(job);const report=Buffer.from(JSON.stringify({results:job.results,controls:job.controls,evaluation:job.evaluation,error:job.error}));writeFileSync(proof,report);job.proofs[proof]=createHash('sha256').update(report).digest('hex');f.store.verification.update('job',job);try{await assert.rejects(f.repo.assess(f.loop.id,f.old.id,true),pattern);}finally{writeFileSync(proof,bytes);f.store.verification.update('job',r.job);}assert.equal(f.repo.routes(f.loop.id).length,0);};
 await forged(job=>{job.controls=[];},/control order\/prefix/);
 await forged(job=>{job.controls[0]!.id=r.proposal.spec.controls[1]!.id;},/control order\/prefix/);
 await forged(job=>{job.controls.push(structuredClone(job.controls[0]!));},/control order\/prefix/);
 await forged(job=>{job.controls[0]!.results=[];},/instance inventory/);
 await forged(job=>{job.controls[0]!.results[0]!.instanceId='forged-instance';},/instance inventory/);
 await forged(job=>{job.controls[0]!.results.push(structuredClone(job.controls[0]!.results[0]!));},/instance inventory/);
 await forged(job=>{job.controls[0]!.results[0]!.checks=[{obligationId:'injected-obligation',verdict:'failed',reason:'forged'}];},/check inventory/);
 await forged(job=>{job.controls[0]!.passed=true;},/every control/);
 await forged(job=>{job.modelStarted=true;},/hide an additional model/);
 await forged(job=>{job.controls[0]!.results[0]!.proofFiles=[];},/actually executed/);
 await forged(job=>{job.controls[0]!.results[0]!.proofFiles=[proof];},/another observation/);
 await forged(job=>{job.controls[0]!.results[0]!.proofFiles=job.controls[0]!.results[0]!.proofFiles!.filter(path=>!path.endsWith('/stdout.log'));},/proof inventory was omitted/);
 writeFileSync(proof,Buffer.concat([bytes,Buffer.from(' ')]));assert.throws(()=>f.repo.begin(input),/proof changed/);writeFileSync(proof,bytes);writeFileSync(join(f.workspace,'value.mjs'),'changed original candidate');assert.throws(()=>f.repo.begin(input),/candidate changed/);assert.equal(f.repo.routes(f.loop.id).length,0);assert.equal(f.store.supervision.jobs(f.loop.id).length,1);
});
test('P6-AUTHREVIEW-I03 second actually rejected rebuilt author remains retained and cannot regenerate again',async t=>{
 const f=await fixture(t,{kind:'valid',calls:5});await review(f);const next=f.repo.beginV2(await request(f));await f.create('valid',next.job);await review(f,f.store.supervision.job(next.job.id));
 const patched=f.store.supervision.job(next.job.id);assert.equal((patched.result as any).protocol,'acceptance-replace-v1');assertAuthorExpansionProof(patched,id=>f.store.supervision.job(id),f.data);
 const actual=readAuthorReviewRejection(f.db,f.data,f.store.supervision.get(f.loop.id),patched,f.context,f.store.runtime.inspect(f.runtime.id).run);assert.equal(actual.classification,'control-rejected');assert.equal(actual.review.id,f.store.supervision.get(f.loop.id).references.reviewId);
 f.reopen();assert.deepEqual(readAuthorReviewRejection(f.db,f.data,f.store.supervision.get(f.loop.id),f.store.supervision.job(next.job.id),f.context,f.store.runtime.inspect(f.runtime.id).run),actual);
 await assert.rejects(f.repo.assess(f.loop.id,next.job.id,true),/Review reconstruction limit exhausted/);assert.equal(f.repo.routes(f.loop.id).length,1);assert.equal(f.store.supervision.jobs(f.loop.id).length,2);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,14);assert.equal(f.store.verification.list('job').length,2);
});
test('P6-AUTHREVIEW-I04 unknown review accounting and queued overlapping Run cannot consume replacement authority',async t=>{
 const f=await fixture(t,{kind:'valid'}),r=await review(f),input=await request(f);f.store.verification.update('job',{...r.job,usageUnknown:true});await assert.rejects(f.repo.assess(f.loop.id,f.old.id,true),/settlement|unresolved/);f.store.verification.update('job',r.job);
 f.store.executionCreate({type:'start',commandId:'unrelated-queued',workspace:f.workspace,workspaceKind:'project',prompt:'Explicit unstarted foreign writer',model:'no-provider',effort:'low',reservation:20,timeoutMs:1000,tokenLimit:100,verificationReserve:20});assert.throws(()=>f.repo.begin(input),/Workspace has active or unverified execution/);assert.equal(f.repo.routes(f.loop.id).length,0);
});
test('P6-AUTHREVIEW-U01 actual advertised Astra high upgrades strictly to xhigh without changing reservation or guessing effort',()=>{
 const config={model:'gpt-6-astra',effort:'high',reservation:30,timeoutMs:5000},capabilities={version:'fixture',schemaDigest:'fixture',models:[{id:'gpt-6-astra',label:'exact provider ID',inputModalities:['text'],reasoningEfforts:['low','high','xhigh'],defaultEffort:'low'}],imageInput:false,checkedAt:new Date().toISOString()};assert.deepEqual(selectAcceptanceAuthorRoute(capabilities,config),{...config,effort:'xhigh'});capabilities.models[0]!.reasoningEfforts=['low','high'];assert.throws(()=>selectAcceptanceAuthorRoute(capabilities,config),/No advertised/);
 // V2 is an explicit host preference, not a speed/quality measurement.
 capabilities.models[0]!.reasoningEfforts=['low','medium','high','xhigh'];
 assert.equal(selectAcceptanceAuthorRouteV2(capabilities,{...config,effort:'low'}).effort,'medium');
 assert.equal(selectAcceptanceAuthorRouteV2(capabilities,{...config,effort:'medium'}).effort,'high');
 assert.equal(selectAcceptanceAuthorRouteV2(capabilities,config).effort,'xhigh');
 assert.throws(()=>selectAcceptanceAuthorRouteV2(capabilities,{...config,effort:'xhigh'}),/No advertised/);
 capabilities.models[0]!.reasoningEfforts=['low','high'];
 assert.equal(selectAcceptanceAuthorRouteV2(capabilities,{...config,effort:'low'}).effort,'high');
 assert.throws(()=>selectAcceptanceAuthorRouteV2({...capabilities,models:[]},config),/No advertised/);
 assert.throws(()=>selectAcceptanceAuthorRouteV2({...capabilities,models:[...capabilities.models,...capabilities.models]},config),/Ambiguous/);
 assert.throws(()=>selectAcceptanceAuthorRouteV2(capabilities,{...config,effort:'invented'}),/explicit/);
 assert.throws(()=>selectAcceptanceAuthorRouteV2(capabilities,config,{...ACCEPTANCE_AUTHOR_ROUTING_POLICY_V2,schemaVersion:3} as never),/Unsupported/);
 const lower={...capabilities,models:[{...capabilities.models[0]!,id:'gpt-5.6-sol',reasoningEfforts:['medium','xhigh']}]};
 assert.throws(()=>selectAcceptanceAuthorRouteV2(lower,{...config,effort:'low'}),/No advertised/);
 assert.equal(selectAcceptanceAuthorRouteV2({...capabilities,models:[...lower.models,{...capabilities.models[0]!,reasoningEfforts:['medium']}]},{...config,model:'gpt-5.6-sol',effort:'high'}).model,'gpt-6-astra');

});

test('P6-AUTHREVIEW-I05 completed synthetic review transport with real P4 controls binds failed independent judgment and retains its cost',async t=>{
 const f=await fixture(t,{kind:'review-valid'}),binary=join(f.root,'review-synthetic.cjs');
 writeFileSync(binary,`#!${process.execPath}
const cp=require('node:child_process'),a=process.argv.slice(2);if(a.includes('--version')||a.includes('generate-json-schema')){process.stdout.write(cp.execFileSync('codex',a));process.exit(0)}if(a.includes('mcp')){console.log('[]');process.exit(0)}const send=x=>console.log(JSON.stringify(x));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(m.method==='initialize')return send({id:m.id,result:{userAgent:'synthetic',codexHome:'fixture',platformFamily:'unix',platformOs:'test'}});if(m.method==='model/list')return send({id:m.id,result:{data:[{id:'must-not-launch-provider',model:'must-not-launch-provider',inputModalities:['text'],supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low',isDefault:true}],nextCursor:null}});if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'actual-synthetic-thread',turns:[]}}});if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'actual-turn',status:'inProgress',items:[]}}});const usage={inputTokens:2,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:4};send({method:'thread/tokenUsage/updated',params:{threadId:'actual-synthetic-thread',turnId:'actual-turn',tokenUsage:{total:usage,last:usage}}});send({method:'item/completed',params:{threadId:'actual-synthetic-thread',turnId:'actual-turn',item:{id:'message',type:'agentMessage',text:JSON.stringify({verdict:'failed',reason:'Explicit synthetic independent judgment: improve verifier coverage',observations:['Fixture judgment, not actual model reasoning']})}}});send({method:'turn/completed',params:{threadId:'actual-synthetic-thread',turn:{id:'actual-turn',status:'completed',items:[{type:'agentMessage',text:JSON.stringify({verdict:'failed',reason:'Explicit synthetic independent judgment: improve verifier coverage',observations:['Fixture judgment, not actual model reasoning']})}]}}});return;}throw Error('Unexpected request '+m.method);});`,{mode:0o700});
 const old=process.env.SUPERVISOR_CODEX_PATH;process.env.SUPERVISOR_CODEX_PATH=binary;t.after(()=>{if(old===undefined)delete process.env.SUPERVISOR_CODEX_PATH;else process.env.SUPERVISOR_CODEX_PATH=old;});
 const r=await review(f,f.old,true),input=await request(f);assert.equal(input.rejection.review!.classification,'definition-rejected');assert.equal(input.rejection.review!.review.id,r.job.id);const next=f.repo.begin(input);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,11);assert.equal(next.job.result,null);assert.equal(f.store.supervision.get(f.loop.id).repairCount,0);
});
