import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SupervisorStore} from '../../packages/persistence/store.js';

// Real SQLite/domain transactions. Stored model outcomes are explicitly ledger
// fixtures; they do not claim a live Codex call or independent verification.
function fixture(){
  const root=mkdtempSync('/tmp/sv-supervision-'),workspace=join(root,'workspace');mkdirSync(workspace);
  let store=new SupervisorStore(join(root,'data'));
  const runtime=store.runtime.submit({type:'submit',commandId:'workflow',workspace,workspaceKind:'project',goal:'Retain original acceptance while supervising',tokenLimit:100,verificationReserve:20,steps:[{id:'input',kind:'input',prompt:'Required input'}]});
  const attach={commandId:'attach',runtimeId:runtime.id,config:{model:'repository-fixture-not-a-model',effort:'low',reservation:30,timeoutMs:1000},limits:{maxRepairs:1,maxReasoningCalls:2,maxDurationMs:60000,maxContextChars:8000}};
  const loop=store.supervision.attach(attach);
  return {root,workspace,runtime,attach,loop,get store(){return store;},reopen(){store.close();store=new SupervisorStore(join(root,'data'));},close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
function completion(root:string){const path=join(root,'fixture-proof.json'),body='{"purpose":"ledger fixture, not model proof"}';writeFileSync(path,body);return {usage:7,stopConfirmed:true,error:null,proofs:{[path]:createHash('sha256').update(body).digest('hex')},threadId:null,result:{diagnosis:'fixture only'}};}

test('P6-SUP-I01 supervisor attachment and prepared intent survive reopen with exact idempotent requests',()=>{
  const f=fixture();try{
    assert.deepEqual(f.store.supervision.attach(f.attach),f.loop);
    assert.throws(()=>f.store.supervision.attach({...f.attach,config:{...f.attach.config,reservation:31}}),/Conflicting/);
    const request={commandId:'prepare',loopId:f.loop.id,expectedRevision:0,kind:'freeze' as const,action:{type:'freeze',runtimeId:f.runtime.id,commandId:'external-freeze',mode:'final'}};
    const intent=f.store.supervision.prepareIntent(request);
    assert.throws(()=>f.store.supervision.beginJob({commandId:'out-of-order',loopId:f.loop.id,expectedRevision:1,purpose:'diagnosis',context:{}}),/Unacknowledged/);
    f.reopen();assert.deepEqual(f.store.supervision.prepareIntent(request),intent);
    const paused=f.store.supervision.update(f.loop.id,1,{paused:true});assert.equal(paused.paused,true);
    const ack=f.store.supervision.acknowledgeIntent(f.loop.id,intent.id,{planId:'actual-receipt-fixture'});assert.equal(ack.paused,true);assert.ok(ack.intent?.completedAt);
    assert.deepEqual(f.store.supervision.acknowledgeIntent(f.loop.id,intent.id,{planId:'actual-receipt-fixture'}),ack);
    assert.throws(()=>f.store.supervision.acknowledgeIntent(f.loop.id,intent.id,{planId:'different'}),/Conflicting/);
    assert.throws(()=>f.store.supervision.update(f.loop.id,0,{paused:false}),/Stale/);
  }finally{f.close();}
});

test('P6-SUP-I02 supervision reasoning reserves and settles original Run budget exactly once without changing requirements',()=>{
  const f=fixture();try{
    const original=f.store.runtime.inspect(f.runtime.id).run.contract;
    const input={commandId:'diagnose',loopId:f.loop.id,expectedRevision:0,purpose:'diagnosis' as const,context:{failure:'explicit repository fixture'}};
    const job=f.store.supervision.beginJob(input),before=f.store.runtime.inspect(f.runtime.id).run;
    assert.equal(before.attempts.at(-1)?.reservation,30);assert.equal(before.budget.spent,0);assert.equal(before.operations.at(-1)?.status,'pending');
    assert.deepEqual(f.store.supervision.beginJob(input),job);assert.equal(f.store.supervision.jobs(f.loop.id).length,1);
    f.store.supervision.observeJob(job.id,{modelStarted:true,observedUsage:7});
    assert.throws(()=>f.store.supervision.observeJob(job.id,{modelStarted:false}),/cannot be erased/);
    assert.throws(()=>f.store.supervision.observeJob(job.id,{observedUsage:6}),/cannot decrease/);
    const result=completion(f.root),finished=f.store.supervision.finishJob(job.id,result);f.reopen();assert.deepEqual(f.store.supervision.finishJob(job.id,result),finished);
    const run=f.store.runtime.inspect(f.runtime.id).run;assert.equal(run.budget.spent,7);assert.deepEqual(run.contract,original);assert.equal(run.attempts.length,1);assert.equal(run.operations.at(-1)?.status,'confirmed');
    assert.throws(()=>f.store.supervision.finishJob(job.id,{...result,usage:8}),/Conflicting/);assert.notEqual(run.status,'succeeded');
  }finally{f.close();}
});

test('P6-SUP-I03 unknown reasoning usage retains reservation and blocks another job or intent across reopen',()=>{
  const f=fixture();try{
    const job=f.store.supervision.beginJob({commandId:'uncertain',loopId:f.loop.id,expectedRevision:0,purpose:'diagnosis',context:{}});
    f.store.supervision.observeJob(job.id,{modelStarted:true});f.store.supervision.finishJob(job.id,{usage:null,stopConfirmed:true,error:'Lost authoritative turn usage',proofs:{},threadId:null,result:null});f.reopen();
    const run=f.store.runtime.inspect(f.runtime.id).run;assert.equal(run.attempts[0]?.settled,false);assert.equal(run.attempts[0]?.reservation,30);assert.equal(run.budget.spent,0);
    assert.throws(()=>f.store.supervision.beginJob({commandId:'retry',loopId:f.loop.id,expectedRevision:1,purpose:'diagnosis',context:{}}),/Unresolved/);
    assert.throws(()=>f.store.supervision.prepareIntent({commandId:'next',loopId:f.loop.id,expectedRevision:1,kind:'freeze',action:{}}),/Unresolved/);
  }finally{f.close();}
});

test('P6-SUP-I04 outer rollback preserves loop counters original ledger and command receipt absence',()=>{
  const f=fixture();try{
    const before=f.store.runtime.inspect(f.runtime.id),request={commandId:'rollback',loopId:f.loop.id,expectedRevision:0,purpose:'diagnosis' as const,context:{}};
    assert.throws(()=>f.store.supervision.transaction(()=>{f.store.supervision.beginJob(request);throw new Error('injected rollback');}),/injected/);
    assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);assert.deepEqual(f.store.supervision.get(f.loop.id),f.loop);assert.equal(f.store.supervision.jobs(f.loop.id).length,0);
    const job=f.store.supervision.beginJob(request);assert.equal(job.status,'running');assert.equal(f.store.supervision.jobs(f.loop.id).length,1);
    assert.throws(()=>f.store.supervision.transaction(()=>Promise.resolve(1)),/Asynchronous/);
  }finally{f.close();}
});

test('P6-SUP-I05 context and budget failures precede intents while overrun remains charged and completion cannot be fabricated',()=>{
  const f=fixture();try{
    const initial=f.store.runtime.inspect(f.runtime.id).run;
    assert.throws(()=>f.store.supervision.beginJob({commandId:'large',loopId:f.loop.id,expectedRevision:0,purpose:'diagnosis',context:{text:'x'.repeat(3000)}}),/capacity/);
    assert.throws(()=>f.store.supervision.beginJob({commandId:'budget',loopId:f.loop.id,expectedRevision:0,purpose:'diagnosis',context:{},config:{...f.attach.config,reservation:81}}),/budget/);
    assert.deepEqual(f.store.runtime.inspect(f.runtime.id).run,initial);assert.equal(f.store.supervision.jobs(f.loop.id).length,0);
    assert.throws(()=>f.store.supervision.update(f.loop.id,0,{phase:'complete'}),/independent delivery/);
    const job=f.store.supervision.beginJob({commandId:'overrun',loopId:f.loop.id,expectedRevision:0,purpose:'diagnosis',context:{}});
    f.store.supervision.finishJob(job.id,{...completion(f.root),usage:105,error:'Actual overrun',result:null});
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,105);
    assert.throws(()=>f.store.supervision.beginJob({commandId:'after-overrun',loopId:f.loop.id,expectedRevision:1,purpose:'diagnosis',context:{}}),/budget/);
  }finally{f.close();}
});

test('P6-SUP-I06 pause stop repair cap and implementation readiness gate supervision dispatch',()=>{
  const f=fixture();try{
    assert.throws(()=>f.store.supervision.beginJob({commandId:'author-too-early',loopId:f.loop.id,expectedRevision:0,purpose:'acceptance-authoring',context:{}}),/completed implementation/);
    let loop=f.store.supervision.update(f.loop.id,0,{paused:true});assert.throws(()=>f.store.supervision.assertEligible(loop.id),/disabled/);
    loop=f.store.supervision.update(loop.id,loop.revision,{paused:false});
    const intent=f.store.supervision.prepareIntent({commandId:'repair-1',loopId:loop.id,expectedRevision:loop.revision,kind:'repair',action:{failureJobId:'ledger-fixture'}});
    loop=f.store.supervision.acknowledgeIntent(loop.id,intent.id,{runtimeId:f.runtime.id});assert.equal(loop.repairCount,1);
    assert.throws(()=>f.store.supervision.prepareIntent({commandId:'repair-2',loopId:loop.id,expectedRevision:loop.revision,kind:'repair',action:{}}),/repair limit/);
    loop=f.store.supervision.update(loop.id,loop.revision,{stopped:true});assert.throws(()=>f.store.supervision.assertEligible(loop.id),/disabled/);
    assert.throws(()=>f.store.supervision.update(loop.id,loop.revision,{stopped:false}),/explicit recovery/);
  }finally{f.close();}
});


test('P6-SUP-I07 underreported final usage keeps observed cost unresolved and reservation overrun cannot publish a result',()=>{
  for(const reported of [0,35]){
    const f=fixture();try{
      const job=f.store.supervision.beginJob({commandId:'accounting',loopId:f.loop.id,expectedRevision:0,purpose:'diagnosis',context:{}});
      f.store.supervision.observeJob(job.id,{modelStarted:true,observedUsage:12});
      const result={...completion(f.root),usage:reported};
      const finished=f.store.supervision.finishJob(job.id,result);assert.equal(finished.reportedUsage,reported);assert.equal(finished.result,null);assert.ok(finished.error);assert.equal(finished.stopConfirmed,true);
      const run=f.store.runtime.inspect(f.runtime.id).run;
      if(reported===0){assert.equal(finished.usage,null);assert.equal(run.attempts[0]?.settled,false);assert.equal(run.attempts[0]?.reservation,30);}
      else {assert.equal(finished.usage,35);assert.equal(run.budget.spent,35);assert.equal(run.attempts[0]?.settled,true);}
      f.reopen();assert.deepEqual(f.store.supervision.finishJob(job.id,result),finished);
    }finally{f.close();}
  }
});
