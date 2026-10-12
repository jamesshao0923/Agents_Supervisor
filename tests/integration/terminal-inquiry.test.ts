import { acceptedDeliveryFixture } from '../fixtures/accepted-delivery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { ConversationController } from '../../packages/orchestration/conversation-controller.js';
import { LocalRuntimeAdapter } from '../../packages/runtime/index.js';
import { ConversationRepository } from '../../packages/persistence/conversations.js';
import { migrate } from '../../packages/persistence/migrations.js';
import { applyAction } from '../../packages/domain/index.js';
import type { GoalSession,GoalProposal,GoalInspection } from '../../packages/contracts/p5.js';
import type { RunAction } from '../../packages/contracts/p1.js';
import type { TerminalAssessmentResult,TerminalAssessmentJob } from '../../packages/contracts/p6.js';

// These are real SQLite/domain/controller mechanism tests. Model result and
// delivery records are explicitly persisted fixtures, not model acceptance.
// No fake reasoner/runtime is installed and no model request may be dispatched.
function fixture(maxContextChars=60000){
  const root=mkdtempSync(join(tmpdir(),'sv-terminal-inquiry-')),workspace=join(root,'project'),data=join(root,'data');mkdirSync(workspace);
  const store=new SupervisorStore(data),path=join(data,'supervisor.sqlite'),db=new DatabaseSync(path);migrate(db);
  const proof=join(root,'fixture-proof.txt'),contents='Repository/controller fixture; this file is not model execution evidence.';writeFileSync(proof,contents);
  const proofDigest=createHash('sha256').update(contents).digest('hex'),adapter=new LocalRuntimeAdapter(store,data),controller=new ConversationController(store,data,adapter);
  return {root,workspace,data,path,db,proof,proofDigest,maxContextChars,store,adapter,controller,goals:store.goals,conversations:store.conversations,runtime:store.runtime,close:async()=>{await controller.close();await adapter.close();db.close();store.close();rmSync(root,{recursive:true,force:true});}};
}
function proposal(session:GoalSession,label='Initial plan'):GoalProposal {
  return {decision:'ready',summary:label,questions:[],facts:session.messages.map(message=>({text:message.text,sourceId:message.id,origin:'explicit'})),constraints:[],style:[],criteria:[{id:'sum',description:'sum(2,3)=5',kind:'command',target:'sum.test.mjs',checks:['Returns exactly five']},{id:'retention',description:'Preserve user requirements',kind:'command',target:'sum.test.mjs',checks:['Retains all explicitly requested behavior']}],steps:[{id:'implement',description:label,dependencies:[],acceptanceIds:['sum','retention']}]};
}
function ready(f:ReturnType<typeof fixture>,commandId='initial',limit=300,initialUsage=10):GoalInspection {
  const initial=f.goals.start({type:'start',commandId,goal:'Produce a local sum function',model:'unused-repository-fixture',effort:'low',reservation:30,timeoutMs:1000,tokenLimit:limit,verificationReserve:20,maxContextChars:f.maxContextChars},f.workspace,'project');
  const result=f.goals.finish(initial.session.id,initial.session.jobs[0]!.id,job=>{job.usage=initialUsage;job.stopConfirmed=true;job.proposal=proposal(initial.session);});
  f.conversations.ensureForGoal(result.session.id);return result;
}
function admit(f:ReturnType<typeof fixture>,goal:GoalInspection):GoalInspection {return f.goals.control({type:'admit',commandId:'admit-'+goal.session.id,sessionId:goal.session.id,expectedRevision:goal.session.revision});}
function receive(f:ReturnType<typeof fixture>,goal:GoalInspection,commandId='change',kind:'question'|'change'|'unclassified'='change'){
  const conversation=f.conversations.forRun(goal.run.projectId,goal.run.id)!;
  return f.conversations.receive({conversationId:conversation.id,commandId,kind,source:'user',text:kind==='question'?'What is the progress?':'Also support zero operands'});
}
function finishFollowup(f:ReturnType<typeof fixture>,goal:GoalInspection,label='Implement the added behavior',usage:number|null=7):GoalInspection {
  const job=goal.session.jobs.at(-1)!;
  return f.goals.finish(goal.session.id,job.id,record=>{record.usage=usage;record.stopConfirmed=true;record.proofs={[f.proof]:f.proofDigest};record.followupResult={decision:'revise',response:label,proposal:proposal(goal.session,label),retiredCriterionIds:[],retirementSources:[]};});
}
function domain(f:ReturnType<typeof fixture>,sessionId:string,action:RunAction):void {
  const inspection=f.goals.inspect(sessionId),result=applyAction(inspection.run,action);
  f.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE project_id=? AND id=?').run(result.run.revision,JSON.stringify(result.run),result.run.projectId,sessionId);
}
function inputRuntime(f:ReturnType<typeof fixture>,goal:GoalInspection):GoalInspection {
  const inspection=admit(f,goal),runtimeId=inspection.session.runtimeId!;
  f.runtime.revise({commandId:'input-plan-'+runtimeId,runtimeId,expectedContractVersion:inspection.run.contract.version,contract:{...inspection.run.contract,version:inspection.run.contract.version+1},nodes:[{id:'local-input',dependencies:[],required:true}],steps:[{id:'local-input',kind:'input',prompt:'Supply an actual durable test input'}],reason:'Repository integration fixture uses a real input operation instead of calling a model'});
  return f.goals.inspect(goal.session.id);
}
function completeInput(f:ReturnType<typeof fixture>,goal:GoalInspection):GoalInspection {
  const runtimeId=goal.session.runtimeId!;
  f.runtime.control({type:'input',commandId:'supply-'+runtimeId,runtimeId,stepId:'local-input',text:'persisted actual input'});
  const operation=f.runtime.claim(runtimeId,'repository-worker');assert.ok(operation);f.runtime.markStarted(operation.id,'repository-worker');
  f.runtime.report(operation.id,'repository-worker',{messageId:'report-'+runtimeId,outcome:'confirmed',result:{input:'persisted actual input'}});return f.goals.inspect(goal.session.id);
}
async function deliverFixture(f:ReturnType<typeof fixture>,goal:GoalInspection,verificationUsage=0):Promise<string> {
  return acceptedDeliveryFixture(f.db,f.root,goal.run,f.workspace,verificationUsage);
}


async function delivered(f:ReturnType<typeof fixture>){const goal=completeInput(f,inputRuntime(f,ready(f)));await deliverFixture(f,goal);return f.goals.inspect(goal.session.id);}
function oldBytes(f:ReturnType<typeof fixture>){return JSON.stringify(['runs','goal_sessions','runtime_runs','runtime_checkpoints','verification_records'].map(table=>[table,f.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));}
function ask(f:ReturnType<typeof fixture>,goal:GoalInspection,key='question',kind:'question'|'change'|'unclassified'='question',replyToMessageId?:string){return f.conversations.receive({conversationId:f.conversations.forRun(goal.run.projectId,goal.run.id)!.id,commandId:key,source:'user',kind,text:kind==='question'?'What was delivered?':'Please clarify whether new work is needed.',...(replyToMessageId?{replyToMessageId}:{})});}
function finishAssessment(f:ReturnType<typeof fixture>,job:TerminalAssessmentJob,result:TerminalAssessmentResult={decision:'answer',response:'Recorded delivery remains unchanged.',questions:[]},usage:number|null=7){return f.conversations.finishAssessment(job.id,{usage,stopConfirmed:true,proofs:{[f.proof]:f.proofDigest},threadId:null,result,error:null});}

test('P6-TERM-I01 terminal question publishes once across SQLite reopen without changing historical Run Goal runtime or delivery bytes',async()=>{
  const f=fixture();try{
    const goal=await delivered(f),before=oldBytes(f),message=ask(f,goal),job=f.conversations.beginAssessment(message.id);
    assert.deepEqual(f.conversations.beginAssessment(message.id),job);finishAssessment(f,job);
    await f.controller.initialize();await f.controller.scan();const published=f.conversations.message(message.id);
    assert.equal(published.state,'answered');assert.equal(published.history.filter(h=>h.state==='answered').length,1);assert.equal(oldBytes(f),before);
    assert.equal(f.conversations.rounds(job.conversationId).length,1);assert.equal(f.conversations.get(job.conversationId).activeRunId,goal.run.id);
    assert.equal(f.conversations.budget(job.conversationId).reasoningSpent,7);assert.equal(f.conversations.budget(job.conversationId).spent,goal.run.budget.spent+7);
    const reopened=new DatabaseSync(f.path);try{migrate(reopened);const repository=new ConversationRepository(reopened);assert.deepEqual(repository.publishAssessment(job.id),f.conversations.assessment(job.id));assert.deepEqual(repository.message(message.id),published);}finally{reopened.close();}
    assert.equal(existsSync(join(f.data,'reasoning')),false,'No real model was requested by this mechanism fixture');
  }finally{await f.close();}
});

test('P6-TERM-I02 external reasoning budget reserves actual cost once preserves unknown usage and authorizes exact remaining child limit',async()=>{
  const f=fixture();try{
    const goal=await delivered(f),message=ask(f,goal),job=f.conversations.beginAssessment(message.id),initial=f.conversations.budget(job.conversationId);
    assert.equal(initial.reasoningReserved,30);assert.equal(initial.available,300-goal.run.budget.spent-30);
    const result={usage:7,stopConfirmed:true,proofs:{[f.proof]:f.proofDigest},threadId:null,result:{decision:'answer' as const,response:'Answer',questions:[]},error:null};
    f.conversations.finishAssessment(job.id,result);assert.deepEqual(f.conversations.finishAssessment(job.id,result),f.conversations.assessment(job.id));f.conversations.publishAssessment(job.id);
    const authorization=f.conversations.childAuthorization(job.conversationId);assert.equal(authorization.tokenLimit,300-goal.run.budget.spent-7);
    const next=ask(f,goal,'unknown'),unknown=f.conversations.beginAssessment(next.id);finishAssessment(f,unknown,{decision:'answer',response:'Uncertain',questions:[]},null);
    assert.equal(f.conversations.budget(job.conversationId).reasoningReserved,30);assert.equal(f.conversations.budget(job.conversationId).reasoningSpent,7);
    assert.throws(()=>f.conversations.childAuthorization(job.conversationId),/unresolved/);assert.throws(()=>f.conversations.retry(next.id,'Retry explicitly'),/Unresolved/);assert.equal(f.goals.inspect(goal.session.id).run.status,'succeeded');
  }finally{await f.close();}
});

test('P6-TERM-I03 unclassified answer and clarification keep old round; a clarified inquiry clears only its own parent chain',async()=>{
  const f=fixture();try{
    const goal=await delivered(f),before=oldBytes(f),first=ask(f,goal,'ambiguous','unclassified'),job=f.conversations.beginAssessment(first.id);
    finishAssessment(f,job,{decision:'clarify',response:'Do you want new work or a status explanation?',questions:['Which intent?']});f.conversations.publishAssessment(job.id);
    assert.equal(f.conversations.rounds(job.conversationId).length,1);assert.equal(f.conversations.hasPendingForRun(goal.run.projectId,goal.run.id),true);
    const reply=ask(f,goal,'inquiry-reply','unclassified',first.id),second=f.conversations.beginAssessment(reply.id);finishAssessment(f,second);f.conversations.publishAssessment(second.id);
    assert.equal(f.conversations.message(first.id).state,'answered');assert.equal(f.conversations.message(reply.id).state,'answered');assert.equal(f.conversations.hasPendingForRun(goal.run.projectId,goal.run.id),false);assert.equal(oldBytes(f),before);
  }finally{await f.close();}
});

test('P6-TERM-I04 continue promotion rolls back completely then creates one exact-budget child and applies terminal clarification ancestors atomically',async()=>{
  const f=fixture();try{
    const goal=await delivered(f),first=ask(f,goal,'ambiguous','unclassified'),one=f.conversations.beginAssessment(first.id);
    finishAssessment(f,one,{decision:'clarify',response:'Specify extra behavior.',questions:['What should be added?']});f.conversations.publishAssessment(one.id);
    const reply=ask(f,goal,'new-work','change',first.id),two=f.conversations.beginAssessment(reply.id);finishAssessment(f,two,{decision:'continue',response:'Plan the requested addition.',questions:[]});
    const before=oldBytes(f),oldParent=f.conversations.message(first.id),beforeMessage=f.conversations.message(reply.id);
    assert.throws(()=>f.conversations.transaction(()=>{f.goals.promoteAssessment(two.id);throw new Error('rollback after child begin');}),/rollback/);
    assert.equal(oldBytes(f),before);assert.deepEqual(f.conversations.message(reply.id),beforeMessage);assert.equal(f.conversations.assessment(two.id).promotion,null);
    const child=f.goals.promoteAssessment(two.id);assert.equal(child.run.budget.limit,300-goal.run.budget.spent-14);assert.equal(child.run.budget.verificationReserve,goal.run.budget.verificationReserve);
    assert.equal(f.conversations.rounds(two.conversationId).length,2);assert.deepEqual(f.goals.promoteAssessment(two.id),child);assert.deepEqual(f.conversations.message(first.id).processing,oldParent.processing);
    assert.equal(f.goals.inspect(goal.session.id).run.status,'succeeded');assert.equal(f.conversations.message(reply.id).processingHistory.length,2);
    finishFollowup(f,child);const applied=f.goals.applyFollowup(child.session.id,child.session.jobs.at(-1)!.id);
    assert.equal(f.conversations.message(first.id).state,'applied');assert.equal(f.conversations.message(reply.id).state,'applied');assert.equal(f.conversations.message(first.id).appliedContractVersion,applied.run.contract.version);
    assert.equal(f.conversations.budget(two.conversationId).spent,goal.run.budget.spent+14+7);assert.equal(f.goals.inspect(goal.session.id).session.jobs.length,goal.session.jobs.length);
  }finally{await f.close();}
});

test('P6-TERM-I05 scoped cancellation suppresses late publication and stale cancel never cancels a retried assessment',async()=>{
  const f=fixture();try{
    const goal=await delivered(f),before=oldBytes(f),message=ask(f,goal),one=f.conversations.beginAssessment(message.id);
    await f.controller.dispatch({type:'cancelAssessment',conversationId:one.conversationId,messageId:message.id,assessmentId:one.id});
    finishAssessment(f,one);assert.equal(f.conversations.message(message.id).state,'failed');assert.throws(()=>f.conversations.publishAssessment(one.id),/cancelled/);
    f.conversations.retry(message.id,'User explicitly retries after known settlement');const two=f.conversations.beginAssessment(message.id);
    await f.controller.dispatch({type:'cancelAssessment',conversationId:one.conversationId,messageId:message.id,assessmentId:one.id});
    assert.equal(f.conversations.assessment(two.id).cancelRequested,false);assert.equal(f.conversations.message(message.id).state,'processing');assert.equal(oldBytes(f),before);
    finishAssessment(f,two);await f.controller.scan();assert.equal(f.conversations.message(message.id).state,'answered');
  }finally{await f.close();}
});

test('P6-TERM-I06 proof tampering rejects terminal publication; interrupted possible turn remains unknown and never replays on restart',async()=>{
  const f=fixture();try{
    const goal=await delivered(f),before=oldBytes(f),message=ask(f,goal),job=f.conversations.beginAssessment(message.id);finishAssessment(f,job);writeFileSync(f.proof,'Changed fixture proof');
    await f.controller.initialize();assert.equal(f.conversations.message(message.id).state,'failed');assert.equal(f.conversations.rounds(job.conversationId).length,1);
    const next=ask(f,goal,'interrupted'),interrupted=f.conversations.beginAssessment(next.id);f.conversations.observeAssessment(interrupted.id,{modelStarted:true});
    const recovery=new ConversationController(f.store,f.data,f.adapter);try{await recovery.initialize();assert.equal(f.conversations.assessment(interrupted.id).usage,null);assert.equal(f.conversations.assessment(interrupted.id).settled,false);assert.equal(f.conversations.budget(job.conversationId).reasoningReserved,30);await recovery.scan();assert.equal(f.conversations.assessments(job.conversationId).length,2);}finally{await recovery.close();}
    assert.equal(oldBytes(f),before);assert.equal(existsSync(join(f.data,'reasoning')),false);
  }finally{await f.close();}
});

test('P6-TERM-I07 terminal capacity rejection occurs before process intent and cannot replace delivered status',async()=>{
  const f=fixture(8000);try{
    const goal=await delivered(f),before=oldBytes(f),id=f.conversations.forRun(goal.run.projectId,goal.run.id)!.id;
    await f.controller.dispatch({type:'send',conversationId:id,commandId:'capacity',kind:'question',text:'Explain recorded status. '.repeat(600)});
    await f.controller.scan();const job=f.conversations.assessments(id)[0]!;
    assert.equal(job.status,'finished');assert.match(job.error!,/容量/);assert.equal(job.usage,0);assert.equal(job.settled,true);assert.deepEqual(job.intents,[]);assert.equal(job.modelStarted,false);assert.equal(f.conversations.rounds(id).length,1);assert.equal(oldBytes(f),before);assert.equal(existsSync(join(f.data,'reasoning')),false);
  }finally{await f.close();}
});

test('P6-TERM-I08 assessment overruns remain actual spend while contradictory final usage stays unknown with its original report',async()=>{
  const f=fixture();try{
    const goal=await delivered(f),before=oldBytes(f),message=ask(f,goal),job=f.conversations.beginAssessment(message.id);
    const result={usage:350,stopConfirmed:true,proofs:{[f.proof]:f.proofDigest},threadId:null,result:{decision:'answer' as const,response:'Fixture result',questions:[]},error:null};
    const finished=f.conversations.finishAssessment(job.id,result);assert.match(finished.error!,/reservation/);assert.equal(finished.result,null);assert.equal(finished.reportedUsage,350);assert.deepEqual(f.conversations.finishAssessment(job.id,result),finished);
    const budget=f.conversations.budget(job.conversationId);assert.equal(budget.reasoningSpent,350);assert.equal(budget.spent,goal.run.budget.spent+350);assert.equal(budget.reasoningReserved,0);assert.ok(budget.remaining!<0);
    assert.throws(()=>f.conversations.childAuthorization(job.conversationId),/exhausted/);f.conversations.retry(message.id,'Explicit retry cannot refill budget');assert.throws(()=>f.conversations.beginAssessment(message.id),/exhausted/);
    assert.equal(f.conversations.assessments(job.conversationId).length,1);assert.equal(oldBytes(f),before);
    const g=fixture();try{
      const deliveredGoal=await delivered(g),inquiry=ask(g,deliveredGoal),assessment=g.conversations.beginAssessment(inquiry.id);
      g.conversations.observeAssessment(assessment.id,{observedUsage:15});assert.throws(()=>g.conversations.observeAssessment(assessment.id,{observedUsage:5}),/decrease/);
      const completion={usage:5,stopConfirmed:true,proofs:{[g.proof]:g.proofDigest},threadId:'fixture-recorded-thread',result:{decision:'answer' as const,response:'Discard contradictory result',questions:[]},error:null};
      const contradictory=g.conversations.finishAssessment(assessment.id,completion);
      assert.equal(contradictory.reportedUsage,5);assert.equal(contradictory.usage,null);assert.equal(contradictory.observedUsage,15);assert.equal(contradictory.stopConfirmed,true);assert.deepEqual(contradictory.proofs,completion.proofs);assert.equal(contradictory.threadId,completion.threadId);assert.equal(contradictory.result,null);assert.match(contradictory.error!,/contradicts/);
      assert.equal(g.conversations.budget(assessment.conversationId).reasoningReserved,30);assert.equal(g.conversations.budget(assessment.conversationId).reasoningSpent,0);assert.deepEqual(g.conversations.finishAssessment(assessment.id,completion),contradictory);assert.throws(()=>g.conversations.childAuthorization(assessment.conversationId),/unresolved/);
    }finally{await g.close();}
  }finally{await f.close();}
});
