import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {lstatSync,realpathSync} from 'node:fs';
import type {MaterialVerifierBinding} from '../contracts/p4-material.js';
import type {ResearchEvidenceContext} from '../contracts/p8-research.js';
import type {ResearchGoalAppendProof} from '../contracts/p4-research-projection.js';
import type {GoalSession} from '../contracts/p5.js';
import {VerificationLineageRepository,lineageDigest} from '../persistence/verification-lineage.js';
import {ConversationRepository} from '../persistence/conversations.js';
import {RuntimeRepository} from '../persistence/runtime.js';
import {researchDigest} from '../workspace/research-materials.js';
import {assertTrue} from '../workspace/research-runtime-files.js';

/** Actual immutable authorization receipts, not a model-written goal prefix.
 * Read-only SQLite lookup: no new authority, reservation or migration. */
export function readResearchGoalAppendProof(
 dataRoot:string,previous:MaterialVerifierBinding,current:MaterialVerifierBinding,
 before:ResearchEvidenceContext,after:ResearchEvidenceContext
):ResearchGoalAppendProof|null {
 if(before.contract.goal===after.contract.goal)return null;
 const path=join(dataRoot,'supervisor.sqlite');
 assertTrue(!lstatSync(path).isSymbolicLink()&&realpathSync(path)===path,'Research authorization database alias');
 const db=new DatabaseSync(path,{readOnly:true});
 try {
  const runtime=new RuntimeRepository(db),lineage=new VerificationLineageRepository(db),conversations=new ConversationRepository(db);
  const oldOp=runtime.getOperation(previous.operationId),newOp=runtime.getOperation(current.operationId);
  const oldRuntime=runtime.get(oldOp.runtimeId),newRuntime=runtime.get(newOp.runtimeId);
  const oldInput=runtime.researchInput(oldOp.id),newInput=runtime.researchInput(newOp.id);
  assertTrue(oldInput&&newInput&&oldInput.path===previous.inputPath&&newInput.path===current.inputPath
   &&oldInput.digest===previous.inputDigest&&newInput.digest===current.inputDigest
   &&oldOp.executionId===previous.executionId&&newOp.executionId===current.executionId
   &&researchDigest(oldInput.package.context)===researchDigest(before)
   &&researchDigest(newInput.package.context)===researchDigest(after),
   'Appended goal context differs from actual original producer inputs');
  assertTrue(oldRuntime.projectId===newRuntime.projectId&&oldRuntime.runId!==newRuntime.runId,
   'Appended goal needs actual same-project new round');
  const readSession=(id:string):GoalSession=>{
   const row=db.prepare('SELECT record FROM goal_sessions WHERE id=?').get(id);
   assertTrue(row,'Research Goal session missing');
   return JSON.parse(String(row.record)) as GoalSession;
  };
  const oldSession=readSession(oldRuntime.runId),session=readSession(newRuntime.runId);
  const binding=lineage.resolveRun(newRuntime.projectId,newRuntime.runId);
  assertTrue(session.continuation?.predecessorRunId===oldRuntime.runId
   &&session.continuation.predecessorDeliveryId===binding.predecessorDeliveryId
   &&binding.predecessorRunId===oldRuntime.runId&&binding.predecessorDeliveryId,
   'Actual continuation predecessor changed');
  const goal=(s:GoalSession)=>'Authoritative user requirements in chronological order. Later explicit changes override earlier requests:\n'
   +s.messages.map(m=>`${m.id}: ${m.text}`).join('\n');
  assertTrue(before.contract.goal===goal(oldSession)&&after.contract.goal===goal(session)
   &&session.messages.length>oldSession.messages.length
   &&researchDigest(session.messages.slice(0,oldSession.messages.length))===researchDigest(oldSession.messages),
   'Actual original requirements or exact appended message construction changed');
  const oldDigest=lineageDigest(before.contract),newDigest=lineageDigest(after.contract);
  assertTrue(lineageDigest(runtime.inspect(newRuntime.id).run.contract)===newDigest,
   'New research context is not the actual admitted contract');
  const transitions=[];let digest=newDigest,runId=newRuntime.runId;
  while(digest!==oldDigest||runId!==oldRuntime.runId){
   assertTrue(transitions.length<32,'Research authorization chain exceeds bounded scope');
   const row=db.prepare('SELECT id FROM verification_contract_transitions WHERE project_id=? AND run_id=? AND to_contract_digest=?')
    .get(newRuntime.projectId,runId,digest);
   assertTrue(row,'Actual applied research transition missing');
   const transition=lineage.transition(String(row.id));
   assertTrue(transition.lineageId===binding.lineageId&&transition.changes.every(c=>c.kind==='add'),
    'Only actual independently approved append transitions support this projection');
   transitions.unshift(transition);digest=transition.from.contractDigest;runId=transition.from.runId;
  }
  const allowed=new Set(transitions.flatMap(t=>[t.messageId,...t.relatedMessageIds]));
  const appendedMessages=session.messages.slice(oldSession.messages.length).map(m=>{
   const actual=conversations.message(m.id);
   assertTrue(allowed.has(m.id)&&actual.source==='user'&&actual.state==='applied'
    &&actual.conversationId===session.continuation!.conversationId&&actual.text===m.text,
    'Appended goal text lacks exact actual applied user message');
   return {id:actual.id,sequence:actual.sequence,text:actual.text};
  });
  const body={schemaVersion:1 as const,authority:'actual-applied-receipts-integrity-only' as const,
   previousGoalDigest:researchDigest(before.contract.goal),currentGoalDigest:researchDigest(after.contract.goal),
   previousContractDigest:before.contractDigest,currentContractDigest:after.contractDigest,
   lineageId:binding.lineageId,predecessorDeliveryId:binding.predecessorDeliveryId,
   previousRunId:oldRuntime.runId,currentRunId:newRuntime.runId,
   transitionIds:transitions.map(t=>t.id),appendedMessages};
  return {...body,digest:researchDigest(body)};
 } finally {db.close();}
}
