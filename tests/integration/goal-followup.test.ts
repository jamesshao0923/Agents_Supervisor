import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../packages/persistence/migrations.js';
import { GoalRepository } from '../../packages/persistence/goals.js';
import { ConversationRepository } from '../../packages/persistence/conversations.js';
import { RuntimeRepository } from '../../packages/persistence/runtime.js';
import { applyAction } from '../../packages/domain/index.js';
import type { GoalSession,GoalProposal,GoalInspection } from '../../packages/contracts/p5.js';
import type { RunAction } from '../../packages/contracts/p1.js';

// Repository integration fixtures use explicit ledger/model-output records. No
// reasoner substitute is executed, and these tests do not claim model acceptance.
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sv-p6-followup-')),workspace=join(root,'project');mkdirSync(workspace);
  const path=join(root,'state.sqlite'),db=new DatabaseSync(path);migrate(db);
  const proof=join(root,'repository-proof.txt'),contents='Actual local proof file for repository integrity inputs; no model was invoked.';writeFileSync(proof,contents);
  const proofDigest=createHash('sha256').update(contents).digest('hex');
  return {root,workspace,path,db,proof,proofDigest,goals:new GoalRepository(db),conversations:new ConversationRepository(db),runtime:new RuntimeRepository(db),close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}
function proposal(session:GoalSession,label='Initial plan'):GoalProposal {
  return {decision:'ready',summary:label,questions:[],facts:session.messages.map(message=>({text:message.text,sourceId:message.id,origin:'explicit'})),constraints:[],style:[],criteria:[{id:'sum',description:'sum(2,3)=5',kind:'command',target:'sum.test.mjs',checks:['Returns exactly five']},{id:'retention',description:'Preserve user requirements',kind:'command',target:'sum.test.mjs',checks:['Retains all explicitly requested behavior']}],steps:[{id:'implement',description:label,dependencies:[],acceptanceIds:['sum','retention']}]};
}
function ready(f:ReturnType<typeof fixture>,commandId='initial',limit=300,initialUsage=10):GoalInspection {
  const initial=f.goals.start({type:'start',commandId,goal:'Produce a local sum function',model:'unused-repository-fixture',effort:'low',reservation:30,timeoutMs:1000,tokenLimit:limit,verificationReserve:20},f.workspace,'project');
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
function deliverFixture(f:ReturnType<typeof fixture>,goal:GoalInspection,verificationUsage=0):string {
  const version=goal.run.contract.version,digest='a'.repeat(64);
  domain(f,goal.session.id,{type:'setArtifact',artifact:{id:'fixture-artifact',path:f.proof,digest,contractVersion:version}});
  if(verificationUsage>0){
    domain(f,goal.session.id,{type:'startAttempt',attemptId:'fixture-verification-accounting',nodeId:goal.run.nodes.at(-1)!.id,contractVersion:version,purpose:'verification',reservation:verificationUsage,resources:[]});
    domain(f,goal.session.id,{type:'finishAttempt',attemptId:'fixture-verification-accounting',outcome:'succeeded'});
    domain(f,goal.session.id,{type:'settleAttempt',attemptId:'fixture-verification-accounting',actual:verificationUsage});
  }
  for(const criterion of goal.run.contract.criteria)domain(f,goal.session.id,{type:'recordEvidence',evidence:{id:'fixture-evidence-'+criterion.id,criterionId:criterion.id,contractVersion:version,artifactDigest:digest,verdict:'passed',verifierVersion:'repository-fixture-only'}});
  domain(f,goal.session.id,{type:'complete'});
  const deliveryId='fixture-delivery-'+goal.session.id;
  f.db.prepare("INSERT INTO verification_records(kind,id,project_id,run_id,record) VALUES ('delivery',?,?,?,?)").run(deliveryId,goal.run.projectId,goal.run.id,JSON.stringify({id:deliveryId,runId:goal.run.id,projectId:goal.run.projectId}));return deliveryId;
}

test('P6-GOAL-I01 follow-up freezes ordered message inputs once and refuses ordinary admission through the pending fence',()=>{
  const f=fixture();try{
    const initial=ready(f),message=receive(f,initial),before=f.goals.inspect(initial.session.id);
    assert.throws(()=>f.goals.validateAdmission({type:'admit',commandId:'unsafe-admit',sessionId:initial.session.id,expectedRevision:initial.session.revision}),/Pending follow-up/);
    const begun=f.goals.beginFollowup(initial.session.id,message.id),job=begun.session.jobs.at(-1)!;
    assert.equal(job.purpose,'followup');assert.equal(job.followup?.baseContractVersion,1);assert.equal(job.followup?.messageSequence,1);assert.equal(job.followup?.processingAttempt,1);
    assert.equal(begun.session.messages.filter(item=>item.id===message.id).length,1);assert.equal(job.followup?.messages.at(-1)?.text,message.text);assert.deepEqual(begun.session.proposal,before.session.proposal);
    assert.deepEqual(f.goals.beginFollowup(initial.session.id,message.id),begun);
    const newer=receive(f,initial,'newer');assert.throws(()=>f.goals.beginFollowup(initial.session.id,newer.id),/settled|Unresolved/);
    assert.equal(f.goals.inspect(initial.session.id).session.jobs.at(-1)!.followup!.messages.length,begun.session.messages.length);
    const reopened=new DatabaseSync(f.path);try{migrate(reopened);assert.deepEqual(new GoalRepository(reopened).inspect(initial.session.id),begun);}finally{reopened.close();}
  }finally{f.close();}
});

test('P6-GOAL-I02 follow-up rejects active work and unknown effects without partially appending requirements',()=>{
  const f=fixture();try{
    const initial=inputRuntime(f,ready(f));
    const runtimeId=initial.session.runtimeId!;f.runtime.control({type:'input',commandId:'input',runtimeId,stepId:'local-input',text:'value'});const operation=f.runtime.claim(runtimeId,'worker')!;
    const message=receive(f,initial),before=f.goals.inspect(initial.session.id);
    assert.throws(()=>f.goals.beginFollowup(initial.session.id,message.id),/settled/);assert.deepEqual(f.goals.inspect(initial.session.id),before);assert.equal(f.conversations.message(message.id).state,'received');
    f.runtime.markStarted(operation.id,'worker');f.runtime.report(operation.id,'worker',{messageId:'unknown-input',outcome:'unknown',result:{reason:'Unknown fixture outcome'}});
    assert.throws(()=>f.goals.beginFollowup(initial.session.id,message.id),/settled/);
  }finally{f.close();}
});

test('P6-GOAL-I10 explicit and classified inquiries remain read-only requirements and legacy controls cannot bypass their processing state',()=>{
  const f=fixture();try{
    const initial=ready(f),question=receive(f,initial,'question','question'),begun=f.goals.beginFollowup(initial.session.id,question.id);
    assert.deepEqual(begun.session.messages,initial.session.messages);assert.deepEqual(begun.session.jobs.at(-1)!.followup!.messages,initial.session.messages);
    assert.equal(f.conversations.hasPendingForRun(initial.run.projectId,initial.run.id),false);
    assert.throws(()=>f.goals.control({type:'restore',commandId:'bypass',sessionId:initial.session.id,expectedRevision:begun.session.revision}),/Pending follow-up prevents legacy/);
    const answered=f.goals.finish(initial.session.id,begun.session.jobs.at(-1)!.id,job=>{job.usage=0;job.stopConfirmed=true;job.proofs={[f.proof]:f.proofDigest};job.followupResult={decision:'answer',response:'No task execution has begun.',proposal:null,retiredCriterionIds:[],retirementSources:[]};});
    assert.equal(answered.session.phase,'ready');assert.equal(answered.session.error,null);assert.equal(answered.session.jobs.at(-1)!.proposal,null);assert.deepEqual(answered.session.proposal,initial.session.proposal);assert.deepEqual(answered.session.messages,initial.session.messages);
    f.conversations.transition(question.id,'answered',{response:'No task execution has begun.'});
    const unclassified=receive(f,initial,'unclassified','unclassified'),classified=f.goals.beginFollowup(initial.session.id,unclassified.id);assert.ok(classified.session.messages.some(item=>item.id===unclassified.id));
    const result=f.goals.finish(initial.session.id,classified.session.jobs.at(-1)!.id,job=>{job.usage=0;job.stopConfirmed=true;job.proofs={[f.proof]:f.proofDigest};job.followupResult={decision:'answer',response:'This is a status inquiry.',proposal:null,retiredCriterionIds:[],retirementSources:[]};});
    assert.deepEqual(result.session.messages,initial.session.messages);assert.equal(result.run.contract.version,1);assert.equal(result.session.jobs.at(-1)!.followup!.messages.at(-1)!.id,unclassified.id,'Frozen reasoning input remains auditable');
    assert.throws(()=>f.goals.control({type:'answer',commandId:'bypass-answer',sessionId:initial.session.id,expectedRevision:result.session.revision,text:'Bypass queue'}),/Pending follow-up prevents legacy/);
    f.conversations.transition(unclassified.id,'answered',{response:'This is a status inquiry.'});assert.equal(f.conversations.hasPendingForRun(initial.run.projectId,initial.run.id),false);
  }finally{f.close();}
});

test('P6-GOAL-I11 recursive clarification replies preserve original text and atomically apply every ancestor with the same contract',()=>{
  const f=fixture();try{
    const initial=ready(f),first=receive(f,initial),conversation=f.conversations.forRun(initial.run.projectId,initial.run.id)!;
    function clarify(messageId:string,response:string){
      const begun=f.goals.beginFollowup(initial.session.id,messageId),jobId=begun.session.jobs.at(-1)!.id;
      f.goals.finish(initial.session.id,jobId,job=>{job.usage=0;job.stopConfirmed=true;job.proofs={[f.proof]:f.proofDigest};job.followupResult={decision:'clarify',response,proposal:{...proposal(begun.session),decision:'clarify',questions:[response]},retiredCriterionIds:[],retirementSources:[]};});
      f.conversations.transition(messageId,'clarifying',{response});
    }
    clarify(first.id,'Should the empty sum be zero?');
    const second=f.conversations.receive({conversationId:conversation.id,commandId:'clarification-one',replyToMessageId:first.id,source:'user',kind:'change',text:'Yes; additionally preserve integer precision.'});clarify(second.id,'Which integer precision boundary is required?');
    const third=f.conversations.receive({conversationId:conversation.id,commandId:'clarification-two',replyToMessageId:second.id,source:'user',kind:'change',text:'Support all safe JavaScript integers.'});
    const interrupted=f.goals.beginFollowup(initial.session.id,third.id);
    f.goals.finish(initial.session.id,interrupted.session.jobs.at(-1)!.id,job=>{job.usage=0;job.stopConfirmed=true;job.error='Confirmed pre-model failure';});
    assert.throws(()=>f.conversations.retry(first.id,'Retry old question'),/latest clarification reply/);
    assert.throws(()=>f.conversations.retry(second.id,'Retry parent'),/latest clarification reply/);
    f.conversations.retry(third.id,'Retry the latest reply after confirmed pre-model failure');
    const begun=f.goals.beginFollowup(initial.session.id,third.id);assert.deepEqual(begun.session.jobs.at(-1)!.followup!.relatedMessageIds,[first.id,second.id]);
    assert.deepEqual(begun.session.messages.slice(-3).map(item=>item.text),[first.text,second.text,third.text]);
    assert.equal(f.conversations.message(first.id).state,'clarifying');assert.equal(f.conversations.message(second.id).state,'clarifying');
    const finished=finishFollowup(f,begun),applied=f.goals.applyFollowup(initial.session.id,finished.session.jobs.at(-1)!.id);
    for(const original of [first,second,third]){const stored=f.conversations.message(original.id);assert.equal(stored.text,original.text);assert.equal(stored.state,'applied');assert.equal(stored.appliedContractVersion,applied.run.contract.version);}
    assert.equal(f.conversations.hasPendingForRun(initial.run.projectId,initial.run.id),false);assert.equal(applied.run.contract.version,2);
  }finally{f.close();}
});

test('P6-GOAL-I12 follow-up budget refusal rolls back processing and requirement append without resetting prior spend',()=>{
  const f=fixture();try{
    const initial=ready(f,'small-budget',59),message=receive(f,initial),before=f.goals.inspect(initial.session.id);
    assert.throws(()=>f.goals.beginFollowup(initial.session.id,message.id),/insufficient budget/);
    assert.deepEqual(f.goals.inspect(initial.session.id),before);assert.equal(f.conversations.message(message.id).state,'received');assert.equal(f.goals.inspect(initial.session.id).run.budget.spent,10);assert.equal(f.conversations.hasPendingForRun(initial.run.projectId,initial.run.id),true);
  }finally{f.close();}
});

test('P6-GOAL-I03 successful follow-up finish retains the old proposal until atomic draft admission and is idempotent',()=>{
  const f=fixture();try{
    const initial=ready(f),message=receive(f,initial),begun=f.goals.beginFollowup(initial.session.id,message.id),finished=finishFollowup(f,begun),job=finished.session.jobs.at(-1)!;
    assert.deepEqual(finished.session.proposal,initial.session.proposal);assert.equal(finished.run.contract.version,1);assert.equal(finished.run.budget.spent,17);assert.equal(f.conversations.message(message.id).state,'processing');
    const applied=f.goals.applyFollowup(initial.session.id,job.id);assert.equal(applied.run.contract.version,2);assert.equal(applied.run.admission,'admitted');assert.equal(applied.session.proposal?.summary,'Implement the added behavior');
    assert.equal(applied.session.runtimeId,applied.run.id);assert.equal(f.conversations.message(message.id).state,'applied');assert.equal(f.conversations.hasPendingForRun(applied.run.projectId,applied.run.id),false);
    assert.match(f.runtime.get(applied.session.runtimeId!).definition.steps[0]!.kind==='codex'?(f.runtime.get(applied.session.runtimeId!).definition.steps[0] as {prompt:string}).prompt:'',/Also support zero operands/);
    assert.deepEqual(f.goals.applyFollowup(initial.session.id,job.id),applied);assert.equal(f.runtime.operations(applied.run.id).length,1);
  }finally{f.close();}
});

test('P6-GOAL-I04 follow-up revises awaiting-verification runtime and keeps later messages fenced and out of the frozen plan',()=>{
  const f=fixture();try{
    const initial=completeInput(f,inputRuntime(f,ready(f))),message=receive(f,initial),begun=f.goals.beginFollowup(initial.session.id,message.id),newer=receive(f,initial,'newer');
    const finished=finishFollowup(f,begun),job=finished.session.jobs.at(-1)!,beforeVersion=initial.run.contract.version,oldOperation=f.runtime.operations(initial.run.id).at(-1)!;
    const applied=f.goals.applyFollowup(initial.session.id,job.id);assert.equal(applied.run.contract.version,beforeVersion+1);assert.equal(applied.session.runtimeId,initial.session.runtimeId);assert.equal(f.runtime.get(initial.run.id).cursor,0);
    assert.equal(f.runtime.operations(initial.run.id).find(item=>item.id===oldOperation.id)!.state,'confirmed');assert.equal(f.runtime.currentOperations(initial.run.id).length,1);assert.notEqual(f.runtime.currentOperations(initial.run.id)[0]!.id,oldOperation.id);
    assert.equal(f.conversations.message(message.id).state,'applied');assert.equal(f.conversations.message(newer.id).state,'received');assert.equal(f.runtime.claim(initial.run.id,'worker'),null);
    assert.equal(applied.session.messages.some(item=>item.id===newer.id),false);assert.equal(applied.session.jobs.length,begun.session.jobs.length);
  }finally{f.close();}
});

test('P6-GOAL-I05 unknown usage and failed follow-up retain the fence and cannot reserve again after explicit retry',()=>{
  const f=fixture();try{
    const initial=ready(f),message=receive(f,initial),begun=f.goals.beginFollowup(initial.session.id,message.id),finished=finishFollowup(f,begun,'Uncertain follow-up',null),job=finished.session.jobs.at(-1)!;
    assert.equal(finished.session.phase,'blocked');assert.deepEqual(finished.session.proposal,initial.session.proposal);assert.equal(f.conversations.message(message.id).state,'failed');assert.equal(f.conversations.hasPendingForRun(initial.run.projectId,initial.run.id),true);
    assert.equal(finished.run.attempts.at(-1)!.settled,false);assert.throws(()=>f.goals.applyFollowup(initial.session.id,job.id),/processing boundary|accounted/);
    f.conversations.retry(message.id,'Explicit request to reconcile accounting');assert.throws(()=>f.goals.beginFollowup(initial.session.id,message.id),/settled/);assert.equal(f.conversations.message(message.id).state,'waiting');assert.equal(f.goals.inspect(initial.session.id).session.jobs.length,2);
  }finally{f.close();}
});

test('P6-GOAL-I06 follow-up apply rejects missing proofs stale contract and mutated frozen requirements',()=>{
  const f=fixture();try{
    const initial=ready(f),message=receive(f,initial),begun=f.goals.beginFollowup(initial.session.id,message.id),jobId=begun.session.jobs.at(-1)!.id;
    const noProof=f.goals.finish(initial.session.id,jobId,job=>{job.usage=0;job.stopConfirmed=true;job.proposal=proposal(begun.session);});
    assert.throws(()=>f.goals.applyFollowup(initial.session.id,jobId),/proof receipts/);assert.equal(f.conversations.message(message.id).state,'processing');
    const edited=structuredClone(noProof.session);edited.jobs.at(-1)!.proofs={[f.proof]:f.proofDigest};edited.messages.push({id:'unexpected',role:'user',text:'Not in the model snapshot',createdAt:new Date().toISOString()});
    f.db.prepare('UPDATE goal_sessions SET record=? WHERE id=?').run(JSON.stringify(edited),edited.id);assert.throws(()=>f.goals.applyFollowup(edited.id,jobId),/snapshot changed/);
    edited.messages.pop();f.db.prepare('UPDATE goal_sessions SET record=? WHERE id=?').run(JSON.stringify(edited),edited.id);
    domain(f,edited.id,{type:'admit',contract:{version:2,goal:'Independently changed contract',criteria:[{id:'retained',description:'Retained assertion',required:true}]},nodes:[{id:'other',dependencies:[],required:true}]});assert.throws(()=>f.goals.applyFollowup(edited.id,jobId),/Contract changed/);
  }finally{f.close();}
});

test('P6-GOAL-I07 failed atomic acknowledgement rolls back runtime revision outbox checkpoint proposal and application marker',()=>{
  const f=fixture();try{
    const initial=completeInput(f,inputRuntime(f,ready(f))),message=receive(f,initial),begun=f.goals.beginFollowup(initial.session.id,message.id),finished=finishFollowup(f,begun),job=finished.session.jobs.at(-1)!,beforeRuntime=f.runtime.inspect(initial.run.id),beforeMessage=f.conversations.message(message.id);
    f.db.exec("CREATE TRIGGER reject_followup_ack BEFORE UPDATE ON conversation_messages WHEN json_extract(NEW.record,'$.state')='applied' BEGIN SELECT RAISE(ABORT,'Injected acknowledgement failure'); END;");
    assert.throws(()=>f.goals.applyFollowup(initial.session.id,job.id),/Injected acknowledgement failure/);
    assert.deepEqual(f.runtime.inspect(initial.run.id),beforeRuntime);assert.deepEqual(f.goals.inspect(initial.session.id),finished);assert.deepEqual(f.conversations.message(message.id),beforeMessage);assert.equal(f.db.isTransaction,false);
    f.db.exec('DROP TRIGGER reject_followup_ack');assert.equal(f.goals.applyFollowup(initial.session.id,job.id).run.contract.version,initial.run.contract.version+1);
  }finally{f.close();}
});

test('P6-GOAL-I08 delivered continuation preserves the old round and exact remaining authorization without starting a model',()=>{
  const f=fixture();try{
    const initial=completeInput(f,inputRuntime(f,ready(f))),deliveryId=deliverFixture(f,initial),before=f.goals.inspect(initial.session.id),message=receive(f,initial),conversation=f.conversations.forRun(initial.run.projectId,initial.run.id)!;
    const child=f.goals.createContinuation(conversation.id,'next-round');assert.notEqual(child.run.id,initial.run.id);assert.equal(child.run.admission,'draft');assert.equal(child.run.attempts.length,0);assert.equal(child.session.jobs.length,0);assert.equal(child.session.runtimeId,null);
    assert.equal(child.run.budget.limit,290);assert.equal(child.run.budget.spent,0);assert.equal(child.run.budget.verificationReserve,20);assert.deepEqual(child.session.messages,before.session.messages);assert.deepEqual(child.session.proposal,before.session.proposal);assert.equal(child.session.continuation?.predecessorDeliveryId,deliveryId);
    assert.deepEqual(f.goals.inspect(initial.session.id),before);assert.equal(f.conversations.budget(conversation.id).limit,300);assert.equal(f.conversations.budget(conversation.id).spent,10);assert.deepEqual(f.goals.createContinuation(conversation.id,'next-round'),child);
    const begun=f.goals.beginFollowup(child.session.id,message.id);assert.equal(begun.session.jobs.at(-1)!.followup!.baseContractVersion,1);assert.equal(begun.session.jobs.at(-1)!.followup!.messages.at(-1)!.id,message.id);
    const finished=finishFollowup(f,begun),applied=f.goals.applyFollowup(child.session.id,finished.session.jobs.at(-1)!.id);assert.equal(applied.run.contract.version,2);assert.equal(f.conversations.budget(conversation.id).spent,17);assert.deepEqual(f.goals.inspect(initial.session.id),before);
  }finally{f.close();}
});

test('P6-GOAL-I09 continuation rejection rolls back new runs for exhausted reasoning capacity and forbids unrelated command reuse',()=>{
  const f=fixture();try{
    const initial=completeInput(f,inputRuntime(f,ready(f,'low-budget',60))),deliveryId=deliverFixture(f,initial,1),conversation=f.conversations.forRun(initial.run.projectId,initial.run.id)!;
    // First-round reasoning and verification fixture settlement leaves 49; the
    // child needs 30 reasoning plus 20 verification and must atomically reject.
    const before=f.goals.list().length;assert.throws(()=>f.goals.createContinuation(conversation.id,'too-small'),/retain reasoning budget/);assert.equal(f.goals.list().length,before);assert.equal(f.conversations.rounds(conversation.id).length,1);assert.equal(f.conversations.get(conversation.id).activeRunId,initial.run.id);
    assert.equal(f.db.prepare("SELECT id FROM verification_records WHERE kind='delivery' AND id=?").get(deliveryId)?.id,deliveryId);
    assert.throws(()=>f.goals.createContinuation(conversation.id,'low-budget'),/Conflicting continuation commandId/);
  }finally{f.close();}
});
