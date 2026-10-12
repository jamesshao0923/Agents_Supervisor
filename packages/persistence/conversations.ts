import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {validateTaskAttachments} from '../contracts/task-attachments.js';
import type { Run } from '../contracts/p1.js';
import type { GoalSession } from '../contracts/p5.js';
import type { Conversation, ConversationBudget, ConversationChildAuthorization, ConversationMessage, ConversationMessageInput, ConversationMessageState, ConversationRound, TerminalAssessmentJob } from '../contracts/p6.js';
import { validateTerminalAssessment } from '../orchestration/terminal-assessment.js';
import { runtimeCanonical as canonical } from './runtime.js';

export const CONVERSATION_MIGRATION_SQL = `
CREATE TABLE conversations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE conversation_rounds(conversation_id TEXT NOT NULL REFERENCES conversations(id), ordinal INTEGER NOT NULL CHECK(ordinal>0), session_id TEXT NOT NULL UNIQUE REFERENCES goal_sessions(id), project_id TEXT NOT NULL, run_id TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(conversation_id,ordinal), UNIQUE(project_id,run_id), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));
CREATE TABLE conversation_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), sequence INTEGER NOT NULL CHECK(sequence>0), command_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL CHECK(json_valid(request)), record TEXT NOT NULL CHECK(json_valid(record)), UNIQUE(conversation_id,sequence));
`;
export const ASSESSMENT_MIGRATION_SQL = `
CREATE TABLE conversation_assessments(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL REFERENCES conversation_messages(id), attempt INTEGER NOT NULL CHECK(attempt>0), record TEXT NOT NULL CHECK(json_valid(record)), UNIQUE(message_id,attempt));
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
  inspect(id:string){return {conversation:this.get(id),rounds:this.rounds(id),messages:this.messages(id),budget:this.budget(id),assessmentJobs:this.assessments(id)};}
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
    ensure(input&&typeof input==='object'&&Object.keys(input).filter(k=>k!=='replyToMessageId'&&k!=='attachments').sort().join(',')==='commandId,conversationId,kind,source,text','Invalid conversation message fields');
    ensure(typeof input.commandId==='string'&&input.commandId.trim()&&input.commandId.length<=4096&&!input.commandId.includes('\0'),'Invalid message commandId');
    ensure(input.source==='user'&&['question','change','unclassified'].includes(input.kind),'Invalid message provenance or kind');
    ensure(typeof input.text==='string'&&input.text.trim()&&input.text.length<=40000&&!input.text.includes('\0'),'Invalid message text');
    if(input.attachments!==undefined)validateTaskAttachments(input.attachments);
    const previous=this.db.prepare('SELECT request,record FROM conversation_messages WHERE command_id=?').get(input.commandId);
    if(previous){ensure(previous.request===canonical(input),'Conflicting conversation commandId');return JSON.parse(String(previous.record)) as ConversationMessage;}
    if(input.replyToMessageId!==undefined){
      ensure(typeof input.replyToMessageId==='string'&&input.replyToMessageId.trim(),'Invalid clarification parent');
      const parent=this.message(input.replyToMessageId);
      ensure(parent.conversationId===input.conversationId&&parent.state==='clarifying'&&parent.kind!=='question'&&input.kind!=='question','Reply must resolve a requirement clarification in this conversation');
      ensure(!this.messages(input.conversationId).some(m=>m.replyToMessageId===parent.id),'Clarification already has a reply; retry or answer its latest clarification');
    }
    const conversation=this.get(input.conversationId),run=this.run(conversation.projectId,conversation.activeRunId),sequence=this.messages(conversation.id).length+1,createdAt=now();
    const message:ConversationMessage={...input,id:'message-'+hash(input.commandId),sequence,receivedRunId:run.id,receivedContractVersion:run.contract.version,createdAt,state:'received',processing:null,processingHistory:[],response:null,appliedContractVersion:null,history:[{state:'received',at:createdAt,reason:null}]};
    this.db.prepare('INSERT INTO conversation_messages(id,conversation_id,sequence,command_id,request,record) VALUES (?,?,?,?,?,?)').run(message.id,conversation.id,sequence,input.commandId,canonical(input),canonical(message));return message;
  });}
  hasPendingForRun(projectId:string,runId:string):boolean {const conversation=this.forRun(projectId,runId);return conversation!==null&&this.messages(conversation.id).some(fenced);}
  private save(message:ConversationMessage):ConversationMessage {this.db.prepare('UPDATE conversation_messages SET record=? WHERE id=?').run(canonical(message),message.id);return message;}
  private state(message:ConversationMessage,state:ConversationMessageState,reason:string|null):void {message.state=state;message.history.push({state,at:now(),reason});}
  clarificationParents(messageId:string):ConversationMessage[] {
    const message=this.message(messageId),parents:ConversationMessage[]=[];
    let child=message;
    while(child.replyToMessageId){const parent=this.message(child.replyToMessageId);ensure(parent.conversationId===message.conversationId&&parent.sequence<child.sequence&&parent.kind!=='question','Invalid clarification chain');parents.push(parent);child=parent;}
    return parents.reverse();
  }
  beginProcessing(messageId:string):ConversationMessage {return this.tx(()=>{
    const message=this.message(messageId);if(message.state==='processing')return message;
    ensure(['received','waiting'].includes(message.state),'Message needs explicit retry before processing');
    const messages=this.messages(message.conversationId);ensure(!messages.some(other=>other.state==='processing'),'Conversation already processing a message');
    const parents=this.clarificationParents(message.id);ensure(parents.every(parent=>parent.state==='clarifying'),'Clarification parent is no longer waiting');
    ensure(!messages.some(other=>other.sequence<message.sequence&&fenced(other)&&!parents.some(parent=>parent.id===other.id)),'Earlier requirement message is unresolved');
    const conversation=this.get(message.conversationId),run=this.run(conversation.projectId,conversation.activeRunId);
    message.processing={attempt:message.processingHistory.length+1,runId:run.id,baseContractVersion:run.contract.version,throughSequence:message.sequence,startedAt:now()};
    message.processingHistory.push({...message.processing});this.state(message,'processing',null);return this.save(message);
  });}
  /** No parent is released until the reply's actual new contract is committed. */
  applyProcessingGroup(messageId:string,parentIds:string[],contractVersion:number,response?:string):ConversationMessage {return this.tx(()=>{
    const message=this.message(messageId),parents=this.clarificationParents(messageId);
    ensure(canonical(parents.map(parent=>parent.id))===canonical(parentIds),'Clarification ancestry changed');
    ensure(parents.every(parent=>parent.state==='clarifying'&&this.parentBoundaryMatches(parent,message)),'Clarification processing boundary changed');
    const applied=this.transition(messageId,'applied',{appliedContractVersion:contractVersion,...(response===undefined?{}:{response})});
    for(const parent of parents){parent.appliedContractVersion=contractVersion;if(response!==undefined)parent.response=response;this.state(parent,'applied',`Resolved by ${messageId}`);this.save(parent);}
    return applied;
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
    ensure(this.assessments(message.conversationId).every(job=>job.status==='finished'&&job.settled),'Unresolved conversation reasoning prevents retry');
    ensure(!this.messages(message.conversationId).some(other=>other.replyToMessageId===messageId),'Retry the latest clarification reply, not an ancestor that already has a reply');
    message.processing=null;this.state(message,'waiting',reason);return this.save(message);
  });}
  budget(id:string):ConversationBudget {
    const conversation=this.get(id),rounds=this.rounds(id).map(round=>{const run=this.run(round.projectId,round.runId);return {runId:run.id,limit:run.budget.limit,spent:run.budget.spent,reserved:run.attempts.filter(attempt=>!attempt.settled).reduce((sum,attempt)=>sum+attempt.reservation,0),status:run.status};});
    const jobs=this.assessments(id),reasoningSpent=jobs.reduce((sum,job)=>sum+(job.settled?job.usage!:0),0),reasoningReserved=jobs.filter(job=>!job.settled).reduce((sum,job)=>sum+job.config.reservation,0);
    const spent=rounds.reduce((sum,round)=>sum+round.spent,0)+reasoningSpent,reserved=rounds.reduce((sum,round)=>sum+round.reserved,0)+reasoningReserved;
    ensure(Number.isSafeInteger(spent)&&Number.isSafeInteger(reserved),'Conversation accounting exceeds safe integer range');
    return {limit:conversation.authorizedLimit,spent,reserved,remaining:conversation.authorizedLimit-spent,available:conversation.authorizedLimit-spent-reserved,reasoningSpent,reasoningReserved,rounds};
  }
  assessments(conversationId:string):TerminalAssessmentJob[] {this.get(conversationId);return this.db.prepare('SELECT record FROM conversation_assessments WHERE conversation_id=? ORDER BY rowid').all(conversationId).map(row=>JSON.parse(String(row.record)) as TerminalAssessmentJob);}
  assessment(id:string):TerminalAssessmentJob {const row=this.db.prepare('SELECT record FROM conversation_assessments WHERE id=?').get(id);ensure(row,'Unknown conversation assessment');return JSON.parse(String(row.record)) as TerminalAssessmentJob;}
  private saveAssessment(job:TerminalAssessmentJob):TerminalAssessmentJob {this.db.prepare('UPDATE conversation_assessments SET record=? WHERE id=?').run(canonical(job),job.id);return job;}
  /** Immutable input and reservation commit before any process intent. */
  beginAssessment(messageId:string):TerminalAssessmentJob {return this.tx(()=>{
    const message=this.message(messageId),conversation=this.get(message.conversationId),prior=this.assessments(conversation.id).find(job=>job.messageId===messageId&&job.processingAttempt===message.processing?.attempt);
    if(prior&&message.state==='processing')return prior;
    const authorization=this.childAuthorization(conversation.id),{session,run}=this.goal(conversation.activeSessionId);
    ensure(session.jobs.every(job=>job.status==='finished'&&job.stopConfirmed&&job.usage!==null),'Prior goal reasoning is unresolved');
    ensure(message.kind!=='change'||message.replyToMessageId,'Explicit changes use execution continuation');
    const reservation=session.config.reservation;
    ensure(Number.isSafeInteger(reservation)&&reservation>0&&reservation+authorization.verificationReserve<=authorization.tokenLimit,'Insufficient conversation assessment budget');
    const processing=this.beginProcessing(messageId).processing!;
    const job:TerminalAssessmentJob={id:'assessment-'+hash(message.id+':'+processing.attempt),conversationId:conversation.id,messageId,processingAttempt:processing.attempt,sessionId:session.id,runId:run.id,baseContractVersion:run.contract.version,messageSequence:message.sequence,relatedMessageIds:this.clarificationParents(messageId).map(parent=>parent.id),workspace:session.workspace,config:structuredClone(session.config),maxContextChars:session.maxContextChars,input:{session,run,messages:this.messages(conversation.id).filter(m=>m.sequence<=message.sequence),budget:this.budget(conversation.id)},status:'running',startedAt:now(),finishedAt:null,intents:[],identities:[],modelStarted:false,observedUsage:null,usage:null,reportedUsage:null,stopConfirmed:false,settled:false,proofs:{},threadId:null,result:null,error:null,cancelRequested:false,publishedAt:null,promotion:null,finishRequest:null};
    this.db.prepare('INSERT INTO conversation_assessments(id,conversation_id,message_id,attempt,record) VALUES (?,?,?,?,?)').run(job.id,job.conversationId,messageId,job.processingAttempt,canonical(job));return job;
  });}
  /** Only process observations may change while a job runs; frozen input never does. */
  observeAssessment(id:string,patch:Partial<Pick<TerminalAssessmentJob,'intents'|'identities'|'modelStarted'|'observedUsage'>>):TerminalAssessmentJob {return this.tx(()=>{
    const job=this.assessment(id);ensure(job.status==='running','Assessment already finished');
    ensure(Object.keys(patch).every(key=>['intents','identities','modelStarted','observedUsage'].includes(key)),'Invalid assessment observation');
    if(patch.modelStarted!==undefined)ensure(patch.modelStarted||!job.modelStarted,'Model intent cannot be erased');
    if(patch.observedUsage!==undefined){ensure(patch.observedUsage!==null&&Number.isSafeInteger(patch.observedUsage)&&patch.observedUsage>=0,'Invalid observed usage');ensure(job.observedUsage===null||patch.observedUsage>=job.observedUsage,'Usage observation cannot decrease');}
    for(const key of ['intents','identities'] as const)if(patch[key])ensure(canonical(patch[key]!.slice(0,job[key].length))===canonical(job[key]),'Process evidence cannot be erased');
    Object.assign(job,structuredClone(patch));return this.saveAssessment(job);
  });}
  finishAssessment(id:string,result:Pick<TerminalAssessmentJob,'usage'|'stopConfirmed'|'proofs'|'threadId'|'result'|'error'>):TerminalAssessmentJob {return this.tx(()=>{
    const job=this.assessment(id);
    if(job.status==='finished'){ensure(job.finishRequest===canonical(result),'Conflicting assessment finish');return job;}
    job.finishRequest=canonical(result);
    ensure(result.usage===null||(Number.isSafeInteger(result.usage)&&result.usage>=0),'Invalid assessment usage');
    ensure(typeof result.stopConfirmed==='boolean','Invalid assessment stop confirmation');
    Object.assign(job,structuredClone(result));job.reportedUsage=result.usage;job.status='finished';job.finishedAt=now();
    if(job.usage!==null&&job.observedUsage!==null&&job.usage<job.observedUsage){job.usage=null;job.error='Final assessment usage contradicts durable observed usage';}
    job.settled=job.stopConfirmed&&job.usage!==null;
    // Never cap measured overruns or release an uncertain reservation.
    if(job.usage!==null&&job.usage>job.config.reservation)job.error??='Conversation reasoning exceeded its reservation';
    if(job.cancelRequested)job.error??='Conversation assessment cancelled';
    if(!job.settled)job.error??='Conversation assessment usage or stop is unknown';
    if(job.error)job.result=null;
    this.saveAssessment(job);
    if(job.error&&this.message(job.messageId).state==='processing')this.transition(job.messageId,'failed',{reason:job.error});
    return job;
  });}
  assertAssessmentBoundary(id:string):TerminalAssessmentJob {
    const job=this.assessment(id),conversation=this.get(job.conversationId),message=this.message(job.messageId),run=this.run(conversation.projectId,conversation.activeRunId);
    ensure(!job.cancelRequested&&conversation.activeRunId===job.runId&&conversation.activeSessionId===job.sessionId&&run.status==='succeeded'&&run.contract.version===job.baseContractVersion,'Terminal assessment boundary changed or cancelled');
    ensure(message.state==='processing'&&message.processing?.attempt===job.processingAttempt&&message.processing.runId===job.runId&&message.processing.baseContractVersion===job.baseContractVersion&&message.processing.throughSequence===job.messageSequence,'Assessment message boundary changed');
    ensure(canonical(this.clarificationParents(message.id).map(parent=>parent.id))===canonical(job.relatedMessageIds),'Assessment ancestry changed');
    return job;
  }
  private completedAssessment(id:string):TerminalAssessmentJob {
    const job=this.assertAssessmentBoundary(id);ensure(job.status==='finished'&&job.settled&&!job.error&&job.result&&Object.keys(job.proofs).length>0&&Object.values(job.proofs).every(value=>/^[a-f0-9]{64}$/.test(value)),'Assessment needs stopped, accounted, proven result');
    validateTerminalAssessment(job.result,this.message(job.messageId),this.clarificationParents(job.messageId));return job;
  }
  /** Caller verifies actual process stop and proof bytes before publication. */
  publishAssessment(id:string):TerminalAssessmentJob {return this.tx(()=>{
    const prior=this.assessment(id);if(prior.publishedAt)return prior;
    const job=this.completedAssessment(id),result=job.result!;ensure(result.decision!=='continue','Continue requires atomic promotion');
    if(result.decision==='answer'){
      this.transition(job.messageId,'answered',{response:result.response});
      for(const parent of this.clarificationParents(job.messageId)){
        ensure(parent.kind==='unclassified'&&parent.state==='clarifying'&&parent.processing?.runId===job.runId&&parent.processing.baseContractVersion===job.baseContractVersion,'Only an inquiry clarification may be answered');
        this.state(parent,'answered',`Inquiry clarified by ${job.messageId}`);parent.response=result.response;this.save(parent);
      }
    }else this.transition(job.messageId,'clarifying',{response:result.response+'\n'+result.questions.join('\n')});
    job.publishedAt=now();return this.saveAssessment(job);
  });}
  cancelAssessment(messageId:string,assessmentId:string):TerminalAssessmentJob {return this.tx(()=>{
    const message=this.message(messageId),job=this.assessment(assessmentId);ensure(job.messageId===messageId&&job.conversationId===message.conversationId,'Assessment belongs to another message');
    if(job.cancelRequested)return job;
    ensure(job.processingAttempt===message.processing?.attempt,'Stale assessment cancellation');
    ensure(!job.publishedAt&&!job.promotion,'Assessment already published');job.cancelRequested=true;this.saveAssessment(job);
    if(message.state==='processing')this.transition(messageId,'failed',{reason:'用户已取消此次询问分析；已交付任务保持不变。'});return job;
  });}
  /** The callback creates and starts a child inside this same transaction. */
  promoteAssessment<T>(id:string,body:()=>{value:T;childSessionId:string;childRunId:string;childProcessingAttempt:number}):T {return this.tx(()=>{
    const job=this.completedAssessment(id);ensure(job.result!.decision==='continue'&&!job.promotion,'Assessment cannot promote');
    const parents=this.clarificationParents(job.messageId).map(parent=>{ensure(parent.state==='clarifying'&&parent.processing,'Parent not clarifying');return {id:parent.id,processing:structuredClone(parent.processing)};});
    const message=this.message(job.messageId);message.processing=null;this.state(message,'waiting',`Confirmed continuation from ${job.id}`);this.save(message);
    const child=body(),round=this.rounds(job.conversationId).find(round=>round.runId===child.childRunId);
    ensure(round?.predecessorRunId===job.runId&&round.sessionId===child.childSessionId,'Promotion did not create the exact successor');
    const current=this.message(job.messageId);ensure(current.processing?.runId===child.childRunId&&current.processing.attempt===child.childProcessingAttempt,'Promotion has no frozen child processing attempt');
    job.promotion={childRunId:child.childRunId,childSessionId:child.childSessionId,childProcessingAttempt:child.childProcessingAttempt,childBaseContractVersion:current.processing.baseContractVersion,parents,promotedAt:now()};job.publishedAt=now();this.saveAssessment(job);return child.value;
  });}
  private parentBoundaryMatches(parent:ConversationMessage,message:ConversationMessage):boolean {
    if(!parent.processing||!message.processing)return false;
    if(parent.processing.runId===message.processing.runId&&parent.processing.baseContractVersion===message.processing.baseContractVersion)return true;
    const chain=[...this.clarificationParents(message.id),message];
    return this.assessments(message.conversationId).some(job=>{
      const promotion=job.promotion;if(!promotion||promotion.childRunId!==message.processing!.runId)return false;
      const trigger=chain.find(item=>item.id===job.messageId),bound=promotion.parents.find(item=>item.id===parent.id);
      return Boolean(trigger&&trigger.processing?.runId===promotion.childRunId&&trigger.processingHistory.some(boundary=>boundary.runId===promotion.childRunId&&boundary.attempt===promotion.childProcessingAttempt&&boundary.baseContractVersion===promotion.childBaseContractVersion)&&message.processing!.baseContractVersion===promotion.childBaseContractVersion&&bound&&canonical(bound.processing)===canonical(parent.processing)&&this.run(this.get(message.conversationId).projectId,job.runId).contract.version===job.baseContractVersion);
    });
  }
  private assertDelivered(run:Run):void {ensure(run.status==='succeeded'&&run.attempts.every(attempt=>attempt.status!=='running'&&attempt.settled)&&run.operations.every(operation=>operation.status==='confirmed')&&run.leases.every(lease=>lease.released),'Prior conversation Run must be delivered and fully settled');}
  childAuthorization(id:string):ConversationChildAuthorization {
    const conversation=this.get(id),rounds=this.rounds(id);ensure(this.assessments(id).every(job=>job.status==='finished'&&job.settled),'Conversation assessment accounting is unresolved');for(const round of rounds)this.assertDelivered(this.run(round.projectId,round.runId));
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
