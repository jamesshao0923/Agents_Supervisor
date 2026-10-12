import {withinTokenReservation} from '../contracts/token-policy.js';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Run,RunAction} from '../contracts/p1.js';
import type {ReasonerConfig} from '../contracts/p5.js';
import type {SupervisionJob,SupervisionRecord} from '../contracts/p6-supervision.js';
import type {MonitorEnvelopeV1,MonitorEvent,MonitorEvidenceRef,InspectionSnapshot,FrozenInspectionInput,InspectionDisposition} from '../contracts/p6-monitor.js';
import {INSPECTION_RESULT_SCHEMA,safeMonitorJSON,parseInspectionResult} from '../contracts/p6-monitor.js';
import {createMonitorState,decideMonitoring,completeInspection,type MonitorInput,type MonitorDecision} from '../orchestration/loop-policy.js';
import {applyAction} from '../domain/index.js';
import {RuntimeRepository,runtimeCanonical as canonical} from './runtime.js';
import {SupervisionRepository} from './supervision.js';
import {ConversationRepository} from './conversations.js';
import {VerificationRepository} from './verification.js';
import {executionList,executionGet} from './executions.js';

export const SUPERVISION_MONITOR_MIGRATION_SQL=`
CREATE TABLE supervision_monitor_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,loop_id TEXT NOT NULL REFERENCES supervision_loops(id),kind TEXT NOT NULL CHECK(kind IN ('health','window','transition','disposition')),window INTEGER CHECK(window IS NULL OR window>=1),job_id TEXT REFERENCES supervision_jobs(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE UNIQUE INDEX supervision_monitor_window ON supervision_monitor_events(loop_id,window) WHERE kind='window';
CREATE UNIQUE INDEX supervision_monitor_disposition ON supervision_monitor_events(job_id) WHERE kind='disposition';
CREATE TRIGGER supervision_monitor_events_no_update BEFORE UPDATE ON supervision_monitor_events BEGIN SELECT RAISE(ABORT,'Monitor events are append-only');END;
CREATE TRIGGER supervision_monitor_events_no_delete BEFORE DELETE ON supervision_monitor_events BEGIN SELECT RAISE(ABORT,'Monitor events are append-only');END;
`;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function ensure(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function identifier(value:string){ensure(typeof value==='string'&&value.trim()&&value.length<=4096&&!value.includes('\0'),'Invalid monitor identifier');}
function integer(value:number,min=0,max=Number.MAX_SAFE_INTEGER){ensure(Number.isSafeInteger(value)&&value>=min&&value<=max,'Invalid monitor integer');}
function json(value:unknown):string{safeMonitorJSON(value);const text=canonical(value);ensure(text.length<=2_000_000,'Monitor context exceeds capacity');return text;}
/** No process or filesystem claims are inferred here; the runner validates actual
 * identities/proofs before persisting completion. This repository owns atomic
 * policy/job/reservation transitions and never reads an active workspace. */
export class SupervisionMonitorRepository {
  private readonly supervision:SupervisionRepository;
  constructor(private readonly db:DatabaseSync){this.supervision=new SupervisionRepository(db);}
  private transaction<T>(work:()=>T):T{return this.supervision.transaction(work);}
  private receipt<T>(commandId:string,input:unknown):T|null{identifier(commandId);const row=this.db.prepare('SELECT request,record FROM supervision_receipts WHERE command_id=?').get(commandId);if(!row)return null;ensure(row.request===json(input),'Conflicting monitor commandId');return JSON.parse(String(row.record)) as T;}
  private remember(commandId:string,input:unknown,value:unknown){this.db.prepare('INSERT INTO supervision_receipts(command_id,request,record) VALUES (?,?,?)').run(commandId,json(input),json(value));}
  private ledger(loop:SupervisionRecord):Run{return new RuntimeRepository(this.db).inspect(loop.runtimeId).run;}
  private act(loop:SupervisionRecord,action:RunAction){const {run,events}=applyAction(this.ledger(loop),action);this.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(canonical(run),run.revision,loop.projectId,loop.runId);for(const event of events)this.db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES (?,?,?,?,?)').run(loop.id,loop.projectId,loop.runId,event.type,canonical(event));}
  envelope(loopId:string):MonitorEnvelopeV1|null{
    const loop=this.supervision.get(loopId);if(loop.monitor===null)return null;safeMonitorJSON(loop.monitor);const value=loop.monitor as MonitorEnvelopeV1;
    ensure(Object.keys(value).sort().join(',')==='activeJobId,contractDigest,contractVersion,policyVersion,schemaVersion,state'&&value.schemaVersion===1&&value.policyVersion==='p6-monitor-v1','Unsupported monitor envelope');
    ensure(value.contractVersion===loop.contractVersion&&value.contractDigest===loop.contractDigest,'Monitor envelope contract changed');
    if(value.activeJobId!==null)identifier(value.activeJobId);
    // The pure policy validates its entire state and chronology without dispatch.
    decideMonitoring(value.state,{nowMs:value.state.lastObservedAtMs,lifecycle:'paused',evidenceCursor:value.state.lastCheckedEvidenceCursor});return structuredClone(value);
  }
  events(loopId:string,after=0):MonitorEvent[]{this.supervision.get(loopId);integer(after);return this.db.prepare('SELECT * FROM supervision_monitor_events WHERE loop_id=? AND seq>? ORDER BY seq').all(loopId,after).map(row=>({seq:Number(row.seq),loopId,kind:String(row.kind) as MonitorEvent['kind'],window:row.window===null?null:Number(row.window),jobId:row.job_id===null?null:String(row.job_id),record:JSON.parse(String(row.record)) as MonitorEvent['record']}));}
  private event(loopId:string,kind:MonitorEvent['kind'],window:number|null,jobId:string|null,record:MonitorEvent['record']){this.db.prepare('INSERT INTO supervision_monitor_events(loop_id,kind,window,job_id,record) VALUES (?,?,?,?,?)').run(loopId,kind,window,jobId,json(record));}
  initialize(input:{commandId:string;loopId:string;expectedRevision:number;startedAtMs:number;evidenceCursor:string;evidenceRefs?:MonitorEvidenceRef[]}):MonitorEnvelopeV1{return this.transaction(()=>{
    const request={method:'monitor-initialize',...input},prior=this.receipt<MonitorEnvelopeV1>(input.commandId,request);if(prior)return prior;
    const loop=this.supervision.get(input.loopId);ensure(loop.revision===input.expectedRevision,'Stale monitor revision');ensure(loop.monitor===null,'Monitor already initialized');this.supervision.assertEligible(loop.id);integer(input.startedAtMs);ensure(input.startedAtMs>=Date.parse(loop.createdAt)&&input.startedAtMs<=Date.now(),'Monitor epoch must be a real current loop time');
    ensure(input.evidenceCursor===this.cursor(loop.id,input.evidenceRefs??[]),'Monitor baseline cursor must match authoritative semantic evidence');
    const envelope:MonitorEnvelopeV1={schemaVersion:1,policyVersion:'p6-monitor-v1',contractVersion:loop.contractVersion,contractDigest:loop.contractDigest,state:createMonitorState(input.startedAtMs,input.evidenceCursor),activeJobId:null};this.supervision.update(loop.id,loop.revision,{monitor:envelope});this.remember(input.commandId,request,envelope);return envelope;
  });}
  cursor(loopId:string,evidenceRefs:MonitorEvidenceRef[]=[]):string{const snapshot=this.snapshot(this.supervision.get(loopId),evidenceRefs);return this.snapshotCursor(snapshot);}
  private snapshotCursor(snapshot:InspectionSnapshot):string{
    // Cursor deliberately excludes budget/usage, timestamps, heartbeat IDs and
    // monitor jobs. Event originals remain in the frozen snapshot/proof digest;
    // only explicit business facts affect model dispatch.
    const facts=snapshot.evidence.map(item=>{const value=item.value as {kind:string;payload:Record<string,unknown>};const payload=value.payload;if(item.reference.kind==='runtime-event'){if(!['effect-intent','reported','recovery-blocked','plan-revised'].includes(value.kind))return null;return {kind:value.kind,operationId:payload.operationId??null,outcome:(payload.report as {outcome?:unknown}|undefined)?.outcome??null,error:payload.error??null,contractVersion:payload.contractVersion??null};}if(value.kind==='execution-error'||value.kind==='deadline-reached')return {kind:value.kind,error:payload.message??null};if(value.kind==='codex-event'&&payload.kind==='diff')return {kind:'diff',diff:payload.diff??null};return null;}).filter(value=>value!==null);
    return hash(json({contract:snapshot.contract,runtime:snapshot.runtime,executions:snapshot.executions.map(item=>({id:item.id,attemptId:item.attemptId,state:item.state,stopConfirmed:item.stopConfirmed})),facts:[...new Set(facts.map(value=>json(value)))].sort()}));
  }
  observe(input:{commandId:string;loopId:string;expectedRevision:number;input:MonitorInput;evidenceRefs?:MonitorEvidenceRef[]}):{loop:SupervisionRecord;decision:MonitorDecision}{return this.transaction(()=>{
    const request={method:'monitor-observe',...input},prior=this.receipt<{loop:SupervisionRecord;decision:MonitorDecision}>(input.commandId,request);if(prior)return prior;
    const loop=this.supervision.get(input.loopId);ensure(loop.revision===input.expectedRevision,'Stale monitor revision');const envelope=this.envelope(loop.id);ensure(envelope,'Monitor not initialized');
    const runtime=new RuntimeRepository(this.db).get(loop.runtimeId),run=this.ledger(loop);
    const actualLifecycle=loop.stopped||loop.phase==='complete'||runtime.cancelled||['cancelled','succeeded'].includes(run.status)?'terminal':loop.paused||runtime.paused||run.status==='paused'||new ConversationRepository(this.db).hasPendingForRun(run.projectId,run.id)?'paused':'active';
    ensure(input.input.lifecycle===actualLifecycle,'Monitor lifecycle does not match authoritative state');
    ensure(input.input.evidenceCursor===this.cursor(loop.id,input.evidenceRefs??[]),'Monitor cursor must match authoritative semantic evidence');
    const decision=decideMonitoring(envelope.state,input.input);envelope.state=decision.state;
    const record:MonitorEvent['record']={observedAt:new Date(input.input.nowMs).toISOString(),decision:decision.inspection,healthScan:decision.healthScan,evidenceCursor:input.input.evidenceCursor,signals:[...(input.input.signals??[])],missedWindows:decision.missedWindows};
    if(decision.healthScan)this.event(loop.id,'health',null,envelope.activeJobId,record);
    if(decision.window!==null){const existing=this.db.prepare("SELECT seq FROM supervision_monitor_events WHERE loop_id=? AND window=? AND kind='window'").get(loop.id,decision.window);this.event(loop.id,existing?'transition':'window',decision.window,envelope.activeJobId,record);}
    const result={loop:this.supervision.update(loop.id,loop.revision,{monitor:envelope}),decision};this.remember(input.commandId,request,result);return result;
  });}
  private snapshot(loop:SupervisionRecord,references:MonitorEvidenceRef[]):InspectionSnapshot{
    ensure(Array.isArray(references)&&references.length<=128,'Invalid monitor evidence references');safeMonitorJSON(references);const runtime=new RuntimeRepository(this.db),record=runtime.get(loop.runtimeId),operations=runtime.currentOperations(loop.runtimeId),run=this.ledger(loop);
    const executions=executionList(this.db).filter(item=>item.projectId===loop.projectId&&item.runId===loop.runId);
    const evidence=references.map(reference=>{
      integer(reference.seq,1);let value:unknown;
      if(reference.kind==='runtime-event'){ensure(Object.keys(reference).sort().join(',')==='kind,seq','Invalid runtime evidence reference');const row=this.db.prepare('SELECT kind,payload,created_at FROM runtime_events WHERE runtime_id=? AND seq=?').get(loop.runtimeId,reference.seq);ensure(row,'Missing runtime evidence');value={kind:row.kind,payload:JSON.parse(String(row.payload)),createdAt:row.created_at};}
      else{ensure(reference.kind==='execution-event'&&Object.keys(reference).sort().join(',')==='executionId,kind,seq','Invalid execution evidence reference');const execution=executionGet(this.db,reference.executionId);ensure(execution.projectId===loop.projectId&&execution.runId===loop.runId,'Foreign execution evidence');const row=this.db.prepare('SELECT kind,payload,received_at FROM execution_events WHERE execution_id=? AND seq=?').get(reference.executionId,reference.seq);ensure(row,'Missing execution evidence');value={kind:row.kind,payload:JSON.parse(String(row.payload)),receivedAt:row.received_at};}
      return {id:reference.kind+':'+('executionId'in reference?reference.executionId+':':'')+reference.seq,reference,digest:hash(json(value)),value};
    });ensure(new Set(evidence.map(item=>item.id)).size===evidence.length,'Duplicate monitor evidence');
    return {schemaVersion:1,contract:run.contract,runtime:{id:record.id,phase:record.phase,cursor:record.cursor,operations:operations.map(item=>({id:item.id,attemptId:item.attemptId,contractVersion:item.contractVersion,state:item.state,executionId:item.executionId}))},executions:executions.map(item=>({id:item.id,attemptId:item.attemptId,state:item.state,stopConfirmed:item.stopConfirmed,usageStatus:item.usageStatus,usage:item.usage,identity:item.identity})),evidence};
  }
  hasInspectionWriter(loopId:string):boolean{
    const loop=this.supervision.get(loopId),runtime=new RuntimeRepository(this.db),run=this.ledger(loop),active=runtime.currentOperations(loop.runtimeId).filter(op=>['claimed','started'].includes(op.state));
    if(loop.phase!=='executing'||active.length!==1||active[0]!.step.kind!=='codex'||!active[0]!.executionId)return false;
    const operation=active[0]!,row=this.db.prepare('SELECT record FROM executions WHERE id=?').get(operation.executionId!);if(!row)return false;const execution=JSON.parse(String(row.record)) as ReturnType<typeof executionGet>,attempt=run.attempts.find(item=>item.id===operation.attemptId);
    return Boolean(attempt?.purpose==='execution'&&attempt.status==='running'&&!attempt.settled&&attempt.contractVersion===loop.contractVersion&&execution.runtimeBinding?.runtimeId===loop.runtimeId&&execution.runtimeBinding.operationId===operation.id&&execution.attemptId===operation.attemptId&&execution.projectId===loop.projectId&&execution.runId===loop.runId&&['starting','running','waiting'].includes(execution.state)&&!execution.stopConfirmed&&!execution.cancelRequested&&execution.identity);
  }
  beginInspection(input:{commandId:string;loopId:string;expectedRevision:number;prompt:string;evidenceRefs:MonitorEvidenceRef[];config?:ReasonerConfig}):SupervisionJob{return this.transaction(()=>{
    const request={method:'monitor-begin',...input},prior=this.receipt<{jobId:string}>(input.commandId,request);if(prior)return this.supervision.job(prior.jobId);
    const loop=this.supervision.get(input.loopId);ensure(loop.revision===input.expectedRevision,'Stale monitor revision');this.supervision.assertEligible(loop.id);ensure(loop.phase==='executing','Inspection requires executing supervision');ensure(!loop.intent||loop.intent.completedAt!==null,'Unacknowledged supervision intent');const envelope=this.envelope(loop.id);ensure(envelope?.state.inFlight&&!envelope.activeJobId,'No unclaimed monitor inspection intent');ensure(loop.reasoningCount<loop.limits.maxReasoningCalls,'Supervision reasoning limit exhausted');ensure(this.supervision.jobs(loop.id).every(job=>job.status==='finished'&&job.stopConfirmed&&job.usage!==null),'Unresolved supervision reasoning');
    const runtime=new RuntimeRepository(this.db),run=this.ledger(loop),active=runtime.currentOperations(loop.runtimeId).filter(op=>['claimed','started'].includes(op.state));ensure(active.length===1&&active[0]!.step.kind==='codex'&&active[0]!.executionId,'Inspection needs one current Codex writer');const operation=active[0]!,execution=executionGet(this.db,operation.executionId!);ensure(execution.runtimeBinding?.runtimeId===loop.runtimeId&&execution.runtimeBinding.operationId===operation.id&&execution.attemptId===operation.attemptId&&execution.runId===loop.runId&&['starting','running','waiting'].includes(execution.state)&&!execution.stopConfirmed&&!execution.cancelRequested&&execution.identity,'Inspection writer receipt is not qualified');new VerificationRepository(this.db).assertNoVerificationWriter(runtime.get(loop.runtimeId).workspace);
    const config=structuredClone(input.config??loop.config);identifier(config.model);identifier(config.effort);integer(config.reservation,1);integer(config.timeoutMs,1000,3600000);ensure(typeof input.prompt==='string'&&input.prompt.trim()&&input.prompt.length<=200000&&!input.prompt.includes('\0'),'Invalid inspection prompt');
    const snapshot=this.snapshot(loop,input.evidenceRefs),intent=envelope.state.inFlight,id='inspection-job-'+hash(loop.id+':'+input.commandId).slice(0,24);
    const frozen:FrozenInspectionInput={prompt:input.prompt,outputSchema:structuredClone(INSPECTION_RESULT_SCHEMA),context:{binding:{schemaVersion:1,loopId:loop.id,runtimeId:loop.runtimeId,projectId:loop.projectId,runId:loop.runId,contractVersion:loop.contractVersion,contractDigest:loop.contractDigest,intentId:intent.id,window:intent.window,evidenceCursor:intent.evidenceCursor,snapshotDigest:hash(json(snapshot))},snapshot}};
    ensure(intent.evidenceCursor===this.snapshotCursor(snapshot),'Inspection observation changed before reservation');
    const content=json(frozen);ensure(content.length+6000<=loop.limits.maxContextChars,'Supervision context exceeds capacity');
    this.act(loop,{type:'startAttempt',attemptId:id,nodeId:'@inspection',contractVersion:run.contract.version,purpose:'inspection',reservation:config.reservation,resources:[]});this.act(loop,{type:'setOperation',operationId:id,attemptId:id,status:'pending'});
    const job:SupervisionJob={id,loopId:loop.id,runtimeId:loop.runtimeId,projectId:loop.projectId,runId:loop.runId,contractVersion:loop.contractVersion,contractDigest:loop.contractDigest,purpose:'inspection',status:'running',attemptId:id,config,input:frozen,inputDigest:hash(content),startedAt:new Date().toISOString(),finishedAt:null,intents:[],identities:[],modelStarted:false,observedUsage:0,usage:null,stopConfirmed:false,error:null,proofs:{},threadId:null,result:null};this.db.prepare('INSERT INTO supervision_jobs(id,loop_id,record) VALUES (?,?,?)').run(id,loop.id,json(job));envelope.activeJobId=id;loop.reasoningCount++;this.db.prepare('UPDATE supervision_loops SET record=? WHERE id=?').run(json(loop),loop.id);this.supervision.update(loop.id,loop.revision,{monitor:envelope});this.remember(input.commandId,request,{jobId:id});return job;
  });}
  deferChangedObservation(input:{commandId:string;loopId:string;expectedRevision:number;evidenceRefs:MonitorEvidenceRef[]}):MonitorEnvelopeV1{return this.transaction(()=>{
    const request={method:'monitor-defer',...input},prior=this.receipt<MonitorEnvelopeV1>(input.commandId,request);if(prior)return prior;
    const loop=this.supervision.get(input.loopId);ensure(loop.revision===input.expectedRevision,'Stale monitor revision');const envelope=this.envelope(loop.id);ensure(envelope?.state.inFlight&&envelope.activeJobId===null,'Only an unclaimed observation may be deferred');
    const run=this.ledger(loop),runtime=new RuntimeRepository(this.db).get(loop.runtimeId),pending=new ConversationRepository(this.db).hasPendingForRun(run.projectId,run.id),changed=this.cursor(loop.id,input.evidenceRefs)!==envelope.state.inFlight.evidenceCursor;
    ensure(changed||loop.paused||loop.stopped||runtime.paused||runtime.cancelled||pending||run.contract.version!==loop.contractVersion||hash(json(run.contract))!==loop.contractDigest||runtime.phase!=='running'||loop.phase!=='executing'||!this.hasInspectionWriter(loop.id),'Observation has no authoritative changed boundary');
    const intent=envelope.state.inFlight,reason=changed?'Semantic evidence changed before inspection reservation':pending?'Pending user follow-up before reservation':'Execution or contract boundary changed before reservation';
    envelope.state=completeInspection(envelope.state,intent.id,false);this.supervision.update(loop.id,loop.revision,{monitor:envelope});this.event(loop.id,'disposition',intent.window,null,{observedAt:new Date().toISOString(),disposition:'discarded-by-runner',reason});this.remember(input.commandId,request,envelope);return envelope;
  });}
  completeInspection(input:{commandId:string;jobId:string;discardReason?:string}):{disposition:InspectionDisposition;envelope:MonitorEnvelopeV1}{return this.transaction(()=>{
    const request={method:'monitor-complete',...input},prior=this.receipt<{disposition:InspectionDisposition;envelope:MonitorEnvelopeV1}>(input.commandId,request);if(prior)return prior;
    const job=this.supervision.job(input.jobId),loop=this.supervision.get(job.loopId),envelope=this.envelope(loop.id);
    const priorDisposition=this.db.prepare("SELECT record FROM supervision_monitor_events WHERE job_id=? AND kind='disposition'").get(job.id);if(priorDisposition){ensure(envelope,'Monitor not initialized');const result={disposition:(JSON.parse(String(priorDisposition.record)) as {disposition:InspectionDisposition}).disposition,envelope};this.remember(input.commandId,request,result);return result;}
    ensure(job.purpose==='inspection'&&job.status==='finished'&&envelope?.activeJobId===job.id&&envelope.state.inFlight,'No finished active inspection');
    const frozen=job.input as FrozenInspectionInput;ensure(hash(json(frozen))===job.inputDigest&&frozen.context.binding.intentId===envelope.state.inFlight.id&&frozen.context.binding.snapshotDigest===hash(json(frozen.context.snapshot)),'Inspection frozen binding changed');const run=this.ledger(loop),attempt=run.attempts.find(item=>item.id===job.attemptId),operation=run.operations.find(item=>item.id===job.id);
    let disposition:InspectionDisposition,reason:string;
    if(job.usage===null||!job.stopConfirmed||!attempt?.settled||operation?.status!=='confirmed'){disposition='unknown';reason='Inspection usage or stop remains unresolved';}
    else if(run.contract.version!==job.contractVersion||hash(json(run.contract))!==job.contractDigest){disposition='discarded-stale-contract';reason='Inspection belongs to an obsolete contract';}
    else if(new ConversationRepository(this.db).hasPendingForRun(run.projectId,run.id)){disposition='discarded-pending-followup';reason='User follow-up supersedes inspection application';}
    else if(loop.paused||loop.stopped||new RuntimeRepository(this.db).get(loop.runtimeId).paused||['paused','cancelled','succeeded'].includes(run.status)){disposition='discarded-inactive';reason='Inspection completion cannot dispatch while inactive';}
    else if(input.discardReason!==undefined){identifier(input.discardReason);disposition='discarded-by-runner';reason=input.discardReason;}
    else if(job.error||!job.modelStarted||job.usage<=0||job.usage<job.observedUsage||!withinTokenReservation(run.budget.limit,job.usage,job.config.reservation)||attempt.actual!==job.usage||attempt.status!=='succeeded'||!job.identities.length||job.intents.length!==job.identities.length||new Set(job.identities.map(identity=>identity.operationId)).size!==job.identities.length||job.identities.some(identity=>!job.intents.some(intent=>intent.operationId===identity.operationId&&intent.ownerToken===identity.ownerToken))||!Object.keys(job.proofs).length){disposition='failed';reason=job.error??'Inspection lacks successful actual model evidence';}
    else{try{ensure(job.completionDigest===hash(json({usage:job.usage,stopConfirmed:job.stopConfirmed,error:job.error,proofs:job.proofs,threadId:job.threadId,result:job.result})),'Inspection completion digest changed');parseInspectionResult(job.result,frozen.context.snapshot.evidence.map(item=>item.id));disposition='applied';reason='Known successful current inspection applied only to monitor cursor';}catch(error){disposition='failed';reason=String(error);}}
    if(disposition!=='unknown'){envelope.state=completeInspection(envelope.state,frozen.context.binding.intentId,disposition==='applied');envelope.activeJobId=null;this.supervision.update(loop.id,loop.revision,{monitor:envelope});}
    this.event(loop.id,'disposition',frozen.context.binding.window,job.id,{observedAt:new Date().toISOString(),disposition,reason});const result={disposition,envelope};this.remember(input.commandId,request,result);return result;
  });}
}
