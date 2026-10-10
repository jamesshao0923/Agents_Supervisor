import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { LocalRuntimeAdapter } from '../../packages/runtime/index.js';
import { ConversationController } from '../../packages/orchestration/conversation-controller.js';
import { startService } from '../../apps/supervisor/server.js';
import { request } from '../../apps/cli/client.js';
import type { GoalInspection,GoalProposal,GoalSession } from '../../packages/contracts/p5.js';
import type { ConversationInspection } from '../../packages/contracts/p6-actions.js';

// These tests exercise real controller/SQLite/socket/file-integrity paths. Completed
// proposals and interrupted-model states are explicit repository fixtures, not
// fake reasoners, model execution, independent model review, or live acceptance.
function fixture(){
  // Keep the actual service socket below macOS's Unix-domain path limit.
  const root=mkdtempSync('/tmp/sv-p6-cc-'),workspace=join(root,'project'),data=join(root,'data');mkdirSync(workspace);
  const store=new SupervisorStore(data),runtime=new LocalRuntimeAdapter(store,data),controller=new ConversationController(store,data,runtime);
  return {root,workspace,data,store,runtime,controller,close:async()=>{await controller.close();await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}};
}
function proposal(session:GoalSession):GoalProposal {return {decision:'ready',summary:'Repository fixture plan',questions:[],facts:session.messages.map(message=>({text:message.text,sourceId:message.id,origin:'explicit'})),constraints:[],style:[],criteria:[{id:'addition',description:'sum(2,3) returns 5',kind:'command',target:'sum.test.mjs',checks:['Assert exact arithmetic result']}],steps:[{id:'implement',description:'Implement the arithmetic',dependencies:[],acceptanceIds:['addition']}]};}
function start(f:ReturnType<typeof fixture>,options:{finish?:boolean;unknownUsage?:boolean;maxContextChars?:number}={}):GoalInspection {
  const initial=f.store.goals.start({type:'start',commandId:'initial',goal:'Produce a local sum function',model:'unused-repository-fixture',effort:'low',reservation:30,timeoutMs:1000,tokenLimit:300,verificationReserve:20,maxContextChars:options.maxContextChars??60000},f.workspace,'project');
  f.store.conversations.ensureForGoal(initial.session.id);
  if(options.finish===false)return initial;
  return f.store.goals.finish(initial.session.id,initial.session.jobs[0]!.id,job=>{job.usage=options.unknownUsage?null:0;job.stopConfirmed=true;job.proposal=proposal(initial.session);});
}
function conversationId(f:ReturnType<typeof fixture>,goal:GoalInspection):string{return f.store.conversations.forRun(goal.run.projectId,goal.run.id)!.id;}
function received(f:ReturnType<typeof fixture>,goal:GoalInspection,commandId:string,kind:'question'|'change'|'unclassified'='question',text='What is the progress?') {return f.store.conversations.receive({conversationId:conversationId(f,goal),commandId,source:'user',kind,text});}
function finishedAnswer(f:ReturnType<typeof fixture>,goal:GoalInspection,commandId='answer',kind:'question'|'unclassified'='question') {
  const message=received(f,goal,commandId,kind),begun=f.store.goals.beginFollowup(goal.session.id,message.id),jobId=begun.session.jobs.at(-1)!.id;
  const proofPath=join(f.root,commandId+'-proof.json'),proofBody=JSON.stringify({kind:'repository-controller-fixture',messageId:message.id,response:'The initial plan is ready; execution has not started.'});writeFileSync(proofPath,proofBody);
  f.store.goals.finish(goal.session.id,jobId,job=>{job.usage=0;job.stopConfirmed=true;job.proofs={[proofPath]:createHash('sha256').update(proofBody).digest('hex')};job.followupResult={decision:'answer',response:'The initial plan is ready; execution has not started.',proposal:null,retiredCriterionIds:[],retirementSources:[]};});
  return {message,jobId,proofPath};
}
async function settleController(controller:ConversationController):Promise<void>{
  // Capacity failure resolves synchronously before the real reasoner request.
  // Serial scans drain publication without sleeping or simulating a timer window.
  await controller.scan();await controller.scan();
}

test('P6-CC-I01 send receipts queue once during P5 reasoning and existing follow-up processing without additional jobs',async()=>{
  for(const phase of ['p5','followup'] as const){
    const f=fixture();try{
      let goal=start(f,{finish:phase!=='p5'});
      if(phase==='followup'){const previous=received(f,goal,'already-processing','change','Also support negatives');goal=f.store.goals.beginFollowup(goal.session.id,previous.id);}
      const beforeJobs=goal.session.jobs.length,action={type:'send',conversationId:conversationId(f,goal),commandId:'queued-send',kind:'change',text:'Also support zero operands'};
      const first=await f.controller.dispatch(action) as ConversationInspection,second=await f.controller.dispatch(action) as ConversationInspection;
      assert.equal(second.messages.filter(message=>message.commandId===action.commandId).length,1);assert.deepEqual(second.messages,first.messages);assert.equal(second.active.session.jobs.length,beforeJobs);
      assert.equal(second.messages.at(-1)!.state,phase==='p5'?'waiting':'received');
      await assert.rejects(f.controller.dispatch({...action,text:'Conflicting text'}),/Conflicting conversation commandId/);
      await f.controller.scan();assert.equal(f.store.goals.inspect(goal.session.id).session.jobs.length,beforeJobs);assert.equal(existsSync(join(f.data,'reasoning')),false);
    }finally{await f.close();}
  }
});

test('P6-CC-I02 unknown prior usage blocks queued follow-up with its reservation retained and no new model job',async()=>{
  const f=fixture();try{
    const goal=start(f,{unknownUsage:true}),id=conversationId(f,goal),before=f.store.goals.inspect(goal.session.id);
    const result=await f.controller.dispatch({type:'send',conversationId:id,commandId:'blocked',kind:'change',text:'Add the requested behavior'}) as ConversationInspection;
    assert.equal(result.messages[0]!.state,'failed');assert.match(result.messages[0]!.history.at(-1)!.reason!,/用量|尚未确认/);assert.equal(result.active.session.jobs.length,before.session.jobs.length);
    assert.equal(result.budget.reserved,30);assert.equal(result.budget.spent,0);assert.equal(f.store.conversations.hasPendingForRun(goal.run.projectId,goal.run.id),true);
    await f.controller.scan();assert.deepEqual(f.store.goals.inspect(goal.session.id),before);assert.equal(existsSync(join(f.data,'reasoning')),false);
  }finally{await f.close();}
});

test('P6-CC-I03 context capacity fails before the real reasoner process receives an intent and settles known zero usage',async()=>{
  const f=fixture();try{
    const goal=start(f,{maxContextChars:8000}),id=conversationId(f,goal),longRequirement='Retain the complete requirement. '.repeat(600);
    await f.controller.dispatch({type:'send',conversationId:id,commandId:'too-large',kind:'change',text:longRequirement});await settleController(f.controller);
    const inspection=f.store.goals.inspect(goal.session.id),job=inspection.session.jobs.at(-1)!,message=f.store.conversations.messages(id)[0]!;
    assert.equal(inspection.session.jobs.length,2);assert.equal(job.purpose,'followup');assert.equal(job.status,'finished');assert.match(job.error!,/上下文超过容量/);
    assert.equal(job.modelStarted,false);assert.deepEqual(job.intents,[]);assert.deepEqual(job.identities,[]);assert.equal(job.usage,0);assert.equal(job.stopConfirmed,true);assert.equal(job.threadId,null);
    assert.equal(inspection.run.attempts.at(-1)!.settled,true);assert.equal(inspection.run.budget.spent,0);assert.equal(message.state,'failed');assert.equal(message.text,longRequirement);assert.equal(f.store.conversations.hasPendingForRun(goal.run.projectId,goal.run.id),true);
    assert.equal(existsSync(join(f.data,'reasoning')),false);assert.equal(f.store.executionList().length,0);assert.equal(f.store.runtime.list().length,0);
  }finally{await f.close();}
});

test('P6-CC-I04 restored finished answer publishes once after checking its actual proof file SHA without changing requirements',async()=>{
  const f=fixture();try{
    const goal=start(f),id=conversationId(f,goal),answer=finishedAnswer(f,goal),before=f.store.goals.inspect(goal.session.id);
    assert.equal(f.store.conversations.message(answer.message.id).state,'processing');
    await f.controller.initialize();const published=f.store.conversations.message(answer.message.id);
    assert.equal(published.state,'answered');assert.match(published.response!,/execution has not started/);assert.equal(published.history.filter(entry=>entry.state==='answered').length,1);
    await f.controller.scan();await f.controller.scan();assert.deepEqual(f.store.conversations.message(answer.message.id),published);assert.deepEqual(f.store.goals.inspect(goal.session.id),before);assert.deepEqual(before.session.messages,goal.session.messages);
    assert.equal(f.store.goals.inspect(goal.session.id).session.jobs.length,2);assert.equal(f.store.conversations.budget(id).reserved,0);assert.equal(existsSync(join(f.data,'reasoning')),false);
  }finally{await f.close();}
});

test('P6-CC-I05 changed proof bytes prevent recovered answer publication and retain the unclassified message fence',async()=>{
  const f=fixture();try{
    const goal=start(f),answer=finishedAnswer(f,goal,'tampered','unclassified'),before=f.store.goals.inspect(goal.session.id);writeFileSync(answer.proofPath,'Changed after the persisted digest was recorded');
    await f.controller.initialize();const rejected=f.store.conversations.message(answer.message.id);
    assert.equal(rejected.state,'failed');assert.equal(rejected.response,null);assert.match(rejected.history.at(-1)!.reason!,/证据已经改变/);assert.equal(rejected.history.some(entry=>entry.state==='answered'),false);
    assert.equal(f.store.conversations.hasPendingForRun(goal.run.projectId,goal.run.id),true);await f.controller.scan();assert.deepEqual(f.store.conversations.message(answer.message.id),rejected);assert.deepEqual(f.store.goals.inspect(goal.session.id),before);assert.equal(existsSync(join(f.data,'reasoning')),false);
  }finally{await f.close();}
});

test('P6-CC-I06 real service restarts preserve messages and reconcile an interrupted-model fixture without resending it',async()=>{
  const f=fixture();let service:Awaited<ReturnType<typeof startService>>|undefined,storeClosed=false;
  try{
    const goal=start(f),first=received(f,goal,'interrupted','change','Preserve a queued requirement through restart'),begun=f.store.goals.beginFollowup(goal.session.id,first.id),jobId=begun.session.jobs.at(-1)!.id;
    // Seed only the durable observation of an interrupted turn. No model process
    // is launched: the purpose is to prove recovery refuses an unaccounted replay.
    f.store.goals.update(goal.session.id,jobId,job=>{job.modelStarted=true;});
    const later=received(f,goal,'later','change','Apply only after the prior uncertainty is resolved'),id=conversationId(f,goal),beforeJobs=f.store.goals.inspect(goal.session.id).session.jobs.length;
    await f.controller.close();await f.runtime.close();f.store.close();storeClosed=true;
    for(let restart=0;restart<2;restart++){
      service=await startService(f.data);
      const response=await request(f.data,{id:'inspect-'+restart,method:'conversation',action:{type:'inspect',conversationId:id}});assert.equal(response.ok,true);
      const value=response.value as ConversationInspection,recovered=value.active.session.jobs.find(job=>job.id===jobId)!;
      assert.equal(value.active.session.jobs.length,beforeJobs);assert.equal(recovered.status,'finished');assert.equal(recovered.usage,null);assert.equal(value.budget.reserved,30);
      assert.equal(value.messages.find(message=>message.id===first.id)!.state,'failed');assert.equal(value.messages.find(message=>message.id===later.id)!.text,later.text);assert.equal(value.messages.find(message=>message.id===later.id)!.state,'received');
      const retryReceipt=await request(f.data,{id:'retry-receipt-'+restart,method:'conversation',action:{type:'send',conversationId:id,commandId:later.commandId,kind:later.kind,text:later.text}});assert.equal(retryReceipt.ok,true);
      const unchanged=retryReceipt.value as ConversationInspection;assert.equal(unchanged.messages.length,2);assert.equal(unchanged.active.session.jobs.length,beforeJobs);
      assert.equal(existsSync(join(f.data,'reasoning')),false);await service.close();service=undefined;
    }
  }finally{await service?.close();if(!storeClosed)await f.close();else rmSync(f.root,{recursive:true,force:true});}
});
