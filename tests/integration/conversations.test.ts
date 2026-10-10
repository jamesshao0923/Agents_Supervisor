import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../packages/persistence/migrations.js';
import { ConversationRepository } from '../../packages/persistence/conversations.js';
import { RuntimeRepository } from '../../packages/persistence/runtime.js';
import { createDraftRun, applyAction } from '../../packages/domain/index.js';
import type { Run, RunAction } from '../../packages/contracts/p1.js';
import type { GoalSession } from '../../packages/contracts/p5.js';
import type { ConversationMessageInput } from '../../packages/contracts/p6.js';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sv-p6-conversations-')),workspace=join(root,'project');mkdirSync(workspace);
  const path=join(root,'state.sqlite'),db=new DatabaseSync(path);migrate(db);
  db.prepare('INSERT INTO projects(id,name) VALUES (?,?)').run('project','Conversation persistence fixture');
  return {root,workspace,path,db,repo:new ConversationRepository(db),close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}
function draft(f:ReturnType<typeof fixture>,id:string,limit=200,workspace=f.workspace,verificationReserve=20):Run {
  const run=createDraftRun({id,projectId:'project',goal:'Retain requirements',budget:{unit:'token',limit,verificationReserve}});
  const session:GoalSession={id,projectId:'project',workspace,workspaceKind:'project',revision:0,goal:run.contract.goal,phase:'ready',messages:[],jobs:[],proposal:null,runtimeId:null,error:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),config:{model:'unused-no-model-is-called',effort:'low',reservation:20,timeoutMs:1000},maxContextChars:60000};
  f.db.prepare('INSERT INTO runs(project_id,id,revision,snapshot) VALUES (?,?,?,?)').run(run.projectId,id,run.revision,JSON.stringify(run));
  f.db.prepare('INSERT INTO goal_sessions(id,project_id,run_id,record) VALUES (?,?,?,?)').run(id,run.projectId,id,JSON.stringify(session));return run;
}
function apply(f:ReturnType<typeof fixture>,id:string,action:RunAction):Run {
  const row=f.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get('project',id)!;
  const result=applyAction(JSON.parse(String(row.snapshot)) as Run,action);
  f.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE project_id=? AND id=?').run(result.run.revision,JSON.stringify(result.run),'project',id);return result.run;
}
function message(conversationId:string,commandId:string,kind:ConversationMessageInput['kind']='change'):ConversationMessageInput {return {conversationId,commandId,source:'user',kind,text:kind==='question'?'What is the current progress?':'Also retain the second requirement'};}
// These are database/domain fixtures, not model or independent-verifier substitutes.
// Actual model/verification behavior is covered by the separate real-run acceptance suite.
function delivered(f:ReturnType<typeof fixture>,id:string,spent:number):string {
  apply(f,id,{type:'startAttempt',attemptId:id+':accounting',nodeId:'@supervisor',contractVersion:1,purpose:'reasoning',reservation:spent,resources:[]});
  apply(f,id,{type:'finishAttempt',attemptId:id+':accounting',outcome:'succeeded'});
  apply(f,id,{type:'settleAttempt',attemptId:id+':accounting',actual:spent});
  apply(f,id,{type:'admit',contract:{version:2,goal:'Retain requirements',criteria:[{id:'retained',description:'Retention fixture assertion',required:true}]},nodes:[{id:'local',dependencies:[],required:false}]});
  const digest='a'.repeat(64);
  apply(f,id,{type:'setArtifact',artifact:{id:'fixture-artifact-'+id,digest,path:join(f.root,'fixture-artifact'),contractVersion:2}});
  apply(f,id,{type:'recordEvidence',evidence:{id:'fixture-evidence-'+id,criterionId:'retained',contractVersion:2,artifactDigest:digest,verdict:'passed',verifierVersion:'database-fixture'}});
  apply(f,id,{type:'complete'});
  const deliveryId='fixture-delivery-'+id;
  f.db.prepare("INSERT INTO verification_records(kind,id,project_id,run_id,record) VALUES ('delivery',?,?,?,?)").run(deliveryId,'project',id,JSON.stringify({id:deliveryId,projectId:'project',runId:id}));return deliveryId;
}

test('P6 conversation SQLite reopens immutable idempotent ordered messages without linking unrelated project goals',()=>{
  const f=fixture();try{
    draft(f,'first');draft(f,'unrelated');const conversation=f.repo.ensureForGoal('first');assert.deepEqual(f.repo.ensureForGoal('first'),conversation);
    const unrelated=f.repo.ensureForGoal('unrelated');assert.notEqual(unrelated.id,conversation.id);
    const input=message(conversation.id,'request-1'),first=f.repo.receive(input),second=f.repo.receive(message(conversation.id,'request-2'));
    assert.deepEqual([first.sequence,second.sequence],[1,2]);assert.deepEqual(f.repo.receive(input),first);
    assert.throws(()=>f.repo.receive({...input,text:'Different text'}),/Conflicting/);
    assert.throws(()=>f.repo.receive({...input,kind:'question'}),/Conflicting/);
    const reopened=new DatabaseSync(f.path);try{migrate(reopened);const repo=new ConversationRepository(reopened);assert.deepEqual(repo.inspect(conversation.id),f.repo.inspect(conversation.id));assert.deepEqual(repo.receive(input),first);assert.equal(repo.messages(unrelated.id).length,0);}finally{reopened.close();}
  }finally{f.close();}
});

test('P6 conversation questions remain read only while failed unclassified changes keep the durable fence',()=>{
  const f=fixture();try{
    draft(f,'first');const conversation=f.repo.ensureForGoal('first'),question=f.repo.receive(message(conversation.id,'question','question'));
    assert.equal(f.repo.hasPendingForRun('project','first'),false);
    f.repo.transition(question.id,'answered',{response:'No implementation has started.'});
    const change=f.repo.receive(message(conversation.id,'change','unclassified'));assert.equal(f.repo.hasPendingForRun('project','first'),true);
    f.repo.transition(change.id,'failed',{reason:'Usage cannot be established'});assert.equal(f.repo.hasPendingForRun('project','first'),true);
    assert.throws(()=>f.repo.beginProcessing(change.id),/explicit retry/);
    assert.throws(()=>f.repo.transition(change.id,'answered',{response:'Ignore failed work'}),/transition/);
    f.repo.retry(change.id,'User supplied the missing accounting receipt');assert.equal(f.repo.message(change.id).state,'waiting');
    f.repo.beginProcessing(change.id);f.repo.transition(change.id,'answered',{response:'Classified as a progress inquiry; no contract changed.'});
    assert.equal(f.repo.hasPendingForRun('project','first'),false);assert.equal(f.repo.message(change.id).kind,'unclassified');
  }finally{f.close();}
});

test('P6 conversation processing freezes its input boundary and prevents out of order or concurrent application',()=>{
  const f=fixture();try{
    draft(f,'first');const conversation=f.repo.ensureForGoal('first'),first=f.repo.receive(message(conversation.id,'first-message')),second=f.repo.receive(message(conversation.id,'second-message'));
    assert.throws(()=>f.repo.beginProcessing(second.id),/Earlier/);
    const processing=f.repo.beginProcessing(first.id);assert.equal(processing.processing?.baseContractVersion,1);assert.equal(processing.processing?.throughSequence,1);
    f.repo.receive(message(conversation.id,'third-message'));assert.deepEqual(f.repo.beginProcessing(first.id),processing);
    assert.throws(()=>f.repo.beginProcessing(second.id),/already processing/);
    assert.throws(()=>f.repo.transition(first.id,'applied',{appliedContractVersion:1}),/newer actual contract/);
    apply(f,'first',{type:'admit',contract:{version:2,goal:'Updated requirements',criteria:[{id:'retained',description:'Retain all requirements',required:true}]},nodes:[{id:'implement',dependencies:[],required:true}]});
    f.repo.transition(first.id,'applied',{appliedContractVersion:2});const next=f.repo.beginProcessing(second.id);assert.equal(next.processing?.baseContractVersion,2);assert.equal(next.processing?.throughSequence,2);
    f.repo.transition(second.id,'clarifying',{response:'Which second behavior is required?'});assert.throws(()=>f.repo.beginProcessing(f.repo.messages(conversation.id)[2]!.id),/Earlier/);
    f.repo.retry(second.id,'A concrete clarification was received');const retried=f.repo.beginProcessing(second.id);assert.equal(retried.processingHistory.length,2);assert.deepEqual(retried.processingHistory[0],next.processing);
  }finally{f.close();}
});

test('P6 conversation unknown usage reserves remain charged after reopening',()=>{
  const f=fixture();try{
    draft(f,'first');const conversation=f.repo.ensureForGoal('first');
    apply(f,'first',{type:'startAttempt',attemptId:'uncertain',nodeId:'@supervisor',contractVersion:1,purpose:'reasoning',reservation:70,resources:[]});
    apply(f,'first',{type:'finishAttempt',attemptId:'uncertain',outcome:'failed'});
    assert.equal(f.repo.budget(conversation.id).reserved,70);assert.equal(f.repo.budget(conversation.id).available,130);assert.throws(()=>f.repo.childAuthorization(conversation.id),/delivered and fully settled/);
    const reopened=new DatabaseSync(f.path);try{migrate(reopened);assert.equal(new ConversationRepository(reopened).budget(conversation.id).reserved,70);}finally{reopened.close();}
  }finally{f.close();}
});

test('P6 conversation linked delivered rounds consume the original authorized budget exactly once',()=>{
  const f=fixture();try{
    draft(f,'first');const conversation=f.repo.ensureForGoal('first'),firstDelivery=delivered(f,'first',60);
    const authorization=f.repo.childAuthorization(conversation.id);assert.equal(authorization.tokenLimit,140);
    draft(f,'second',140);const round=f.repo.attachRound(conversation.id,'second',firstDelivery);assert.equal(round.predecessorRunId,'first');assert.deepEqual(f.repo.attachRound(conversation.id,'second',firstDelivery),round);
    assert.equal(f.repo.budget(conversation.id).spent,60);assert.equal(f.repo.budget(conversation.id).limit,200);
    delivered(f,'second',35);assert.equal(f.repo.childAuthorization(conversation.id).tokenLimit,105);assert.equal(f.repo.budget(conversation.id).spent,95);
    const reopened=new DatabaseSync(f.path);try{migrate(reopened);const repository=new ConversationRepository(reopened);assert.equal(repository.get(conversation.id).activeRunId,'second');assert.equal(repository.budget(conversation.id).remaining,105);}finally{reopened.close();}
  }finally{f.close();}
});

test('P6 conversation rejects reset budgets spent drafts foreign workspaces and parallel active rounds',()=>{
  const f=fixture();try{
    draft(f,'first');const conversation=f.repo.ensureForGoal('first');draft(f,'premature',200);
    assert.throws(()=>f.repo.attachRound(conversation.id,'premature','missing'),/delivered and fully settled/);
    const delivery=delivered(f,'first',60);draft(f,'reset',200);assert.throws(()=>f.repo.attachRound(conversation.id,'reset',delivery),/pristine draft/);
    draft(f,'lowered-reserve',140,f.workspace,1);assert.throws(()=>f.repo.attachRound(conversation.id,'lowered-reserve',delivery),/preserve verification reserve/);
    draft(f,'wrong-workspace',140,join(f.root,'other'));assert.throws(()=>f.repo.attachRound(conversation.id,'wrong-workspace',delivery),/workspace differs/);
    draft(f,'spent-child',140);apply(f,'spent-child',{type:'startAttempt',attemptId:'spent-attempt',nodeId:'@supervisor',contractVersion:1,purpose:'reasoning',reservation:10,resources:[]});apply(f,'spent-child',{type:'finishAttempt',attemptId:'spent-attempt',outcome:'failed'});apply(f,'spent-child',{type:'settleAttempt',attemptId:'spent-attempt',actual:3});assert.throws(()=>f.repo.attachRound(conversation.id,'spent-child',delivery),/pristine draft/);
    draft(f,'good-child',140);assert.throws(()=>f.repo.attachRound(conversation.id,'good-child','wrong-delivery'),/Stale predecessor/);f.repo.attachRound(conversation.id,'good-child',delivery);
    draft(f,'parallel-child',140);assert.throws(()=>f.repo.attachRound(conversation.id,'parallel-child',delivery),/delivered and fully settled/);
    assert.equal(f.repo.rounds(conversation.id).length,2);assert.equal(f.repo.get(conversation.id).activeRunId,'good-child');
    draft(f,'low-balance-parent');const lowBalance=f.repo.ensureForGoal('low-balance-parent'),lowDelivery=delivered(f,'low-balance-parent',170);draft(f,'low-balance-child',30);assert.throws(()=>f.repo.attachRound(lowBalance.id,'low-balance-child',lowDelivery),/retain reasoning budget/);
  }finally{f.close();}
});

test('P6 conversation parent transaction rollback restores contract version and message application together',()=>{
  const f=fixture();try{
    draft(f,'first');const conversation=f.repo.ensureForGoal('first'),messageRecord=f.repo.receive(message(conversation.id,'atomic-revision'));f.repo.beginProcessing(messageRecord.id);
    const before=f.repo.message(messageRecord.id);
    assert.throws(()=>f.repo.transaction(()=>{
      apply(f,'first',{type:'admit',contract:{version:2,goal:'Changed goal',criteria:[{id:'check',description:'A real domain contract change',required:true}]},nodes:[{id:'implement',dependencies:[],required:true}]});
      f.repo.transition(messageRecord.id,'applied',{appliedContractVersion:2});
      assert.equal(f.db.isTransaction,true);throw new Error('Crash before parent commit');
    }),/Crash before parent commit/);
    assert.equal(f.db.isTransaction,false);assert.deepEqual(f.repo.message(messageRecord.id),before);assert.equal(f.repo.hasPendingForRun('project','first'),true);
    const row=f.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get('project','first')!;assert.equal((JSON.parse(String(row.snapshot)) as Run).contract.version,1);
  }finally{f.close();}
});

test('P6 conversation fence blocks new runtime claims but lets a claimed input finish without weakening failed-message fences',()=>{
  const f=fixture();try{
    draft(f,'first');const conversation=f.repo.ensureForGoal('first');
    apply(f,'first',{type:'admit',contract:{version:2,goal:'Two actual repository input operations',criteria:[{id:'check',description:'Persist both inputs',required:true}]},nodes:[{id:'one',dependencies:[],required:true},{id:'two',dependencies:['one'],required:true}]});
    const runtime=new RuntimeRepository(f.db);
    f.repo.transaction(()=>runtime.adoptGoal({type:'submit',commandId:'adopt',workspace:f.workspace,workspaceKind:'project',goal:'Persist inputs',tokenLimit:200,verificationReserve:20,steps:[{id:'one',kind:'input',prompt:'First input'},{id:'two',kind:'input',prompt:'Second input'}]},'project','first'));
    f.repo.receive(message(conversation.id,'question','question'));runtime.control({type:'input',commandId:'input-one',runtimeId:'first',stepId:'one',text:'Actual first input'});
    const claimed=runtime.claim('first','worker');assert.ok(claimed,'An explicit question cannot fence dispatch');
    const change=f.repo.receive(message(conversation.id,'change'));assert.doesNotThrow(()=>runtime.eligible(claimed.id,'worker'));runtime.markStarted(claimed.id,'worker');
    runtime.report(claimed.id,'worker',{messageId:'report-first',outcome:'confirmed',result:{input:'Actual first input'}});
    assert.equal(runtime.inspect('first').run.attempts[0]!.settled,true);
    runtime.control({type:'input',commandId:'input-two',runtimeId:'first',stepId:'two',text:'Actual second input'});assert.equal(runtime.claim('first','worker'),null);
    f.repo.transition(change.id,'failed',{reason:'The new requirement needs reconciliation'});assert.equal(runtime.claim('first','worker'),null);assert.equal(runtime.inspect('first').runtime.cursor,1);
  }finally{f.close();}
});

test('P6 conversation runtime revision commit-hook rollback restores queued work checkpoint and message atomically',()=>{
  const f=fixture();try{
    draft(f,'first');const conversation=f.repo.ensureForGoal('first');
    apply(f,'first',{type:'admit',contract:{version:2,goal:'Original plan',criteria:[{id:'check',description:'Original retained check',required:true}]},nodes:[{id:'one',dependencies:[],required:true}]});
    const runtime=new RuntimeRepository(f.db);
    f.repo.transaction(()=>runtime.adoptGoal({type:'submit',commandId:'adopt',workspace:f.workspace,workspaceKind:'project',goal:'Original plan',tokenLimit:200,verificationReserve:20,steps:[{id:'one',kind:'input',prompt:'Original input'}]},'project','first'));
    const received=f.repo.receive(message(conversation.id,'atomic-replan'));f.repo.beginProcessing(received.id);const beforeRuntime=runtime.inspect('first'),beforeMessage=f.repo.message(received.id);
    assert.throws(()=>runtime.revise({commandId:'replan',runtimeId:'first',expectedContractVersion:2,contract:{version:3,goal:'Updated plan',criteria:[{id:'check',description:'Original retained check',required:true}]},nodes:[{id:'two',dependencies:[],required:true}],steps:[{id:'two',kind:'input',prompt:'Updated input'}],reason:'Explicit requested plan change'},()=>{
      f.repo.transition(received.id,'applied',{appliedContractVersion:3});assert.equal(f.db.isTransaction,true);throw new Error('Atomic message acknowledgement failed');
    }),/Atomic message acknowledgement failed/);
    assert.deepEqual(runtime.inspect('first'),beforeRuntime);assert.deepEqual(f.repo.message(received.id),beforeMessage);assert.equal(f.repo.hasPendingForRun('project','first'),true);
  }finally{f.close();}
});
