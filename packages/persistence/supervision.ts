import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Run,RunAction } from '../contracts/p1.js';
import type { ReasonerConfig } from '../contracts/p5.js';
import type { SupervisionRecord,SupervisionJob,SupervisionIntent,SupervisionLimits } from '../contracts/p6-supervision.js';
import { applyAction } from '../domain/index.js';
import { RuntimeRepository,runtimeCanonical as canonical } from './runtime.js';
import { ConversationRepository } from './conversations.js';
import { VerificationRepository } from './verification.js';

export const SUPERVISION_MIGRATION_SQL=`
CREATE TABLE supervision_loops(id TEXT PRIMARY KEY,runtime_id TEXT NOT NULL UNIQUE REFERENCES runtime_runs(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE supervision_jobs(id TEXT PRIMARY KEY,loop_id TEXT NOT NULL REFERENCES supervision_loops(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE supervision_receipts(command_id TEXT PRIMARY KEY,request TEXT NOT NULL CHECK(json_valid(request)),record TEXT NOT NULL CHECK(json_valid(record)));
`;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
function ensure(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
function integer(value:number,label:string,min=0,max=Number.MAX_SAFE_INTEGER){ensure(Number.isSafeInteger(value)&&value>=min&&value<=max,`Invalid ${label}`);}
function identifier(value:string){ensure(typeof value==='string'&&value.trim()&&value.length<=4096&&!value.includes('\0'),'Invalid supervision identifier');}
function configValid(config:ReasonerConfig){identifier(config.model);identifier(config.effort);integer(config.reservation,'reservation',1);integer(config.timeoutMs,'timeout',1000,3600000);}
function serializable(value:unknown):string{const text=canonical(value);ensure(typeof text==='string'&&text.length<=2_000_000,'Supervision snapshot exceeds capacity');JSON.parse(text);return text;}
export class SupervisionRepository {
  constructor(private readonly db:DatabaseSync){}
  transaction<T>(body:()=>T):T {
    const own=!this.db.isTransaction;if(own)this.db.exec('BEGIN IMMEDIATE');
    try{const value=body();ensure(!value||typeof (value as {then?:unknown}).then!=='function','Asynchronous supervision transaction prohibited');if(own)this.db.exec('COMMIT');return value;}
    catch(error){if(own)this.db.exec('ROLLBACK');throw error;}
  }
  list():SupervisionRecord[]{return this.db.prepare('SELECT record FROM supervision_loops ORDER BY rowid').all().map(row=>JSON.parse(String(row.record)) as SupervisionRecord);}
  get(id:string):SupervisionRecord{const row=this.db.prepare('SELECT record FROM supervision_loops WHERE id=?').get(id);ensure(row,'Unknown supervision loop');return JSON.parse(String(row.record)) as SupervisionRecord;}
  forRuntime(runtimeId:string):SupervisionRecord|null{const row=this.db.prepare('SELECT record FROM supervision_loops WHERE runtime_id=?').get(runtimeId);return row?JSON.parse(String(row.record)) as SupervisionRecord:null;}
  jobs(loopId:string):SupervisionJob[]{this.get(loopId);return this.db.prepare('SELECT record FROM supervision_jobs WHERE loop_id=? ORDER BY rowid').all(loopId).map(row=>JSON.parse(String(row.record)) as SupervisionJob);}
  job(id:string):SupervisionJob{const row=this.db.prepare('SELECT record FROM supervision_jobs WHERE id=?').get(id);ensure(row,'Unknown supervision job');return JSON.parse(String(row.record)) as SupervisionJob;}
  private save(value:SupervisionRecord){value.revision++;value.updatedAt=now();this.db.prepare('UPDATE supervision_loops SET record=? WHERE id=?').run(serializable(value),value.id);}
  private saveJob(value:SupervisionJob){this.db.prepare('UPDATE supervision_jobs SET record=? WHERE id=?').run(serializable(value),value.id);}
  private receipt<T>(commandId:string,input:unknown):T|null{identifier(commandId);const row=this.db.prepare('SELECT request,record FROM supervision_receipts WHERE command_id=?').get(commandId);if(!row)return null;ensure(row.request===serializable(input),'Conflicting supervision commandId');return JSON.parse(String(row.record)) as T;}
  private record(commandId:string,input:unknown,value:unknown){this.db.prepare('INSERT INTO supervision_receipts(command_id,request,record) VALUES (?,?,?)').run(commandId,serializable(input),serializable(value));}
  private ledger(loop:SupervisionRecord):Run{const row=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(loop.projectId,loop.runId);ensure(row,'Missing supervision ledger');return JSON.parse(String(row.snapshot)) as Run;}
  private act(loop:SupervisionRecord,action:RunAction):Run{
    const result=applyAction(this.ledger(loop),action);
    this.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(canonical(result.run),result.run.revision,loop.projectId,loop.runId);
    for(const event of result.events)this.db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES (?,?,?,?,?)').run(loop.id,loop.projectId,loop.runId,event.type,canonical(event));return result.run;
  }
  attach(input:{commandId:string;runtimeId:string;config:ReasonerConfig;limits:SupervisionLimits}):SupervisionRecord{return this.transaction(()=>{
    const prior=this.receipt<{id:string}>(input.commandId,input);if(prior)return this.get(prior.id);
    configValid(input.config);integer(input.limits.maxRepairs,'repair limit',0,100);integer(input.limits.maxReasoningCalls,'reasoning limit',1,1000);integer(input.limits.maxDurationMs,'duration',1000,30*24*3600000);integer(input.limits.maxContextChars,'context capacity',8000,200000);
    const inspection=new RuntimeRepository(this.db).inspect(input.runtimeId),run=inspection.run;
    ensure(!this.forRuntime(input.runtimeId),'Runtime already supervised');ensure(run.admission!=='draft'&&!['succeeded','cancelled'].includes(run.status),'Only unfinished admitted runtime may be supervised');
    const time=now(),value:SupervisionRecord={id:'supervision-'+hash(input.runtimeId).slice(0,24),runtimeId:input.runtimeId,projectId:run.projectId,runId:run.id,contractVersion:run.contract.version,contractDigest:hash(canonical(run.contract)),revision:0,phase:'executing',paused:false,stopped:false,reason:null,config:structuredClone(input.config),limits:structuredClone(input.limits),createdAt:time,updatedAt:time,repairCount:0,reasoningCount:0,intent:null,references:{},monitor:null};
    this.db.prepare('INSERT INTO supervision_loops(id,runtime_id,record) VALUES (?,?,?)').run(value.id,value.runtimeId,serializable(value));this.record(input.commandId,input,{id:value.id});return value;
  });}
  /** CAS prevents an older monitor/controller callback overwriting a newer pause or contract boundary. */
  update(id:string,expectedRevision:number,patch:Partial<Pick<SupervisionRecord,'phase'|'paused'|'stopped'|'reason'|'references'|'monitor'>>):SupervisionRecord{return this.transaction(()=>{
    const value=this.get(id);ensure(value.revision===expectedRevision,'Stale supervision revision');
    ensure(Object.keys(patch).every(key=>['phase','paused','stopped','reason','references','monitor'].includes(key)),'Immutable supervision fields cannot change');
    if(patch.phase!==undefined)ensure(['executing','authoring','reviewing','publishing','freezing','verifying','diagnosing','repairing','delivering','blocked','complete'].includes(patch.phase),'Invalid supervision phase');
    for(const key of ['paused','stopped'] as const)if(patch[key]!==undefined)ensure(typeof patch[key]==='boolean','Invalid supervision control');
    if(patch.reason!==undefined)ensure(patch.reason===null||typeof patch.reason==='string','Invalid supervision reason');
    if(patch.phase==='complete')ensure(this.ledger(value).status==='succeeded','Only independent delivery completes supervision');
    if(patch.stopped===false)ensure(!value.stopped,'Stopped supervision needs a separate explicit recovery policy');
    Object.assign(value,structuredClone(patch));this.save(value);return value;
  });}
  private eligible(loop:SupervisionRecord):Run{
    const run=this.ledger(loop);ensure(!loop.paused&&!loop.stopped&&!['paused','cancelled','succeeded'].includes(run.status),'Supervision dispatch disabled');
    ensure(run.contract.version===loop.contractVersion&&hash(canonical(run.contract))===loop.contractDigest,'Supervision contract changed');
    ensure(Date.now()-Date.parse(loop.createdAt)<loop.limits.maxDurationMs,'Supervision duration exhausted');
    ensure(!new ConversationRepository(this.db).hasPendingForRun(run.projectId,run.id),'Pending user follow-up prevents supervision dispatch');return run;
  }
  assertEligible(id:string):void{this.eligible(this.get(id));}
  prepareIntent(input:{commandId:string;loopId:string;expectedRevision:number;kind:SupervisionIntent['kind'];action:unknown}):SupervisionIntent{return this.transaction(()=>{
    const prior=this.receipt<{id:string;intent:SupervisionIntent}>(input.commandId,input);if(prior)return prior.intent;
    const loop=this.get(input.loopId);ensure(loop.revision===input.expectedRevision,'Stale supervision revision');this.eligible(loop);
    ensure(['propose','review','publish','freeze','verify','deliver','repair','retry'].includes(input.kind),'Invalid supervision intent kind');
    if(['repair','retry'].includes(input.kind))ensure(loop.repairCount<loop.limits.maxRepairs,'Supervision repair limit exhausted');
    ensure(!loop.intent||loop.intent.completedAt!==null,'Unacknowledged supervision intent');
    ensure(!this.jobs(loop.id).some(job=>job.status==='running'||!job.stopConfirmed||job.usage===null),'Unresolved supervision job prevents transition');
    const actionText=serializable(input.action),intent:SupervisionIntent={id:'intent-'+hash(input.commandId).slice(0,24),commandId:input.commandId,kind:input.kind,contractVersion:loop.contractVersion,input:JSON.parse(actionText),inputDigest:hash(actionText),preparedAt:now(),receipt:null,completedAt:null};
    loop.intent=intent;this.save(loop);this.record(input.commandId,input,{id:loop.id,intent});return intent;
  });}
  acknowledgeIntent(loopId:string,intentId:string,receipt:unknown):SupervisionRecord{return this.transaction(()=>{
    const loop=this.get(loopId),intent=loop.intent;ensure(intent?.id===intentId,'Supervision intent changed');
    if(intent.completedAt){ensure(canonical(intent.receipt)===canonical(receipt),'Conflicting supervision receipt');return loop;}
    // Record even after pause/cancel: acknowledging a dispatched effect is not authorizing another one.
    intent.receipt=JSON.parse(serializable(receipt));intent.completedAt=now();if(['repair','retry'].includes(intent.kind))loop.repairCount++;this.save(loop);return loop;
  });}
  beginJob(input:{commandId:string;loopId:string;expectedRevision:number;purpose:SupervisionJob['purpose'];context:unknown;config?:ReasonerConfig}):SupervisionJob{return this.transaction(()=>{
    ensure(input.purpose!=='inspection','Inspection requires the dedicated monitor reservation and frozen evidence binding');
    const prior=this.receipt<{jobId:string}>(input.commandId,input);if(prior)return this.job(prior.jobId);
    const loop=this.get(input.loopId);ensure(loop.revision===input.expectedRevision,'Stale supervision revision');const run=this.eligible(loop);
    ensure(!loop.intent||loop.intent.completedAt!==null,'Unacknowledged supervision intent');
    ensure(loop.reasoningCount<loop.limits.maxReasoningCalls,'Supervision reasoning limit exhausted');ensure(['acceptance-authoring','diagnosis'].includes(input.purpose),'Unknown supervision purpose');
    ensure(!this.jobs(loop.id).some(job=>job.status==='running'||!job.stopConfirmed||job.usage===null),'Unresolved supervision reasoning');
    const config=structuredClone(input.config??loop.config);configValid(config);const context=serializable(input.context);ensure(context.length+6000<=loop.limits.maxContextChars,'Supervision context exceeds capacity');
    // Assets and diagnoses are built only at a settled boundary. Concurrent read-only
    // inspection requires its own domain reservation capability; do not bypass this.
    ensure(run.attempts.every(a=>a.settled)&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released),'Supervision requires a settled execution boundary');
    if(input.purpose==='acceptance-authoring')ensure(run.nodes.every(node=>!node.required||node.status==='succeeded'),'Acceptance authoring needs completed implementation');
    new VerificationRepository(this.db).assertNoVerificationWriter(new RuntimeRepository(this.db).get(loop.runtimeId).workspace);
    const id='supervision-job-'+hash(input.commandId).slice(0,24);
    this.act(loop,{type:'startAttempt',attemptId:id,nodeId:'@supervisor',contractVersion:run.contract.version,purpose:'reasoning',reservation:config.reservation,resources:[]});this.act(loop,{type:'setOperation',operationId:id,attemptId:id,status:'pending'});
    const job:SupervisionJob={id,loopId:loop.id,runtimeId:loop.runtimeId,projectId:run.projectId,runId:run.id,contractVersion:run.contract.version,contractDigest:loop.contractDigest,purpose:input.purpose,status:'running',attemptId:id,config,input:JSON.parse(context),inputDigest:hash(context),startedAt:now(),finishedAt:null,intents:[],identities:[],modelStarted:false,observedUsage:0,usage:null,stopConfirmed:false,error:null,proofs:{},threadId:null,result:null};
    this.db.prepare('INSERT INTO supervision_jobs(id,loop_id,record) VALUES (?,?,?)').run(id,loop.id,serializable(job));loop.reasoningCount++;this.save(loop);this.record(input.commandId,input,{jobId:id});return job;
  });}
  observeJob(id:string,patch:Partial<Pick<SupervisionJob,'intents'|'identities'|'modelStarted'|'observedUsage'>>):SupervisionJob{return this.transaction(()=>{
    const job=this.job(id);ensure(job.status==='running','Finished supervision job is immutable');ensure(Object.keys(patch).every(key=>['intents','identities','modelStarted','observedUsage'].includes(key)),'Invalid job observation');
    if(patch.observedUsage!==undefined){integer(patch.observedUsage,'observed usage');ensure(patch.observedUsage>=job.observedUsage,'Usage observation cannot decrease');}
    ensure(!job.modelStarted||patch.modelStarted!==false,'Model start intent cannot be erased');
    for(const key of ['intents','identities'] as const)if(patch[key])ensure(canonical(patch[key]!.slice(0,job[key].length))===canonical(job[key]),'Process history cannot be overwritten');
    Object.assign(job,structuredClone(patch));this.saveJob(job);return job;
  });}
  finishJob(id:string,completion:Pick<SupervisionJob,'usage'|'stopConfirmed'|'error'|'proofs'|'threadId'|'result'>):SupervisionJob{return this.transaction(()=>{
    const job=this.job(id),loop=this.get(job.loopId),completionDigest=hash(serializable(completion));if(job.status==='finished'){ensure(job.completionDigest===completionDigest,'Conflicting supervision settlement');return job;}
    if(completion.usage!==null)integer(completion.usage,'actual usage');ensure(typeof completion.stopConfirmed==='boolean','Invalid stop confirmation');
    for(const [path,digest] of Object.entries(completion.proofs))ensure(path.startsWith('/')&&/^[a-f0-9]{64}$/.test(digest),'Invalid supervision proof');
    ensure(completion.result===null||(completion.stopConfirmed&&completion.usage!==null&&!completion.error&&Object.keys(completion.proofs).length>0),'Unverified model result cannot publish');
    Object.assign(job,structuredClone(completion));job.reportedUsage=completion.usage;job.completionDigest=completionDigest;
    if(job.usage!==null&&job.usage<job.observedUsage){job.usage=null;job.error='Final model usage is lower than the durable observed usage; settlement remains unknown';job.result=null;}
    else if(job.usage!==null&&job.usage>job.config.reservation){job.error=job.error??'Supervision model exceeded its reserved budget';job.result=null;}
    job.status='finished';job.finishedAt=now();
    this.act(loop,{type:'finishAttempt',attemptId:id,outcome:!job.error&&job.stopConfirmed&&job.usage!==null?'succeeded':'failed'});
    if(job.usage!==null)this.act(loop,{type:'settleAttempt',attemptId:id,actual:job.usage});
    this.act(loop,{type:'setOperation',operationId:id,attemptId:id,status:job.stopConfirmed?'confirmed':'unknown'});this.saveJob(job);return job;
  });}
}
