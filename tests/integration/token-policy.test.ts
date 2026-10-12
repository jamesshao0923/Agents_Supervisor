import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../packages/persistence/migrations.js';
import { GoalRepository } from '../../packages/persistence/goals.js';
import { RuntimeRepository } from '../../packages/persistence/runtime.js';
import { ConversationRepository } from '../../packages/persistence/conversations.js';
import type { GoalInspection, GoalProposal } from '../../packages/contracts/p5.js';
import { acceptedDeliveryFixture } from '../fixtures/accepted-delivery.js';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sv-token-policy-')),workspace=join(root,'project');mkdirSync(workspace);
  const path=join(root,'state.sqlite'),db=new DatabaseSync(path);migrate(db);
  return {root,workspace,path,db,goals:new GoalRepository(db),runtime:new RuntimeRepository(db),conversations:new ConversationRepository(db),close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}
function start(f:ReturnType<typeof fixture>,commandId='unlimited',limit:number|null=null):GoalInspection {
  return f.goals.start({type:'start',commandId,goal:'Retain one actual input',model:'repository-ledger-input-no-model-call',effort:'low',reservation:1,timeoutMs:1000,tokenLimit:limit,verificationReserve:2},f.workspace,'project');
}
// Explicit repository ledger inputs exercise actual persistence transactions;
// no reasoner substitute runs and no model/business acceptance is claimed.
function ready(f:ReturnType<typeof fixture>,initial:GoalInspection,usage=60_000_000):GoalInspection {
  const proposal:GoalProposal={decision:'ready',summary:'Retain one input',questions:[],facts:[{text:initial.session.goal,origin:'explicit',sourceId:initial.session.messages[0]!.id}],constraints:[],style:[],criteria:[{id:'input',description:'Retain supplied input',kind:'command',target:'input.test.mjs',checks:['Retain supplied input']}],steps:[{id:'one',description:'Retain one input',dependencies:[],acceptanceIds:['input']}]};
  return f.goals.finish(initial.session.id,initial.session.jobs[0]!.id,job=>{job.usage=usage;job.stopConfirmed=true;job.proposal=proposal;});
}
function completeInput(f:ReturnType<typeof fixture>,goal:GoalInspection):GoalInspection {
  const admitted=f.goals.control({type:'admit',commandId:'admit-'+goal.session.id,sessionId:goal.session.id,expectedRevision:goal.session.revision}),id=admitted.session.runtimeId!;
  f.runtime.revise({commandId:'input-plan-'+id,runtimeId:id,expectedContractVersion:admitted.run.contract.version,contract:{...admitted.run.contract,version:admitted.run.contract.version+1},nodes:[{id:'input',dependencies:[],required:true}],steps:[{id:'input',kind:'input',prompt:'Supply actual input'}],reason:'Use a real durable input operation for the repository persistence scenario'});
  f.runtime.control({type:'input',commandId:'supply-'+id,runtimeId:id,stepId:'input',text:'Actual durable input'});
  const operation=f.runtime.claim(id,'token-policy-worker');assert.ok(operation);f.runtime.markStarted(operation.id,'token-policy-worker');
  f.runtime.report(operation.id,'token-policy-worker',{messageId:'report-'+id,outcome:'confirmed',result:{input:'Actual durable input'}});
  return f.goals.inspect(goal.session.id);
}

test('unlimited goal runtime and conversation persist null ceilings and actual overspend across SQLite reopen',()=>{
  const f=fixture();try{
    const initial=ready(f,start(f));const conversation=f.conversations.ensureForGoal(initial.session.id);const done=completeInput(f,initial);
    assert.equal(done.run.budget.limit,null);assert.equal(done.run.budget.spent,60_000_000);assert.equal(done.session.phase,'admitted');
    const runtime=f.runtime.inspect(done.session.runtimeId!);assert.equal(runtime.runtime.definition.tokenLimit,null);assert.equal(runtime.runtime.phase,'awaiting-verification');
    const budget=f.conversations.budget(conversation.id);assert.equal(budget.limit,null);assert.equal(budget.remaining,null);assert.equal(budget.available,null);assert.equal(budget.spent,60_000_000);assert.equal(budget.reserved,0);
    const reopened=new DatabaseSync(f.path);try{migrate(reopened);assert.deepEqual(new GoalRepository(reopened).inspect(done.session.id),done);assert.deepEqual(new RuntimeRepository(reopened).inspect(runtime.runtime.id),runtime);assert.deepEqual(new ConversationRepository(reopened).budget(conversation.id),budget);}finally{reopened.close();}
    assert.equal(f.goals.startReceipt({type:'start',commandId:'unlimited',goal:'Retain one actual input',model:'repository-ledger-input-no-model-call',effort:'low',reservation:1,timeoutMs:1000,tokenLimit:null,verificationReserve:2})!.run.budget.limit,null);
  }finally{f.close();}
});

test('unlimited delivered continuation preserves null authorization old accounting and finite reservations after reopen',async()=>{
  const f=fixture();try{
    const first=completeInput(f,ready(f,start(f)));const conversation=f.conversations.ensureForGoal(first.session.id);
    const deliveryId=await acceptedDeliveryFixture(f.db,f.root,first.run,f.workspace,3),before=f.goals.inspect(first.session.id),spent=f.conversations.budget(conversation.id).spent;
    assert.ok(spent>=60_000_003);assert.equal(f.conversations.childAuthorization(conversation.id).tokenLimit,null);
    const child=f.goals.createContinuation(conversation.id,'continue-unlimited');assert.equal(child.run.budget.limit,null);assert.equal(child.run.budget.spent,0);assert.equal(child.run.budget.verificationReserve,2);assert.equal(child.session.config.reservation,1);assert.equal(child.run.attempts.length,0);assert.equal(child.session.continuation?.predecessorDeliveryId,deliveryId);
    assert.deepEqual(f.goals.inspect(first.session.id),before);assert.equal(f.conversations.budget(conversation.id).spent,spent);assert.equal(f.conversations.budget(conversation.id).limit,null);
    const reopened=new DatabaseSync(f.path);try{migrate(reopened);const goals=new GoalRepository(reopened),conversations=new ConversationRepository(reopened);assert.deepEqual(goals.inspect(child.session.id),child);assert.deepEqual(goals.createContinuation(conversation.id,'continue-unlimited'),child);assert.equal(conversations.get(conversation.id).authorizedLimit,null);assert.equal(conversations.budget(conversation.id).remaining,null);assert.equal(conversations.budget(conversation.id).spent,spent);assert.equal(conversations.rounds(conversation.id).length,2);assert.deepEqual(goals.inspect(first.session.id),before);}finally{reopened.close();}
  }finally{f.close();}
});

test('unlimited unknown reasoning usage stays reserved and blocks admission and continuation after SQLite reopen',()=>{
  const f=fixture();try{
    const initial=start(f),conversation=f.conversations.ensureForGoal(initial.session.id);
    const unknown=f.goals.finish(initial.session.id,initial.session.jobs[0]!.id,job=>{job.usage=null;job.stopConfirmed=true;job.error='No actual usage receipt';});
    assert.equal(unknown.session.phase,'blocked');assert.equal(unknown.run.budget.limit,null);assert.equal(unknown.run.budget.spent,0);assert.equal(unknown.run.attempts[0]!.settled,false);assert.equal(f.conversations.budget(conversation.id).reserved,1);
    assert.throws(()=>f.goals.control({type:'admit',commandId:'unsafe',sessionId:unknown.session.id,expectedRevision:unknown.session.revision}));assert.throws(()=>f.goals.createContinuation(conversation.id,'unsafe-continuation'),/delivered|settled/);
    const reopened=new DatabaseSync(f.path);try{migrate(reopened);const goals=new GoalRepository(reopened),conversations=new ConversationRepository(reopened);assert.deepEqual(goals.inspect(unknown.session.id),unknown);assert.equal(conversations.budget(conversation.id).reserved,1);assert.equal(conversations.budget(conversation.id).available,null);assert.throws(()=>goals.control({type:'restore',commandId:'unsafe-restore',sessionId:unknown.session.id,expectedRevision:unknown.session.revision}),/unsettled|unresolved/i);}finally{reopened.close();}
  }finally{f.close();}
});
