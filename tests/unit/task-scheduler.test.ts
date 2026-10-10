import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createTaskScheduler,schedulerResourcesConflict} from '../../packages/domain/task-scheduler.js';
import {createTaskResultDomain} from '../../packages/domain/task-results.js';
import type {SchedulerNode,SchedulerSnapshot,SchedulerResource} from '../../packages/contracts/p7-scheduler.js';
import type {TaskResultManifest,ResultAction} from '../../packages/contracts/p7-results.js';
const sha256=(text:string)=>createHash('sha256').update(text).digest('hex'), domain=createTaskResultDomain({sha256}), scheduler=createTaskScheduler({sha256,decisionId:d=>'schedule-'+d});
function node(id:string):SchedulerNode {return {id,dependencies:[],required:true,status:'pending',inputs:[],resources:[],reservation:10,loopIds:[],admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:['criterion:necessary'],quality:'strong',value:'strong',reasons:['Host-bound necessary implementation']}};}
function snapshot(nodes=[node('A'),node('B')]):SchedulerSnapshot {return {schemaVersion:1,revision:3,scope:{projectId:'project',runId:'run',contractVersion:1,contractDigest:sha256('contract')},status:'ready',tier:'low',nodes,results:domain.createResultLedger(),claims:[],loops:[],budget:{limit:100,spent:0,verificationRemaining:20,futureVerificationFloor:30},limits:{maxActive:2,maxNodes:20,maxDepth:3,nowMs:10,deadlineMs:1000}};}
function result(s:SchedulerSnapshot,id='A') {const m:TaskResultManifest={schemaVersion:1,...s.scope,taskId:id,attemptId:id+'-attempt',generation:1,planRevision:1,inputs:[],artifacts:[],conclusion:'Real pure ledger publication',sources:[],checks:[],limitations:[],unresolved:[]};const {schemaVersion,inputs,artifacts,conclusion,sources,checks,limitations,unresolved,...producer}=m;let seq=0;const act=(a:object)=>{s.results=domain.applyResultAction(s.results,{...a,commandId:'cmd-'+(++seq),expectedRevision:s.results.revision} as ResultAction).ledger;};act({type:'stageDraft',manifest:m,currentProducer:producer,expectedHead:null});const ref=s.results.versions.at(-1)!.ref;return {ref,publish:()=>act({type:'submit',ref,currentProducer:producer,expectedHead:null,publication:{complete:true,artifacts:[]}}),verify:()=>act({type:'recordVerification',ref,verification:{scope:id,manifestDigest:ref.manifestDigest,candidateDigest:domain.resultDigest(m.artifacts),contractVersion:1,contractDigest:s.scope.contractDigest,frozenPlanId:'frozen',proofDigest:sha256('proof'),stopConfirmed:true,usageKnown:true,checks:[{evidenceId:'actual-domain-proof-value',required:true,verdict:'passed'}]}})};}
const resource=(key:string,mode:'read'|'write'='write'):SchedulerResource=>({kind:'path',key,mode});

test('P7-SCHED-U01 cycles reject while unknown and blocked dependencies preserve unrelated dispatch and necessary gaps',()=>{
 const s=snapshot([node('blocked'),node('dependent'),node('free')]);s.nodes[0]!.status='blocked';s.nodes[1]!.dependencies=['blocked','missing'];
 const d=scheduler.evaluate(s);assert.deepEqual(d.dispatchTaskIds,['free']);assert.equal(d.nodes[1]!.ready,false);assert.deepEqual(d.requiredGaps,['blocked','dependent','free']);
 s.nodes[0]!.dependencies=['dependent'];assert.throws(()=>scheduler.evaluate(s),/cyclic/);
});
test('P7-SCHED-U02 dependencies use exact published heads scope and verification minimum never drafts unknown or stale refs',()=>{
 const s=snapshot();s.nodes[0]!.status='succeeded';s.nodes[1]!.dependencies=['A'];const r=result(s);s.nodes[1]!.inputs=[{dependencyNodeId:'A',result:r.ref,minimumState:'verified'}];
 assert.equal(scheduler.evaluate(s).nodes[1]!.ready,false);r.publish();assert.equal(scheduler.evaluate(s).nodes[1]!.ready,false);r.verify();assert.deepEqual(scheduler.evaluate(s).dispatchTaskIds,['B']);
 s.nodes[1]!.inputs[0]!.result={...r.ref,manifestDigest:sha256('stale')};assert.equal(scheduler.evaluate(s).nodes[1]!.ready,false);
 s.nodes[1]!.inputs[0]!.result=r.ref;s.scope.contractDigest=sha256('new-contract');assert.equal(scheduler.evaluate(s).nodes[1]!.ready,false);
 const unknownLedger=structuredClone(s);unknownLedger.results.schemaVersion=2 as never;assert.throws(()=>scheduler.evaluate(unknownLedger),/unknown result ledger/);
 const bad=structuredClone(s);bad.results.versions[0]!.state='unknown' as never;assert.throws(()=>scheduler.evaluate(bad),/unknown dependency/);
});
test('P7-SCHED-U03 resource readers share while ancestor writers queue and unknown held effects cannot be released by predictions',()=>{
 const s=snapshot([node('reader1'),node('reader2'),node('writer')]);s.limits.maxActive=3;s.nodes[0]!.resources=[resource('/non-git/data','read')];s.nodes[1]!.resources=[resource('/non-git/data/file','read')];s.nodes[2]!.resources=[resource('/non-git','write')];
 assert.deepEqual(scheduler.evaluate(s).dispatchTaskIds,['reader1','reader2']);
 s.claims=[{id:'held',taskId:'old-writer',reservation:10,resources:[resource('/non-git')],loopIds:[],usage:'known',effects:'unknown'}];s.nodes.push(node('unrelated'));assert.deepEqual(scheduler.evaluate(s).dispatchTaskIds,['unrelated']);
 assert.equal(schedulerResourcesConflict(resource('/a'),resource('/ab')),false);assert.equal(schedulerResourcesConflict(resource('/'),resource('/ab','read')),true);
 assert.throws(()=>schedulerResourcesConflict(resource('/a/../b'),resource('/b')),/canonical/);
});
test('P7-SCHED-U04 qualitative tier admission is nested independent of agent cap and required work stays necessary',()=>{
 const ns=['strong','supported','exploratory','uncertain'].map((basis,i)=>{const n=node('optional'+i);n.required=false;n.admission.requirementRefs=[];n.admission.quality=basis as never;n.admission.value=basis as never;return n;});ns.push(node('necessary'));ns[4]!.admission.quality='uncertain';ns[4]!.admission.value='uncertain';const s=snapshot(ns);s.limits.maxActive=1;
 let previous:string[]=[];for(const tier of ['low','medium','high','unlimited'] as const){s.tier=tier;const d=scheduler.evaluate(s),admitted=d.nodes.filter(n=>n.admitted).map(n=>n.taskId);assert.ok(previous.every(id=>admitted.includes(id)));assert.ok(admitted.includes('necessary'));assert.equal(d.dispatchTaskIds.length,1);previous=admitted;}
 assert.equal(previous.length,5);s.nodes[0]!.admission.relevant=false;s.nodes[1]!.admission.duplicate=true;const d=scheduler.evaluate(s);assert.equal(d.nodes[0]!.admitted,false);assert.equal(d.nodes[1]!.admitted,false);
 s.nodes[4]!.admission.requirementRefs=[];assert.equal(scheduler.evaluate(s).nodes[4]!.admitted,false);assert.ok(scheduler.evaluate(s).requiredGaps.includes('necessary'));
});
test('P7-SCHED-U05 shared budget protects max overlapping verification floor and unknown usage stops every tier without freeing reservations',()=>{
 const s=snapshot();s.budget.limit=50;s.claims=[{id:'active',taskId:'external',reservation:10,resources:[],loopIds:[],usage:'known',effects:'pending'}];const d=scheduler.evaluate(s);assert.deepEqual(d.dispatchTaskIds,['A']);assert.equal(d.reservation,10);assert.equal(d.remaining,0);
 for(const tier of ['low','medium','high','unlimited'] as const){s.tier=tier;s.claims[0]!.usage='unknown';const stopped=scheduler.evaluate(s);assert.equal(stopped.state,'stopped');assert.equal(stopped.reservation,0);assert.equal(s.claims[0]!.reservation,10);}
});
test('P7-SCHED-U06 nested allocations constrain every ancestor and expansion respects depth nodes rounds and total budget',()=>{
 const s=snapshot();s.loops=[{id:'parent',parentId:null,depth:1,iteration:1,maxIterations:2,nodeCount:2,maxNodes:4,limit:20,spent:0},{id:'child',parentId:'parent',depth:2,iteration:1,maxIterations:1,nodeCount:2,maxNodes:3,limit:20,spent:0}];s.nodes.forEach(n=>n.loopIds=['parent','child']);assert.deepEqual(scheduler.evaluate(s).dispatchTaskIds,['A','B']);assert.equal(scheduler.evaluate(s).reservation,20);
 s.loops[0]!.spent=10;s.budget.spent=10;assert.deepEqual(scheduler.evaluate(s).dispatchTaskIds,['A']);
 const request={parentLoopId:'child',childDepth:3,additionalNodes:1,reservation:10};assert.equal(scheduler.evaluateExpansion(s,request).allowed,true);assert.equal(scheduler.evaluateExpansion(s,{...request,additionalNodes:2}).allowed,false);assert.equal(scheduler.evaluateExpansion(s,{...request,childDepth:4}).allowed,false);
 s.budget.spent=65;assert.equal(scheduler.evaluateExpansion(s,request).allowed,false);s.budget.spent=0;s.loops[0]!.spent=0;s.loops[1]!.iteration=2;assert.deepEqual(scheduler.evaluate(s).dispatchTaskIds,[]);assert.equal(scheduler.evaluateExpansion(s,request).allowed,false);
 s.loops[1]!.spent=1;assert.throws(()=>scheduler.evaluate(s),/spending exceeds parent/);s.loops[1]!.spent=0;
 s.loops[1]!.limit=21;assert.throws(()=>scheduler.evaluate(s),/allocation exceeds parent/);
});
test('P7-SCHED-U07 decisions are deterministic immutable input preserving and stop on deadline without claiming final delivery',()=>{
 const s=snapshot(),before=structuredClone(s),d=scheduler.evaluate(s);assert.deepEqual(scheduler.evaluate(s),d);assert.deepEqual(s,before);assert.throws(()=>d.dispatchTaskIds.push('invented'),TypeError);
 s.nodes.forEach(n=>n.status='succeeded');assert.equal(scheduler.evaluate(s).state,'exhausted');s.limits.nowMs=s.limits.deadlineMs;assert.equal(scheduler.evaluate(s).state,'stopped');assert.equal(scheduler.evaluateExpansion(s,{parentLoopId:null,childDepth:1,additionalNodes:1,reservation:10}).allowed,false);
 let invoked=false;const unsafe=Object.defineProperty({...s},'tier',{enumerable:true,get(){invoked=true;return 'unlimited';}});assert.throws(()=>scheduler.evaluate(unsafe),/unsafe JSON/);assert.equal(invoked,false);
 assert.throws(()=>createTaskScheduler({sha256:()=> 'invalid',decisionId:()=> 'id'}).evaluate(snapshot()),/SHA-256/);
});
