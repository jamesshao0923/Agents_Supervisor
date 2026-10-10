import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {runtimeCanonical} from '../../packages/persistence/runtime.js';
import {acceptanceAuthoringContextDigest,acceptanceAuthoringSchema,buildAcceptanceAuthoringPrompt,diagnoseAcceptanceAuthoringResult,type AcceptanceAuthoringContext,type AcceptanceBundle} from '../../packages/orchestration/acceptance-authoring.js';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
// Actual SQLite/domain and parser modules. Model-start/usage metadata below is
// explicitly ledger fixture data; no transport, model approval or live pass.
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


function fixture(options:{limit?:number;calls?:number;capacity?:number}={}){
  const root=mkdtempSync('/tmp/sv-author-recovery-'),workspace=join(root,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'math.mjs'),context().candidate.files[0]!.content);
  let store=new SupervisorStore(join(root,'data'));
  const runtime=store.runtime.submit({type:'submit',commandId:'workflow',workspace,workspaceKind:'project',goal:'Compute sum',tokenLimit:options.limit??100,verificationReserve:20,steps:[{id:'input',kind:'input',prompt:'Fixture input'}]});
  const c=context();store.runtime.revise({commandId:'revise',runtimeId:runtime.id,expectedContractVersion:1,contract:c.contract,nodes:[{id:'input',required:true,dependencies:[]}],steps:[{id:'input',kind:'input',prompt:'Fixture input'}],reason:'Actual domain fixture, no model implementation claim'});
  store.runtime.control({type:'input',commandId:'input',runtimeId:runtime.id,stepId:'input',text:'Ready'});const op=store.runtime.claim(runtime.id,'fixture')!;store.runtime.report(op.id,'fixture',{messageId:'report',outcome:'confirmed',result:'Ready'});
  const config={model:'ledger-fixture-not-model',effort:'low',reservation:30,timeoutMs:1000};
  const input={prompt:buildAcceptanceAuthoringPrompt(c),outputSchema:acceptanceAuthoringSchema(c),context:{acceptance:c,candidate:{fixture:'Frozen candidate ownership is independently checked by controller'}}};
  const loop=store.supervision.attach({commandId:'attach',runtimeId:runtime.id,config,limits:{maxRepairs:1,maxReasoningCalls:options.calls??3,maxDurationMs:60000,maxContextChars:options.capacity===1?runtimeCanonical(input).length+6100:200000}});
  const bad=bundle(c);bad.spec.obligations[0]!.id='sum-undeclared';
  const job=store.supervision.beginJob({commandId:'old',loopId:loop.id,expectedRevision:loop.revision,purpose:'acceptance-authoring',context:input});
  function finish(id:string,result:unknown,usage=7){const proof=join(root,id+'.json'),text=JSON.stringify(result);writeFileSync(proof,text);store.supervision.observeJob(id,{modelStarted:true,observedUsage:usage});return store.supervision.finishJob(id,{result,usage,stopConfirmed:true,error:null,proofs:{[proof]:hash(text)},threadId:null});}
  const old=finish(job.id,bad),current=store.supervision.get(loop.id);store.supervision.update(loop.id,current.revision,{phase:'authoring',references:{authorJobId:old.id}});
  const diagnostic=diagnoseAcceptanceAuthoringResult(bad,c)!;assert.match(diagnostic.message,/unknown obligation/);
  function request(commandId='regenerate'){return {commandId,loopId:loop.id,expectedRevision:store.supervision.get(loop.id).revision,previousJobId:old.id,diagnostic};}
  return {root,runtime,loop,c,bad,old,input,finish,request,get store(){return store;},reopen(){store.close();store=new SupervisorStore(join(root,'data'));},close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
test('P6-AUTHREC-I01 malformed obligation fails schema without decoding repair or fabricated authority',()=>{
 const c=context(),bad=bundle(c);bad.spec.obligations[0]!.id='sum-ok},{';bad.spec.cases[0]!.obligationIds=['sum-ok','sum-finite','sum-types','sum-mutation','sum-scope'];
 assert.throws(()=>diagnoseAcceptanceAuthoringResult(bad,c),/pattern|schema/i);
 assert.equal(bad.spec.obligations.length,1);assert.equal(bad.spec.obligations[0]!.id,'sum-ok},{');
 assert.equal(diagnoseAcceptanceAuthoringResult(bundle(),context()),null);
 assert.throws(()=>diagnoseAcceptanceAuthoringResult({...bundle(),passed:true},context()),/Unexpected|additional|schema|field/i);
 assert.match(buildAcceptanceAuthoringPrompt(context()),/Never pack multiple IDs/);
});
test('P6-AUTHREC-I02 one atomic replacement preserves frozen inputs raw failed result and fees across restart and second invalid output rejects',()=>{
 const f=fixture();try{
  const request=f.request(),next=f.store.supervision.beginAuthorRegeneration(request);
  assert.equal(f.store.supervision.jobs(f.loop.id).length,2);assert.deepEqual(f.store.supervision.job(f.old.id),f.old);
  const frozen=next.input as typeof f.input & {context:{authorFeedback:{result:unknown;diagnostic:string}}};
  assert.deepEqual(frozen.outputSchema,f.input.outputSchema);assert.deepEqual(frozen.context.acceptance,f.input.context.acceptance);assert.deepEqual(frozen.context.candidate,f.input.context.candidate);assert.deepEqual(frozen.context.authorFeedback.result,f.bad);
  assert.match(frozen.prompt,/All prior fees remain charged/);assert.equal(next.config.reservation,30);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,7);
  f.reopen();assert.deepEqual(f.store.supervision.beginAuthorRegeneration(request),next);
  assert.throws(()=>f.store.supervision.beginAuthorRegeneration({...request,diagnostic:{...request.diagnostic,message:'different'}}),/Conflicting/);
  const second=f.finish(next.id,f.bad,8),current=f.store.supervision.get(f.loop.id),before=f.store.runtime.inspect(f.runtime.id);
  assert.throws(()=>f.store.supervision.beginAuthorRegeneration({commandId:'third',loopId:f.loop.id,expectedRevision:current.revision,previousJobId:second.id,diagnostic:f.request().diagnostic}),/regeneration limit/);
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.equal(before.run.budget.spent,15);assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,2);assert.equal(f.store.supervision.jobs(f.loop.id).length,2);assert.deepEqual(f.store.supervision.job(f.old.id),f.old);
 }finally{f.close();}
});
test('P6-AUTHREC-I03 diagnostic result CAS pause limits capacity and parent rollback never create an unaccounted retry',()=>{
 for(const options of [{},{calls:1},{limit:50},{capacity:1}]){
 const f=fixture(options);try{
  const before=f.store.runtime.inspect(f.runtime.id),loop=f.store.supervision.get(f.loop.id);
  if(Object.keys(options).length){assert.throws(()=>f.store.supervision.beginAuthorRegeneration(f.request()),/limit|budget|capacity/);}
  else {
   assert.throws(()=>f.store.supervision.beginAuthorRegeneration({...f.request(),diagnostic:{...f.request().diagnostic,resultDigest:'0'.repeat(64)}}),/actual result/);
   assert.throws(()=>f.store.supervision.transaction(()=>{f.store.supervision.beginAuthorRegeneration(f.request());throw Error('parent rollback');}),/parent rollback/);
   assert.deepEqual(f.store.supervision.get(f.loop.id),loop);
   f.store.supervision.update(f.loop.id,loop.revision,{paused:true});assert.throws(()=>f.store.supervision.beginAuthorRegeneration(f.request()),/disabled/);
  }
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.deepEqual(f.store.supervision.job(f.old.id),f.old);assert.equal(f.store.supervision.jobs(f.loop.id).length,1);
 }finally{f.close();}}
});

test('P6-AUTHREC-I04 unresolved usage and changed current contract reject regeneration without erasing retained author cost',()=>{
 for(const mode of ['unknown','contract','stopped'] as const){const f=fixture();try{
  if(mode==='unknown'){
   const loop=f.store.supervision.get(f.loop.id),job=f.store.supervision.beginJob({commandId:'unknown',loopId:loop.id,expectedRevision:loop.revision,purpose:'diagnosis',context:{explicit:'Accounting fixture, never model output'}});
   f.store.supervision.observeJob(job.id,{modelStarted:true,observedUsage:3});f.store.supervision.finishJob(job.id,{usage:null,stopConfirmed:true,error:'Unknown cost fixture',proofs:{},threadId:null,result:null});
  }else if(mode==='contract'){
   const current=f.store.runtime.inspect(f.runtime.id);f.store.runtime.revise({commandId:'changed',runtimeId:f.runtime.id,expectedContractVersion:current.run.contract.version,contract:{...current.run.contract,version:current.run.contract.version+1},nodes:[{id:'input',required:true,dependencies:[]}],steps:[{id:'input',kind:'input',prompt:'Changed contract fixture'}],reason:'Actual version boundary fixture'});
  }else {const loop=f.store.supervision.get(f.loop.id);f.store.supervision.update(loop.id,loop.revision,{stopped:true});}
  const before=f.store.runtime.inspect(f.runtime.id),jobs=f.store.supervision.jobs(f.loop.id),loop=f.store.supervision.get(f.loop.id);
  assert.throws(()=>f.store.supervision.beginAuthorRegeneration(f.request()),/Unresolved|contract changed|disabled/);
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.deepEqual(f.store.supervision.jobs(f.loop.id),jobs);assert.deepEqual(f.store.supervision.get(f.loop.id),loop);assert.equal(before.run.budget.spent,7);assert.deepEqual(f.store.supervision.job(f.old.id),f.old);
 }finally{f.close();}}
});
