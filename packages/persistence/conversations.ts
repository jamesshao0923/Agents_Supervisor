import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Run } from '../contracts/p1.js';
import type { GoalSession } from '../contracts/p5.js';
import type { Conversation, ConversationBudget, ConversationChildAuthorization, ConversationMessage, ConversationMessageInput, ConversationMessageState, ConversationRound } from '../contracts/p6.js';
import { runtimeCanonical as canonical } from './runtime.js';

export const CONVERSATION_MIGRATION_SQL = `
CREATE TABLE conversations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE conversation_rounds(conversation_id TEXT NOT NULL REFERENCES conversations(id), ordinal INTEGER NOT NULL CHECK(ordinal>0), session_id TEXT NOT NULL UNIQUE REFERENCES goal_sessions(id), project_id TEXT NOT NULL, run_id TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(conversation_id,ordinal), UNIQUE(project_id,run_id), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));
CREATE TABLE conversation_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), sequence INTEGER NOT NULL CHECK(sequence>0), command_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL CHECK(json_valid(request)), record TEXT NOT NULL CHECK(json_valid(record)), UNIQUE(conversation_id,sequence));
`;
function ensure(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
const now=()=>new Date().toISOString();
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);
const terminal=(message:ConversationMessage)=>['applied','answered'].includes(message.state);
const fenced=(message:ConversationMessage)=>message.kind!=='question'&&!terminal(message);
export class ConversationRepository {
  constructor(private readonly db:DatabaseSync){}
  /** Nested callers participate in the owner's transaction and never commit it. */
  transaction<T>(body:()=>T):T {if(this.db.isTransaction)return body();this.db.exec('BEGIN IMMEDIATE');try{const result=body();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private tx<T>(body:()=>T):T {return this.transaction(body);}
  private goal(id:string):{session:GoalSession;run:Run} {
    const row=this.db.prepare('SELECT project_id,run_id,record FROM goal_sessions WHERE id=?').get(id);ensure(row,'Unknown goal session');
    const session=JSON.parse(String(row.record)) as GoalSession;
    ensure(session.id===id&&session.projectId===row.project_id,'Goal identity mismatch');
    return {session,run:this.run(String(row.project_id),String(row.run_id))};
  }
  private run(projectId:string,runId:string):Run {
    const row=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(projectId,runId);ensure(row,'Missing conversation Run');
    const run=JSON.parse(String(row.snapshot)) as Run;ensure(run.id===runId&&run.projectId===projectId,'Conversation Run identity mismatch');return run;
  }
  get(id:string):Conversation {const row=this.db.prepare('SELECT record FROM conversations WHERE id=?').get(id);ensure(row,'Unknown conversation');return JSON.parse(String(row.record)) as Conversation;}
  list():Conversation[]{return this.db.prepare('SELECT record FROM conversations ORDER BY rowid').all().map(row=>JSON.parse(String(row.record)) as Conversation);}
  rounds(id:string):ConversationRound[]{this.get(id);return this.db.prepare('SELECT record FROM conversation_rounds WHERE conversation_id=? ORDER BY ordinal').all(id).map(row=>JSON.parse(String(row.record)) as ConversationRound);}
  messages(id:string):ConversationMessage[]{this.get(id);return this.db.prepare('SELECT record FROM conversation_messages WHERE conversation_id=? ORDER BY sequence').all(id).map(row=>JSON.parse(String(row.record)) as ConversationMessage);}
  message(id:string):ConversationMessage {const row=this.db.prepare('SELECT record FROM conversation_messages WHERE id=?').get(id);ensure(row,'Unknown conversation message');return JSON.parse(String(row.record)) as ConversationMessage;}
  inspect(id:string){return {conversation:this.get(id),rounds:this.rounds(id),messages:this.messages(id),budget:this.budget(id)};}
  forRun(projectId:string,runId:string):Conversation|null {const row=this.db.prepare('SELECT conversation_id FROM conversation_rounds WHERE project_id=? AND run_id=?').get(projectId,runId);return row?this.get(String(row.conversation_id)):null;}
  ensureForGoal(sessionId:string):Conversation {return this.tx(()=>{
    const old=this.db.prepare('SELECT conversation_id FROM conversation_rounds WHERE session_id=?').get(sessionId);if(old)return this.get(String(old.conversation_id));
    const {session,run}=this.goal(sessionId),createdAt=now();
    const conversation:Conversation={id:'conversation-'+hash(sessionId),projectId:session.projectId,workspace:session.workspace,firstRunId:run.id,activeRunId:run.id,activeSessionId:sessionId,authorizedLimit:run.budget.limit,createdAt};
    this.db.prepare('INSERT INTO conversations(id,project_id,record) VALUES (?,?,?)').run(conversation.id,conversation.projectId,canonical(conversation));
    this.insertRound({conversationId:conversation.id,ordinal:1,sessionId,projectId:run.projectId,runId:run.id,predecessorRunId:null,predecessorDeliveryId:null,createdAt});return conversation;
  });}
  private insertRound(round:ConversationRound):void {this.db.prepare('INSERT INTO conversation_rounds(conversation_id,ordinal,session_id,project_id,run_id,record) VALUES (?,?,?,?,?,?)').run(round.conversationId,round.ordinal,round.sessionId,round.projectId,round.runId,canonical(round));}
  receive(input:ConversationMessageInput):ConversationMessage {return this.tx(()=>{
    ensure(input&&typeof input==='object'&&Object.keys(input).sort().join(',')==='commandId,conversationId,kind,source,text','Invalid conversation message fields');
    ensure(typeof input.commandId==='string'&&input.commandId.trim()&&input.commandId.length<=4096&&!input.commandId.includes('\0'),'Invalid message commandId');
    ensure(input.source==='user'&&['question','change','unclassified'].includes(input.kind),'Invalid message provenance or kind');
    ensure(typeof input.text==='string'&&input.text.trim()&&input.text.length<=40000&&!input.text.includes('\0'),'Invalid message text');
    const previous=this.db.prepare('SELECT request,record FROM conversation_messages WHERE command_id=?').get(input.commandId);
    if(previous){ensure(previous.request===canonical(input),'Conflicting conversation commandId');return JSON.parse(String(previous.record)) as ConversationMessage;}
    const conversation=this.get(input.conversationId),run=this.run(conversation.projectId,conversation.activeRunId),sequence=this.messages(conversation.id).length+1,createdAt=now();
    const message:ConversationMessage={...input,id:'message-'+hash(input.commandId),sequence,receivedRunId:run.id,receivedContractVersion:run.contract.version,createdAt,state:'received',processing:null,processingHistory:[],response:null,appliedContractVersion:null,history:[{state:'received',at:createdAt,reason:null}]};
    this.db.prepare('INSERT INTO conversation_messages(id,conversation_id,sequence,command_id,request,record) VALUES (?,?,?,?,?,?)').run(message.id,conversation.id,sequence,input.commandId,canonical(input),canonical(message));return message;
  });}
  hasPendingForRun(projectId:string,runId:string):boolean {const conversation=this.forRun(projectId,runId);return conversation!==null&&this.messages(conversation.id).some(fenced);}
  private save(message:ConversationMessage):ConversationMessage {this.db.prepare('UPDATE conversation_messages SET record=? WHERE id=?').run(canonical(message),message.id);return message;}
  private state(message:ConversationMessage,state:ConversationMessageState,reason:string|null):void {message.state=state;message.history.push({state,at:now(),reason});}
  beginProcessing(messageId:string):ConversationMessage {return this.tx(()=>{
    const message=this.message(messageId);if(message.state==='processing')return message;
    ensure(['received','waiting'].includes(message.state),'Message needs explicit retry before processing');
    const messages=this.messages(message.conversationId);ensure(!messages.some(other=>other.state==='processing'),'Conversation already processing a message');
    ensure(!messages.some(other=>other.sequence<message.sequence&&fenced(other)),'Earlier requirement message is unresolved');
    const conversation=this.get(message.conversationId),run=this.run(conversation.projectId,conversation.activeRunId);
    message.processing={attempt:message.processingHistory.length+1,runId:run.id,baseContractVersion:run.contract.version,throughSequence:message.sequence,startedAt:now()};
    message.processingHistory.push({...message.processing});this.state(message,'processing',null);return this.save(message);
  });}
  transition(messageId:string,state:ConversationMessageState,details:{reason?:string;response?:string;appliedContractVersion?:number}={}):ConversationMessage {return this.tx(()=>{
    const message=this.message(messageId);
    const allowed:Record<ConversationMessageState,ConversationMessageState[]>={received:['waiting','answered','failed'],waiting:['failed'],processing:['clarifying','applied','answered','failed'],clarifying:['failed'],failed:[],applied:[],answered:[]};
    ensure(allowed[message.state].includes(state),'Invalid conversation message transition; retries must be explicit');
    if(state==='answered')ensure(message.kind==='question'||(message.kind==='unclassified'&&message.state==='processing'),'Only explicit questions or processed unclassified inquiries can be answered');
    if(state==='applied'){
      ensure(message.kind!=='question'&&message.processing,'Read-only question cannot revise requirements');
      const conversation=this.get(message.conversationId),run=this.run(conversation.projectId,message.processing.runId);
      ensure(details.appliedContractVersion===run.contract.version&&run.contract.version>message.processing.baseContractVersion,'Applied message needs a newer actual contract');
      ensure(conversation.activeRunId===run.id,'Applied message targets an inactive round');message.appliedContractVersion=run.contract.version;
    }
    if(state==='answered'||state==='clarifying')ensure(typeof details.response==='string'&&details.response.trim(),'Answer or clarification response required');
    if(state==='failed')ensure(typeof details.reason==='string'&&details.reason.trim(),'Failure reason required');
    if(details.response!==undefined)message.response=details.response;
    this.state(message,state,details.reason??null);return this.save(message);
  });}
  retry(messageId:string,reason:string):ConversationMessage {return this.tx(()=>{
    ensure(typeof reason==='string'&&reason.trim(),'Explicit retry reason required');const message=this.message(messageId);
    ensure(['failed','clarifying'].includes(message.state),'Only failed or clarifying messages can retry');
    message.processing=null;this.state(message,'waiting',reason);return this.save(message);
  });}
  budget(id:string):ConversationBudget {
    const conversation=this.get(id),rounds=this.rounds(id).map(round=>{const run=this.run(round.projectId,round.runId);return {runId:run.id,limit:run.budget.limit,spent:run.budget.spent,reserved:run.attempts.filter(attempt=>!attempt.settled).reduce((sum,attempt)=>sum+attempt.reservation,0),status:run.status};});
    const spent=rounds.reduce((sum,round)=>sum+round.spent,0),reserved=rounds.reduce((sum,round)=>sum+round.reserved,0);
    ensure(Number.isSafeInteger(spent)&&Number.isSafeInteger(reserved),'Conversation accounting exceeds safe integer range');
    return {limit:conversation.authorizedLimit,spent,reserved,remaining:conversation.authorizedLimit-spent,available:conversation.authorizedLimit-spent-reserved,rounds};
  }
  private assertDelivered(run:Run):void {ensure(run.status==='succeeded'&&run.attempts.every(attempt=>attempt.status!=='running'&&attempt.settled)&&run.operations.every(operation=>operation.status==='confirmed')&&run.leases.every(lease=>lease.released),'Prior conversation Run must be delivered and fully settled');}
  childAuthorization(id:string):ConversationChildAuthorization {
    const conversation=this.get(id),rounds=this.rounds(id);for(const round of rounds)this.assertDelivered(this.run(round.projectId,round.runId));
    const run=this.run(conversation.projectId,conversation.activeRunId),budget=this.budget(id);
    const rows=this.db.prepare("SELECT record FROM verification_records WHERE kind='delivery' AND project_id=? AND run_id=? ORDER BY rowid DESC").all(conversation.projectId,run.id);
    ensure(rows.length>0,'Prior conversation Run has no independent delivery');const delivery=JSON.parse(String(rows[0]!.record)) as {id:string;runId:string;projectId:string};
    ensure(delivery.runId===run.id&&delivery.projectId===run.projectId,'Delivery identity mismatch');
    ensure(budget.reserved===0&&budget.remaining>0,'Conversation budget exhausted or unresolved');
    return {conversationId:id,projectId:conversation.projectId,workspace:conversation.workspace,predecessorRunId:run.id,predecessorDeliveryId:delivery.id,tokenLimit:budget.remaining,verificationReserve:run.budget.verificationReserve};
  }
  attachRound(id:string,sessionId:string,predecessorDeliveryId:string):ConversationRound {return this.tx(()=>{
    const existing=this.db.prepare('SELECT record FROM conversation_rounds WHERE session_id=?').get(sessionId);
    if(existing){const round=JSON.parse(String(existing.record)) as ConversationRound;ensure(round.conversationId===id&&round.predecessorDeliveryId===predecessorDeliveryId,'Goal already belongs to another conversation or predecessor');return round;}
    const authorization=this.childAuthorization(id),conversation=this.get(id),{session,run}=this.goal(sessionId);
    ensure(authorization.predecessorDeliveryId===predecessorDeliveryId,'Stale predecessor delivery');
    ensure(session.projectId===conversation.projectId&&session.workspace===conversation.workspace&&run.projectId===conversation.projectId,'Child goal project or workspace differs');
    ensure(run.admission==='draft'&&run.status==='ready'&&run.budget.unit==='token'&&run.budget.limit===authorization.tokenLimit&&run.budget.spent===0&&run.attempts.length===0&&run.operations.length===0&&run.leases.length===0&&run.nodes.length===0&&run.artifact===null&&run.evidence.length===0&&session.jobs.length===0&&session.runtimeId===null,'Child must be a pristine draft with the exact remaining authorization');
    ensure(run.budget.verificationReserve===authorization.verificationReserve&&run.budget.verificationReserve+session.config.reservation<=authorization.tokenLimit,'Child must preserve verification reserve and retain reasoning budget');
    ensure(!this.messages(id).some(message=>message.state==='processing'),'Cannot rotate a processing conversation');
    const round:ConversationRound={conversationId:id,ordinal:this.rounds(id).length+1,sessionId,projectId:run.projectId,runId:run.id,predecessorRunId:authorization.predecessorRunId,predecessorDeliveryId,createdAt:now()};
    this.insertRound(round);conversation.activeRunId=run.id;conversation.activeSessionId=sessionId;this.db.prepare('UPDATE conversations SET record=? WHERE id=?').run(canonical(conversation),id);return round;
  });}
}
