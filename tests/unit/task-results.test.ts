import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseResultAction,parseTaskResultManifest,safeResultJSON} from '../../packages/contracts/p7-results.js';
import type {DependencyBinding,ResultAction,ResultLedger,ResultProducer,ResultRef,ResultVerification,TaskResultManifest} from '../../packages/contracts/p7-results.js';
import {createTaskResultDomain} from '../../packages/domain/task-results.js';
const {affectedConsumers,applyResultAction,createResultLedger,resolveDependencies,resultDigest}=createTaskResultDomain({sha256:canonicalJSON=>createHash('sha256').update(canonicalJSON).digest('hex')});
const hash='a'.repeat(64);
function manifest(taskId='A',generation=1,inputs:DependencyBinding[]=[]):TaskResultManifest {return {schemaVersion:1,projectId:'project',runId:'run',taskId,attemptId:`${taskId}-${generation}`,contractVersion:1,contractDigest:hash,planRevision:1,generation,inputs,artifacts:[{relativePath:`${taskId}.txt`,digest:hash,size:3}],conclusion:'A value, not verification authority',sources:[],checks:[],limitations:[],unresolved:[]};}
function producer(m:TaskResultManifest):ResultProducer {const {projectId,runId,taskId,attemptId,contractVersion,contractDigest,planRevision,generation}=m;return {projectId,runId,taskId,attemptId,contractVersion,contractDigest,planRevision,generation};}
function fixture(){let ledger=createResultLedger();let command=0;
 const act=(a:Record<string,unknown>)=>{const full={commandId:`cmd-${++command}`,expectedRevision:ledger.revision,...a} as ResultAction;const result=applyResultAction(ledger,full);ledger=result.ledger;return {full,result};};
 const draft=(m:TaskResultManifest)=>{act({type:'stageDraft',currentProducer:producer(m),expectedHead:ledger.heads.find(h=>h.taskId===m.taskId)?.ref??null,manifest:m});return ledger.versions.at(-1)!.ref;};
 const submit=(ref:ResultRef,m:TaskResultManifest)=>act({type:'submit',currentProducer:producer(m),expectedHead:ledger.heads.find(h=>h.taskId===m.taskId)?.ref??null,ref,publication:{complete:true,artifacts:m.artifacts}});
 const publish=(m:TaskResultManifest)=>{const ref=draft(m);submit(ref,m);return ref;};
 return {get ledger(){return ledger;},act,draft,submit,publish};
}
function dependency(ref:ResultRef,minimumState:'submitted'|'verified'='submitted'):DependencyBinding {return {dependencyNodeId:ref.taskId,result:ref,minimumState};}
function proof(ref:ResultRef,m:TaskResultManifest):ResultVerification {return {scope:m.taskId,manifestDigest:ref.manifestDigest,candidateDigest:resultDigest(m.artifacts),contractVersion:m.contractVersion,contractDigest:m.contractDigest,frozenPlanId:'frozen-independent-plan',proofDigest:hash,stopConfirmed:true,usageKnown:true,checks:[{evidenceId:'necessary-proof',required:true,verdict:'passed'}]};}

test('P7-RESULT-U01 strict safe data rejects authority extras unsafe paths duplicate identities and executable JSON',()=>{
 const m=manifest();assert.deepEqual(parseTaskResultManifest(m),m);
 assert.throws(()=>parseTaskResultManifest({...m,passed:true}),/fields/);
 for(const relativePath of ['../out','/out','a/../out','a\\out','C:/out','a//out','a/./out'])assert.throws(()=>parseTaskResultManifest({...m,artifacts:[{...m.artifacts[0]!,relativePath}]}),/path/);
 assert.throws(()=>parseTaskResultManifest({...m,artifacts:[m.artifacts[0],m.artifacts[0]]}),/duplicate/);
 assert.throws(()=>parseTaskResultManifest({...m,artifacts:[{...m.artifacts[0],size:NaN}]}),/JSON/);
 let accessed=false;const bad=Object.defineProperty({},'secret',{enumerable:true,get(){accessed=true;return true;}});assert.throws(()=>safeResultJSON(bad),/field/);assert.equal(accessed,false);
 assert.throws(()=>safeResultJSON(JSON.parse('{"__proto__":{}}')),/field/);assert.throws(()=>safeResultJSON(new Array(1)),/sparse/);
 assert.throws(()=>parseResultAction({type:'stageDraft',commandId:'x',expectedRevision:0,currentProducer:producer(m),expectedHead:null,manifest:m,authorized:true}),/fields/);
});
test('P7-RESULT-U02 draft never releases dependencies and original manifest stays immutable',()=>{
 const f=fixture(),m=manifest(),ref=f.draft(m);m.conclusion='mutated executor value';
 assert.equal(f.ledger.versions[0]!.manifest.conclusion,'A value, not verification authority');assert.equal(f.ledger.heads.length,0);
 assert.equal(resolveDependencies(f.ledger,[dependency(ref)]).ready,false);
 assert.throws(()=>{f.ledger.versions[0]!.manifest.conclusion='mutated ledger';},TypeError);
});
test('P7-RESULT-U03 submitted and verified minimum states require exact known necessary proof',()=>{
 const f=fixture(),m=manifest(),ref=f.publish(m);assert.equal(resolveDependencies(f.ledger,[dependency(ref)]).ready,true);assert.equal(resolveDependencies(f.ledger,[dependency(ref,'verified')]).ready,false);
 const p=proof(ref,m);
 for(const bad of [{...p,usageKnown:false},{...p,stopConfirmed:false},{...p,checks:[]},{...p,checks:[{evidenceId:'p',required:true,verdict:'failed'}]},{...p,checks:[{evidenceId:'p',required:true,verdict:'unknown'}]}])assert.throws(()=>f.act({type:'recordVerification',ref,verification:bad}),/proof not known passed/);
 const dependent=manifest('B',1,[dependency(ref)]),b=f.publish(dependent);const before=f.ledger.versions.find(v=>v.ref.taskId==='B')!;
 f.act({type:'recordVerification',ref,verification:p});assert.equal(resolveDependencies(f.ledger,[dependency(ref,'verified')]).ready,true);assert.deepEqual(f.ledger.versions.find(v=>v.ref.taskId==='B'),before);assert.equal(resolveDependencies(f.ledger,[dependency(b)]).ready,true);
});
test('P7-RESULT-U04 exact ref digest and historical input cannot float to latest head',()=>{
 const f=fixture(),a=f.publish(manifest());assert.equal(resolveDependencies(f.ledger,[dependency({...a,manifestDigest:'b'.repeat(64)})]).ready,false);
 const next=f.publish(manifest('A',2));assert.equal(next.version,2);assert.equal(resolveDependencies(f.ledger,[dependency(a)]).ready,false);assert.equal(resolveDependencies(f.ledger,[dependency(next)]).ready,true);
 assert.equal(f.ledger.versions[0]!.state,'invalidated');
});
test('P7-RESULT-U05 partial or mismatched publication cannot move head or mutate ledger',()=>{
 const f=fixture(),m=manifest(),ref=f.draft(m),before=f.ledger;
 for(const publication of [{complete:false,artifacts:m.artifacts},{complete:true,artifacts:[]},{complete:true,artifacts:[{...m.artifacts[0]!,digest:'b'.repeat(64)}]}])assert.throws(()=>f.act({type:'submit',ref,currentProducer:producer(m),expectedHead:null,publication}),/incomplete/);
 assert.deepEqual(f.ledger,before);assert.equal(f.ledger.heads.length,0);
});
test('P7-RESULT-U06 identical command returns original receipt despite later revisions and conflict CAS reject',()=>{
 const f=fixture(),m=manifest(),ref=f.draft(m);const first=f.submit(ref,m);f.publish(manifest('B'));
 const repeated=applyResultAction(f.ledger,first.full);assert.deepEqual(repeated.ledger,f.ledger);assert.deepEqual(repeated.events,first.result.events);
 assert.throws(()=>applyResultAction(f.ledger,{...first.full,expectedRevision:f.ledger.revision}),/command conflict/);
 assert.throws(()=>applyResultAction(f.ledger,{type:'invalidate',commandId:'fresh',expectedRevision:0,ref,reason:'old revision'}),/revision CAS/);
 const n=manifest('A',2);assert.throws(()=>f.act({type:'stageDraft',currentProducer:producer(n),expectedHead:null,manifest:n}),/head CAS/);
});
test('P7-RESULT-U07 late generation draft cannot submit after newer producer and wrong scope rejects',()=>{
 const f=fixture(),old=manifest(),ref=f.draft(old),newer=manifest('A',2);f.draft(newer);
 assert.throws(()=>f.submit(ref,old),/late producer/);
 assert.throws(()=>f.draft({...manifest('A',1),attemptId:'other-old'}),/late producer/);
 assert.throws(()=>f.draft({...manifest('B'),projectId:'foreign'}),/foreign ledger/);
 assert.throws(()=>f.act({type:'stageDraft',manifest:manifest('C'),currentProducer:{...producer(manifest('C')),generation:2},expectedHead:null}),/producer generation/);
});
test('P7-RESULT-U08 head advancement transitively invalidates derived versions and in-flight consumers',()=>{
 const f=fixture(),a=f.publish(manifest()),b=f.publish(manifest('B',1,[dependency(a)])),c=f.publish(manifest('C',1,[dependency(b)]));
 f.act({type:'bindConsumer',consumer:{attemptId:'D-active',taskId:'D',inputs:[dependency(c)]}});
 assert.deepEqual(affectedConsumers(f.ledger,a),['B-1','C-1','D-active']);const prior=f.ledger;f.publish(manifest('A',2));
 assert.deepEqual(prior.versions.map(v=>v.state),['submitted','submitted','submitted']);assert.equal(f.ledger.consumers[0]!.invalidated,true);
 for(const r of [a,b,c])assert.equal(f.ledger.versions.find(v=>v.ref.taskId===r.taskId&&v.ref.version===r.version)!.state,'invalidated');
 assert.equal(f.ledger.versions.find(v=>v.ref.taskId==='C')!.invalidation!.upstream!.manifestDigest,a.manifestDigest);
 assert.equal(f.ledger.events.filter(e=>e.type==='consumer-invalidated').length,1);
});
test('P7-RESULT-U09 unaffected branches stay ready and fresh attempts can consume replacement version',()=>{
 const f=fixture(),a=f.publish(manifest()),unrelated=f.publish(manifest('X'));
 f.act({type:'bindConsumer',consumer:{attemptId:'Y-active',taskId:'Y',inputs:[dependency(unrelated)]}});const next=f.publish(manifest('A',2));
 assert.equal(resolveDependencies(f.ledger,[dependency(unrelated)]).ready,true);assert.equal(f.ledger.consumers[0]!.invalidated,false);
 const b=f.publish(manifest('B',1,[dependency(next)]));assert.equal(resolveDependencies(f.ledger,[dependency(b)]).ready,true);assert.equal(resolveDependencies(f.ledger,[dependency(a)]).ready,false);
});
test('P7-RESULT-U10 invalidated results cannot revive or verify and historical proof is retained',()=>{
 const f=fixture(),m=manifest(),ref=f.publish(m),p=proof(ref,m);f.act({type:'recordVerification',ref,verification:p});f.act({type:'invalidate',ref,reason:'actual upstream failure'});
 assert.deepEqual(f.ledger.versions[0]!.verification,p);assert.throws(()=>f.act({type:'recordVerification',ref,verification:p}),/current submitted/);assert.throws(()=>f.submit(ref,m),/requires draft/);
 const next=f.publish(manifest('A',2));assert.equal(next.version,2);assert.equal(f.ledger.versions[0]!.state,'invalidated');
});
test('P7-RESULT-U11 frozen consumer inputs and proof scope candidate contract bindings cannot be substituted',()=>{
 const f=fixture(),m=manifest(),a=f.publish(m),x=f.publish(manifest('X'));
 f.act({type:'bindConsumer',consumer:{attemptId:'B-1',taskId:'B',inputs:[dependency(a)]}});
 assert.throws(()=>f.draft(manifest('B',1,[dependency(x)])),/frozen consumer/);
 const p=proof(a,m);for(const bad of [{...p,scope:'X'},{...p,candidateDigest:'b'.repeat(64)},{...p,contractVersion:2},{...p,manifestDigest:x.manifestDigest}])assert.throws(()=>f.act({type:'recordVerification',ref:a,verification:bad}),/proof.*mismatch/);
 const b=f.draft(manifest('B',1,[dependency(a)]));f.publish(manifest('A',2));assert.throws(()=>f.submit(b,manifest('B',1,[dependency(a)])),/requires draft/);
});
test('P7-RESULT-U12 canonical request digest and immutable events do not depend on object key order',()=>{
 const m=manifest();assert.equal(resultDigest(m),resultDigest(Object.fromEntries(Object.entries(m).reverse())));
 assert.equal(resultDigest({b:2,a:1}),createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
 const f=fixture(),ref=f.draft(m),{result}=f.submit(ref,m);assert.throws(()=>{result.events[0]!.reason='spoof';},TypeError);assert.throws(()=>{result.ledger.events.push(result.events[0]!);},TypeError);
 const corrupt=structuredClone(f.ledger);corrupt.versions[0]!.manifest.conclusion='same ref changed content';assert.throws(()=>applyResultAction(corrupt,{type:'invalidate',commandId:'x',expectedRevision:corrupt.revision,ref,reason:'x'}),/manifest ref mismatch/);
});
test('P7-RESULT-U13 head replacement cannot revive its own transitively invalidated draft inputs',()=>{
 const f=fixture(),oldB=f.publish(manifest('B')),a=f.publish(manifest('A',1,[dependency(oldB)])),m=manifest('B',2,[dependency(a)]),ref=f.draft(m),before=f.ledger;
 assert.throws(()=>f.submit(ref,m),/invalidate its own inputs/);assert.deepEqual(f.ledger,before);assert.equal(resolveDependencies(f.ledger,[dependency(oldB)]).ready,true);
});
test('P7-RESULT-U14 current producer cannot freeze dependencies from a different contract scope',()=>{
 const f=fixture(),a=f.publish(manifest()),m={...manifest('B',1,[dependency(a)]),contractVersion:2,contractDigest:'b'.repeat(64)};
 assert.equal(resolveDependencies(f.ledger,[dependency(a)],producer(m)).ready,false);assert.throws(()=>f.draft(m),/dependency scope mismatch/);assert.equal(f.ledger.versions.length,1);
});
