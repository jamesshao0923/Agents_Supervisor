import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {SupervisionInterruption} from '../contracts/p6-interruptions.js';
import {SupervisionRepository} from './supervision.js';
import {VerificationRepository} from './verification.js';
import {runtimeCanonical} from './runtime.js';

export const SUPERVISION_INTERRUPTION_MIGRATION_SQL=`
CREATE TABLE supervision_interruptions(id TEXT PRIMARY KEY,loop_id TEXT NOT NULL REFERENCES supervision_loops(id),job_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL CHECK(json_valid(record)));
`;
const digest=(value:unknown)=>createHash('sha256').update(runtimeCanonical(value)).digest('hex');
function ensure(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
/** The parent supervision transaction owns pause/resume plus this provenance. */
export class SupervisionInterruptionRepository {
  constructor(private readonly db:DatabaseSync){}
  private transaction<T>(body:()=>T):T{return new SupervisionRepository(this.db).transaction(body);}
  list(loopId:string):SupervisionInterruption[]{return this.db.prepare('SELECT record FROM supervision_interruptions WHERE loop_id=? ORDER BY rowid').all(loopId).map(row=>JSON.parse(String(row.record)) as SupervisionInterruption);}
  forJob(jobId:string):SupervisionInterruption|null{const row=this.db.prepare('SELECT record FROM supervision_interruptions WHERE job_id=?').get(jobId);return row?JSON.parse(String(row.record)) as SupervisionInterruption:null;}
  forCommand(commandId:string):SupervisionInterruption|null{return this.db.prepare('SELECT record FROM supervision_interruptions').all().map(row=>JSON.parse(String(row.record)) as SupervisionInterruption).find(record=>record.replacement?.commandId===commandId)??null;}
  private get(id:string):SupervisionInterruption{const row=this.db.prepare('SELECT record FROM supervision_interruptions WHERE id=?').get(id);ensure(row,'Unknown supervision interruption');return JSON.parse(String(row.record)) as SupervisionInterruption;}
  private save(record:SupervisionInterruption):void{this.db.prepare('UPDATE supervision_interruptions SET record=? WHERE id=?').run(runtimeCanonical(record),record.id);}
  requestPause(loopId:string,jobId:string):SupervisionInterruption{return this.transaction(()=>{
    const previous=this.forJob(jobId);if(previous){ensure(previous.loopId===loopId,'Interruption belongs to another loop');return previous;}
    const loop=new SupervisionRepository(this.db).get(loopId),repo=new VerificationRepository(this.db),job=repo.get('job',jobId);
    ensure(loop.paused&&!loop.stopped,'Explicit paused loop required');
    ensure(job.runtimeId===loop.runtimeId&&job.projectId===loop.projectId&&job.runId===loop.runId&&[loop.references.reviewId,loop.references.verificationJobId].includes(job.id),'Pause may only bind an owned verifier job');
    ensure(job.status==='running'&&!job.error,'Only running verifier without prior error can record pause provenance');
    const proposal=repo.get('proposal',job.proposalId),plan=job.planId?repo.get('plan',job.planId):null,head=repo.headForRun(job.projectId,job.runId);
    ensure(proposal.contractDigest===loop.contractDigest&&(!plan||plan.contractDigest===loop.contractDigest),'Interruption contract changed');
    const value:SupervisionInterruption={id:'interruption-'+digest(jobId).slice(0,24),loopId,jobId,origin:'explicit-supervision-pause',requestedAt:new Date().toISOString(),runtimeId:job.runtimeId,projectId:job.projectId,runId:job.runId,kind:job.kind,proposalId:job.proposalId,planId:job.planId,boundary:{contractDigest:loop.contractDigest,proposalDigest:digest(proposal),planDigest:plan?digest(plan):null,head:head?{id:head.id,version:head.version}:null,environmentDigest:job.environmentDigest,requestDigest:digest(job.request),configDigest:digest(job.config)},replacement:null};
    this.db.prepare('INSERT INTO supervision_interruptions(id,loop_id,job_id,record) VALUES (?,?,?,?)').run(value.id,loopId,jobId,runtimeCanonical(value));return value;
  });}
  /** Revalidate immutable records synchronously, including inside resume commit. */
  assertBoundary(value:SupervisionInterruption):void{
    ensure(runtimeCanonical(this.get(value.id))===runtimeCanonical(value),'Interruption changed');
    const loop=new SupervisionRepository(this.db).get(value.loopId),repo=new VerificationRepository(this.db),job=repo.get('job',value.jobId),proposal=repo.get('proposal',value.proposalId),plan=value.planId?repo.get('plan',value.planId):null,head=repo.headForRun(value.projectId,value.runId);
    ensure(loop.runtimeId===value.runtimeId&&loop.runId===value.runId&&loop.projectId===value.projectId&&loop.contractDigest===value.boundary.contractDigest,'Pause loop boundary changed');
    ensure(job.runtimeId===value.runtimeId&&job.projectId===value.projectId&&job.runId===value.runId&&job.kind===value.kind&&job.proposalId===value.proposalId&&job.planId===value.planId&&job.environmentDigest===value.boundary.environmentDigest&&digest(job.request)===value.boundary.requestDigest&&digest(job.config)===value.boundary.configDigest,'Paused verifier binding changed');
    ensure(digest(proposal)===value.boundary.proposalDigest&&(plan?digest(plan):null)===value.boundary.planDigest&&runtimeCanonical(head?{id:head.id,version:head.version}:null)===runtimeCanonical(value.boundary.head),'Paused proposal, plan or published head changed');
  }
  authorizeReplacement(id:string,commandId:string):SupervisionInterruption{return this.transaction(()=>{
    const value=this.get(id);if(value.replacement){ensure(value.replacement.commandId===commandId,'Pause already authorized another replacement');return value;}
    this.assertBoundary(value);const supervision=new SupervisionRepository(this.db),loop=supervision.get(value.loopId),repo=new VerificationRepository(this.db),job=repo.get('job',value.jobId),run=repo.run(value.projectId,value.runId),intent=loop.intent;
    supervision.assertEligible(loop.id);ensure(job.status==='finished'&&job.stopConfirmed&&!job.usageUnknown&&job.error!==null&&Object.keys(job.proofs).length>0,'Paused verifier is not settled with cancellation evidence');
    ensure(run.attempts.every(a=>a.settled&&a.status!=='running')&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released),'Pause recovery requires a fully settled boundary');ensure(run.attempts.find(a=>a.id===job.attemptId)?.actual===job.usage,'Paused verification usage mismatch');
    ensure(intent?.commandId===commandId&&intent.completedAt===null&&intent.kind===(value.kind==='review'?'review':'verify'),'Replacement must have a fresh prepared intent');
    const action=intent.input as Record<string,unknown>;ensure(action.commandId===commandId&&action.type===(value.kind==='review'?'review':'run')&&(value.kind==='review'?action.proposalId===value.proposalId:action.planId===value.planId),'Replacement changes original verification target');
    ensure(digest({model:action.model,effort:action.effort,reservation:action.reservation,timeoutMs:action.timeoutMs})===value.boundary.configDigest,'Replacement changes original model configuration');
    value.replacement={commandId,intentId:intent.id,authorizedAt:new Date().toISOString(),jobId:null};this.save(value);return value;
  });}
  acknowledgeReplacement(id:string,jobId:string):SupervisionInterruption{return this.transaction(()=>{
    const value=this.get(id);ensure(value.replacement,'No authorized replacement');if(value.replacement.jobId){ensure(value.replacement.jobId===jobId,'Conflicting replacement receipt');return value;}
    const loop=new SupervisionRepository(this.db).get(value.loopId),intent=loop.intent;ensure(intent?.id===value.replacement.intentId,'Replacement intent changed');
    const repo=new VerificationRepository(this.db),receipt=repo.receipt(value.replacement.commandId,intent.input) as {id?:string}|undefined,job=repo.get('job',jobId);ensure(receipt?.id===job.id&&job.runtimeId===value.runtimeId&&job.runId===value.runId&&job.projectId===value.projectId&&job.kind===value.kind&&job.proposalId===value.proposalId&&job.planId===value.planId&&runtimeCanonical(job.request)===runtimeCanonical(intent.input)&&digest(job.config)===value.boundary.configDigest,'Unbound replacement receipt');
    value.replacement.jobId=jobId;this.save(value);return value;
  });}
}
