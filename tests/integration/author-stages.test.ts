import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {LocalRuntimeAdapter} from '../../packages/runtime/index.js';
import {SupervisionController} from '../../packages/orchestration/supervision-controller.js';
import {captureCandidate} from '../../packages/verification/candidate.js';
import {VerificationController} from '../../packages/verification/controller.js';
import type {Proposal,VerificationJob} from '../../packages/verification/records.js';
import {beginAuthorStages,advanceAuthorStage} from '../../packages/orchestration/author-stage-controller.js';
import {authorStageDigest,parseAuthorStageInput} from '../../packages/orchestration/author-stage-protocol.js';
import {assertStoredAuthorStage,assertAuthorStageAssemblyProof} from '../../packages/orchestration/author-stage-proofs.js';
import {SupervisionReasoningRunner} from '../../packages/orchestration/supervision-reasoning.js';
import {prepareReasonerTurn,type SupervisorReasoner,type ReasonerInput,type ReasonerResult} from '../../packages/orchestration/reasoner.js';
import {resolveAuthorBundle,patchInput,assertAuthorExpansionProof} from '../../packages/orchestration/author-result-patch.js';
import {assertAuthorWireProof} from '../../packages/orchestration/author-presentation-proofs.js';
import {acceptanceAuthoringContextDigest,materializeAcceptanceBundle,validateAcceptanceBundle,type AcceptanceAuthoringContext,type AcceptanceBundle} from '../../packages/orchestration/acceptance-authoring.js';
import {spawnManagedProcess,inspectProcess} from '../../packages/process-control/index.js';
import type {SupervisionJob} from '../../packages/contracts/p6-supervision.js';
import {AUTHOR_STAGE_PROTOCOL,AUTHOR_STAGE_PROTOCOL_V2,type AuthorStageProtocol,type AuthorDefinitionStageV2,type AuthorPositiveStageV2,type AuthorDefinitionStage,type AuthorPositiveStage,type AuthorNegativeStage} from '../../packages/contracts/p6-author-stages.js';
import {capabilities} from './author-review-fixture.js';

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

// This suite exercises actual SQLite/FS, runner dispatch, managed Node ownership,
// physical stop and P4 command execution. Model JSON and seven tokens per turn
// are explicit protocol fixtures, never supplier reasoning or semantic approval.
async function fixture(t:TestContext,options:{calls?:number;limit?:number;protocol?:AuthorStageProtocol}={}) {
  const root=realpathSync(mkdtempSync('/tmp/sv-author-stages-'));
  const data=join(root,'data'),workspace=join(root,'workspace');mkdirSync(workspace);
  const content='export const value=2;\n';writeFileSync(join(workspace,'value.mjs'),content);
  const item={id:'value',description:'Export the exact value',kind:'command' as const,target:'value.mjs',checks:['Named value export equals two.']};
  const contract={version:2,goal:'Explicit component fixture: retain value requirement',criteria:[{id:item.id,required:true,description:[item.description,'Acceptance kind: command; target: value.mjs',...item.checks].join('\n')}]};
  let store=new SupervisorStore(data);
  const runtime=store.runtime.submit({type:'submit',commandId:'workflow',workspace,workspaceKind:'project',goal:contract.goal,tokenLimit:options.limit??200,verificationReserve:20,steps:[{id:'input',kind:'input',prompt:'Fixture input'}]});
  store.runtime.revise({commandId:'revise',runtimeId:runtime.id,expectedContractVersion:1,contract,nodes:[{id:'input',required:true,dependencies:[]}],steps:[{id:'input',kind:'input',prompt:'Fixture input'}],reason:'Component fixture, not live implementation'});
  store.runtime.control({type:'input',commandId:'input',runtimeId:runtime.id,stepId:'input',text:'Ready'});
  const op=store.runtime.claim(runtime.id,'fixture')!;
  store.runtime.report(op.id,'fixture',{messageId:'ready',outcome:'confirmed',result:'Ready'});
  const candidate=await captureCandidate(workspace,join(data,'candidate'));
  const acceptance:AcceptanceAuthoringContext={contract,criteria:[item],candidate:{workspace,digest:candidate.digest,files:[{path:'value.mjs',content,sha256:sha(content)}]},environment:{fixture:'synthetic JSON and accounting; actual Node/FS/SQLite'},failureContext:null,previousSpec:null};
  const bundle:AcceptanceBundle={contextDigest:acceptanceAuthoringContextDigest(acceptance),spec:{schemaVersion:1,contractVersion:2,standardsVersion:'stage-component',obligations:[{id:'value-check',criterionId:'value',expectation:'Value equals two',required:true,applicable:true}],cases:[{id:'case',revision:1,status:'active',obligationIds:['value-check'],parameters:[{}],modules:['value'],replaces:[],defectRefs:[],verifier:{kind:'command',version:'fixture',entry:'check.mjs',files:['check.mjs'],timeoutMs:1000}}],controls:[{id:'good',workspace:'good',expect:'passed',mustFail:[]},{id:'bad',workspace:'bad',expect:'failed',mustFail:['value-check']}],moduleDependencies:{value:[]}},verifierFiles:[{path:'check.mjs',content:'// Deliberately missing report: real P4 must reject this checker.\n'}],controls:[{id:'good',files:[{path:'value.mjs',content}]},{id:'bad',files:[{path:'value.mjs',content:'export const value=3;\n'}]}],coverageExplanation:[{criterionId:'value',check:item.checks[0]!,caseIds:['case'],explanation:'Independent command should read and compare the export; P4 decides its effectiveness.'}]};
  const originalDefinition:AuthorDefinitionStage={protocol:AUTHOR_STAGE_PROTOCOL,stage:'definition',contextDigest:bundle.contextDigest,spec:bundle.spec,verifierFiles:bundle.verifierFiles,coverageExplanation:bundle.coverageExplanation,negativeBases:[{controlId:'bad',positiveId:'good'}]};
  const protocol=options.protocol??AUTHOR_STAGE_PROTOCOL;
  const definition:AuthorDefinitionStage|AuthorDefinitionStageV2=protocol===AUTHOR_STAGE_PROTOCOL?originalDefinition:
    {protocol,stage:'definition',contextDigest:bundle.contextDigest,spec:bundle.spec,coverageExplanation:bundle.coverageExplanation,negativeBases:originalDefinition.negativeBases,verifierPaths:bundle.verifierFiles.map(file=>file.path)};
  const positive:AuthorPositiveStage|AuthorPositiveStageV2={protocol,stage:'positive',contextDigest:bundle.contextDigest,definitionDigest:authorStageDigest(definition),controls:[bundle.controls[0]!],...(protocol===AUTHOR_STAGE_PROTOCOL_V2?{verifierFiles:bundle.verifierFiles}:{})} as AuthorPositiveStage|AuthorPositiveStageV2;
  const negative={protocol,stage:'negative',contextDigest:bundle.contextDigest,definitionDigest:authorStageDigest(definition),positiveDigest:authorStageDigest(positive),controls:[{id:'bad',basePositiveId:'good',basePositiveDigest:authorStageDigest(positive.controls[0]),fileChanges:[{operation:'replace' as const,...bundle.controls[1]!.files[0]!}]}]};
  const loop=store.supervision.attach({commandId:'loop',runtimeId:runtime.id,authoringProtocol:protocol,config:{model:'gpt-5.6-sol',effort:'low',reservation:30,timeoutMs:5000},limits:{maxRepairs:1,maxReasoningCalls:options.calls??4,maxDurationMs:120000,maxContextChars:200000}});
  const runners:SupervisionReasoningRunner[]=[];
  t.after(async()=>{for(const runner of runners)await runner.close();store.close();rmSync(root,{recursive:true,force:true});});
  return {root,data,workspace,runtime,loop,acceptance,candidate,bundle,fragments:[definition,positive,negative],
    get store(){return store;},reopen(){runners.length=0;store.close();store=new SupervisorStore(data);},
    begin(){return beginAuthorStages(store,loop.id,{acceptance,candidate});},
    runner(transport:SupervisorReasoner){const runner=new SupervisionReasoningRunner(store,data,transport);runners.push(runner);return runner;},
    pause(){const current=store.supervision.get(loop.id);store.supervision.update(current.id,current.revision,{paused:true});},
  };
}

class NodeFragments implements SupervisorReasoner {
  calls=0;
  constructor(private readonly output:(request:ReasonerInput)=>unknown,private readonly options:{unknown?:boolean;afterStop?:()=>void;usage?:number}={}){}
  async request(input:ReasonerInput):Promise<ReasonerResult> {
    this.calls++;
    const raw=JSON.stringify(this.output(input)),threadId='fixture-thread-'+input.id,turnId='fixture-turn-'+input.id;
    const result:ReasonerResult={value:null,usage:this.options.unknown?null:this.options.usage??7,threadId,turnId,proofFiles:[],stopConfirmed:false,modelStarted:false};
    await prepareReasonerTurn(input,result,()=>input.assertEligible?.());
    const requestPath=join(input.logDir,'node-request.json'),stdoutPath=join(input.logDir,'stdout.log'),eventsPath=join(input.logDir,'events.jsonl');
    const notification={method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{type:'agentMessage',text:raw}]}}};
    writeFileSync(requestPath,JSON.stringify(notification));
    const child=await spawnManagedProcess({operationId:input.id+'-fragment',command:process.execPath,args:['-e',"process.stdout.write(require('node:fs').readFileSync(process.argv[1]))",requestPath],cwd:input.cwd,timeoutMs:input.timeoutMs,onBeforeSpawn:intent=>input.onIntent?.(intent),onIdentity:identity=>input.onIdentity?.(identity)});
    let stdout='';child.stdout.on('data',chunk=>stdout+=chunk);
    const stopped=await child.completion;
    assert.equal((await inspectProcess(child.identity)).status,'stopped');assert.equal(stopped.stopped,true);
    const actual=JSON.parse(stdout);assert.deepEqual(actual,notification);
    const events=[
      {kind:'reasoner-input',value:{id:input.id,prompt:input.prompt,outputSchema:input.outputSchema,model:input.model,effort:input.effort,timeoutMs:input.timeoutMs,...(input.absoluteDeadlineMs!==undefined?{absoluteDeadlineMs:input.absoluteDeadlineMs}:{})}},
      {kind:'reasoner-turn-intent',value:{threadId,input:[{type:'text',text:input.prompt}],model:input.model,effort:input.effort}},
      {kind:'reasoner-turn-started',value:{turn:{id:turnId}}},
      {kind:'codex-raw',value:{direction:'received',message:actual}},
      {kind:'codex-event',value:{method:actual.method,threadId,raw:actual}},
      {kind:'process-stop',value:{result:stopped}},
    ];
    writeFileSync(stdoutPath,stdout);writeFileSync(eventsPath,events.map(event=>JSON.stringify(event)).join('\n')+'\n');
    writeFileSync(join(input.logDir,'output.txt'),actual.params.turn.items[0]!.text);
    result.value=JSON.parse(actual.params.turn.items[0]!.text);result.stopConfirmed=stopped.stopped;
    result.proofFiles=[requestPath,stdoutPath,eventsPath,join(input.logDir,'output.txt'),join(input.logDir,'result.json')];
    writeFileSync(join(input.logDir,'result.json'),JSON.stringify(result));
    await input.onUsage?.(this.options.usage??7);
    this.options.afterStop?.();
    return result;
  }
}

async function assertProofs(f:Awaited<ReturnType<typeof fixture>>,job:SupervisionJob) {
  const directory=join(f.data,'supervision-reasoning',sha(job.id));
  assertAuthorWireProof(job,directory);
  for(const [path,digest] of Object.entries(job.proofs))assert.equal(sha(readFileSync(path)),digest);
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'output.txt'),'utf8')),job.result);
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'result.json'),'utf8')).value,job.result);
  assert.equal(job.identities.length,1);assert.equal(job.intents.length,1);
  for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');
  return directory;
}

test('P6-AUTH-STAGE-I01 actual three-stage author retains raw fragments and shared budget across reopen before one P4-rejected patch recovery',{timeout:120000},async t=>{
  for(const protocol of [AUTHOR_STAGE_PROTOCOL,AUTHOR_STAGE_PROTOCOL_V2]) {
  const f=await fixture(t,{protocol}),transport=new NodeFragments(request=>f.fragments[parseAuthorStageInput(f.store.supervision.job(request.id).input)!.context.authorStage.index]);
  let runner=f.runner(transport),job=f.begin();
  const completed:SupervisionJob[]=[];
  for(const index of [0,1,2] as const) {
    assert.equal(job.config.reservation,[30,23,16][index]);
    assert.equal(job.config.timeoutMs,5000);
    const binding=parseAuthorStageInput(job.input)!.context.authorStage;
    assert.equal(binding.protocol,protocol);
    assert.equal(parseAuthorStageInput(job.input)!.context.authorPresentation.schemaVersion,protocol===AUTHOR_STAGE_PROTOCOL?6:8);
    assert.equal(binding.sessionTokenCeiling,30);assert.equal(binding.perCallTimeoutMs,5000);
    assert.equal(binding.loopDeadlineMs,Date.parse(f.loop.createdAt)+120000);
    assert.equal(binding.index,index);assert.equal(binding.parents.length,index);
    const done=await runner.run(job.id);completed.push(done);
    assert.equal(done.usage,7);assert.equal(done.modelStarted,true);assert.equal(done.stopConfirmed,true);
    assert.deepEqual(done.result,f.fragments[index]);assertStoredAuthorStage(done,f.data);
    await assertProofs(f,done);
    if(protocol===AUTHOR_STAGE_PROTOCOL_V2){
      assert.equal(Object.hasOwn(done.result as object,'verifierFiles'),index===1);
      if(index===0)assert.deepEqual((done.result as AuthorDefinitionStageV2).verifierPaths,['check.mjs']);
    }
    if(index===0) {
      await runner.close();f.reopen();runner=f.runner(transport);await runner.initialize();
      assert.deepEqual(await runner.run(done.id),done);assert.equal(transport.calls,1);
      assert.equal(f.store.supervision.jobs(f.loop.id).length,1);
    }
    if(index<2) {
      const before=f.store.runtime.inspect(f.runtime.id),beforeLoop=f.store.supervision.get(f.loop.id);
      assert.throws(()=>f.store.supervision.transaction(()=>{advanceAuthorStage(f.store,f.data,done);throw Error('outer rollback');}),/outer rollback/);
      assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.deepEqual(f.store.supervision.get(f.loop.id),beforeLoop);
      job=advanceAuthorStage(f.store,f.data,done)!;assert.ok(job);
      assert.throws(()=>advanceAuthorStage(f.store,f.data,done),/no longer current/);
    } else assert.equal(advanceAuthorStage(f.store,f.data,done),null);
  }
  const final=completed[2]!;
  assert.equal(transport.calls,3);assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,3);
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,21);
  assertAuthorStageAssemblyProof(final,id=>f.store.supervision.job(id),f.data);
  const expanded=resolveAuthorBundle(final,id=>f.store.supervision.job(id),f.data).bundle;
  assert.deepEqual(expanded,f.bundle);assert.deepEqual(validateAcceptanceBundle(expanded,f.acceptance),f.bundle);
  assert.equal((final.result as AuthorNegativeStage).stage,'negative');assert.ok(!Object.hasOwn(final.result as object,'spec'));
  const assets=await materializeAcceptanceBundle({privateRoot:join(f.data,'supervision','authoring'),jobId:final.id,context:f.acceptance,bundle:expanded});
  const p4=new VerificationController(f.store,f.data);await p4.initialize();
  let rejected:VerificationJob;
  try {
    const proposal=await p4.dispatch({type:'propose',commandId:'stage-propose',runtimeId:f.runtime.id,specPath:assets.specPath}) as Proposal;
    rejected=await p4.dispatch({type:'review',commandId:'stage-review',proposalId:proposal.id,model:'must-not-launch-provider',effort:'low',reservation:20,timeoutMs:15000}) as VerificationJob;
    const deadline=Date.now()+15000;
    while(rejected.status==='running'){assert.ok(Date.now()<deadline,'Actual checker review did not finish');await delay(25);rejected=f.store.verification.get('job',rejected.id);}
    assert.equal(rejected.approved,false);assert.equal(rejected.modelStarted,false);assert.equal(rejected.usage,0);assert.equal(rejected.stopConfirmed,true);
    assert.equal(rejected.controls.length,1);assert.equal(rejected.controls[0]!.passed,false);
    assert.ok(rejected.controls[0]!.results.some(result=>result.executionStatus==='verifier-error'));
    assert.throws(()=>f.store.verification.publish(proposal,'cannot-publish-fragments'),/review|approved|qualification/i);
    const loop=f.store.supervision.get(f.loop.id);f.store.supervision.update(loop.id,loop.revision,{phase:'reviewing',references:{...loop.references,proposalId:proposal.id,reviewId:rejected.id}});
  } finally {await p4.close();}
  const rejection=await f.store.authorRouting.assess(f.loop.id,final.id,true);
  assert.equal(rejection.kind,'review');assert.equal(rejection.review!.classification,'control-rejected');
  const request={commandId:'stage-rebuild',loopId:f.loop.id,previousJobId:final.id,expectedRevision:f.store.supervision.get(f.loop.id).revision,rejection,capabilities:await capabilities(f.data)};
  const beforeRoute=f.store.runtime.inspect(f.runtime.id);
  assert.throws(()=>f.store.authorRouting.begin(request),/requires versioned shared-session routing/);
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id),beforeRoute);assert.equal(f.store.authorRouting.routes(f.loop.id).length,0);
  const route=f.store.authorRouting.beginV2(request),patch=patchInput(route.job.input)!;
  assert.equal(route.receipt.baseline.reservation,16);
  assert.equal(route.receipt.schemaVersion,2);
  if(route.receipt.schemaVersion===2){assert.equal(route.receipt.authorization.authorSession!.spent,21);assert.equal(route.receipt.authorization.authorSession!.ceiling,30);assert.deepEqual(route.receipt.authorization.authorSession!.jobs.map(j=>j.jobId),completed.map(j=>j.id));}
  assert.deepEqual(f.store.authorRouting.forJob(route.job.id),route.receipt);
  assert.ok(patch);assert.equal(route.job.config.reservation,9,'Recovery shares original 30-token author ceiling after 21 spent');
  assert.deepEqual(patch.context.authorPatch!.expandedBase,f.bundle);
  const repair=new NodeFragments(()=>({protocol:'acceptance-replace-v1',baseJobId:patch.context.authorPatch!.base.jobId,baseResultDigest:patch.context.authorPatch!.base.resultDigest,replacements:[{path:'/verifierFiles',replacementJSON:JSON.stringify([{path:'check.mjs',content:'// Fresh raw patch fixture; still requires future independent P4.\n'}])}]}));
  const recoveryRunner=f.runner(repair),recovered=await recoveryRunner.run(route.job.id);
  assert.equal((recovered.result as {protocol:string}).protocol,'acceptance-replace-v1');
  assertAuthorExpansionProof(recovered,id=>f.store.supervision.job(id),f.data);await assertProofs(f,recovered);
  const resolved=resolveAuthorBundle(recovered,id=>f.store.supervision.job(id),f.data).bundle;
  assert.deepEqual(resolved.spec,f.bundle.spec);assert.deepEqual(resolved.controls,f.bundle.controls);assert.notDeepEqual(resolved.verifierFiles,f.bundle.verifierFiles);
  assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,4);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,28);
  const run=f.store.runtime.inspect(f.runtime.id).run;
  assert.ok(run.attempts.every(attempt=>attempt.settled));assert.ok(run.operations.every(operation=>operation.status==='confirmed'));assert.ok(run.leases.every(lease=>lease.released));
  for(const original of completed)assert.deepEqual(f.store.supervision.job(original.id),original);
  await runner.close();await recoveryRunner.close();f.reopen();const reopened=f.runner(repair);await reopened.initialize();
  assert.deepEqual(await reopened.run(recovered.id),recovered);assert.equal(repair.calls,1);assert.deepEqual(f.store.authorRouting.beginV2(request),{receipt:route.receipt,job:recovered});
  assert.equal(f.store.supervision.jobs(f.loop.id).length,4);assert.equal(f.store.verification.list('delivery').length,0);
  }
});

test('P6-AUTH-STAGE-I02 stage preflight and interrupted accounting reject without extra calls or fabricated progress',{timeout:60000},async t=>{
  for(const protocol of [AUTHOR_STAGE_PROTOCOL,AUTHOR_STAGE_PROTOCOL_V2]) {
  for(const options of [{calls:2},{limit:49}]) {
    const f=await fixture(t,{...options,protocol}),before=f.store.runtime.inspect(f.runtime.id),loop=f.store.supervision.get(f.loop.id);
    assert.throws(()=>f.begin(),options.calls?/not enough actual calls/:/budget|token|reservation/i);
    assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.deepEqual(f.store.supervision.get(f.loop.id),loop);
    assert.equal(f.store.supervision.jobs(f.loop.id).length,0);
  }
  for(const mode of ['unknown','paused-before','paused-after','exhausted'] as const) {
    const f=await fixture(t,{protocol}),job=f.begin();
    const transport=new NodeFragments(()=>f.fragments[0],mode==='unknown'?{unknown:true}:mode==='paused-after'?{afterStop:()=>f.pause()}:mode==='exhausted'?{usage:30}:{});
    let runner=f.runner(transport);
    if(mode==='paused-before')f.pause();
    if(mode==='exhausted')await runner.run(job.id);else await assert.rejects(runner.run(job.id));
    const actual=f.store.supervision.job(job.id),run=f.store.runtime.inspect(f.runtime.id).run,attempt=run.attempts.find(a=>a.id===job.attemptId)!;
    assert.equal(actual.status,'finished');assert.equal(actual.stopConfirmed,true);
    assert.equal(actual.usage,mode==='unknown'?null:mode==='paused-before'?0:mode==='exhausted'?30:7);
    assert.equal(actual.modelStarted,mode!=='paused-before');
    assert.equal(attempt.settled,mode!=='unknown');assert.equal(run.budget.spent,mode==='paused-before'||mode==='unknown'?0:mode==='exhausted'?30:7);
    if(mode==='unknown'){assert.equal(attempt.reservation,30);assert.equal(attempt.actual,null);assert.equal(run.operations.find(op=>op.id===job.id)!.status,'confirmed','Physical stop resolves the operation, not unknown accounting');}
    for(const identity of actual.identities)assert.equal((await inspectProcess(identity)).status,'stopped');
    const before=f.store.runtime.inspect(f.runtime.id),loop=f.store.supervision.get(f.loop.id);
    assert.throws(()=>advanceAuthorStage(f.store,f.data,actual));
    assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.deepEqual(f.store.supervision.get(f.loop.id),loop);
    await runner.close();f.reopen();runner=f.runner(transport);await runner.initialize();
    if(mode==='exhausted')assert.deepEqual(await runner.run(job.id),actual);else await assert.rejects(runner.run(job.id));
    assert.equal(transport.calls,mode==='paused-before'?0:1);assert.equal(f.store.supervision.jobs(f.loop.id).length,1);
    assert.deepEqual(f.store.supervision.job(job.id),actual);assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,1);
    if(mode==='paused-before'||mode==='paused-after'||mode==='unknown') {
      if(mode==='unknown')f.pause();
      const runtimeAdapter=new LocalRuntimeAdapter(f.store,f.data),verification=new VerificationController(f.store,f.data);
      const controller=new SupervisionController(f.store,f.data,runtimeAdapter,verification,runner);
      const beforeResume=f.store.runtime.inspect(f.runtime.id);
      try {
        if(mode==='paused-before') {
          await controller.dispatch({type:'resume',loopId:f.loop.id});
          const replacement=f.store.supervision.jobs(f.loop.id).find(value=>value.id!==job.id)!;
          assert.ok(replacement);assert.equal(replacement.status,'running');assert.equal(replacement.modelStarted,false);
          assert.deepEqual(replacement.input,actual.input);assert.deepEqual(replacement.config,actual.config);
          assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,2);
          assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,0);
          assert.equal(transport.calls,0,'Resume authorizes a fresh known-zero request; it does not dispatch in this call');
        } else {
          await assert.rejects(controller.dispatch({type:'resume',loopId:f.loop.id}),mode==='unknown'?/unknown usage or stop/:/already started.*forbids replay/);
          assert.deepEqual(f.store.runtime.inspect(f.runtime.id),beforeResume);
          assert.equal(f.store.supervision.jobs(f.loop.id).length,1);
        }
        assert.deepEqual(f.store.supervision.job(job.id),actual);
      } finally {await controller.close();await verification.close();await runtimeAdapter.close();}
    }
  }
  }
});
