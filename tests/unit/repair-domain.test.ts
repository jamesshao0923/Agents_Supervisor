import test from 'node:test';
import assert from 'node:assert/strict';
import type { Run, RunAction } from '../../packages/contracts/p1.js';
import { applyAction, createRun, futureVerificationFloor, readiness } from '../../packages/domain/index.js';

function fresh():Run {
  return createRun({id:'run',projectId:'project',contract:{version:1,goal:'Strict original behavior',criteria:[{id:'correct',description:'All original assertions',required:true}]},nodes:[{id:'implement',dependencies:[],required:true}],budget:{unit:'token',limit:100,verificationReserve:20}});
}
const act=(run:Run,action:RunAction):Run=>applyAction(run,action).run;
function built():Run {
  let run=act(fresh(),{type:'startAttempt',attemptId:'initial',nodeId:'implement',contractVersion:1,reservation:60,purpose:'execution',resources:[]});
  run=act(run,{type:'finishAttempt',attemptId:'initial',outcome:'succeeded'});
  run=act(run,{type:'settleAttempt',attemptId:'initial',actual:10});
  return act(run,{type:'setArtifact',artifact:{id:'old-plan',contractVersion:1,digest:'bad-candidate',path:'/old-plan'}});
}
const allocate=(run:Run,amount=50):Run=>act(run,{type:'setFutureVerification',allocationId:'final',contractVersion:1,amount,reason:'Protect mandatory re-verification'});
const repair:RunAction={type:'appendRepairNodes',contractVersion:1,nodes:[{id:'repair',dependencies:['implement'],required:true}],failureJobId:'actual-failure',failedObligationIds:['normal'],reason:'Repair actual failed behavior'};
function start(reservation:number,purpose:'execution'|'verification'|'reasoning'='execution'):Extract<RunAction,{type:'startAttempt'}> {
  return {type:'startAttempt',attemptId:'next',nodeId:purpose==='reasoning'?'@supervisor':purpose==='verification'?'implement':'repair',contractVersion:1,reservation,purpose,resources:[]};
}

test('P6-REPAIR-U01 same-contract append preserves original standards nodes budget and audit history',()=>{
  const old=built();const before=structuredClone(old),result=applyAction(old,repair),next=result.run;
  assert.deepEqual(old,before);assert.deepEqual(next.contract,old.contract);assert.deepEqual(next.nodes[0],old.nodes[0]);
  assert.deepEqual(next.attempts,old.attempts);assert.deepEqual(next.budget,old.budget);assert.equal(next.nodes[1]?.status,'pending');
  assert.equal(next.artifact,null);assert.equal(next.status,'ready');assert.deepEqual(result.events[0]?.details.invalidatedArtifact,old.artifact);
});
test('P6-REPAIR-U02 append rejects duplicate ids unknown dependencies optional repairs and stale contract',()=>{
  for(const nodes of [[{id:'implement',dependencies:[],required:true}],[{id:'repair',dependencies:['missing'],required:true}],[{id:'repair',dependencies:['implement'],required:false}],[]]){
    assert.throws(()=>act(built(),{...repair,nodes}));
  }
  assert.throws(()=>act(built(),{...repair,contractVersion:2}),/stale repair/);
  assert.throws(()=>act(fresh(),repair),/completed required/);
  assert.throws(()=>act(built(),{...repair,failedObligationIds:[]}),/failed obligations/);
});
test('P6-REPAIR-U03 repair is prohibited by pause cancellation terminal success or unknown accounting',()=>{
  assert.throws(()=>act(act(built(),{type:'pause'}),repair),/active admitted/);
  assert.throws(()=>act(act(built(),{type:'cancel'}),repair),/cancelled/);
  const unsettled=act(fresh(),{type:'startAttempt',attemptId:'initial',nodeId:'implement',contractVersion:1,reservation:60,purpose:'execution',resources:[]});
  assert.throws(()=>act(act(unsettled,{type:'finishAttempt',attemptId:'initial',outcome:'succeeded'}),repair),/settled/);
  const effects=act(built(),{type:'setOperation',operationId:'unknown-effect',attemptId:'initial',status:'unknown'});
  assert.throws(()=>act(effects,repair),/confirmed effects/);
  const passed=act(built(),{type:'recordEvidence',evidence:{id:'proof',criterionId:'correct',contractVersion:1,artifactDigest:'bad-candidate',verdict:'passed',verifierVersion:'independent'}});
  assert.throws(()=>act(act(passed,{type:'complete'}),repair),/terminal/);
});
test('P6-REPAIR-U04 future floor overlaps original reserve and bounds subsequent execution exactly',()=>{
  const run=act(allocate(built()),repair);assert.equal(futureVerificationFloor(run),50);
  assert.equal(readiness(run).state,'ready');assert.throws(()=>act(run,start(41)),/insufficient budget/);
  const next=act(run,start(40));assert.equal(next.attempts.at(-1)?.reservation,40);assert.equal(futureVerificationFloor(next),50);
});
test('P6-REPAIR-U05 legacy reserve is retained when greater than future allocation',()=>{
  const run=act(allocate(built(),10),repair);assert.throws(()=>act(run,start(71)),/insufficient budget/);
  assert.equal(act(run,start(70)).attempts.at(-1)?.reservation,70);
});
test('P6-REPAIR-U06 ordinary review cannot consume final verification allocation',()=>{
  const run=allocate(built());assert.throws(()=>act(run,start(41,'verification')),/insufficient budget/);
  const review=act(run,start(40,'verification'));assert.equal(futureVerificationFloor(review),50);
  assert.equal(review.attempts.at(-1)?.purpose,'verification');
});
test('P6-REPAIR-U07 matching final allocation converts atomically into actual reservation without double counting',()=>{
  const run=allocate(built()),result=applyAction(run,{...start(50,'verification'),futureVerificationAllocationId:'final'});
  assert.equal(result.run.budget.futureVerification,undefined);assert.equal(result.run.attempts.at(-1)?.reservation,50);
  assert.deepEqual(result.events[0]?.details.consumedFutureVerification,run.budget.futureVerification);
  assert.equal(futureVerificationFloor(run),50,'Input allocation remains unchanged');
  assert.throws(()=>act(result.run,{...start(1,'reasoning'),attemptId:'independent-reasoning'}),/unsettled/);
});
test('P6-REPAIR-U08 mismatched amount id purpose or stale allocation cannot bypass protection',()=>{
  for(const action of [{...start(49,'verification'),futureVerificationAllocationId:'final'},{...start(50,'verification'),futureVerificationAllocationId:'other'},{...start(50,'reasoning'),futureVerificationAllocationId:'final'}]){
    assert.throws(()=>act(allocate(built()),action),/does not match/);
  }
  const stale=allocate(built());stale.budget.futureVerification!.contractVersion=2;
  assert.throws(()=>act(stale,start(1,'verification')),/stale future/);
});
test('P6-REPAIR-U09 allocation rejects noninteger unavailable and unsafe amounts',()=>{
  for(const amount of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,91])assert.throws(()=>allocate(built(),amount));
  assert.throws(()=>allocate(act(built(),{type:'pause'})),/active admitted/);
  assert.throws(()=>allocate(act(built(),{type:'cancel'})),/cancelled/);
  assert.throws(()=>allocate(fresh() as Run,101),/insufficient/);
});
test('P6-REPAIR-U10 explicit quiet release retains mandatory completion gate and release audit',()=>{
  const run=allocate(built());const release=applyAction(run,{type:'setFutureVerification',allocationId:'final',contractVersion:1,amount:0,reason:'Release obsolete future plan'});
  assert.equal(release.run.budget.futureVerification,undefined);assert.deepEqual(release.events[0]?.details.previousAllocation,run.budget.futureVerification);
  assert.throws(()=>act(release.run,{type:'complete'}),/lacks current passed/);
  assert.throws(()=>act(run,{type:'setFutureVerification',allocationId:'different',contractVersion:1,amount:0,reason:'Cannot release unrelated allocation'}),/unknown future/);
});
test('P6-REPAIR-U11 legitimate contract revision audits and invalidates stale future allocation',()=>{
  const run=allocate(built());const result=applyAction(run,{type:'revisePlan',contract:{...run.contract,version:2},nodes:[{id:'new',required:true,dependencies:[]}],reason:'Actual newly authorized user change'});
  assert.equal(result.run.budget.futureVerification,undefined);assert.deepEqual(result.events[0]?.details.invalidatedFutureVerification,run.budget.futureVerification);
  assert.equal(result.run.budget.spent,10);assert.deepEqual(result.run.attempts,run.attempts);
});
test('P6-REPAIR-U12 passed evidence does not complete a run with unconsumed future allocation',()=>{
  const run=act(allocate(built()),{type:'recordEvidence',evidence:{id:'proof',criterionId:'correct',contractVersion:1,artifactDigest:'bad-candidate',verdict:'passed',verifierVersion:'independent'}});
  assert.throws(()=>act(run,{type:'complete'}),/allocation not consumed/);assert.equal(readiness(run).state,'verification');
});
