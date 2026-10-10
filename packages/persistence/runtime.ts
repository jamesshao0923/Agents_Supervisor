import { VerificationRepository } from './verification.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { basename, sep } from 'node:path';
import type { Run, RunAction } from '../contracts/p1.js';
import { parseRuntimeAction, type RuntimeBinding, type RuntimeCheckpoint, type RuntimeControl, type RuntimeEvent, type RuntimeOperation, type RuntimeRecord, type RuntimeReport, type RuntimeSubmit } from '../contracts/p3.js';
import { applyAction, createRun } from '../domain/index.js';

export function runtimeCanonical(v: unknown): string {
  if(v===null||typeof v!=='object')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(runtimeCanonical).join(',')+']';
  return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+runtimeCanonical(x)).join(',')+'}';
}
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const ensure=(v:unknown,message:string):void=>{if(!v)throw new Error(message);};
export class RuntimeRepository {
  constructor(private readonly db: DatabaseSync) {}
  private tx<T>(work:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  get(id:string):RuntimeRecord {const row=this.db.prepare('SELECT record FROM runtime_runs WHERE id=?').get(id);if(!row)throw new Error('Unknown runtime');return JSON.parse(String(row.record)) as RuntimeRecord;}
  list():RuntimeRecord[] {return this.db.prepare('SELECT record FROM runtime_runs ORDER BY rowid DESC').all().map(r=>JSON.parse(String(r.record)) as RuntimeRecord);}
  operations(id?:string):RuntimeOperation[] {return (id?this.db.prepare('SELECT record FROM runtime_outbox WHERE runtime_id=? ORDER BY rowid').all(id):this.db.prepare('SELECT record FROM runtime_outbox ORDER BY rowid').all()).map(r=>JSON.parse(String(r.record)) as RuntimeOperation);}
  private operation(id:string):RuntimeOperation {const row=this.db.prepare('SELECT record FROM runtime_outbox WHERE id=?').get(id);if(!row)throw new Error('Unknown operation');return JSON.parse(String(row.record)) as RuntimeOperation;}
  private run(r:RuntimeRecord):Run {const row=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(r.projectId,r.runId);if(!row)throw new Error('Missing runtime domain Run');return JSON.parse(String(row.snapshot)) as Run;}
  private action(r:RuntimeRecord,action:RunAction) {const value=applyAction(this.run(r),action);this.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(runtimeCanonical(value.run),value.run.revision,r.projectId,r.runId);for(const e of value.events)this.db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES (?,?,?,?,?)').run(r.id,r.projectId,r.runId,e.type,runtimeCanonical(e));return value.run;}
  private save(r:RuntimeRecord,kind:string,payload:unknown) {r.projectionVersion++;r.updatedAt=new Date().toISOString();this.db.prepare('UPDATE runtime_runs SET record=? WHERE id=?').run(runtimeCanonical(r),r.id);this.db.prepare('INSERT INTO runtime_events(runtime_id,kind,payload,created_at) VALUES (?,?,?,?)').run(r.id,kind,runtimeCanonical(payload),r.updatedAt);}
  private saveOp(o:RuntimeOperation) {this.db.prepare('UPDATE runtime_outbox SET record=? WHERE id=?').run(runtimeCanonical(o),o.id);}
  events(id:string,after:number):RuntimeEvent[] {this.get(id);return this.db.prepare('SELECT * FROM runtime_events WHERE runtime_id=? AND seq>? ORDER BY seq LIMIT 500').all(id,after).map(r=>({seq:Number(r.seq),runtimeId:id,kind:String(r.kind),payload:JSON.parse(String(r.payload)),createdAt:String(r.created_at)}));}
  inspect(id:string) {const runtime=this.get(id);return {runtime,run:this.run(runtime),operations:this.operations(id),checkpoints:this.db.prepare('SELECT record,digest FROM runtime_checkpoints WHERE runtime_id=? ORDER BY rowid').all(id).map(r=>({checkpoint:JSON.parse(String(r.record)) as RuntimeCheckpoint,digest:String(r.digest),valid:hash(String(r.record))===r.digest}))};}
  checkpoint(id:string):RuntimeCheckpoint|null {const r=this.get(id);if(!r.checkpointId)return null;const row=this.db.prepare('SELECT record,digest FROM runtime_checkpoints WHERE id=?').get(r.checkpointId);ensure(row,'Missing checkpoint');ensure(hash(String(row!.record))===row!.digest,'Checkpoint digest mismatch');const c=JSON.parse(String(row!.record)) as RuntimeCheckpoint;ensure(c.schemaVersion===1&&c.workflowVersion===1,'Unsupported checkpoint version');ensure(c.runtimeId===r.id&&c.cursor===r.cursor,'Checkpoint position mismatch');ensure(c.contractVersion===this.run(r).contract.version,'Checkpoint contract version mismatch');return c;}
  private checkpointWrite(r:RuntimeRecord) {
    const run=this.run(r);const old=r.checkpointId?this.checkpoint(r.id):null;
    const plans=this.db.prepare('SELECT definition FROM verification_plans WHERE project_id=? AND run_id=? ORDER BY id').all(r.projectId,r.runId).map(x=>JSON.parse(String(x.definition)) as unknown);
    const retained=new Map<string,unknown>();for(const p of [...(old?.frozenPlans??[]),...plans]){const v=p as {id:string};if(retained.has(v.id))ensure(runtimeCanonical(retained.get(v.id))===runtimeCanonical(p),'Frozen plan changed');retained.set(v.id,p);}
    const c:RuntimeCheckpoint={id:`${r.id}:checkpoint:${r.projectionVersion+1}`,runtimeId:r.id,schemaVersion:1,workflowVersion:1,cursor:r.cursor,contractVersion:run.contract.version,domainRevision:run.revision,budget:run.budget,attempts:run.attempts,operations:run.operations,artifact:run.artifact,frozenPlans:[...retained.values()],createdAt:new Date().toISOString()};
    const content=runtimeCanonical(c);this.db.prepare('INSERT INTO runtime_checkpoints(id,runtime_id,digest,record) VALUES (?,?,?,?)').run(c.id,r.id,hash(content),content);r.checkpointId=c.id;
  }
  private enqueue(r:RuntimeRecord) {
    const step=r.definition.steps[r.cursor];if(!step)return;
    const id='op-'+hash(`${r.id}:${step.id}`).slice(0,32);
    const attemptId=step.kind==='codex'?'exec-'+hash(id).slice(0,24):id;
    const op:RuntimeOperation={id,runtimeId:r.id,stepIndex:r.cursor,step,attemptId,contractVersion:this.run(r).contract.version,owner:null,state:'queued',executionId:step.kind==='codex'?attemptId:null,result:null,error:null};
    this.db.prepare('INSERT INTO runtime_outbox(id,runtime_id,record) VALUES (?,?,?)').run(id,r.id,runtimeCanonical(op));
  }
  submit(input:RuntimeSubmit&{workspace:string;workspaceKind:'project'|'managed'}):RuntimeRecord {
    const {workspaceKind,...request}=input;parseRuntimeAction(request);
    return this.tx(()=>{
      const receipt=this.db.prepare('SELECT request,result FROM runtime_receipts WHERE command_id=?').get(input.commandId);
      if(receipt){ensure(receipt.request===runtimeCanonical(input),'Runtime commandId conflicts with prior request');return this.get(String(JSON.parse(String(receipt.result)).id));}
      new VerificationRepository(this.db).assertNoVerificationWriter(input.workspace);
      const id='runtime-'+hash(input.commandId).slice(0,24),projectId='workspace-'+hash(input.workspace).slice(0,24),now=new Date().toISOString();
      for(const active of this.list().filter(r=>r.workspace===input.workspace||r.workspace.startsWith(input.workspace+sep)||input.workspace.startsWith(r.workspace+sep))) ensure(['cancelled','awaiting-verification'].includes(active.phase)&&this.operations(active.id).every(o=>['confirmed','cancelled'].includes(o.state)),'Workspace has unresolved runtime work');
      for(const row of this.db.prepare('SELECT record FROM executions').all()){const e=JSON.parse(String(row.record)) as {workspace:string;stopConfirmed:boolean};ensure(e.stopConfirmed||!(e.workspace===input.workspace||e.workspace.startsWith(input.workspace+sep)||input.workspace.startsWith(e.workspace+sep)),'Workspace has an active or unverified writer');}
      this.db.prepare('INSERT OR IGNORE INTO projects(id,name) VALUES (?,?)').run(projectId,basename(input.workspace));
      const run=createRun({id,projectId,contract:{version:1,goal:input.goal,criteria:[{id:'independent-acceptance',description:'Independently verify the candidate; completing workflow steps is not delivery acceptance',required:true}]},nodes:input.steps.map((s,i)=>({id:s.id,dependencies:i?[input.steps[i-1]!.id]:[],required:true})),budget:{unit:'token',limit:input.tokenLimit,verificationReserve:input.verificationReserve}});
      this.db.prepare('INSERT INTO runs(project_id,id,revision,snapshot) VALUES (?,?,?,?)').run(projectId,id,run.revision,runtimeCanonical(run));
      const r:RuntimeRecord={id,engine:'local-v1',workflowVersion:1,projectionVersion:0,projectId,runId:id,workspace:input.workspace,workspaceKind,definition:request,cursor:0,phase:input.steps[0]?.kind==='input'?'waiting-input':'ready',paused:false,cancelled:false,createdAt:now,updatedAt:now,error:null,inputs:{},checkpointId:null};
      this.db.prepare('INSERT INTO runtime_runs(id,project_id,run_id,record) VALUES (?,?,?,?)').run(id,projectId,id,runtimeCanonical(r));this.enqueue(r);this.checkpointWrite(r);this.save(r,'submitted',{definition:request});
      this.db.prepare('INSERT INTO runtime_receipts(command_id,request,result) VALUES (?,?,?)').run(input.commandId,runtimeCanonical(input),runtimeCanonical(r));return r;
    });
  }
  control(input:RuntimeControl):RuntimeRecord {parseRuntimeAction(input);return this.tx(()=>{
    const receipt=this.db.prepare('SELECT request,result FROM runtime_receipts WHERE command_id=?').get(input.commandId);if(receipt){ensure(receipt.request===runtimeCanonical(input),'Runtime commandId conflicts with prior request');return JSON.parse(String(receipt.result)) as RuntimeRecord;}
    const r=this.get(input.runtimeId);this.compatible(r);
    if(input.type==='cancel') {if(!r.cancelled){r.cancelled=true;r.paused=false;r.phase='cancelled';this.action(r,{type:'cancel'});for(const o of this.operations(r.id))if(o.state==='queued'){o.state='cancelled';this.saveOp(o);}}}
    else {ensure(!r.cancelled||input.type==='reconcile','Cancelled runtime cannot resume or accept input');
      if(input.type==='pause'){if(!r.paused){r.paused=true;r.phase='paused';this.action(r,{type:'pause'});}}
      if(input.type==='resume'){this.checkpoint(r.id);ensure(r.paused,'Runtime is not paused');r.paused=false;this.action(r,{type:'resume'});r.phase=this.phase(r);}
      if(input.type==='input'){const s=r.definition.steps[r.cursor];ensure(s?.kind==='input'&&s.id===input.stepId,'Input is only accepted at the declared current wait');ensure(!Object.hasOwn(r.inputs,input.stepId),'Input already supplied');r.inputs[input.stepId]=input.text;r.phase=this.phase(r);}
      if(input.type==='reconcile'){r.error=null;/* A durable request, consumed by worker query-only reconciliation. */}
    }
    this.save(r,input.type,input);this.db.prepare('INSERT INTO runtime_receipts(command_id,request,result) VALUES (?,?,?)').run(input.commandId,runtimeCanonical(input),runtimeCanonical(r));return r;
  });}
  private compatible(r:RuntimeRecord){ensure(r.engine==='local-v1'&&r.workflowVersion===1,'Unsupported runtime workflow version');this.checkpoint(r.id);}
  private phase(r:RuntimeRecord):RuntimeRecord['phase'] {if(r.cancelled)return 'cancelled';if(r.paused)return 'paused';if(r.cursor>=r.definition.steps.length)return 'awaiting-verification';const o=this.operations(r.id).find(x=>x.stepIndex===r.cursor);if(o&&['unknown','failed'].includes(o.state))return 'blocked';if(o&&['claimed','started'].includes(o.state))return 'running';const s=r.definition.steps[r.cursor]!;return s.kind==='input'&&!Object.hasOwn(r.inputs,s.id)?'waiting-input':'ready';}
  claim(id:string,owner:string):RuntimeOperation|null {return this.tx(()=>{
    const r=this.get(id);this.compatible(r);if(r.paused||r.cancelled)return null;const o=this.operations(id).find(x=>x.stepIndex===r.cursor&&x.state==='queued');if(!o)return null;if(o.step.kind==='input'&&!Object.hasOwn(r.inputs,o.step.id))return null;
    this.action(r,{type:'startAttempt',attemptId:o.attemptId,nodeId:o.step.id,contractVersion:o.contractVersion,reservation:o.step.kind==='codex'?o.step.reservation:0,purpose:'execution',resources:o.step.kind==='codex'?['workspace:'+r.workspace]:[]});this.action(r,{type:'setOperation',operationId:o.attemptId,attemptId:o.attemptId,status:'pending'});
    o.owner=owner;o.state='claimed';this.saveOp(o);r.phase='running';this.save(r,'claimed',{operationId:o.id,owner});return o;
  });}
  eligible(id:string,owner:string):void {const o=this.operation(id),r=this.get(o.runtimeId);this.compatible(r);ensure(o.owner===owner,'Stale worker qualification');ensure(!r.paused&&!r.cancelled,'Runtime dispatch is paused or cancelled');ensure(['claimed','started'].includes(o.state),'Operation is not eligible');const run=this.run(r);ensure(run.contract.version===o.contractVersion&&run.attempts.find(a=>a.id===o.attemptId)?.status==='running','Stale attempt qualification');}
  markStarted(id:string,owner:string):RuntimeOperation {return this.tx(()=>{this.eligible(id,owner);const o=this.operation(id);if(o.state==='started')return o;o.state='started';this.saveOp(o);const r=this.get(o.runtimeId);this.save(r,'effect-intent',{operationId:id,owner});return o;});}
  binding(id:string,owner:string):RuntimeBinding {this.eligible(id,owner);const o=this.operation(id),r=this.get(o.runtimeId);return {runtimeId:r.id,operationId:id,owner,projectId:r.projectId,runId:r.runId,attemptId:o.attemptId};}
  adopt(id:string,owner:string):RuntimeOperation {return this.tx(()=>{const o=this.operation(id),r=this.get(o.runtimeId);this.compatible(r);ensure(!['confirmed','failed','cancelled'].includes(o.state),'Terminal operation cannot be adopted');o.owner=owner;this.saveOp(o);this.save(r,'recovery-adopted',{operationId:id,owner});return o;});}
  report(id:string,owner:string,report:RuntimeReport):RuntimeRecord {return this.tx(()=>{
    const request=runtimeCanonical({id,owner,report});const prior=this.db.prepare('SELECT request,result FROM runtime_inbox WHERE message_id=?').get(report.messageId);if(prior){ensure(prior.request===request,'Conflicting inbox delivery');return JSON.parse(String(prior.result)) as RuntimeRecord;}
    const o=this.operation(id),r=this.get(o.runtimeId);ensure(o.owner===owner,'Stale worker report');ensure(!['confirmed','failed','cancelled'].includes(o.state),'Operation already terminal');
    let run=this.run(r);let attempt=run.attempts.find(a=>a.id===o.attemptId);ensure(attempt,'Operation has no attempt');
    if(o.step.kind!=='codex'){
      if(report.outcome!=='unknown'&&attempt!.status==='running')this.action(r,{type:'finishAttempt',attemptId:o.attemptId,outcome:report.outcome==='confirmed'?'succeeded':report.outcome==='cancelled'?'cancelled':'failed'});
      if(report.outcome!=='unknown'&&!attempt!.settled)this.action(r,{type:'settleAttempt',attemptId:o.attemptId,actual:0});
      this.action(r,{type:'setOperation',operationId:o.attemptId,attemptId:o.attemptId,status:report.outcome==='confirmed'||(o.state==='claimed'&&report.outcome==='cancelled')?'confirmed':'unknown'});
    } else {
      const execution=this.db.prepare('SELECT record FROM executions WHERE id=?').get(o.executionId!);
      if(!execution && ['claimed','started'].includes(o.state) && report.outcome==='cancelled') {
        if(attempt!.status==='running')this.action(r,{type:'finishAttempt',attemptId:o.attemptId,outcome:'cancelled'});
        if(!attempt!.settled)this.action(r,{type:'settleAttempt',attemptId:o.attemptId,actual:0});
        this.action(r,{type:'setOperation',operationId:o.attemptId,attemptId:o.attemptId,status:'confirmed'});
        const lease=this.run(r).leases.find(l=>l.attemptId===o.attemptId&&!l.released);if(lease)this.action(r,{type:'releaseLease',attemptId:o.attemptId,resource:lease.resource});
      } else {
        ensure(execution,'Codex report needs durable execution receipt');const e=JSON.parse(String(execution!.record)) as {state:string;stopConfirmed:boolean};ensure(e.stopConfirmed||report.outcome==='unknown','Codex writer not confirmed stopped');if(report.outcome==='confirmed')ensure(e.state==='completed'&&attempt!.settled,'Codex result is not completed and settled');
      }
    }
    o.state=report.outcome;o.result=report.result;o.error=report.error??null;this.saveOp(o);r.error=o.error;
    if(report.outcome==='confirmed'&&!r.cancelled){r.cursor++;this.enqueue(r);}
    // Read prior checkpoint before saving the changed cursor; it remains the immutable parent.
    this.checkpointWrite(r);r.phase=this.phase(r);this.save(r,'reported',{operationId:id,report});
    this.db.prepare('INSERT INTO runtime_inbox(message_id,request,result) VALUES (?,?,?)').run(report.messageId,request,runtimeCanonical(r));return r;
  });}
  block(id:string,error:string):void {this.tx(()=>{const r=this.get(id);r.error=error;if(!r.cancelled&&!r.paused)r.phase='blocked';this.save(r,'recovery-blocked',{error});});}
}
