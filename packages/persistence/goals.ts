import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Run, RunAction } from '../contracts/p1.js';
import type { GoalInspection,GoalSession,OrchestrationAction,ReasoningJob } from '../contracts/p5.js';
import { applyAction,createDraftRun } from '../domain/index.js';
import { admittedPlan } from '../orchestration/admission.js';
import { RuntimeRepository,runtimeCanonical as canonical } from './runtime.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function ensure(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
export class GoalRepository {
  constructor(private db:DatabaseSync){}
  private tx<T>(f:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const x=f();this.db.exec('COMMIT');return x;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  list():GoalSession[]{return this.db.prepare('SELECT record FROM goal_sessions ORDER BY rowid DESC').all().map(r=>JSON.parse(String(r.record)) as GoalSession);}
  get(id:string):GoalSession {const row=this.db.prepare('SELECT record FROM goal_sessions WHERE id=?').get(id);ensure(row,'Unknown goal');return JSON.parse(String(row.record)) as GoalSession;}
  inspect(id:string):GoalInspection {const session=this.get(id);return {session,run:this.run(session)};}
  private run(s:GoalSession):Run {const row=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(s.projectId,s.id);ensure(row,'Missing goal ledger');return JSON.parse(String(row.snapshot)) as Run;}
  private act(s:GoalSession,a:RunAction):Run {const x=applyAction(this.run(s),a);this.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(canonical(x.run),x.run.revision,s.projectId,s.id);for(const e of x.events)this.db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES (?,?,?,?,?)').run(s.id,s.projectId,s.id,e.type,canonical(e));return x.run;}
  private save(s:GoalSession):void{s.revision++;s.updatedAt=new Date().toISOString();this.db.prepare('UPDATE goal_sessions SET record=? WHERE id=?').run(canonical(s),s.id);}
  private receipt(a:Exclude<OrchestrationAction,{type:'list'}|{type:'inspect';sessionId:string}>):GoalSession|null {const old=this.db.prepare('SELECT request,session_id FROM goal_receipts WHERE command_id=?').get(a.commandId);if(!old)return null;ensure(old.request===canonical(a),'Conflicting goal commandId');return this.get(String(old.session_id));}
  private receipted(a:unknown,id:string,commandId:string){this.db.prepare('INSERT INTO goal_receipts(command_id,request,session_id) VALUES (?,?,?)').run(commandId,canonical(a),id);}
  private begin(s:GoalSession,purpose:ReasoningJob['purpose']):void {
    ensure(!s.jobs.some(j=>j.status==='running'),'Reasoner already running');
    const id=`${s.id}-reason-${s.jobs.length+1}`;
    this.act(s,{type:'startAttempt',attemptId:id,nodeId:'@supervisor',contractVersion:this.run(s).contract.version,purpose:'reasoning',reservation:s.config.reservation,resources:[]});
    this.act(s,{type:'setOperation',operationId:id,attemptId:id,status:'pending'});
    s.jobs.push({id,purpose,status:'running',attemptId:id,config:s.config,intents:[],identities:[],startedAt:new Date().toISOString(),finishedAt:null,modelStarted:false,usage:null,stopConfirmed:false,error:null,proofs:{},context:null,proposal:null,threadId:null});s.phase='thinking';s.error=null;
  }
  startReceipt(a:Extract<OrchestrationAction,{type:'start'}>):GoalInspection|null {const prior=this.receipt(a);return prior?this.inspect(prior.id):null;}
  start(a:Extract<OrchestrationAction,{type:'start'}>,workspace:string,workspaceKind:'project'|'managed'):GoalInspection {return this.tx(()=>{
    const prior=this.receipt(a);if(prior)return this.inspect(prior.id);
    const id='goal-'+hash(a.commandId).slice(0,24),projectId='workspace-'+hash(workspace).slice(0,24),now=new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO projects(id,name) VALUES (?,?)').run(projectId,basename(workspace));
    const run=createDraftRun({id,projectId,goal:a.goal,budget:{unit:'token',limit:a.tokenLimit,verificationReserve:a.verificationReserve}});
    this.db.prepare('INSERT INTO runs(project_id,id,revision,snapshot) VALUES (?,?,?,?)').run(projectId,id,run.revision,canonical(run));
    const s:GoalSession={id,projectId,workspace,workspaceKind,revision:0,goal:a.goal,phase:'thinking',messages:[{id:`${id}:message:1`,role:'user',text:a.goal,createdAt:now}],jobs:[],proposal:null,runtimeId:null,error:null,createdAt:now,updatedAt:now,config:{model:a.model,effort:a.effort,reservation:a.reservation,timeoutMs:a.timeoutMs},maxContextChars:a.maxContextChars??60000};
    this.db.prepare('INSERT INTO goal_sessions(id,project_id,run_id,record) VALUES (?,?,?,?)').run(id,projectId,id,canonical(s));this.begin(s,'requirements');this.save(s);this.receipted(a,id,a.commandId);return this.inspect(id);
  });}
  validateAdmission(a:Extract<OrchestrationAction,{type:'admit'}>):void {
    if(this.receipt(a))return;const s=this.get(a.sessionId),run=this.run(s);
    ensure(a.expectedRevision===s.revision,'Goal revision changed');ensure(s.phase==='ready'&&!s.runtimeId,'Goal is not ready for admission');
    ensure(s.jobs.every(j=>j.status==='finished'&&j.stopConfirmed&&j.usage!==null),'Unresolved model work prevents admission');
    const plan=admittedPlan(s,run);applyAction(run,{type:'admit',contract:plan.contract,nodes:plan.steps.map((step,i)=>({id:step.id,dependencies:i?[plan.steps[i-1]!.id]:[],required:true}))});
    ensure(run.budget.limit-run.budget.spent-run.budget.verificationReserve>=s.config.reservation,'Insufficient execution budget');
  }
  control(a:Exclude<OrchestrationAction,{type:'start'}|{type:'list'}|{type:'inspect';sessionId:string}>):GoalInspection {return this.tx(()=>{
    const prior=this.receipt(a);if(prior)return this.inspect(prior.id);const s=this.get(a.sessionId);
    if(a.type==='cancel'){ensure(!s.runtimeId,'Cancel admitted tasks through runtime');this.act(s,{type:'cancel'});s.phase='cancelled';}
    else {ensure(s.phase!=='cancelled','Goal is cancelled');ensure(a.expectedRevision===s.revision,'Goal revision changed');
      if(a.type==='admit'){
        ensure(s.phase==='ready'&&!s.runtimeId,'Goal is not ready for admission');const plan=admittedPlan(s,this.run(s));
        ensure(s.jobs.every(j=>j.status==='finished'&&j.stopConfirmed&&j.usage!==null),'Unresolved model work prevents admission');
        this.act(s,{type:'admit',contract:plan.contract,nodes:plan.steps.map((step,i)=>({id:step.id,dependencies:i?[plan.steps[i-1]!.id]:[],required:true}))});
        const run=this.run(s);ensure(run.budget.limit-run.budget.spent-run.budget.verificationReserve>=s.config.reservation,'Insufficient execution budget');
        const runtime=new RuntimeRepository(this.db).adoptGoal({type:'submit',commandId:a.commandId,workspace:s.workspace,workspaceKind:s.workspaceKind,goal:s.goal,tokenLimit:run.budget.limit,verificationReserve:run.budget.verificationReserve,steps:plan.steps},s.projectId,s.id);s.runtimeId=runtime.id;s.phase='admitted';
      }else {if(a.type==='answer'){ensure(!s.runtimeId&&!s.jobs.some(j=>j.status==='running'),'Cannot change requirements during execution or reasoning');s.messages.push({id:`${s.id}:message:${s.messages.length+1}`,role:'user',text:a.text,createdAt:new Date().toISOString()});s.proposal=null;}
        if(a.type==='restore'&&s.runtimeId){const runtime=new RuntimeRepository(this.db).inspect(s.runtimeId);ensure(['awaiting-verification','paused','blocked'].includes(runtime.runtime.phase)&&runtime.run.attempts.every(x=>x.status!=='running'&&x.settled),'Runtime must be quiescent before context restoration');}
        this.begin(s,a.type==='restore'?'restore':'requirements');
      }
    }
    this.save(s);this.receipted(a,s.id,a.commandId);return this.inspect(s.id);
  });}
  update(id:string,jobId:string,change:(job:ReasoningJob,session:GoalSession)=>void):GoalInspection {return this.tx(()=>{const s=this.get(id),j=s.jobs.find(j=>j.id===jobId);ensure(j?.status==='running','Reasoning job is not running');change(j,s);this.save(s);return this.inspect(id);});}
  finish(id:string,jobId:string,change:(job:ReasoningJob)=>void):GoalInspection{return this.tx(()=>{
    const s=this.get(id),j=s.jobs.find(j=>j.id===jobId);ensure(j,'Missing job');if(j.status==='finished')return this.inspect(id);change(j);if(this.run(s).status==='cancelled')s.phase='cancelled';j.status='finished';j.finishedAt=new Date().toISOString();
    this.act(s,{type:'finishAttempt',attemptId:j.attemptId,outcome:s.phase==='cancelled'?'cancelled':j.error?'failed':'succeeded'});
    if(j.usage!==null)this.act(s,{type:'settleAttempt',attemptId:j.attemptId,actual:j.usage});
    this.act(s,{type:'setOperation',operationId:j.attemptId,attemptId:j.attemptId,status:j.stopConfirmed?'confirmed':'unknown'});
    if(s.phase!=='cancelled'){s.error=j.error;s.phase=j.error||j.usage===null||!j.stopConfirmed?'blocked':s.runtimeId?'admitted':j.proposal?.decision==='ready'?'ready':'clarifying';if(j.proposal&&!j.error&&!s.runtimeId)s.proposal=j.proposal;}
    this.save(s);return this.inspect(id);
  });}
}
