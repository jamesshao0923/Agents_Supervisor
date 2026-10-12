import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createTaskScheduler} from '../../packages/domain/task-scheduler.js';
import {createTaskResultDomain} from '../../packages/domain/task-results.js';
import {createDraftRun} from '../../packages/domain/index.js';
import {decideLoop, type LoopDecisionInput} from '../../packages/orchestration/loop-policy.js';
import {assessResearchGrouping} from '../../packages/orchestration/research-group-admission.js';
import type {SchedulerNode,SchedulerSnapshot} from '../../packages/contracts/p7-scheduler.js';
import {session} from '../helpers/research-group-admission-fixture.js';
const sha256=(text:string)=>createHash('sha256').update(text).digest('hex');
const results=createTaskResultDomain({sha256}),scheduler=createTaskScheduler({sha256,decisionId:d=>'schedule-'+d});
function node(id:string):SchedulerNode{return {id,dependencies:[],required:true,status:'pending',inputs:[],resources:[],reservation:100,loopIds:['loop'],admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:['required'],quality:'strong',value:'strong',reasons:['Original requirement preserved']}};}
function snapshot():SchedulerSnapshot{return {schemaVersion:1,revision:1,scope:{projectId:'project',runId:'run',contractVersion:1,contractDigest:sha256('contract')},status:'ready',tier:'medium',nodes:[node('first'),node('second')],results:results.createResultLedger(),claims:[],loops:[{id:'loop',parentId:null,depth:1,iteration:2,maxIterations:3,nodeCount:2,maxNodes:4,limit:1,spent:100}],budget:{limit:null,spent:100,verificationRemaining:1000,futureVerificationFloor:1000,futureExecutionFloor:1000},limits:{maxActive:2,maxNodes:10,maxDepth:2,nowMs:10,deadlineMs:100}};}
function loop():LoopDecisionInput{return {cancelled:false,paused:false,completion:{requiredCriteria:[{id:'required',status:'failed',evidenceCurrent:true}],integrationPassed:true,usabilityPassed:true,sideEffectsResolved:true,writersEndedOrIsolated:true},budget:{used:50000000,limit:null,attempts:1,maxAttempts:3,elapsedMs:1,maxElapsedMs:10,stopMode:'strict'},noProgressExhausted:false,diagnosisDue:false,missingInputs:[],runnableWork:true,inFlightWork:false,retryOrExternalEventPending:false,repairableGap:true};}

test('TOKEN-UNLIMITED-SCHED-U01 null root bypasses shared and ancestor token ceilings with finite reservations and serializable null remaining',()=>{
 const source=snapshot(),before=structuredClone(source),decision=scheduler.evaluate(source);
 assert.deepEqual(decision.dispatchTaskIds,['first','second']);assert.equal(decision.reservation,200);assert.equal(decision.remaining,null);assert.equal(JSON.parse(JSON.stringify(decision)).remaining,null);assert.deepEqual(source,before);
 assert.equal(scheduler.evaluateExpansion(source,{parentLoopId:'loop',childDepth:2,additionalNodes:1,reservation:10000}).allowed,true);
 const finite=structuredClone(source);finite.budget.limit=5000;
 assert.equal(scheduler.evaluate(finite).dispatchTaskIds.length,0);assert.match(scheduler.evaluate(finite).nodes[0]!.reasons.join(),/ancestor budget exhausted/);
 finite.loops[0]!.limit=4000;finite.budget.limit=4000;assert.deepEqual(scheduler.evaluate(finite).dispatchTaskIds,['first','second']);assert.equal(scheduler.evaluate(finite).remaining,1700);
 finite.budget.limit=100;finite.loops[0]!.limit=100;assert.match(scheduler.evaluate(finite).reasons.join(),/global budget protection/);
});
test('TOKEN-UNLIMITED-SCHED-U02 unlimited scheduling retains unknown accounting resource iteration time node and depth gates',()=>{
 const unknown=snapshot();unknown.claims=[{id:'held',taskId:'external',reservation:1,resources:[],loopIds:[],usage:'unknown',effects:'unknown'}];assert.match(scheduler.evaluate(unknown).reasons.join(),/unknown shared accounting/);
 const conflict=snapshot();conflict.nodes.forEach(n=>n.resources=[{kind:'path',key:'/project',mode:'write'}]);assert.deepEqual(scheduler.evaluate(conflict).dispatchTaskIds,['first']);assert.match(scheduler.evaluate(conflict).nodes[1]!.reasons.join(),/resource conflict/);
 const iteration=snapshot();iteration.loops[0]!.iteration=4;assert.match(scheduler.evaluate(iteration).nodes[0]!.reasons.join(),/loop bound reached/);
 const deadline=snapshot();deadline.limits.nowMs=100;assert.match(scheduler.evaluate(deadline).reasons.join(),/deadline/);
 const capacity=snapshot();capacity.limits.maxNodes=1;assert.match(scheduler.evaluate(capacity).reasons.join(),/node cap/);
 assert.match(scheduler.evaluateExpansion(snapshot(),{parentLoopId:'loop',childDepth:3,additionalNodes:1,reservation:10000}).reasons.join(),/depth limit/);
 assert.match(scheduler.evaluateExpansion(snapshot(),{parentLoopId:'loop',childDepth:2,additionalNodes:3,reservation:10000}).reasons.join(),/ancestor limit/);
 const invalid=snapshot();invalid.budget.limit=undefined as never;assert.throws(()=>scheduler.evaluate(invalid),/invalid integer|unsafe JSON/);
});
test('TOKEN-UNLIMITED-SCHED-U03 null loop budget continues above token estimates while finite time attempt and no-progress bounds still stop',()=>{
 assert.equal(decideLoop(loop()).action,'continue');
 const finite=loop();finite.budget.limit=100;assert.equal(decideLoop(finite).reason,'shared-budget-limit');
 const attempts=loop();attempts.budget.attempts=3;assert.equal(decideLoop(attempts).reason,'attempt-limit');
 const elapsed=loop();elapsed.budget.elapsedMs=10;assert.equal(decideLoop(elapsed).reason,'elapsed-time-limit');
 const unchanged=loop();unchanged.noProgressExhausted=true;assert.equal(decideLoop(unchanged).reason,'bounded-no-progress-limit');
 const unknown=loop();unknown.budget.used=NaN;assert.throws(()=>decideLoop(unknown),/used/);
});
test('TOKEN-UNLIMITED-SCHED-U04 unlimited research grouping funds all original sources with finite estimates and still refuses unknown accounting',()=>{
 const run=createDraftRun({id:'goal',projectId:'project',goal:'Trace all five materials.',budget:{unit:'token',limit:null,verificationReserve:300}}),configured=session();
 run.budget.spent=50000000;
 const admitted=assessResearchGrouping(configured,run);assert.equal(admitted.decision.mode,'grouped');assert.equal(admitted.decision.groupReservation,400);assert.equal(admitted.decision.totalProtectedReservation,800);assert.equal(admitted.groups.length,configured.proposal!.researchGroups!.groups.length);
 assert.deepEqual(admitted.groups.flatMap(group=>group.materialIds).sort(),configured.research!.inputs.map(input=>input.id).sort());
 run.attempts.push({id:'unknown',nodeId:'@supervisor',contractVersion:1,status:'cancelled',purpose:'reasoning',reservation:200,actual:null,settled:false});
 assert.throws(()=>assessResearchGrouping(configured,run),/unknown accounting/);
});
