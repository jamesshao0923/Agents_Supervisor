import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapFixture } from '../helpers/control-bootstrap-fixture.js';
import { acceptanceAuthoringContextDigest } from '../../packages/orchestration/acceptance-authoring.js';
import { buildControlEvolutionAuthoringPrompt, captureControlEvolutionContext, controlEvolutionContextDigest, controlEvolutionAuthoringSchema, materializeControlEvolutionBundle, validateControlEvolutionBundle } from '../../packages/orchestration/acceptance-authoring-v2.js';
import type { ControlEvolutionAuthoringContext, ControlEvolutionBundle } from '../../packages/orchestration/acceptance-authoring-v2.js';
import { controlDigest } from '../../packages/verification/control-rules.js';
import { digest } from '../../packages/verification/candidate.js';
import { prepareControlDraft, executeControlBootstrap, assembleQualification } from '../../packages/verification/control-bootstrap.js';
import { parseReasonerOutput } from '../../packages/orchestration/reasoner-schema.js';
import type { TestContext } from 'node:test';

async function setup(t: TestContext) {
  const f = await bootstrapFixture(t), item = { id: 'math', description: 'Exact addition', kind: 'command' as const, target: 'data.json', checks: ['Sum is exactly 3'] };
  const contract = { version: 1, goal: 'Exact sum', criteria: [{ id: item.id, required: true, description: [item.description, 'Acceptance kind: command; target: data.json', ...item.checks].join('\n') }] };
  f.input.target.definition.contract = contract; f.input.base.target.contractDigest = controlDigest(contract);
  const content = await readFile(join(f.root, 'good/data.json'), 'utf8');
  const current = { contract, criteria: [item], previousSpec: null, candidate: { workspace: join(f.root, 'good'), digest: f.input.target.bundle.controls[0]!.candidate.digest, files: [{ path: 'data.json', content, sha256: digest(content) }] }, environment: { node: process.version }, failureContext: null };
  const context = await captureControlEvolutionContext({ current, base: f.input.base, transitions: [], history: f.input.history });
  const spec = structuredClone(f.input.target.definition.spec); spec.moduleDependencies = { math: [] };
  for (const c of spec.controls) c.workspace = c.id;
  for (const c of spec.cases) c.status = 'active';
  const bundle: ControlEvolutionBundle = { contextDigest: controlEvolutionContextDigest(context), plan: f.input.authoredPlan, assets: { contextDigest: acceptanceAuthoringContextDigest(current), spec, verifierFiles: [{ path: 'check.mjs', content: await readFile(join(f.root, 'defs/check.mjs'), 'utf8') }], controls: await Promise.all(['good', 'bad'].map(async id => ({ id, files: [{ path: 'data.json', content: await readFile(join(f.root, id, 'data.json'), 'utf8') }] }))), coverageExplanation: [{ criterionId: 'math', check: item.checks[0]!, caseIds: ['sum-detector'], explanation: 'Real independent checker reads sum and compares to three.' }] } };
  return { ...f, engineContext: f.context, context, bundle };
}

import {CONTROL_EVOLUTION_PRESENTATION_PROMPT,CONTROL_EVOLUTION_PRESENTATION_PROMPT_V2,CONTROL_EVOLUTION_PRESENTATION_PROMPT_V3,AUTHOR_RECOVERY_PRESENTATION_PROMPT_V3,AUTHOR_RECOVERY_PRESENTATION_PROMPT_V4,createAuthorRecoveryInput,renderControlEvolutionPrompt,renderControlEvolutionPromptV2,authorRecoveryInput,authorWireInput,assertAuthorWireCapacity} from '../../packages/orchestration/author-presentation.js';
import {COMMAND_AUTHOR_RUNTIME_CONTEXT,COMMAND_AUTHOR_EXIT_CONTEXT_V3} from '../../packages/orchestration/acceptance-runtime-guidance.js';
import {controlEvolutionAuthorInput} from '../../packages/orchestration/acceptance-authoring-v2.js';
import {authorWireReceipt,assertAuthorWireProof} from '../../packages/orchestration/author-presentation-proofs.js';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {SupervisionReasoningRunner} from '../../packages/orchestration/supervision-reasoning.js';
import {prepareReasonerTurn} from '../../packages/orchestration/reasoner.js';
import type {ReasonerInput,ReasonerResult,SupervisorReasoner} from '../../packages/orchestration/reasoner.js';
import {spawnManagedProcess,inspectProcess} from '../../packages/process-control/index.js';
import {verificationCanonical} from '../../packages/verification/rules.js';
import {runtimeCanonical} from '../../packages/persistence/runtime.js';

// Real SQLite, actual managed Node process, complete actual request transcripts.
// Output and seven tokens are explicit protocol fixtures, not provider approval.
async function runtimeFixture(t:TestContext,maxContextChars=200000,presentationVersion:1|2|3|'recovery'|'recovery-v4'=3){
  const f=await setup(t),workspace=join(f.root,'runtime');await mkdir(workspace);
  const data=join(f.root,'store');let store=new SupervisorStore(data);
  const runtime=store.runtime.submit({type:'submit',commandId:'runtime',workspace,workspaceKind:'project',goal:'Frozen standard',tokenLimit:100,verificationReserve:20,steps:[{id:'input',kind:'input',prompt:'Original input'}]});
  store.runtime.control({type:'input',runtimeId:runtime.id,commandId:'answer',stepId:'input',text:'Ready'});
  const operation=store.runtime.claim(runtime.id,'fixture')!;assert.ok(operation);
  store.runtime.report(operation.id,'fixture',{messageId:'ready',outcome:'confirmed',result:'Ready'});
  const loop=store.supervision.attach({commandId:'loop',runtimeId:runtime.id,config:{model:'explicit-node-protocol-fixture',effort:'low',reservation:30,timeoutMs:5000},limits:{maxRepairs:1,maxReasoningCalls:4,maxDurationMs:60000,maxContextChars}});
  t.after(()=>store.close());
  const latest=controlEvolutionAuthorInput({acceptance:f.context.current,candidate:{fixture:'complete candidate already in evolution'},evolution:f.context});
  const input=presentationVersion==='recovery'||presentationVersion==='recovery-v4'
    ? (presentationVersion==='recovery'?authorRecoveryInput:createAuthorRecoveryInput)({acceptance:f.context.current,candidate:{fixture:'complete candidate already in acceptance'},authorFeedback:{schemaVersion:1,attempt:1,previousJobId:'prior-explicit-fixture',inputDigest:'a'.repeat(64),rejection:{schemaVersion:1,kind:'review',raw:f.bundle,diagnostics:'Full rejected evidence retained. '.repeat(2000)},references:{missing:[]}}},latest.outputSchema)
    : presentationVersion===3?latest:{...latest,prompt:presentationVersion===2?CONTROL_EVOLUTION_PRESENTATION_PROMPT_V2:CONTROL_EVOLUTION_PRESENTATION_PROMPT,context:{...latest.context,authorPresentation:{schemaVersion:presentationVersion,kind:'control-evolution' as const}}};
  return {...f,data,runtime,loop,input,get store(){return store;},reopen(){store.close();store=new SupervisorStore(data);},begin(value:unknown=input,commandId='author'){return store.supervision.beginJob({commandId,loopId:loop.id,expectedRevision:store.supervision.get(loop.id).revision,purpose:'acceptance-authoring',context:value});}};
}
class NodeWireTransport implements SupervisorReasoner{
  calls=0;
  constructor(readonly value:unknown){}
  async request(request:ReasonerInput):Promise<ReasonerResult>{
    this.calls++;
    const result:ReasonerResult={value:this.value,usage:7,threadId:'actual-node-fixture-thread',turnId:'actual-node-fixture-turn',proofFiles:[],stopConfirmed:false,modelStarted:false};
    await prepareReasonerTurn(request,result,()=>request.assertEligible?.());
    const path=join(request.logDir,'events.jsonl');
    const events=[{kind:'reasoner-input',value:{id:request.id,prompt:request.prompt,outputSchema:request.outputSchema,model:request.model,effort:request.effort}},
      {kind:'reasoner-turn-intent',value:{threadId:result.threadId,input:[{type:'text',text:request.prompt}],model:request.model,effort:request.effort}},
      {kind:'reasoner-turn-started',value:{turn:{id:result.turnId}}},
      {kind:'codex-event',value:{method:'turn/completed',threadId:result.threadId,raw:{params:{threadId:result.threadId,turn:{id:result.turnId,status:'completed'}}}}}];
    const inputPath=join(request.logDir,'node-request.json');await writeFile(inputPath,JSON.stringify(events));
    const child=await spawnManagedProcess({operationId:request.id+'-actual-node',command:process.execPath,args:['-e',"require('node:fs').writeFileSync(process.argv[2],JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).map(JSON.stringify).join('\\n'))",inputPath,path],cwd:request.cwd,timeoutMs:5000,onBeforeSpawn:i=>request.onIntent?.(i),onIdentity:i=>request.onIdentity?.(i)});
    const stopped=await child.completion;result.stopConfirmed=stopped.stopped;assert.equal((await inspectProcess(child.identity)).status,'stopped');await request.onUsage?.(7);result.proofFiles=[path,inputPath];return result;
  }
}

test('P6-AUTH-PRESENT-I01 explicit presentation preserves complete context and exact legacy wire text',async t=>{
  const f=await runtimeFixture(t),legacy=buildControlEvolutionAuthoringPrompt(f.context),wire=authorWireInput(f.input,'acceptance-authoring');
  const v1={...f.input,prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT,context:{...(f.input.context as object),authorPresentation:{schemaVersion:1,kind:'control-evolution'}}};
  assert.equal(authorWireInput(v1,'acceptance-authoring').prompt,legacy);
  assert.equal(renderControlEvolutionPrompt(f.context),legacy);
  assert.ok(wire.prompt.startsWith(legacy+'\n\n'));
  assert.match(wire.prompt,/SUPERVISOR_VERIFY_TYPESCRIPT_MODULE/);
  assert.ok(!legacy.includes('SUPERVISOR_VERIFY_TYPESCRIPT_MODULE'));
  assert.equal(f.input.prompt,CONTROL_EVOLUTION_PRESENTATION_PROMPT_V3);assert.deepEqual((f.input.context as any).evolution,f.context);assert.deepEqual((f.input.context as any).acceptance,f.context.current);
  const v2={...f.input,prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT_V2,context:{...(f.input.context as object),authorPresentation:{schemaVersion:2,kind:'control-evolution'}}};
  assert.equal(authorWireInput(v2,'acceptance-authoring').prompt,legacy+'\n\n'+COMMAND_AUTHOR_RUNTIME_CONTEXT);
  assert.equal(renderControlEvolutionPromptV2(f.context),legacy+'\n\n'+COMMAND_AUTHOR_RUNTIME_CONTEXT);
  assert.equal(wire.prompt,renderControlEvolutionPromptV2(f.context)+'\n\n'+COMMAND_AUTHOR_EXIT_CONTEXT_V3);
  const recovery=await runtimeFixture(t,200000,'recovery'),recoveryWire=authorWireInput(recovery.input,'acceptance-authoring');
  const feedback=(recovery.input.context as any).authorFeedback;
  assert.equal(recovery.input.prompt,AUTHOR_RECOVERY_PRESENTATION_PROMPT_V3);
  const v4=await runtimeFixture(t,200000,'recovery-v4'),v4wire=authorWireInput(v4.input,'acceptance-authoring');
  assert.equal(v4.input.prompt,AUTHOR_RECOVERY_PRESENTATION_PROMPT_V4);
  const v4feedback=(v4.input.context as any).authorFeedback;
  assert.equal(v4feedback.rejection.diagnostics,feedback.rejection.diagnostics);
  assert.ok(v4wire.prompt.includes(verificationCanonical(v4feedback)));
  assert.equal(v4wire.prompt.split(feedback.rejection.diagnostics).length,2);
  assert.ok(v4wire.prompt.includes(verificationCanonical((v4.input.context as any).acceptance)));
  const v4receipt=authorWireReceipt({id:'new-v4',input:v4.input,inputDigest:'complete-input',purpose:'acceptance-authoring'})!;
  assert.equal(v4receipt.schemaVersion,2);
  assert.deepEqual((v4receipt as any).presentation,{schemaVersion:4,kind:'acceptance-recovery'});
  for(const version of [false,0,null,{schemaVersion:5,kind:'acceptance-recovery'},{schemaVersion:4,kind:'control-evolution'},{schemaVersion:4,kind:'acceptance-recovery',extra:true}])assert.throws(()=>authorWireReceipt({id:'bad',input:{...v4.input,context:{...(v4.input.context as object),authorPresentation:version}},inputDigest:'x',purpose:'acceptance-authoring'}),/Unknown/);
  assert.throws(()=>authorWireInput({...v4.input,prompt:AUTHOR_RECOVERY_PRESENTATION_PROMPT_V3},'acceptance-authoring'),/marker/);
  assert.throws(()=>authorWireInput({...recovery.input,context:{...(recovery.input.context as object),authorPresentation:{schemaVersion:4,kind:'acceptance-recovery'}}},'acceptance-authoring'),/marker/);
  assert.throws(()=>authorWireInput({prompt:AUTHOR_RECOVERY_PRESENTATION_PROMPT_V4,context:{},outputSchema:{}},'acceptance-authoring'),/Missing/);
  const mixed=structuredClone((v4.input.context as any));mixed.acceptance.criteria.push({...mixed.acceptance.criteria[0],id:'native',kind:'ui'});
  assert.equal(createAuthorRecoveryInput(mixed,{}).prompt,AUTHOR_RECOVERY_PRESENTATION_PROMPT_V3);
  assert.throws(()=>authorWireInput({...v4.input,context:mixed},'acceptance-authoring'),/command-only/);

  assert.ok(recoveryWire.prompt.includes(feedback.rejection.diagnostics));
  assert.equal(recoveryWire.prompt.split(feedback.rejection.diagnostics).length,2,'complete diagnostics occur exactly once');
  assert.match(recoveryWire.prompt,/Exit with code 0 exactly when every verdict is passed or not-applicable/);
  assert.match(recoveryWire.prompt,/process.exitCode=1 when any verdict is failed or unknown/);
  assert.equal((authorWireReceipt({id:'new-recovery',input:recovery.input,inputDigest:'x',purpose:'acceptance-authoring'}) as any).schemaVersion,2);
  for(const change of [{schemaVersion:3,kind:'acceptance-recovery',extra:true},{schemaVersion:5,kind:'acceptance-recovery'},null,false,0])assert.throws(()=>authorWireInput({...recovery.input,context:{...(recovery.input.context as object),authorPresentation:change}},'acceptance-authoring'),/Unknown/);
  assert.throws(()=>authorWireInput({...recovery.input,prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT_V3},'acceptance-authoring'),/marker/);
  assert.throws(()=>authorWireInput({...recovery.input,context:{...(recovery.input.context as object),authorFeedback:{...feedback,rejection:{kind:'review'}}}},'acceptance-authoring'),/typed author recovery/);
  assert.ok(JSON.stringify(f.input).length<JSON.stringify({...f.input,prompt:legacy}).length);
  assert.equal(authorWireInput({prompt:'historical prompt byte exact\n',outputSchema:{},context:{}},'diagnosis').prompt,'historical prompt byte exact\n');
  assert.equal(authorWireInput({prompt:'historical inline author prompt byte exact\n',outputSchema:{},context:{}},'acceptance-authoring').prompt,'historical inline author prompt byte exact\n');
  assert.equal(authorWireReceipt({id:'legacy',input:{prompt:legacy,outputSchema:{},context:{}},inputDigest:'x',purpose:'acceptance-authoring'}),null);
  for(const change of [()=>({...f.input,prompt:'caller rendered replacement'}),()=>({...f.input,context:{...(f.input.context as object),authorPresentation:{schemaVersion:4,kind:'control-evolution'}}}),()=>({...f.input,context:{...(f.input.context as object),acceptance:{}}})])assert.throws(()=>authorWireInput(change(),'acceptance-authoring'));
  for(const bad of [false,0,null,{schemaVersion:99,kind:'control-evolution'},{schemaVersion:2,kind:'control-evolution',extra:true}])assert.throws(()=>authorWireInput({...f.input,context:{...(f.input.context as object),authorPresentation:bad}},'acceptance-authoring'),/Unknown/);
  assert.throws(()=>authorWireInput({...v1,prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT_V2},'acceptance-authoring'),/marker/);
  assert.throws(()=>authorWireInput({...f.input,prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT},'acceptance-authoring'),/marker/);
  assert.throws(()=>authorWireInput({prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT_V2,outputSchema:{},context:{}},'acceptance-authoring'),/Missing/);
  assert.throws(()=>authorWireInput(f.input,'diagnosis'),/Only acceptance/);
  assert.throws(()=>authorWireInput({prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT,outputSchema:{},context:{}},'acceptance-authoring'),/Missing/);
  assert.ok(legacy.includes('contextDigest='+controlEvolutionContextDigest(f.context)));assert.ok(legacy.includes('assets.contextDigest='+acceptanceAuthoringContextDigest(f.context.current)));
});

test('P6-AUTH-PRESENT-I02 both unchanged capacity ceilings reject before reservation and leave the ledger intact',async t=>{
  const f=await runtimeFixture(t),before=f.store.runtime.inspect(f.runtime.id),loop=f.store.supervision.get(f.loop.id);
  const wire=authorWireInput(f.input,'acceptance-authoring');
  const wireLimit=wire.prompt.length+JSON.stringify(wire.outputSchema).length+6000-1;
  assert.throws(()=>assertAuthorWireCapacity(f.input,'acceptance-authoring',wireLimit),/Rendered/);
  const v1={...f.input,prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT,context:{...(f.input.context as object),authorPresentation:{schemaVersion:1,kind:'control-evolution'}}};
  const oldWire=authorWireInput(v1,'acceptance-authoring');
  assert.throws(()=>assertAuthorWireCapacity(v1,'acceptance-authoring',oldWire.prompt.length+JSON.stringify(v1.outputSchema).length+5999),/Rendered/);
  const huge=structuredClone(f.input);(huge.context as any).retainedProof='x'.repeat(200000);
  assert.throws(()=>f.begin(huge),/context exceeds capacity/);
  const hugeV1={...huge,prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT,context:{...(huge.context as object),authorPresentation:{schemaVersion:1,kind:'control-evolution'}}};
  assert.throws(()=>f.begin(hugeV1),/context exceeds capacity/);
  const v4=await runtimeFixture(t,200000,'recovery-v4'),v4before=v4.store.runtime.inspect(v4.runtime.id);
  const v4wire=authorWireInput(v4.input,'acceptance-authoring');
  assert.throws(()=>assertAuthorWireCapacity(v4.input,'acceptance-authoring',v4wire.prompt.length+JSON.stringify(v4.input.outputSchema).length+5999),/Rendered/);
  const hugeV4=structuredClone(v4.input);(hugeV4.context as any).authorFeedback.rejection.diagnostics='x'.repeat(200000);
  assert.throws(()=>v4.begin(hugeV4),/context exceeds capacity/);
  assert.deepEqual(v4.store.runtime.inspect(v4.runtime.id),v4before);assert.equal(v4.store.supervision.jobs(v4.loop.id).length,0);
  const minimal={prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT,outputSchema:{},context:{authorPresentation:{schemaVersion:1,kind:'control-evolution'},acceptance:{},evolution:{schemaVersion:1,current:{},history:{},historyText:{},base:{},transitions:[]}}};
  const length=runtimeCanonical(minimal).length+6000;assert.ok(length<8000);
  const small=await runtimeFixture(t,8000),smallBefore=small.store.runtime.inspect(small.runtime.id);
  assert.throws(()=>small.begin(minimal),/Rendered author input exceeds capacity/);
  const minimalV2={...minimal,prompt:CONTROL_EVOLUTION_PRESENTATION_PROMPT_V2,context:{...minimal.context,authorPresentation:{schemaVersion:2,kind:'control-evolution'}}};
  assert.throws(()=>small.begin(minimalV2),/Rendered author input exceeds capacity/);
  assert.deepEqual(small.store.runtime.inspect(small.runtime.id),smallBefore);
  const frozen=f.store.runtime.inspect(f.runtime.id);
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id),frozen);assert.deepEqual(frozen,before);assert.equal(f.store.supervision.jobs(f.loop.id).length,0);assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,0);
});

test('P6-AUTH-PRESENT-I03 actual Node dispatch stores wire binding and finished reopen never dispatches again',async t=>{
  for(const presentationVersion of [1,2,3,'recovery','recovery-v4'] as const){
  const f=await runtimeFixture(t,200000,presentationVersion),transport=new NodeWireTransport(f.bundle);let runner=new SupervisionReasoningRunner(f.store,f.data,transport);
  const job=f.begin(),done=await runner.run(job.id),directory=join(f.data,'supervision-reasoning',digest(job.id));
  assert.equal(done.error,null);assert.equal(done.usage,7);assert.equal(done.stopConfirmed,true);assert.equal(done.inputDigest,digest(runtimeCanonical(f.input)));
  assertAuthorWireProof(done,directory);assert.deepEqual(JSON.parse(await readFile(join(directory,'author-wire.json'),'utf8')),authorWireReceipt(done));
  const receipt=authorWireReceipt(done)!;
  assert.equal(receipt.schemaVersion,presentationVersion===1||presentationVersion===2?1:2);
  if(presentationVersion==='recovery'||presentationVersion==='recovery-v4'){
    const changed=structuredClone(done),input=changed.input as any;
    input.context.authorFeedback.rejection.diagnostics+=' changed frozen evidence';
    changed.inputDigest=digest(runtimeCanonical(input));
    assert.throws(()=>assertAuthorWireProof(changed,directory),/wire receipt/);
    assert.deepEqual((done.input as any).context.authorFeedback,(f.input.context as any).authorFeedback);
  }
  await runner.close();f.reopen();runner=new SupervisionReasoningRunner(f.store,f.data,transport);assert.deepEqual(await runner.run(job.id),done);assert.equal(transport.calls,1);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,7);
  const path=join(directory,'events.jsonl'),original=await readFile(path,'utf8'),events=original.trim().split('\n').map(line=>JSON.parse(line));events.find(e=>e.kind==='reasoner-turn-intent').value.input[0].text+=' altered';await writeFile(path,events.map(e=>JSON.stringify(e)).join('\n'));
  const forged={...done,proofs:{...done.proofs,[path]:digest(await readFile(path))}};
  assert.throws(()=>assertAuthorWireProof(forged,directory),/complete rendered prompt/);
  await assert.rejects(runner.run(job.id),/proof digest changed/);assert.equal(transport.calls,1);
  await writeFile(path,original);events.find(e=>e.kind==='reasoner-turn-intent').value.input[0].text=authorWireInput(f.input,'acceptance-authoring').prompt;events.find(e=>e.kind==='codex-event').value.raw.params.turn.id='unrelated';await writeFile(path,events.map(e=>JSON.stringify(e)).join('\n'));
  const changedHash=digest(await readFile(path));
  assert.throws(()=>assertAuthorWireProof({...done,proofs:{...done.proofs,[path]:changedHash}},directory),/actual completed turn/);
  await runner.close();
  }
});
