import {renderStageRecoveryInput,parseStageRecoveryInput,AUTHOR_STAGE_RECOVERY_PROMPT} from '../../packages/orchestration/author-stage-recovery-presentation.js';
import {authorWireReceipt} from '../../packages/orchestration/author-presentation-proofs.js';
import * as stageProtocols from '../../packages/orchestration/author-stage-protocol.js';
import * as stageV2 from '../../packages/orchestration/acceptance-authoring-stages-v2.js';
import {AUTHOR_STAGE_PROTOCOL_V2,type HostAuthorStageBindingV2,type AuthorDefinitionStageV2,type AuthorPositiveStageV2,type AuthorNegativeStageV2} from '../../packages/contracts/p6-author-stages.js';
import {AUTHOR_STAGE_PROTOCOL, AUTHOR_STAGE_ORDER, AUTHOR_STAGE_POLICY, type HostAuthorStageBinding, type AuthorDefinitionStage, type AuthorPositiveStage, type AuthorNegativeStage} from '../../packages/contracts/p6-author-stages.js';
import {AUTHOR_STAGE_PROMPT, authorStageDigest, authorStageOutputSchema, parseAuthorStageOutput, renderAuthorStageInput, parseAuthorStageInput, renderAuthorStagePrompt, assembleAuthorStages, expandAuthorStages, applyAuthorControlChanges, validateAuthorStageBinding} from '../../packages/orchestration/acceptance-authoring-stages.js';
import {applyAuthorReplacements,authorPatchBinding,authorPatchSchema,expandAuthorPatch,patchInput,AUTHOR_PATCH_PROMPT} from '../../packages/orchestration/author-result-patch.js';
import {createAuthorPatchInput,authorWireInput} from '../../packages/orchestration/author-presentation.js';
import {isCommandOnlyAuthorContext,renderAcceptanceAuthoringPromptV3,renderAcceptanceAuthoringPromptV4} from '../../packages/orchestration/acceptance-authoring-presentation.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVerificationSpec } from '../../packages/contracts/p4.js';
import { parseReasonerOutput } from '../../packages/orchestration/reasoner-schema.js';
import { acceptanceAuthoringContextDigest, acceptanceAuthoringSchema, currentAcceptanceAssetSchema, buildAcceptanceAuthoringPrompt, materializeAcceptanceBundle, validateAcceptanceBundle, type AcceptanceAuthoringContext, type AcceptanceBundle } from '../../packages/orchestration/acceptance-authoring.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function context(): AcceptanceAuthoringContext {
  const content = 'export function sum(a,b) { return a+b; }\n';
  const criterion = { id: 'sum', description: 'Add finite numbers', kind: 'command' as const, target: 'math.mjs', checks: ['sum(2,3) equals 5', 'invalid inputs are rejected'] };
  return { contract: { version: 2, goal: 'Compute sum', criteria: [{ id: 'sum', required: true, description: [criterion.description, 'Acceptance kind: command; target: math.mjs', ...criterion.checks].join('\n') }] }, criteria: [criterion],
    candidate: { workspace: '/private/candidate', digest: hash('frozen-external-candidate-digest'), files: [{ path: 'math.mjs', content, sha256: hash(content) }] }, environment: { node: process.version, platform: process.platform }, failureContext: { actual: 'Invalid input accepted', proof: 'failed-proof-sha' }, previousSpec: null };
}
function bundle(c = context()): AcceptanceBundle {
  const checks = c.criteria[0]!.checks;
  return { contextDigest: acceptanceAuthoringContextDigest(c), spec: { schemaVersion: 1, contractVersion: 2, standardsVersion: 'author-v1', obligations: [{ id: 'sum-ok', criterionId: 'sum', expectation: 'Normal sum and exceptions', required: true, applicable: true }],
    cases: [{ id: 'sum-check', revision: 1, obligationIds: ['sum-ok'], parameters: [{}], modules: ['sum'], replaces: [], defectRefs: ['invalid-input'], status: 'active', verifier: { kind: 'command', version: 'independent-v1', entry: 'check.mjs', files: ['check.mjs'], timeoutMs: 1000 } }], controls: [{ id: 'good', workspace: 'good', expect: 'passed', mustFail: [] }, { id: 'bad', workspace: 'bad', expect: 'failed', mustFail: ['sum-ok'] }], moduleDependencies: { sum: [] } },
    verifierFiles: [{ path: 'check.mjs', content: '/* independently authored checker; executed only by P4 after proposal */\n' }], controls: [{ id: 'good', files: [{ path: 'math.mjs', content: 'export const sum=(a,b)=>{if(typeof a!=="number"||typeof b!=="number")throw Error();return a+b};\n' }] }, { id: 'bad', files: [{ path: 'math.mjs', content: 'export const sum=(a,b)=>a-b;\n' }] }], coverageExplanation: checks.map(check => ({ criterionId: 'sum', check, caseIds: ['sum-check'], explanation: 'Separate assertions exercise values and exception behavior; P4 independently assesses effectiveness.' })) };
}

// Pure protocol fixtures: these IDs/digests do not assert actual model jobs/proofs.
function stages(c = context()) {
  const b = bundle(c);
  const d: AuthorDefinitionStage = {protocol: AUTHOR_STAGE_PROTOCOL, stage: 'definition', contextDigest: b.contextDigest,
    spec: b.spec, verifierFiles: b.verifierFiles, coverageExplanation: b.coverageExplanation, negativeBases: [{controlId: 'bad', positiveId: 'good'}]};
  const p: AuthorPositiveStage = {protocol: AUTHOR_STAGE_PROTOCOL, stage: 'positive', contextDigest: b.contextDigest,
    definitionDigest: authorStageDigest(d), controls: [b.controls[0]!]};
  const n: AuthorNegativeStage = {protocol: AUTHOR_STAGE_PROTOCOL, stage: 'negative', contextDigest: b.contextDigest,
    definitionDigest: authorStageDigest(d), positiveDigest: authorStageDigest(p), controls: [{id: 'bad', basePositiveId: 'good',
      basePositiveDigest: authorStageDigest(p.controls[0]), fileChanges: [{operation: 'replace', ...b.controls[1]!.files[0]!}]}]};
  const binding = (index: 0 | 1 | 2): HostAuthorStageBinding => ({protocol: AUTHOR_STAGE_PROTOCOL, sessionId: 'pure-protocol-session', index,
    stage: AUTHOR_STAGE_ORDER[index], sessionTokenCeiling: 180000, perCallTimeoutMs: 240000, loopDeadlineMs: 2000000000000,
    parents: [d, p].slice(0, index).map((value, i) => ({stage: AUTHOR_STAGE_ORDER[i]!, jobId: 'pure-parent-'+i,
      inputDigest: 'a'.repeat(64), resultDigest: authorStageDigest(value), rawOutputDigest: 'b'.repeat(64), proofsDigest: 'c'.repeat(64)}))});
  return {b, d, p, n, binding};
}

function stagesV2(c = context()) {
  const prior=stages(c),{verifierFiles,...definition}=prior.d;
  const d:AuthorDefinitionStageV2={...definition,protocol:AUTHOR_STAGE_PROTOCOL_V2,verifierPaths:verifierFiles.map(f=>f.path)};
  const p:AuthorPositiveStageV2={...prior.p,protocol:AUTHOR_STAGE_PROTOCOL_V2,definitionDigest:authorStageDigest(d),verifierFiles};
  const n:AuthorNegativeStageV2={...prior.n,protocol:AUTHOR_STAGE_PROTOCOL_V2,definitionDigest:authorStageDigest(d),positiveDigest:authorStageDigest(p)};
  const binding=(index:0|1|2):HostAuthorStageBindingV2=>({...prior.binding(index),protocol:AUTHOR_STAGE_PROTOCOL_V2,
    parents:prior.binding(index).parents.map((ref,i)=>({...ref,resultDigest:authorStageDigest([d,p][i])}))});
  return {b:prior.b,d,p,n,binding};
}

test('P6-AUTH-U01 strict proposed assets bind complete contract source environment and failure context without granting success', () => {
  const c = context(), b = bundle(c), schema = acceptanceAuthoringSchema(c);
  const staged = stages(c), rawFragments = JSON.stringify([staged.d, staged.p, staged.n]);
  assert.deepEqual(assembleAuthorStages(c, staged.d, staged.p, staged.n), b);
  assert.equal(JSON.stringify([staged.d, staged.p, staged.n]), rawFragments, 'Assembly never rewrites raw stage fragments');
  assert.equal(AUTHOR_STAGE_POLICY.callsRequired, 3);
  assert.equal(AUTHOR_STAGE_POLICY.timeout, 'min-original-per-call-and-loop-remaining');
  for (const index of [0, 1, 2] as const) {
    const parents = [staged.d, staged.p].slice(0, index), value = [staged.d, staged.p, staged.n][index]!;
    const input = renderAuthorStageInput({acceptance: c, candidate: {snapshot: 'full-host-candidate'}, binding: staged.binding(index), parents});
    assert.equal(input.prompt, AUTHOR_STAGE_PROMPT); assert.equal(input.context.authorPresentation.schemaVersion, 6);
    assert.deepEqual(parseAuthorStageInput(input), input);
    assert.deepEqual(parseAuthorStageOutput(value, c, staged.binding(index), parents), value);
    assert.doesNotThrow(() => parseReasonerOutput(JSON.stringify(value), input.outputSchema));
    const wire = renderAuthorStagePrompt(c, staged.binding(index), parents);
    for (const original of [c.candidate.files[0]!.content, c.contract.criteria[0]!.description, 'Invalid input accepted'])
      assert.ok(wire.includes(JSON.stringify(original).slice(1, -1)));
    for (const prior of parents) {
      const strings = 'verifierFiles' in prior ? prior.verifierFiles.map(f => f.content) : prior.controls.flatMap(control => control.files.map(f => f.content));
      for (const content of strings) assert.ok(wire.includes(JSON.stringify(content).slice(1, -1)));
    }
    assert.deepEqual(input.context.authorStageParents, parents); assert.deepEqual(input.context.acceptance, c);
    assert.equal(input.context.authorStage.perCallTimeoutMs, 240000);
    assert.equal(input.context.authorStage.sessionTokenCeiling, 180000);
  }
  const v2=stagesV2(c);
  assert.deepEqual(stageProtocols.assembleAuthorStages(c,v2.d,v2.p,v2.n),b);
  // A schema-valid diff must also satisfy the original complete-bundle rules
  // before the final fragment can finish and become an accepted stage.
  const emptyControl=structuredClone(v2.n);
  emptyControl.controls[0]!.fileChanges=[{operation:'delete',path:'math.mjs'}];
  assert.throws(()=>stageProtocols.parseAuthorStageOutput(emptyControl,c,v2.binding(2),[v2.d,v2.p]),
    /\$output\.controls\[1\]\.files: array length outside schema/);
  const missingTarget=structuredClone(emptyControl);
  missingTarget.controls[0]!.fileChanges.push({operation:'add',path:'unrelated.mjs',content:'export const unrelated=true;'});
  assert.throws(()=>stageProtocols.parseAuthorStageOutput(missingTarget,c,v2.binding(2),[v2.d,v2.p]),
    /Control project lacks frozen acceptance target/);
  assert.deepEqual(stageProtocols.parseAuthorStageOutput(v2.n,c,v2.binding(2),[v2.d,v2.p]),v2.n);
  assert.equal(stageProtocols.expandAuthorStages(c,v2.d,v2.p,emptyControl).controls[1]!.files.length,0,
    'Pure historical expansion remains diagnosable and grants no acceptance');

  assert.equal(Object.hasOwn(v2.d,'verifierFiles'),false);
  for(const index of [0,1,2] as const){
    const parents=[v2.d,v2.p].slice(0,index),output=[v2.d,v2.p,v2.n][index];
    const input=stageProtocols.renderAuthorStageInput({acceptance:c,candidate:{complete:'snapshot'},binding:v2.binding(index),parents});
    assert.equal(input.context.authorPresentation.schemaVersion,8);
    assert.deepEqual(stageProtocols.parseAuthorStageInput(input),input);
    assert.deepEqual(stageProtocols.parseAuthorStageOutput(output,c,v2.binding(index),parents),output);
    assert.deepEqual(input.context.acceptance,c);assert.deepEqual(input.context.authorStageParents,parents);
    const wire=authorWireInput(input,'acceptance-authoring');
    assert.equal(wire.prompt,stageV2.renderAuthorStagePrompt(c,v2.binding(index),parents));
    const fresh=stageProtocols.renderNewAuthorStageInput({acceptance:c,candidate:{complete:'snapshot'},binding:v2.binding(index),parents});
    assert.equal(fresh.context.authorPresentation.schemaVersion,9);
    assert.deepEqual(stageProtocols.parseAuthorStageInput(fresh),fresh);
    assert.deepEqual(fresh.outputSchema,input.outputSchema);
    assert.deepEqual(fresh.context.acceptance,input.context.acceptance);
    assert.deepEqual(fresh.context.authorStageParents,input.context.authorStageParents);
    const freshWire=authorWireInput(fresh,'acceptance-authoring');
    assert.ok(freshWire.prompt.endsWith(wire.prompt),'All previous V2 requirements/context remain byte-exact');
    assert.match(freshWire.prompt,/EACH positive\/negative control and the final candidate/);
    assert.match(freshWire.prompt,/not passed to the checker as readable files/);
    assert.match(freshWire.prompt,/does not prove a particular earlier development action/);
    assert.match(freshWire.prompt,/do not impose a blanket syntax restriction/);
    const receipt=authorWireReceipt({id:'prompt-only-binding',input:fresh,inputDigest:'fixed-test-input',purpose:'acceptance-authoring'});
    assert.equal(receipt?.schemaVersion,2);
    assert.deepEqual(receipt?.presentation,{schemaVersion:9,kind:'acceptance-stage'});
    assert.equal(receipt?.promptDigest,hash(freshWire.prompt));
    assert.deepEqual(stageProtocols.renderAuthorStageInput({acceptance:c,candidate:{complete:'snapshot'},binding:v2.binding(index),parents},8),input);
    assert.deepEqual(stageProtocols.renderAuthorStageInput({acceptance:c,candidate:{complete:'snapshot'},binding:v2.binding(index),parents},9),fresh);
    assert.throws(()=>stageProtocols.parseAuthorStageInput({...fresh,prompt:input.prompt}));
    assert.throws(()=>stageProtocols.parseAuthorStageInput({...fresh,context:{...fresh.context,authorPresentation:{schemaVersion:10,kind:'acceptance-stage'}}}));
    assert.throws(()=>stageProtocols.renderAuthorStageInput({acceptance:c,candidate:{},binding:staged.binding(index),parents:[staged.d,staged.p].slice(0,index)},9));

    assert.ok(wire.prompt.includes(JSON.stringify(c.contract.criteria[0]!.description).slice(1,-1)));
    // The legacy dispatcher path must reproduce the original stored and wire bytes exactly.
    const rejectedRaw={...output,invalidFixture:'complete rejected fragment'};
    const recovery={schemaVersion:1 as const,rejection:{jobId:'pure-rejected-stage',inputDigest:'d'.repeat(64),completionDigest:'e'.repeat(64),proofsDigest:'f'.repeat(64),rawOutputDigest:hash(JSON.stringify(rejectedRaw)),classification:'schema' as const,message:'pure schema rejection'},raw:rejectedRaw,previousAttempt:null};
    const replacement=renderStageRecoveryInput({acceptance:c,candidate:{complete:'snapshot'},binding:v2.binding(index),parents},recovery);
    assert.equal(replacement.prompt,AUTHOR_STAGE_RECOVERY_PROMPT);
    assert.deepEqual(stageProtocols.parseAuthorStageInput(replacement),replacement);
    assert.deepEqual(replacement.outputSchema,fresh.outputSchema);
    assert.deepEqual(replacement.context.acceptance,c);assert.deepEqual(replacement.context.authorStageParents,parents);
    assert.deepEqual(replacement.context.stageRecovery.raw,rejectedRaw);
    const replacementWire=authorWireInput(replacement,'acceptance-authoring');
    assert.ok(replacementWire.prompt.includes(freshWire.prompt));
    assert.ok(replacementWire.prompt.includes(JSON.stringify(recovery)));
    assert.deepEqual(authorWireReceipt({id:'pure-recovery',input:replacement,inputDigest:'pure',purpose:'acceptance-authoring'})?.presentation,{schemaVersion:10,kind:'acceptance-stage-recovery'});
    for(const version of [false,null,0,9,11])assert.throws(()=>parseStageRecoveryInput({...replacement,context:{...replacement.context,authorPresentation:{schemaVersion:version,kind:'acceptance-stage-recovery'}}}));
    assert.throws(()=>parseStageRecoveryInput({...replacement,context:{...replacement.context,stageRecovery:{...recovery,rejection:{...recovery.rejection,classification:['schema']}}}}));
    assert.throws(()=>parseStageRecoveryInput({...replacement,outputSchema:{type:'object'}}));
    assert.throws(()=>renderStageRecoveryInput({acceptance:c,candidate:{},binding:staged.binding(index) as unknown as HostAuthorStageBindingV2,parents},recovery));
    const oldParents=[staged.d,staged.p].slice(0,index);
    const oldInput=renderAuthorStageInput({acceptance:c,candidate:{complete:'snapshot'},binding:staged.binding(index),parents:oldParents});
    assert.equal(JSON.stringify(stageProtocols.renderAuthorStageInput({acceptance:c,candidate:{complete:'snapshot'},binding:staged.binding(index),parents:oldParents})),JSON.stringify(oldInput));
    assert.equal(stageProtocols.renderAuthorStagePrompt(c,staged.binding(index),oldParents),renderAuthorStagePrompt(c,staged.binding(index),oldParents));
  }
  assert.equal(parseAuthorStageInput({prompt: 'legacy', outputSchema: {}, context: {acceptance: c}}), null);

  assert.deepEqual(validateAcceptanceBundle(b, c), b);
  assert.doesNotThrow(() => parseReasonerOutput(JSON.stringify(b), schema));
  const prompt = buildAcceptanceAuthoringPrompt(c);
  for (const text of [c.candidate.files[0]!.content, c.contract.criteria[0]!.description, 'Invalid input accepted', process.version]) assert.ok(prompt.includes(JSON.stringify(text).slice(1, -1)));
  assert.match(prompt, /untrusted project data/); assert.match(prompt, /PROPOSALS/);
  assert.equal(prompt, renderAcceptanceAuthoringPromptV4(c));
  assert.match(prompt, /must be an EXACT declared obligation ID, never a case ID/);
  assert.match(prompt, /exactly its own obligationIds, each once/);
  assert.match(prompt, /one command case may check several obligations/);
  assert.ok(!prompt.includes('Each mobile case'));
  assert.ok(!prompt.includes('For material acceptance'));
  assert.ok(!prompt.includes('fixed Node builtins createApplication'));
  const mixed = structuredClone(c);
  mixed.criteria.push({id:'ui',description:'Visible result',kind:'ui',target:'index.html',checks:['Result visible']});
  mixed.candidate.files.push({path:'index.html',content:'<p>Result</p>',sha256:hash('<p>Result</p>')});
  mixed.contract.criteria.push({id:'ui',required:true,description:'Visible result\nAcceptance kind: ui; target: index.html\nResult visible'});
  assert.equal(isCommandOnlyAuthorContext(mixed),false);
  assert.equal(buildAcceptanceAuthoringPrompt(mixed),renderAcceptanceAuthoringPromptV3(mixed));
  assert.throws(()=>renderAcceptanceAuthoringPromptV4(mixed),/command-only/);
  assert.equal(isCommandOnlyAuthorContext({...c,criteria:[]}),false);
  assert.throws(()=>renderAcceptanceAuthoringPromptV4({...c,criteria:[]}),/command-only/);
  const workflow = {...c,workflowMode:'fixture-preserve-all-of' as NonNullable<AcceptanceAuthoringContext['workflowMode']>};
  assert.ok(renderAcceptanceAuthoringPromptV4(workflow).includes('Keep EVERY original criterion/check unchanged'));

  // Generic checker ABI, not a task-specific detector or permission expansion.
  assert.match(prompt, /SUPERVISOR_VERIFY_TYPESCRIPT_MODULE: an absolute path/);
  assert.match(prompt, /TypeScript 6\.0\.3 parser module/);
  assert.match(prompt, /not supplied to candidateEntries/);
  assert.match(prompt, /does not supply an assertion trace, mutation detector or precomputed control observations/);
  assert.match(prompt, /synchronous node:module registerHooks/);
  assert.match(prompt, /does not authorize workers, subprocesses, candidate writes/);
  assert.match(prompt, /do not require their future observations to be present in the author input/);
  assert.match(prompt, /report unknown\/failure on unavailable evidence/);
  assert.match(prompt, /Exit with code 0 exactly when every verdict is passed or not-applicable/);
  assert.match(prompt, /process.exitCode=1 when any verdict is failed or unknown/);
  assert.match(prompt, /Missing\/malformed reports, crashes, timeouts and unavailable evidence cannot stand in/);
  assert.equal(acceptanceAuthoringContextDigest(c), b.contextDigest);
  assert.deepEqual(validateAcceptanceBundle(b, c), b, 'Runtime explanation does not change contract or asset semantics');
  assert.throws(() => validateAcceptanceBundle({ ...b, passed: true }, c));
  const modified = context(); modified.candidate.files[0]!.content += 'changed'; assert.throws(() => acceptanceAuthoringSchema(modified), /source hash/);
  modified.candidate.files[0]!.sha256 = hash(modified.candidate.files[0]!.content); assert.throws(() => validateAcceptanceBundle(b, modified), /const/);
  let getterCalled = false;
  const unsafe = Object.defineProperty({ ...b }, 'sideEffect', { enumerable: true, get() { getterCalled = true; return 'passed'; } });
  assert.throws(() => validateAcceptanceBundle(unsafe, c), /Unsafe JSON/); assert.equal(getterCalled, false);
  const unsafeContext = Object.defineProperty({ ...c }, 'previousSpec', { enumerable: true, get() { getterCalled = true; return null; } });
  assert.throws(() => acceptanceAuthoringSchema(unsafeContext), /Unsafe JSON/); assert.equal(getterCalled, false);
});

test('P6-AUTH-U02 semantic checks reject weakened necessity coverage controls and copied candidate tests', () => {
  const stagedContext = context(), st = stages(stagedContext), stageInput = renderAuthorStageInput({acceptance: stagedContext, candidate: {}, binding: st.binding(0), parents: []});
  for (const version of [false, null, 0, 1, 5, 7]) assert.throws(() => parseAuthorStageInput({...stageInput,
    context: {...stageInput.context, authorPresentation: {schemaVersion: version, kind: 'acceptance-stage'}}}), /presentation/);
  assert.throws(() => parseAuthorStageInput({...stageInput, outputSchema: {type:'object'}}), /binding differs/);
  assert.throws(() => authorStageOutputSchema({...stagedContext, criteria: []}, st.binding(0), []));
  assert.throws(() => authorStageOutputSchema({...stagedContext, previousSpec: st.d.spec}, st.binding(0), []), /published history/);
  assert.throws(() => validateAuthorStageBinding({...st.binding(1), stage:'negative'}), /order/);
  assert.throws(() => validateAuthorStageBinding({...st.binding(1), parents: []}), /parents/);
  assert.throws(() => authorStageOutputSchema(stagedContext, {...st.binding(1), parents: st.binding(1).parents.map(p=>({...p,resultDigest:'0'.repeat(64)}))}, [st.d]), /digest/);
  for (const value of [
    {...st.d, negativeBases: []},
    {...st.d, negativeBases: [{controlId:'bad',positiveId:'bad'}]},
    {...st.d, coverageExplanation: st.d.coverageExplanation.slice(1)},
    {...st.d, verifierFiles: [{path:'../escape',content:'bad'}]},
  ]) assert.throws(() => parseAuthorStageOutput(value, stagedContext, st.binding(0), []));
  for (const value of [
    {...st.p, definitionDigest:'0'.repeat(64)}, {...st.p, controls: []}, {...st.p, controls:[st.b.controls[1]]},
    {...st.n, positiveDigest:'0'.repeat(64)}, {...st.n, controls: st.n.controls.map(c=>({...c,basePositiveDigest:'0'.repeat(64)}))},
  ]) assert.throws(() => assembleAuthorStages(stagedContext, st.d, 'positive'===value.stage?value:st.p, 'negative'===value.stage?value:st.n));
  const v2=stagesV2(stagedContext);
  for(const d of [
    {...v2.d,verifierPaths:[]},{...v2.d,verifierPaths:['../check.mjs']},
    {...v2.d,verifierPaths:['check.mjs','CHECK.mjs']},{...v2.d,verifierPaths:['check.mjs','check.mjs/helper.mjs']},
    {...v2.d,verifierPaths:['manifest.json']},{...v2.d,verifierFiles:st.d.verifierFiles},
    {...v2.d,coverageExplanation:[]},
  ])assert.throws(()=>stageProtocols.parseAuthorStageOutput(d,stagedContext,v2.binding(0),[]));
  for(const p of [
    {...v2.p,verifierFiles:[]},{...v2.p,verifierFiles:[...v2.p.verifierFiles,{path:'undeclared.mjs',content:'extra'}]},
    {...v2.p,verifierFiles:[...v2.p.verifierFiles,...v2.p.verifierFiles]},
    {...v2.p,spec:v2.d.spec},{...v2.p,negativeBases:[]},{...v2.p,definitionDigest:'0'.repeat(64)},
  ])assert.throws(()=>stageProtocols.parseAuthorStageOutput(p,stagedContext,v2.binding(1),[v2.d]));
  assert.throws(()=>stageProtocols.assembleAuthorStages(stagedContext,v2.d,v2.p,{...v2.n,verifierFiles:[]}));
  assert.throws(()=>stageProtocols.assembleAuthorStages(stagedContext,v2.d,{...v2.p,verifierFiles:[{path:'check.mjs',content:'changed'}]},v2.n));
  assert.throws(()=>stageProtocols.assembleAuthorStages(stagedContext,v2.d,st.p,v2.n));
  const newInput=stageProtocols.renderAuthorStageInput({acceptance:stagedContext,candidate:{},binding:v2.binding(0),parents:[]});
  for(const version of [false,null,0,6,7,9])assert.throws(()=>stageProtocols.parseAuthorStageInput({...newInput,context:{...newInput.context,authorPresentation:{schemaVersion:version,kind:'acceptance-stage'}}}));
  assert.throws(()=>stageProtocols.parseAuthorStageInput({...newInput,context:{...newInput.context,authorStage:st.binding(0)}}));
  assert.throws(()=>stageProtocols.parseAuthorStageInput({...stageInput,context:{...stageInput.context,authorStage:v2.binding(0)}}));
  // Candidate execution entries and TypeScript sources retain their original namespace.
  const candidateOnly=structuredClone(v2.d);
  const command=candidateOnly.spec.cases[0]!.verifier;
  if(command.kind==='command')command.candidateEntries=['math.mjs'];
  assert.deepEqual(stageProtocols.parseAuthorStageOutput(candidateOnly,stagedContext,v2.binding(0),[]),candidateOnly);
  const stageBase = st.p.controls[0]!;
  for (const change of [
    {operation:'replace',path:'absent.mjs',content:'x'}, {operation:'add',path:'math.mjs',content:'x'},
    {operation:'delete',path:'absent.mjs'}, {operation:'add',path:'__proto__/x',content:'x'},
    {operation:'add',path:'../escape',content:'x'}, {operation:'move',path:'math.mjs',content:'x'},
  ]) assert.throws(() => applyAuthorControlChanges(stageBase, [change] as never));
  assert.throws(() => applyAuthorControlChanges(stageBase, [{operation:'replace',path:'math.mjs',content:'x'},{operation:'delete',path:'math.mjs'}]), /overlapping/);
  const removed = {...st.n, controls: st.n.controls.map(c=>({...c,fileChanges:[{operation:'delete' as const,path:'math.mjs'}]}))};
  const rejected = expandAuthorStages(stagedContext, st.d, st.p, removed);
  assert.equal(rejected.controls[1]!.files.length, 0, 'Rejected expanded full proposal remains available for diagnosis');
  assert.throws(() => assembleAuthorStages(stagedContext, st.d, st.p, removed));
  assert.equal(st.n.controls[0]!.fileChanges[0]!.operation, 'replace', 'Negative raw fragment remains untouched');

  // Proposed-asset mechanism fixtures: necessity comes from the original criterion,
  // including a genuinely optional criterion; no model or P4 success is implied.
  for (const required of [true, false]) {
    const mapped = context();
    mapped.contract.criteria[0]!.required = required;
    const proposed = bundle(mapped);
    proposed.spec.obligations[0]!.required = required;
    assert.deepEqual(validateAcceptanceBundle(proposed, mapped), proposed);
    const mismatch = structuredClone(proposed);
    mismatch.spec.obligations[0]!.required = !required;
    assert.doesNotThrow(() => parseReasonerOutput(JSON.stringify(mismatch), acceptanceAuthoringSchema(mapped)));
    assert.throws(() => validateAcceptanceBundle(mismatch, mapped), /necessary obligation|necessity/);
    assert.equal(mapped.contract.criteria[0]!.required, required);
  }
  const c = context();
  const original=bundle(c),before=JSON.stringify(original);
  const base={jobId:'unit-base-only',jobDigest:'a'.repeat(64),inputDigest:'b'.repeat(64),resultDigest:authorPatchBinding({id:'unit-base-only',inputDigest:'b'.repeat(64),result:original} as never,original).resultDigest,bundleDigest:authorPatchBinding({id:'unit-base-only',inputDigest:'b'.repeat(64),result:original} as never,original).bundleDigest};
  const frozen=createAuthorPatchInput({acceptance:c,candidate:{frozen:true},authorFeedback:{schemaVersion:1,attempt:1,previousJobId:base.jobId,inputDigest:base.inputDigest,rejection:{schemaVersion:1,kind:'semantic',raw:original},references:{}},authorPatch:{schemaVersion:1,base}});
  const patch={protocol:'acceptance-replace-v1',baseJobId:base.jobId,baseResultDigest:base.resultDigest,replacements:[{path:'/spec/cases/0/verifier/files',replacementJSON:JSON.stringify(['check.mjs'])}]};
  assert.equal(frozen.prompt,AUTHOR_PATCH_PROMPT);assert.deepEqual(frozen.outputSchema,authorPatchSchema(base));
  assert.deepEqual(validateAcceptanceBundle(expandAuthorPatch(frozen,patch),c),original);
  assert.equal(JSON.stringify(original),before,'Replacement leaves the immutable original untouched');
  assert.ok(authorWireInput(frozen,'acceptance-authoring').prompt.includes(JSON.stringify(original.verifierFiles[0]!.content).slice(1,-1)));
  for(const path of ['', '/', '/contextDigest','/spec/no-such-field','/spec/cases/00/verifier','/spec/cases/-/verifier','/spec/cases/1','/__proto__/x','/spec/constructor','/spec/prototype','/bad~2escape'])assert.throws(()=>applyAuthorReplacements(original,[{path,replacementJSON:'null'}]));
  for(const pair of [['/spec','/spec/cases'],['/controls','/controls'],['/spec/cases/0','/spec/cases/0/verifier']])assert.throws(()=>applyAuthorReplacements(original,pair.map(path=>({path,replacementJSON:'[]'}))),/overlapping/);
  assert.throws(()=>applyAuthorReplacements(original,[{path:'/spec',replacementJSON:'{"__proto__":{}}'}]),/Unsafe/);
  assert.throws(()=>expandAuthorPatch(frozen,{...patch,baseResultDigest:'0'.repeat(64)}),/const/);
  assert.throws(()=>expandAuthorPatch(frozen,{...patch,replacements:[{path:'/spec/controls',replacementJSON:'[]'}]}));
  const weak=expandAuthorPatch(frozen,{...patch,replacements:[{path:'/spec/obligations/0/required',replacementJSON:'false'}]});
  assert.throws(()=>validateAcceptanceBundle(weak,c),/necessary obligation|necessity/);
  const expanded=expandAuthorPatch(frozen,{...patch,replacements:[{path:'/verifierFiles',replacementJSON:JSON.stringify([...original.verifierFiles,{path:'helper.mjs',content:'export const shared=1;'}])},{path:'/spec/cases/0/verifier/files',replacementJSON:JSON.stringify(['check.mjs','helper.mjs'])}]});
  assert.deepEqual(validateAcceptanceBundle(expanded,c),expanded,'Whole parent array replacement supports complete shared checker assets');
  for(const version of [null,false,0,4,6])assert.throws(()=>patchInput({...frozen,context:{...(frozen.context as object),authorPresentation:{schemaVersion:version,kind:'acceptance-patch'}}}),/protocol/);
  assert.throws(()=>patchInput({...frozen,context:{...(frozen.context as object),acceptance:{...c,criteria:[]}}}),/ordinary command/);
  const shared=bundle(c);
  shared.spec.obligations.push({...shared.spec.obligations[0]!,id:'sum.exceptions',expectation:'Invalid operands rejected independently'});
  shared.spec.cases[0]!.obligationIds.push('sum.exceptions');
  shared.spec.controls[1]!.mustFail.push('sum.exceptions');
  assert.deepEqual(validateAcceptanceBundle(shared,c),shared,'Shared command checker may independently report all scoped obligations');
  for(const field of ['mustFail','obligationIds'] as const){
    const invalid=structuredClone(shared);
    if(field==='mustFail')invalid.spec.controls[1]!.mustFail=[invalid.spec.cases[0]!.id];
    else invalid.spec.cases[0]!.obligationIds=[invalid.spec.cases[0]!.id];
    assert.doesNotThrow(()=>parseReasonerOutput(JSON.stringify(invalid),acceptanceAuthoringSchema(c)));
    assert.throws(()=>validateAcceptanceBundle(invalid,c),/unknown (control )?obligation/,'Case IDs are never implicit obligation aliases');
  }
  const mutations: ((b: AcceptanceBundle) => void)[] = [
    b => { b.spec.obligations[0]!.required = false; }, b => { b.spec.obligations[0]!.applicable = false; },
    b => { b.coverageExplanation.pop(); }, b => { b.coverageExplanation[0]!.caseIds = ['invented']; },
    b => { b.spec.controls[1]!.mustFail = []; }, b => { b.controls[1]!.files = [{ path: 'irrelevant.mjs', content: 'wrong' }]; },
    b => { b.verifierFiles[0]!.content = c.candidate.files[0]!.content; }, b => { b.spec.controls[1]!.workspace = '/escape'; },
    b => { b.controls.push(structuredClone(b.controls[0]!)); }, b => { b.coverageExplanation[0]!.caseIds.push('sum-check'); },
  ];
  for (const mutate of mutations) { const b = bundle(c); mutate(b); assert.throws(() => validateAcceptanceBundle(b, c)); }
});

test('P6-AUTH-U03 preserves native HTML and source acceptance and rejects command downgrade', () => {
  for (const kind of ['ui', 'source'] as const) {
    const c = context(), item = c.criteria[0]!; item.kind = kind;
    item.target = kind === 'ui' ? 'index.html' : 'https://nodejs.org/api/assert.html';
    const claimFile = 'research/claim.txt', localFile = kind === 'ui' ? item.target : claimFile;
    c.candidate.files[0]!.path = localFile;
    if (kind === 'source') {
      item.description = 'Explain the strict assertion API using the official Node.js documentation';
      item.checks = ['Claim is supported by the exact official source', 'Supporting excerpt and current provenance are independently verified'];
      c.candidate.files[0]!.content = 'Node.js provides strict assertion functions for testing invariants.\n';
      c.candidate.files[0]!.sha256 = hash(c.candidate.files[0]!.content);
    }
    c.contract.criteria[0]!.description = [item.description, `Acceptance kind: ${kind}; target: ${item.target}`, ...item.checks].join('\n');
    const originalContract = structuredClone(c.contract);
    assert.doesNotThrow(() => acceptanceAuthoringSchema(c));
    assert.throws(() => authorStageOutputSchema(c, stages().binding(0), []), /command-only/);
    const b = bundle(c); for (const control of b.controls) control.files[0]!.path = localFile;
    assert.throws(() => validateAcceptanceBundle(b, c), /kind/);
    b.verifierFiles = []; b.spec.cases[0]!.verifier = kind === 'ui'
      ? { kind, version: 'ui-v1', entry: item.target, steps: [{ kind: 'assertText', selector: '#sum', text: '5' }], expectations: item.checks, timeoutMs: 1000 }
      : { kind, version: 'source-v1', claimFile, sources: [{ id: 'primary', url: item.target, excerpt: 'assert', maxAgeMs: 1000 }], timeoutMs: 1000 };
    assert.doesNotThrow(() => validateAcceptanceBundle(b, c));
    assert.deepEqual(c.contract, originalContract, 'HTTPS target authority is never rewritten to a local file');
    const verifier = b.spec.cases[0]!.verifier;
    if (verifier.kind === 'ui') { verifier.entry = 'other.html'; assert.throws(() => validateAcceptanceBundle(b, c), /target/); }
    else if (verifier.kind === 'source') {
      const prompt = buildAcceptanceAuthoringPrompt(c); assert.match(prompt, /exact HTTPS sourceURL/); assert.match(prompt, /separate project-relative claimFile/);
      verifier.sources[0]!.url = 'https://nodejs.org/api/other.html'; assert.throws(() => validateAcceptanceBundle(b, c), /authoritative HTTPS target/);
      verifier.sources[0]!.url = item.target; verifier.claimFile = 'missing-claim.txt'; assert.throws(() => validateAcceptanceBundle(b, c), /missing frozen candidate input/);
      verifier.claimFile = claimFile; b.controls[0]!.files[0]!.path = 'other-claim.txt'; assert.throws(() => validateAcceptanceBundle(b, c), /required verifier input/);
      b.controls[0]!.files[0]!.path = claimFile;
      const weakened = structuredClone(b); weakened.spec.obligations[0]!.required = false; assert.throws(() => validateAcceptanceBundle(weakened, c), /necessary obligation/);
      const downgrade = structuredClone(b); downgrade.verifierFiles = bundle(c).verifierFiles; downgrade.spec.cases[0]!.verifier = bundle(c).spec.cases[0]!.verifier; assert.throws(() => validateAcceptanceBundle(downgrade, c), /kind/);
      for (const target of ['claim.txt', 'http://nodejs.org/api/assert.html', 'https://user:secret@nodejs.org/api/assert.html']) {
        const invalid = structuredClone(c); invalid.criteria[0]!.target = target;
        invalid.contract.criteria[0]!.description = [item.description, `Acceptance kind: source; target: ${target}`, ...item.checks].join('\n');
        assert.throws(() => acceptanceAuthoringSchema(invalid), /HTTPS/);
      }
    }
  }
});

test('P6-AUTH-U04 rejects escaping conflicting oversized unreferenced and unauthorized asset types', () => {
  for (const path of ['../escape', '/escape', 'a/../escape', 'a\\escape', '.git/config', 'node_modules/pkg.js', 'spec.json', 'controls/good/x', 'check.mjs?x']) {
    const b = bundle(); b.verifierFiles[0]!.path = path; assert.throws(() => validateAcceptanceBundle(b, context()));
  }
  const b = bundle(); b.verifierFiles.push({ path: 'unreferenced', content: 'junk' }); assert.throws(() => validateAcceptanceBundle(b, context()), /Unreferenced/);
  b.verifierFiles[1]!.path = 'check.mjs/child'; assert.throws(() => validateAcceptanceBundle(b, context()), /conflicting/);
  b.verifierFiles.pop(); b.verifierFiles[0]!.content = 'x'.repeat(128 * 1024 + 1); assert.throws(() => validateAcceptanceBundle(b, context()));
  const tooMany = bundle(); tooMany.controls[0]!.files.push(...Array.from({ length: 126 }, (_, i) => ({ path: `input-${i}.txt`, content: 'control text' }))); assert.throws(() => validateAcceptanceBundle(tooMany, context()), /file or byte limits/);
  const oversized = bundle(); oversized.verifierFiles = Array.from({ length: 7 }, (_, i) => ({ path: `checker-${i}.mjs`, content: 'x'.repeat(120_000) })); assert.throws(() => validateAcceptanceBundle(oversized, context()), /file or byte limits/);
  const unauthorized = bundle(); (unauthorized.spec.cases[0]!.verifier as unknown as Record<string, unknown>).kind = 'shell'; assert.throws(() => validateAcceptanceBundle(unauthorized, context()));
});

test('P6-AUTH-U05 materializes immutable proposed P4 spec idempotently and detects edits extra paths and symlinks', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'supervisor-author-'))); const privateRoot = join(temporary, 'private');
  try {
    const options = { privateRoot, jobId: 'author-1', context: context(), bundle: bundle() };
    const [first, second] = await Promise.all([materializeAcceptanceBundle(options), materializeAcceptanceBundle(options)]);
    assert.deepEqual(first, second); assert.equal(first.status, 'proposed');
    const spec = parseVerificationSpec(JSON.parse(await readFile(first.specPath, 'utf8')));
    assert.equal(spec.controls[0]!.workspace, join(first.directory, 'controls', 'good'));
    assert.equal((JSON.parse(await readFile(join(first.directory, 'manifest.json'), 'utf8')) as { status: string }).status, 'proposed');
    await writeFile(join(first.directory, 'check.mjs'), 'tampered'); await assert.rejects(materializeAcceptanceBundle(options), /tampered/);
    await writeFile(join(first.directory, 'check.mjs'), options.bundle.verifierFiles[0]!.content);
    await mkdir(join(first.directory, 'extra-empty-directory')); await assert.rejects(materializeAcceptanceBundle(options), /tampered/); await rm(join(first.directory, 'extra-empty-directory'), { recursive: true });
    await rm(join(first.directory, 'check.mjs')); await symlink(join(first.directory, 'spec.json'), join(first.directory, 'check.mjs')); await assert.rejects(materializeAcceptanceBundle(options), /symlink/);
    const linkedRoot = join(temporary, 'linked'); await symlink(privateRoot, linkedRoot); await assert.rejects(materializeAcceptanceBundle({ ...options, privateRoot: linkedRoot, jobId: 'new-job' }), /symlink/);
    await assert.rejects(materializeAcceptanceBundle({ ...options, privateRoot: '/private/candidate/assets' }), /outside/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('P6-AUTH-U06 retains published controls and historical revisions and rejects reused changed definitions', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'supervisor-author-history-')));
  try {
    const c = context(), b = bundle(c); const first = await materializeAcceptanceBundle({ privateRoot: temporary, jobId: 'first', context: c, bundle: b });
    c.previousSpec = first.spec;
    const next = bundle(c); next.spec.controls = structuredClone(first.spec.controls); next.controls = []; next.spec.standardsVersion = 'author-v2';
    assert.doesNotThrow(() => validateAcceptanceBundle(next, c));
    next.spec.cases[0]!.defectRefs.push('invented-change'); assert.throws(() => validateAcceptanceBundle(next, c), /revision/);
    next.spec.cases = structuredClone(first.spec.cases); next.spec.controls[0]!.workspace = 'good'; assert.throws(() => validateAcceptanceBundle(next, c), /Published control/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});


test('P6-AUTH-U07 retains P4 TypeScript build semantics and actual CLI input declarations', () => {
  const c = context();
  const source = 'export const sum = (a: number, b: number): number => a+b;\n';
  c.candidate.files.push({ path: 'src/math.ts', content: source, sha256: hash(source) }, { path: 'build/math.js', content: 'exports.sum = (a,b) => a+b;\n', sha256: hash('exports.sum = (a,b) => a+b;\n') });
  const b = bundle(c), verifier = b.spec.cases[0]!.verifier;
  assert.equal(verifier.kind, 'command'); if (verifier.kind !== 'command') throw Error('fixture');
  verifier.build = { kind: 'typescript', sources: ['src/math.ts'], rootDir: 'src', outputDir: 'build', timeoutMs: 1000 };
  verifier.candidateEntries = ['math.mjs'];
  for (const control of b.controls) control.files.push({ path: 'build/math.js', content: 'exports.sum = (a,b) => a+b;\n' }, { path: 'src/math.ts', content: source });
  assert.doesNotThrow(() => validateAcceptanceBundle(b, c));
  verifier.candidateEntries = ['missing.mjs']; assert.throws(() => validateAcceptanceBundle(b, c), /missing frozen candidate input/);
  verifier.candidateEntries = ['math.mjs']; b.controls[0]!.files.pop(); assert.throws(() => validateAcceptanceBundle(b, c), /required verifier input/);
});


test('P6-AUTH-U08 historical case schema is typed and preserves exact parameters order shape and verifier without provider claims', () => {
  const c = context(), historical = structuredClone(bundle(c).spec.cases[0]!);
  delete historical.status;
  historical.parameters = [{ input: '2', label: 'first' }, { input: '3', label: 'second' }];
  const cases = Array.from({ length: 40 }, (_, index) => ({ ...structuredClone(historical), id: `published-${index}` }));
  const schema = currentAcceptanceAssetSchema(c, cases);
  type Node = Record<string, unknown>;
  const item = ((schema.properties as Node).spec as Node).properties as Node;
  const caseSchema = (item.cases as Node).items as Node;
  function checkTyped(node: Node): void {
    assert.ok(typeof node.type === 'string' || Array.isArray(node.anyOf), 'Every historical literal declares its type; composition nodes contain typed branches');
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      const properties = node.properties as Record<string, Node>;
      assert.deepEqual(node.required, Object.keys(properties));
      Object.values(properties).forEach(checkTyped);
    }
    if (node.type === 'array') checkTyped(node.items as Node);
    if (Array.isArray(node.anyOf)) { assert.ok(node.anyOf.length <= 32); (node.anyOf as Node[]).forEach(checkTyped); }
  }
  const historyBranch = (caseSchema.anyOf as Node[])[1]!;
  checkTyped(historyBranch);
  for (const published of cases) assert.deepEqual(parseReasonerOutput(JSON.stringify(published), historyBranch), published);
  const mutations: ((value: typeof historical) => void)[] = [
    value => { value.parameters[0]!.input = '99'; },
    value => { value.parameters.reverse(); },
    value => { value.parameters.push({ input: '2', label: 'first' }); },
    value => { value.parameters[0]!.unexpected = 'addition'; },
    value => { delete value.parameters[0]!.label; },
    value => { value.status = 'active'; },
    value => { value.verifier.timeoutMs = 2000; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(cases[0]!); mutate(changed);
    assert.throws(() => parseReasonerOutput(JSON.stringify(changed), caseSchema));
  }
  const next = bundle(c); next.spec.cases = [structuredClone(cases[0]!)];
  assert.doesNotThrow(() => parseReasonerOutput(JSON.stringify(next), schema));
  c.previousSpec = { ...structuredClone(bundle(c).spec), cases };
  for (const control of c.previousSpec.controls) control.workspace = `/private/published/${control.id}`;
  const legacySchema = acceptanceAuthoringSchema(c);
  const legacyCase = (((legacySchema.properties as Node).spec as Node).properties as Node).cases as Node;
  assert.doesNotThrow(() => parseReasonerOutput(JSON.stringify(cases[0]), legacyCase.items as Node));
  let getterCalled = false;
  const unsafe = Object.defineProperty({}, 'id', { enumerable: true, get() { getterCalled = true; return 'published'; } });
  assert.throws(() => currentAcceptanceAssetSchema(context(), [unsafe as typeof historical]), /Unsafe JSON/);
  assert.equal(getterCalled, false);
});
