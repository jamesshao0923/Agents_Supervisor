import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SupervisorStore} from '../../packages/persistence/store.js';

// Actual SQLite/domain accounting; supplied completions are ledger fixtures,
// never evidence of a model call or product acceptance.
function fixture(tokenLimit:number|null){
  const root=mkdtempSync('/tmp/sv-token-supervision-'),workspace=join(root,'workspace');mkdirSync(workspace);
  let store=new SupervisorStore(join(root,'data'));
  const runtime=store.runtime.submit({type:'submit',commandId:'workflow',workspace,workspaceKind:'project',goal:'Keep unlimited supervision accounting explicit',tokenLimit,verificationReserve:20,steps:[{id:'input',kind:'input',prompt:'Required input'}]});
  const loop=store.supervision.attach({commandId:'attach',runtimeId:runtime.id,config:{model:'ledger-fixture',effort:'low',reservation:1,timeoutMs:1000},limits:{maxRepairs:1,maxReasoningCalls:4,maxDurationMs:60000,maxContextChars:8000}});
  const path=join(root,'ledger.json'),body='{"purpose":"supplied ledger outcome"}';writeFileSync(path,body);
  const completion={usage:35,stopConfirmed:true,error:null,proofs:{[path]:createHash('sha256').update(body).digest('hex')},threadId:null,result:{diagnosis:'ledger fixture'}};
  return {root,runtime,loop,completion,get store(){return store;},start(commandId:string){return store.supervision.beginJob({commandId,loopId:loop.id,expectedRevision:store.supervision.get(loop.id).revision,purpose:'diagnosis',context:{}});},reopen(){store.close();store=new SupervisorStore(join(root,'data'));},close(){store.close();rmSync(root,{recursive:true,force:true});}};
}

test('TOKEN-SUP-U01 unlimited supervision retains finite estimates and settles usage above reservation across reopen',()=>{
  const f=fixture(null);try{
    const job=f.start('first');f.store.supervision.observeJob(job.id,{modelStarted:true,observedUsage:35});
    const finished=f.store.supervision.finishJob(job.id,f.completion);
    assert.equal(finished.error,null);assert.deepEqual(finished.result,f.completion.result);assert.equal(finished.usage,35);
    const original=f.store.runtime.inspect(f.runtime.id).run;
    assert.equal(original.budget.limit,null);assert.equal(original.budget.spent,35);assert.equal(original.attempts[0]?.reservation,1);assert.equal(original.attempts[0]?.actual,35);assert.equal(original.attempts[0]?.status,'succeeded');
    f.reopen();assert.deepEqual(f.store.supervision.finishJob(job.id,f.completion),finished);
    const next=f.start('second');assert.equal(next.config.reservation,1);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.limit,null);
    assert.equal(JSON.stringify(f.store.runtime.inspect(f.runtime.id)).includes('Infinity'),false);
  }finally{f.close();}
});

test('TOKEN-SUP-U02 finite supervision still charges overruns and rejects their publication',()=>{
  const f=fixture(100);try{
    const job=f.start('finite');f.store.supervision.observeJob(job.id,{modelStarted:true,observedUsage:35});
    const finished=f.store.supervision.finishJob(job.id,f.completion),run=f.store.runtime.inspect(f.runtime.id).run;
    assert.match(finished.error!,/reserved budget/);assert.equal(finished.result,null);assert.equal(run.budget.spent,35);assert.equal(run.attempts[0]?.actual,35);assert.equal(run.attempts[0]?.status,'failed');
  }finally{f.close();}
});

test('TOKEN-SUP-U03 unlimited supervision preserves unknown usage underreporting and unconfirmed stop gates',()=>{
  for(const boundary of ['unknown','underreported','stop'] as const){
    const f=fixture(null);try{
      const job=f.start(boundary);f.store.supervision.observeJob(job.id,{modelStarted:true,observedUsage:35});
      const completion={...f.completion,usage:boundary==='unknown'?null:boundary==='underreported'?34:35,stopConfirmed:boundary!=='stop',error:'Explicit unresolved ledger fixture',result:null};
      const finished=f.store.supervision.finishJob(job.id,completion);f.reopen();
      assert.equal(finished.result,null);
      assert.throws(()=>f.start('blocked-next'),/Unresolved/);
      const run=f.store.runtime.inspect(f.runtime.id).run;assert.equal(run.budget.limit,null);
      if(boundary==='stop'){assert.equal(run.attempts[0]?.settled,true);assert.equal(run.operations[0]?.status,'unknown');}
      else{assert.equal(run.attempts[0]?.settled,false);assert.equal(run.attempts[0]?.reservation,1);}
    }finally{f.close();}
  }
});
