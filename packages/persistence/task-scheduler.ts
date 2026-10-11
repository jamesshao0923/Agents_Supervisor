import {parseExplorationAction,type ExplorationAction,type ExplorationInspection} from '../contracts/p7-exploration.js';
import type {ExplorationTier} from '../contracts/p7-scheduler.js';
import {ConversationRepository} from './conversations.js';
import {assertScheduledProjection,assertScheduledClaimOrigin,loopProgramComplete,stoppedLoopTask,hasLoopTables} from './scheduled-plan-history.js';
import {HostScheduledInputs,type ScheduledInputSource,type ScheduledInputReceipt} from '../workspace/scheduled-inputs.js';
import {scheduledExecutionPrompt} from '../contracts/p7-inputs.js';
import {createHash} from 'node:crypto';
import {realpathSync,lstatSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import type {Run,DomainEvent} from '../contracts/p1.js';
import type {ExecutionRecord,ExecutionStart} from '../contracts/p2.js';
import type {RuntimeRecord} from '../contracts/p3.js';
import type {ScheduledPlan,ScheduledRecord,ScheduledClaim,ScheduledOperation,ScheduledLease,ScheduledExpected,ScheduledClaimResult,ScheduledBinding} from '../contracts/p7-dispatch.js';
import {safeResultJSON} from '../contracts/p7-results.js';
import {createScheduledDispatch} from '../domain/scheduled-dispatch.js';
import {createTaskScheduler} from '../domain/task-scheduler.js';
import {inspectProcess,type ProcessIdentity} from '../process-control/index.js';
import {TaskResultRepository} from './task-results.js';
const sha256=(s:string)=>createHash('sha256').update(s).digest('hex'),domain=createScheduledDispatch({sha256});
function canonical(v:any):string{if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
function ensure(ok:unknown,message:string):asserts ok{if(!ok)throw Error('Scheduled repository: '+message);}
export { SCHEDULED_MIGRATION_SQL } from './schema13.js';
/** All budget amounts are projections of runs.snapshot. No scheduler budget
 * table, cost reset or independent settlement authority exists here. */
export class TaskSchedulerRepository{
 constructor(private readonly db:DatabaseSync,private readonly dataRoot:string,private readonly now:()=>number=Date.now){}
 private tx<T>(work:()=>T):T{const own=!this.db.isTransaction;if(own)this.db.exec('BEGIN IMMEDIATE');else this.db.exec('SAVEPOINT scheduled_call');try{const result=work();ensure(!result||typeof(result as {then?:unknown}).then!=='function','async transaction forbidden');this.db.exec(own?'COMMIT':'RELEASE scheduled_call');return result;}catch(e){this.db.exec(own?'ROLLBACK':'ROLLBACK TO scheduled_call');if(!own)this.db.exec('RELEASE scheduled_call');throw e;}}
 private prior<T>(commandId:string,request:unknown):T|undefined{safeResultJSON(request);ensure(commandId.trim()&&commandId.length<=200,'invalid command');const row=this.db.prepare('SELECT request,result FROM scheduled_receipts WHERE command_id=?').get(commandId);if(!row)return undefined;ensure(row.request===canonical(request),'command conflict');return JSON.parse(String(row.result)) as T;}
 private remember(commandId:string,request:unknown,result:unknown){this.db.prepare('INSERT INTO scheduled_receipts VALUES(?,?,?)').run(commandId,canonical(request),canonical(result));}
 get(id:string):ScheduledRecord{const row=this.db.prepare('SELECT record FROM scheduled_records WHERE id=?').get(id);ensure(row,'unknown scheduler');const value=JSON.parse(String(row.record)) as ScheduledRecord;assertScheduledProjection(this.db,value);return value;}
 list():ScheduledRecord[]{return this.db.prepare('SELECT record FROM scheduled_records ORDER BY id').all().map(r=>JSON.parse(String(r.record)) as ScheduledRecord);}
 claimGet(id:string):ScheduledClaim{const row=this.db.prepare('SELECT record FROM scheduled_claims WHERE id=?').get(id);ensure(row,'unknown claim');return JSON.parse(String(row.record)) as ScheduledClaim;}
 claims(id:string):ScheduledClaim[]{return this.db.prepare('SELECT record FROM scheduled_claims WHERE scheduler_id=? ORDER BY rowid').all(id).map(r=>JSON.parse(String(r.record)) as ScheduledClaim);}
 operation(id:string):ScheduledOperation{const row=this.db.prepare('SELECT record FROM scheduled_outbox WHERE id=?').get(id);ensure(row,'unknown operation');return JSON.parse(String(row.record)) as ScheduledOperation;}
 operations(id:string):ScheduledOperation[]{return this.db.prepare('SELECT o.record FROM scheduled_outbox o JOIN scheduled_claims c ON c.id=o.claim_id WHERE c.scheduler_id=? ORDER BY c.rowid').all(id).map(r=>JSON.parse(String(r.record)) as ScheduledOperation);}
 leases():ScheduledLease[]{return this.db.prepare('SELECT record,state FROM scheduled_leases ORDER BY rowid').all().map(r=>({...JSON.parse(String(r.record)),state:r.state}) as ScheduledLease);}
 integrationFenced(runtimeId:string):boolean {const row=this.db.prepare('SELECT record FROM scheduled_records WHERE runtime_id=?').get(runtimeId);return !!row&&(JSON.parse(String(row.record)) as ScheduledRecord).fence==='held';}
 private actualOperations(claims:ScheduledClaim[],operations:ScheduledOperation[]):ScheduledOperation[]{return operations.map(op=>{
  const claim=claims.find(c=>c.id===op.claimId)!;const row=this.db.prepare('SELECT record FROM executions WHERE id=?').get(claim.attemptId);if(!row)return op;
  const actual=JSON.parse(String(row.record)) as ExecutionRecord&{scheduledBinding?:ScheduledBinding};ensure(actual.scheduledBinding?.claimId===claim.id&&actual.attemptId===claim.attemptId&&actual.workspace===claim.workspace,'foreign actual execution');const runRow=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(claim.projectId,claim.runId);ensure(runRow,'actual scope missing');const attempt=(JSON.parse(String(runRow.snapshot)) as Run).attempts.find(a=>a.id===claim.attemptId);ensure(attempt,'actual attempt missing');if(attempt.settled)ensure(actual.usageStatus==='reported'&&actual.usage?.totalTokens===attempt.actual,'actual settled accounting inconsistent');
  return actual.state==='unknown'||actual.state==='interrupted'||actual.cancelRequested||actual.usage&&actual.usage.totalTokens>claim.reservation?{...op,state:'unknown'}:op;
 });}
 private allResourceLeases():ScheduledLease[]{const leases=this.leases();for(const row of this.db.prepare('SELECT record FROM executions').all()){const e=JSON.parse(String(row.record)) as ExecutionRecord;if(!e.stopConfirmed&&!leases.some(l=>l.state==='held'&&l.resource.kind==='path'&&l.resource.key===e.workspace))leases.push({id:'actual:'+e.id,claimId:'actual:'+e.id,resource:{kind:'path',key:e.workspace,mode:'write'},state:'held'});}return leases;}
 private unavailableDependencies(s:ScheduledRecord):string[]{const ledger=this.results().inspect(s.plan);return s.plan.tasks.filter(task=>task.inputRequirements.some(input=>{
  const head=ledger.heads.find(h=>h.taskId===input.dependencyNodeId),v=ledger.versions.find(v=>head&&domain.digest(v.ref)===domain.digest(head.ref)),upstream=s.plan.tasks.find(t=>t.node.id===input.dependencyNodeId),claim=this.claims(s.id).find(c=>c.taskId===input.dependencyNodeId&&c.generation===upstream?.generation);
  if(!head||!v||!upstream||!claim||v.manifest.planRevision!==claim.planRevision||v.manifest.generation!==upstream.generation||v.manifest.attemptId!==claim.attemptId||input.minimumState!=='submitted')return true;
  try{assertScheduledClaimOrigin(this.db,s,claim!);this.results().readPublished({projectId:s.plan.projectId,runId:s.plan.runId,ref:head.ref,minimumState:'submitted'});return false;}catch{return true;}
 })).map(task=>task.node.id);}
 private effectivePolicy(id: string): {tier: ExplorationTier; revision: number} {
  const s = this.get(id);
  const row = this.db.prepare('SELECT revision,tier,record FROM scheduled_exploration_policy WHERE scheduler_id=?').get(id);
  if (!row) return {tier: s.plan.tier, revision: 0};
  const record = JSON.parse(String(row.record)) as {schedulerId: string; planDigest: string; tier: ExplorationTier; revision: number};
  ensure(record.schedulerId === id && record.planDigest === s.planDigest && record.tier === row.tier && record.revision === row.revision, 'exploration policy binding changed');
  return {tier: record.tier, revision: record.revision};
 }
 private decision(id: string) {
  const s = this.get(id), claims = this.claims(id);
  return domain.evaluate({
   run: this.run(s.plan), plan: s.plan, effectiveTier: this.effectivePolicy(id).tier,
   ledger: this.results().inspect(s.plan), claims,
   operations: this.actualOperations(claims, this.operations(id)), leases: this.allResourceLeases(),
   nowMs: this.now(), blockedTaskIds: this.unavailableDependencies(s),
  });
 }
 exploration(id: string): ExplorationInspection {
  const s = this.get(id), policy = this.effectivePolicy(id), claims = this.claims(id), runtime = this.runtime(s.plan.runtimeId);
  let decision: ExplorationInspection['decision'] = null, reason: string | null = null;
  try { decision = this.decision(id); } catch (error) { reason = String(error); }
  let completion: ExplorationInspection['completion'] = null, completionError: string | null = null;
  if (s.state === 'drained' && s.fence === 'released' && !this.db.isTransaction) {
   try { completion = this.persistedCompletion(id); } catch (error) { completionError = String(error); }
  }
  if (runtime.paused) reason = 'Runtime is paused; exploration cannot dispatch';
  if (runtime.cancelled || s.state === 'cancelled') reason = 'Runtime is cancelled; no new exploration';
  if (s.fence === 'released') reason = 'Integration has started; use a follow-up for new work';
  const optional = s.plan.tasks.some(task => !task.node.required);
  const loop = !!this.db.prepare('SELECT 1 FROM scheduled_loop_programs WHERE scheduler_id=?').get(id);
  if (!optional) reason = 'No optional exploration candidates; required work is unchanged';
  if (loop) reason = 'Changing exploration tiers within loop programs is not supported';
  if (completionError) reason = completionError;
  const canChangeTier = optional && !loop && s.fence === 'held' && ['active', 'paused'].includes(s.state) &&
   !runtime.cancelled && !['cancelled', 'succeeded'].includes(this.run(s.plan).status);
  return {
   schedulerId: id, canChangeTier, tier: policy.tier, originalTier: s.plan.tier,
   policyRevision: policy.revision, expected: this.expected(id), decision, reason, completion,
   counts: {
    required: s.plan.tasks.filter(task => task.node.required).length,
    optional: s.plan.tasks.filter(task => !task.node.required).length,
    admitted: decision?.nodes.filter(node => node.admitted).length ?? 0,
    waiting: s.fence === 'released' ? 0 : decision?.nodes.filter(node => node.admitted && !node.dispatch &&
     s.plan.tasks.some(task => task.node.id === node.taskId) && !claims.some(claim => claim.taskId === node.taskId)).length ?? 0,
    active: claims.filter(claim => !['confirmed', 'cancelled', 'failed'].includes(this.operation(claim.operationId).state)).length,
   },
  };
 }
 dispatchExploration(input: ExplorationAction): ExplorationInspection {
  const action = parseExplorationAction(input);
  if (action.type === 'inspect') return this.exploration(action.schedulerId);
  return this.setExplorationTier({commandId: action.commandId, id: action.schedulerId, expected: action.expected, tier: action.tier});
 }
 setExplorationTier(input: {commandId: string; id: string; expected: ScheduledExpected; tier: ExplorationTier}): ExplorationInspection {
  parseExplorationAction({type: 'set-tier', commandId: input.commandId, schedulerId: input.id, expected: input.expected, tier: input.tier});
  return this.tx(() => {
   const request = {method: 'scheduled-exploration-tier', ...input};
   const prior = this.prior<ExplorationInspection>(input.commandId, request);
   if (prior) return prior;
   this.checkExpected(input.id, input.expected);
   const s = this.get(input.id), run = this.run(s.plan), runtime = this.runtime(s.plan.runtimeId), old = this.effectivePolicy(s.id);
   ensure(s.fence === 'held' && ['active', 'paused'].includes(s.state) && !runtime.cancelled &&
    !['cancelled', 'succeeded'].includes(run.status), 'exploration cannot reopen terminal or integrated work');
   ensure(s.plan.tasks.some(task => !task.node.required) &&
    !this.db.prepare('SELECT 1 FROM scheduled_loop_programs WHERE scheduler_id=?').get(s.id),
    'tier changes require optional candidates outside loop programs');
   ensure(run.contract.version === s.plan.contractVersion && domain.digest(run.contract) === s.plan.contractDigest, 'exploration contract changed');
   const record = {schemaVersion: 1, schedulerId: s.id, planDigest: s.planDigest,
    revision: old.revision + 1, tier: input.tier, previousTier: old.tier};
   this.db.prepare('INSERT INTO scheduled_exploration_policy VALUES(?,?,?,?) ON CONFLICT(scheduler_id) DO UPDATE SET revision=excluded.revision,tier=excluded.tier,record=excluded.record')
    .run(s.id, record.revision, record.tier, canonical(record));
   this.save(s, 'exploration-tier-changed', record);
   const result = this.exploration(s.id);
   this.remember(input.commandId, request, result);
   return result;
  });
 }
 private run(s:ScheduledPlan):Run{const row=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(s.projectId,s.runId);ensure(row,'missing Run');return JSON.parse(String(row.snapshot)) as Run;}
 private runtime(id:string):RuntimeRecord{const row=this.db.prepare('SELECT record FROM runtime_runs WHERE id=?').get(id);ensure(row,'missing original runtime');return JSON.parse(String(row.record)) as RuntimeRecord;}
 private results(){return new TaskResultRepository(this.db,this.dataRoot);}
 expected(id:string):ScheduledExpected{const s=this.get(id),run=this.run(s.plan),ledger=this.results().inspect(s.plan);return {schedulerRevision:s.revision,runRevision:run.revision,resultRevision:ledger.revision,leaseRevision:Number(this.db.prepare('SELECT lease_revision FROM scheduled_meta WHERE id=1').get()!.lease_revision)};}
 private checkExpected(id:string,expected:ScheduledExpected){ensure(canonical(this.expected(id))===canonical(expected),'stale scheduler/run/result/lease CAS');}
 private persistRun(previous:Run,next:Run,events:DomainEvent[],commandId:string){const changed=this.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=? AND revision=?').run(canonical(next),next.revision,next.projectId,next.id,previous.revision);ensure(changed.changes===1,'Run CAS failed');for(const event of events)this.db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES(?,?,?,?,?)').run(commandId,next.projectId,next.id,event.type,canonical(event));}
 private save(s:ScheduledRecord,kind:string,value:unknown){s.revision++;this.db.prepare('UPDATE scheduled_records SET record=? WHERE id=?').run(canonical(s),s.id);this.db.prepare('INSERT INTO scheduled_events(scheduler_id,kind,record) VALUES(?,?,?)').run(s.id,kind,canonical(value));}
 install(input:{commandId:string;plan:ScheduledPlan;expectedRunRevision:number;expectedResultRevision:number}):ScheduledRecord{safeResultJSON(input);return this.tx(()=>{
  const request={method:'scheduled-install',...input},prior=this.prior<ScheduledRecord>(input.commandId,request);if(prior)return prior;
  const run=this.run(input.plan),runtime=this.runtime(input.plan.runtimeId);ensure(runtime.projectId===run.projectId&&runtime.runId===run.id&&!runtime.paused&&!runtime.cancelled&&runtime.cursor===0,'original runtime not unstarted active');ensure(runtime.definition.steps.length===1&&runtime.definition.steps[0]!.id===input.plan.integrationNodeId,'unique integration step required');
  const original=this.db.prepare('SELECT record FROM runtime_outbox WHERE runtime_id=?').all(runtime.id).map(row=>JSON.parse(String(row.record)));ensure(original.length===1&&original[0].state==='queued'&&original[0].step.id===input.plan.integrationNodeId,'original integration outbox already started or ambiguous');
  ensure(run.revision===input.expectedRunRevision&&this.results().inspect(input.plan).revision===input.expectedResultRevision,'install CAS stale');
  for(const task of input.plan.tasks){ensure(realpathSync(task.workspace)===task.workspace&&lstatSync(task.workspace).isDirectory(),'workspace must be real host canonical directory');for(const r of task.node.resources)if(r.kind==='path')ensure(realpathSync(r.key)===r.key,'lease path must be existing host canonical path');}
  const next=domain.install(run,input.plan),record:ScheduledRecord={id:input.plan.id,plan:structuredClone(input.plan),planDigest:domain.digest(input.plan),revision:0,state:'active',fence:'held'};
  this.persistRun(run,next.run,next.events,input.commandId);this.db.prepare('INSERT INTO scheduled_plans VALUES(?,?,?)').run(record.id,record.planDigest,canonical(record.plan));this.db.prepare('INSERT INTO scheduled_records VALUES(?,?,?,?,?)').run(record.id,runtime.id,run.projectId,run.id,canonical(record));this.db.prepare('INSERT INTO scheduled_events(scheduler_id,kind,record) VALUES(?,?,?)').run(record.id,'installed',canonical({planDigest:record.planDigest,inputSource:'Current admitted Run contract; unstarted host execution decomposition',anchor:input.plan.integrationNodeId}));this.remember(input.commandId,request,record);return record;
 });}
 claim(input:{commandId:string;id:string;expected:ScheduledExpected;owner:string}):ScheduledClaimResult{safeResultJSON(input);return this.tx(()=>{
  const request={method:'scheduled-claim',...input},prior=this.prior<ScheduledClaimResult>(input.commandId,request);if(prior)return prior;this.checkExpected(input.id,input.expected);const s=this.get(input.id),runtime=this.runtime(s.plan.runtimeId);ensure(s.state==='active'&&s.fence==='held'&&!runtime.paused&&!runtime.cancelled,'scheduler or original runtime stopped');ensure(input.owner.trim()&&input.owner.length<=200,'invalid host worker owner');ensure(!new ConversationRepository(this.db).hasPendingForRun(s.plan.projectId,s.plan.runId),'pending conversation change blocks new scheduled claims');
  const run=this.run(s.plan),ledger=this.results().inspect(s.plan),claims=this.claims(s.id),operations=this.actualOperations(claims,this.operations(s.id)),leases=this.allResourceLeases(),base={run,plan:s.plan,effectiveTier:this.effectivePolicy(s.id).tier,ledger,claims,operations,leases,nowMs:this.now(),blockedTaskIds:[...this.unavailableDependencies(s),...s.plan.tasks.filter(t=>stoppedLoopTask(this.db,s.id,t.node.id)).map(t=>t.node.id)]},decision=domain.evaluate(base),taskId=decision.dispatchTaskIds[0];
  if(!taskId){const waiting:ScheduledClaimResult={kind:'waiting',decision};this.remember(input.commandId,request,waiting);return waiting;}
  const claimId='claim-'+sha256(canonical({scheduler:s.id,plan:s.planDigest,taskId,generation:s.plan.tasks.find(t=>t.node.id===taskId)!.generation})),attemptId='exec-'+sha256(claimId),next=domain.start({...base,taskId,attemptId,claimId,operationId:attemptId,owner:input.owner});
  this.persistRun(run,next.run,next.events,input.commandId);this.db.prepare('INSERT INTO scheduled_claims VALUES(?,?,?,?,?,?)').run(claimId,s.id,attemptId,taskId,next.claim.generation,canonical(next.claim));this.db.prepare('INSERT INTO scheduled_outbox VALUES(?,?,?)').run(next.operation.id,claimId,canonical(next.operation));
  for(const [i,resource] of next.claim.resources.entries()){const lease:ScheduledLease={id:claimId+':'+i,claimId,resource,state:'held'};this.db.prepare('INSERT INTO scheduled_leases VALUES(?,?,?,?)').run(lease.id,claimId,lease.state,canonical(lease));}
  this.db.prepare('UPDATE scheduled_meta SET lease_revision=lease_revision+1 WHERE id=1').run();
  this.results().bindScheduledConsumer({commandId:input.commandId+':inputs',projectId:run.projectId,runId:run.id,claimId,expectedRevision:ledger.revision});this.save(s,'claimed',{claimId,attemptId,taskId,inputBindings:next.claim.inputBindings});const result:ScheduledClaimResult={kind:'claimed',claim:next.claim,operation:next.operation,decision};this.remember(input.commandId,request,result);return result;
 });}
 /** Read-only host completion eligibility, never an optional pass verdict.
  * Unattempted optional admission is a spending permission, not a completion
  * obligation. Only permanently unaffordable quiet branches may be omitted. */
 completionEligibility(id:string):{ready:boolean;reasons:string[];remaining:number|null;unperformedOptional:{taskId:string;reason:string;blockedBy:string[]}[]}{return this.tx(()=>{
  const s=this.get(id),run=this.run(s.plan),runtime=this.runtime(s.plan.runtimeId),claims=this.claims(id),operations=this.operations(id),reasons:string[]=[];
  const result={ready:false,reasons,remaining:null as number|null,unperformedOptional:[] as {taskId:string;reason:string;blockedBy:string[]}[]};
  if(s.state!=='active'||s.fence!=='held'||runtime.paused||runtime.cancelled||!['ready','running'].includes(run.status))reasons.push('completion boundary closed');
  if(!loopProgramComplete(this.db,id))reasons.push('loop program has not yielded');
  if(new ConversationRepository(this.db).hasPendingForRun(run.projectId,run.id))reasons.push('pending follow-up');
  if(run.attempts.some(a=>!a.settled||a.status==='running')||run.operations.some(o=>o.status!=='confirmed')||run.leases.some(l=>!l.released)||this.leases().some(l=>claims.some(c=>c.id===l.claimId)&&l.state!=='released'))reasons.push('unresolved cost effects or resources');
  if(run.budget.spent>run.budget.limit)reasons.push('total budget exceeded');
  if(reasons.length)return result;
  const actual=this.actualOperations(claims,operations),ledger=this.results().inspect(s.plan);
  const snapshot=domain.snapshot(run,s.plan,ledger,claims,actual,this.allResourceLeases(),this.now());
  result.remaining=snapshot.budget.limit-snapshot.budget.spent-Math.max(snapshot.budget.verificationRemaining,snapshot.budget.futureVerificationFloor)-(snapshot.budget.futureExecutionFloor??0);
  if(result.remaining<0){reasons.push('protected final budget exhausted');return result;}
  for(const task of s.plan.tasks){
   const c=claims.find(c=>c.taskId===task.node.id&&c.generation===task.generation);if(!task.node.required&&!c)continue;
   if(!c||actual.find(o=>o.claimId===c.id)?.state!=='confirmed'||run.nodes.find(n=>n.id===task.node.id)?.status!=='succeeded'){reasons.push('required or attempted branch not confirmed successful: '+task.node.id);continue;}
   assertScheduledClaimOrigin(this.db,s,c);
   const row=this.db.prepare('SELECT record FROM executions WHERE id=?').get(c.attemptId),execution=row?JSON.parse(String(row.record)) as ExecutionRecord:null,attempt=run.attempts.find(a=>a.id===c.attemptId);
   if(!execution||!execution.stopConfirmed||execution.state!=='completed'||execution.error||execution.cancelRequested||execution.usageStatus!=='reported'||!execution.usage||!attempt?.settled||attempt.actual!==execution.usage.totalTokens){reasons.push('actual successful stop/accounting missing: '+task.node.id);continue;}
   const head=ledger.heads.find(h=>h.taskId===task.node.id),v=ledger.versions.find(v=>head&&domain.digest(v.ref)===domain.digest(head.ref));
   if(!head||!v||v.manifest.attemptId!==c.attemptId||v.manifest.generation!==c.generation||v.manifest.planRevision!==c.planRevision||domain.digest(v.manifest.inputs)!==domain.digest(c.inputBindings)){reasons.push('exact current branch publication missing: '+task.node.id);continue;}
   try{this.results().readPublished({projectId:s.plan.projectId,runId:s.plan.runId,ref:head.ref,minimumState:'submitted'});}catch(error){if(error&&typeof error==='object'&&'code' in error&&String(error.code).startsWith('ERR_SQLITE'))throw error;reasons.push('current branch package rejected: '+task.node.id+': '+String(error));}
  }
  if(reasons.length)return result;
  const decision=this.decision(id),omitted=new Map<string,{taskId:string;reason:string;blockedBy:string[]}>();
  const unattempted=(task:ScheduledPlan['tasks'][number])=>!task.node.required&&!claims.some(c=>c.taskId===task.node.id&&c.generation===task.generation)&&run.nodes.find(n=>n.id===task.node.id)?.status==='pending'&&!stoppedLoopTask(this.db,id,task.node.id);
  for(const task of s.plan.tasks){const node=decision.nodes.find(n=>n.taskId===task.node.id)!;
   if(unattempted(task)&&node.admitted&&node.ready&&task.node.reservation>result.remaining)omitted.set(task.node.id,{taskId:task.node.id,reason:'never attempted: shared budget cannot fit reservation after protected final floors',blockedBy:[]});
  }
  // Only the unattempted optional dependency closure of actual budget exclusions
  // is omitted. Required or attempted work, independent resource blockage and
  // unrelated missing inputs cannot be concealed by this closure.
  for(let changed=true;changed;){changed=false;for(const task of s.plan.tasks){
   const node=decision.nodes.find(n=>n.taskId===task.node.id)!;if(!unattempted(task)||!node.admitted||omitted.has(task.node.id))continue;
   const blockedBy=task.node.dependencies.filter(id=>omitted.has(id));if(!blockedBy.length)continue;
   if(!task.node.dependencies.every(id=>omitted.has(id)||run.nodes.find(n=>n.id===id)?.status==='succeeded'))continue;
   if(snapshot.nodes.find(n=>n.id===task.node.id)?.status!=='pending')continue;
   omitted.set(task.node.id,{taskId:task.node.id,reason:'never attempted: optional prerequisite cannot fit protected shared budget',blockedBy});changed=true;
  }}
  for(const node of decision.nodes)if(node.admitted&&run.nodes.find(n=>n.id===node.taskId)?.status!=='succeeded'&&!omitted.has(node.taskId))reasons.push('admitted optional work remains: '+node.taskId);
  result.unperformedOptional=[...omitted.values()];result.ready=reasons.length===0;return result;
 });}
 /** Projection of committed release evidence only; no live budget inference. */
 persistedCompletion(id:string):{planDigest:string;protectedRemaining:number;unperformedOptional:{taskId:string;reason:string;blockedBy:string[]}[]}|null{
  ensure(!this.db.isTransaction,'committed completion cannot be read inside a transaction');
  const s=this.get(id);if(s.state!=='drained'||s.fence!=='released')return null;
  const row=this.db.prepare("SELECT record FROM scheduled_events WHERE scheduler_id=? AND kind='integration-fence-released' ORDER BY rowid DESC LIMIT 1").get(id);if(!row)return null;
  const evidence=JSON.parse(String(row.record));if(!Object.hasOwn(evidence,'unperformedOptional'))return null;
  ensure(evidence.planDigest===s.planDigest&&Number.isSafeInteger(evidence.protectedRemaining)&&evidence.protectedRemaining>=0&&Array.isArray(evidence.unperformedOptional),'invalid committed completion evidence');
  const seen=new Set<string>(),claims=this.claims(id);
  for(const item of evidence.unperformedOptional){
   const task=s.plan.tasks.find(t=>t.node.id===item.taskId);
   ensure(task&&!task.node.required&&!claims.some(c=>c.taskId===item.taskId&&c.generation===task.generation)&&!seen.has(item.taskId)&&typeof item.reason==='string'&&item.reason.startsWith('never attempted:')&&Array.isArray(item.blockedBy)&&item.blockedBy.every((id:unknown)=>typeof id==='string'),'invalid committed optional omission');seen.add(item.taskId);
  }
  ensure(evidence.unperformedOptional.every((item:{blockedBy:string[]})=>item.blockedBy.every(id=>seen.has(id))),'invalid committed optional closure');
  return {planDigest:s.planDigest,protectedRemaining:evidence.protectedRemaining,unperformedOptional:evidence.unperformedOptional};
 }
 /** Release only for exact submitted branch packages and known actual receipts.
  * This opens serial integration; it never marks the Run delivered. */
 releaseIntegration(input:{commandId:string;id:string;expected:ScheduledExpected}):ScheduledRecord{safeResultJSON(input);return this.tx(()=>{
  const request={method:'scheduled-drain',...input},prior=this.prior<ScheduledRecord>(input.commandId,request);if(prior)return prior;this.checkExpected(input.id,input.expected);const s=this.get(input.id),run=this.run(s.plan),claims=this.claims(s.id),operations=this.operations(s.id);
  ensure(s.state==='active'&&s.fence==='held'&&['ready','running'].includes(run.status),loopProgramComplete(this.db,s.id)?'drain boundary closed':'loop program has not yielded; final integration remains fenced');ensure(loopProgramComplete(this.db,s.id),'loop program has not yielded; final integration remains fenced');
  ensure(run.attempts.every(a=>a.settled&&a.status!=='running')&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released)&&this.leases().filter(l=>claims.some(c=>c.id===l.claimId)).every(l=>l.state==='released'),'unresolved cost or effects prevent integration');
  const completion=this.completionEligibility(s.id);ensure(completion.ready,completion.reasons.join('; '));
  for(const task of s.plan.tasks){const c=claims.find(c=>c.taskId===task.node.id&&c.generation===task.generation);if(!task.node.required&&!c)continue;ensure(c&&operations.find(o=>o.claimId===c.id)?.state==='confirmed'&&run.nodes.find(n=>n.id===task.node.id)?.status==='succeeded','required or attempted branch not confirmed successful');const ledger=this.results().inspect(s.plan),head=ledger.heads.find(h=>h.taskId===task.node.id),v=ledger.versions.find(v=>head&&domain.digest(v.ref)===domain.digest(head.ref));ensure(head&&v&&v.manifest.attemptId===c.attemptId&&v.manifest.generation===c.generation&&v.manifest.planRevision===c.planRevision&&domain.digest(v.manifest.inputs)===domain.digest(c.inputBindings),'exact current branch publication missing');this.results().readPublished({projectId:s.plan.projectId,runId:s.plan.runId,ref:head.ref,minimumState:'submitted'});}
  s.state='drained';s.fence='released';this.save(s,'integration-fence-released',{planDigest:s.planDigest,claimIds:claims.map(c=>c.id),unperformedOptional:completion.unperformedOptional,protectedRemaining:completion.remaining,reason:'Exact submitted packages, actual settled branch receipts; final P4 still required'});this.remember(input.commandId,request,s);return s;
 });}
 /** Host-only blocked propagation. Callers supply CAS/command identity, never
  * a verdict or receipt. OS observations happen outside the shared transaction;
  * exact records are rechecked before any parent projection is changed. */
 async reconcileTerminal(input:{commandId:string;id:string;expected:ScheduledExpected}):Promise<{kind:'waiting'|'blocked'|'drained';reason:string|null;known:boolean}>{
  safeResultJSON(input);ensure(!this.db.isTransaction,'physical terminal inspection must precede transaction');
  const initial=this.get(input.id),observedRuntime=this.runtime(initial.plan.runtimeId),observedClaims=this.claims(input.id);
  const observed=await Promise.all(observedClaims.map(async claim=>{const row=this.db.prepare('SELECT record FROM executions WHERE id=?').get(claim.attemptId);if(!row)return {claim,record:null,stopped:false};const record=String(row.record),e=JSON.parse(record) as ExecutionRecord;return {claim,record,stopped:e.identity?(await inspectProcess(e.identity as ProcessIdentity)).status==='stopped':!e.turnIntent&&!e.turnId};}));
  return this.tx(()=>{
   const request={method:'scheduled-terminal',...input},prior=this.prior<{kind:'waiting'|'blocked'|'drained';reason:string|null;known:boolean}>(input.commandId,request);if(prior)return prior;
   this.checkExpected(input.id,input.expected);const s=this.get(input.id),runtime=this.runtime(s.plan.runtimeId),run=this.run(s.plan);
   ensure(canonical(runtime)===canonical(observedRuntime)&&canonical(observedClaims)===canonical(this.claims(input.id)),'terminal runtime/claims changed after physical inspection');
   ensure(s.plan.contractVersion===run.contract.version&&s.plan.contractDigest===domain.digest(run.contract),'terminal contract stale');
   const waiting={kind:'waiting' as const,reason:null,known:false};
   if(s.state!=='active'||s.fence!=='held'||runtime.paused||runtime.cancelled||['paused','cancelled','succeeded'].includes(run.status))return waiting;
   const operations=this.operations(s.id),allQuiet=run.attempts.every(a=>a.settled&&a.status!=='running')&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released)&&this.leases().filter(l=>observedClaims.some(c=>c.id===l.claimId)).every(l=>l.state==='released');
   let actualQuiet=true;const failures:string[]=[];
   for(const item of observed){
    assertScheduledClaimOrigin(this.db,s,item.claim);
    const current=this.db.prepare('SELECT record FROM executions WHERE id=?').get(item.claim.attemptId);ensure((current?String(current.record):null)===item.record,'terminal execution changed after physical inspection');
    const op=operations.find(o=>o.id===item.claim.operationId),attempt=run.attempts.find(a=>a.id===item.claim.attemptId);ensure(op&&attempt,'terminal actual binding missing');
    if(item.record===null){actualQuiet=false;continue;}
    const e=JSON.parse(item.record) as ExecutionRecord&{scheduledBinding?:ScheduledBinding};
    ensure(e.id===item.claim.attemptId&&e.attemptId===item.claim.attemptId&&e.workspace===item.claim.workspace&&e.projectId===s.plan.projectId&&e.runId===s.plan.runId&&domain.digest(e.scheduledBinding)===domain.digest({schedulerId:s.id,claimId:item.claim.id,operationId:op.id,owner:item.claim.owner,projectId:s.plan.projectId,runId:s.plan.runId,attemptId:item.claim.attemptId,planRevision:item.claim.planRevision,generation:item.claim.generation}),'terminal actual execution scope differs');
    const known=op.executionId===e.id&&item.stopped&&e.stopConfirmed&&['completed','failed','cancelled'].includes(e.state)&&e.usageStatus==='reported'&&e.usage!==null&&attempt.settled&&attempt.actual===e.usage.totalTokens&&attempt.status===(e.state==='completed'?'succeeded':e.state==='cancelled'?'cancelled':'failed')&&['confirmed','failed','cancelled'].includes(op.state);
    if(!known)actualQuiet=false;
    const task=s.plan.tasks.find(t=>t.node.id===item.claim.taskId&&t.generation===item.claim.generation)!;
    // Attempted optional branches remain required for safe integration under the
    // existing release gate. Unattempted optional nodes never become failures.
    if(known&&['failed','cancelled'].includes(op.state)&&run.nodes.find(n=>n.id===task.node.id)?.status==='failed')failures.push(task.node.id+': '+(e.error??op.error??e.state));
   }
   const expired=this.now()>=s.plan.limits.deadlineMs;
   let pendingFrontier=false;
   if(!expired){
    if(new ConversationRepository(this.db).hasPendingForRun(run.projectId,run.id))return waiting;
    const decision=domain.evaluate({run,plan:s.plan,effectiveTier:this.effectivePolicy(s.id).tier,ledger:this.results().inspect(s.plan),claims:observedClaims,operations:this.actualOperations(observedClaims,operations),leases:this.allResourceLeases(),nowMs:this.now(),blockedTaskIds:[...this.unavailableDependencies(s),...s.plan.tasks.filter(t=>stoppedLoopTask(this.db,s.id,t.node.id)).map(t=>t.node.id)]});
    if(decision.dispatchTaskIds.length)return waiting;
    // A temporarily leased/capacity-constrained independent task may still run
    // later. Only failed dependency ancestry makes its pending frontier terminal.
    const possible=(id:string,seen=new Set<string>()):boolean=>{if(seen.has(id))return false;const node=run.nodes.find(n=>n.id===id);if(!node||['failed','blocked'].includes(node.status))return false;if(node.status==='succeeded')return true;seen.add(id);return node.dependencies.every(d=>possible(d,new Set(seen)));};
    const completion=this.completionEligibility(s.id),budgetOmitted=new Set(completion.ready?completion.unperformedOptional.map(t=>t.taskId):[]);
    pendingFrontier=decision.nodes.some(n=>!budgetOmitted.has(n.taskId)&&n.admitted&&run.nodes.find(r=>r.id===n.taskId)?.status==='pending'&&possible(n.taskId)&&!stoppedLoopTask(this.db,s.id,n.taskId));
   }
   // Normal loop advancement runs before this method. A live root with no failed
   // occurrence may still append its next genuine iteration and must wait.
   const loopRow=hasLoopTables(this.db)?this.db.prepare('SELECT record FROM scheduled_loop_states WHERE scheduler_id=?').get(s.id):undefined;
   const loop=loopRow?JSON.parse(String(loopRow.record)):null,root=loop?.frames.find((f:{key:string})=>f.key===loop.rootKey),loopStopped=root&&['blocked','stopped'].includes(root.state);
   const known=allQuiet&&actualQuiet;
   if(!expired&&((pendingFrontier&&!loopStopped)||(root&&!loopStopped&&!loopProgramComplete(this.db,s.id))))return waiting;
   // The graph deadline prevents new branch starts, not use of an already
   // completed and genuinely published graph. Reuse the original entire gate,
   // including current packages/loop/tier eligibility. Its nested tx provides a
   // SAVEPOINT: a failed qualification cannot leave a partial drain behind.
   if(known&&!failures.length&&loopProgramComplete(this.db,s.id)){
    try{
     this.releaseIntegration({commandId:'scheduled-terminal-drain:'+sha256(canonical(request)),id:s.id,expected:input.expected});
     const result={kind:'drained' as const,reason:null,known:true};this.remember(input.commandId,request,result);return result;
    }catch(error){
     // SQL/transaction failures are not qualification outcomes. Abort the parent
     // transaction rather than translating an injected/failed write into blocked.
     if(error&&typeof error==='object'&&'code' in error&&String(error.code).startsWith('ERR_SQLITE'))throw error;
    }
   }
   if(!expired&&(!known||(!failures.length&&!loopStopped)))return waiting;
   const reason=expired?'Scheduled graph absolute deadline reached'+(known?'; actual work stopped and accounting settled':'; stop or accounting remains unresolved'):(failures.length?'Scheduled branch cannot satisfy integration: '+failures.join('; '):'Scheduled loop cannot continue: '+String(root.reason??root.state));
   const next=structuredClone(run);next.status='blocked';next.revision++;
   this.persistRun(run,next,[{type:'ScheduledBlocked',runId:next.id,revision:next.revision,details:{schedulerId:s.id,reason,known,expired,failedTaskIds:failures.map(f=>f.split(':')[0])}}],input.commandId);
   runtime.phase='blocked';runtime.error=reason;runtime.projectionVersion++;runtime.updatedAt=new Date(this.now()).toISOString();
   const changed=this.db.prepare('UPDATE runtime_runs SET record=? WHERE id=? AND record=?').run(canonical(runtime),runtime.id,canonical(observedRuntime));ensure(changed.changes===1,'terminal runtime CAS failed');
   this.db.prepare('INSERT INTO runtime_events(runtime_id,kind,payload,created_at) VALUES(?,?,?,?)').run(runtime.id,'scheduled-blocked',canonical({schedulerId:s.id,reason,known,expired}),runtime.updatedAt);
   s.state='blocked';this.save(s,'terminal-blocked',{reason,known,expired,failedTaskIds:failures.map(f=>f.split(':')[0]),executionIds:observedClaims.map(c=>c.attemptId)});
   const result={kind:'blocked' as const,reason,known};this.remember(input.commandId,request,result);return result;
  });
 }
 executionInput(claimId:string):ExecutionStart&{workspaceKind:'project'|'managed'}{const c=this.claimGet(claimId),s=this.get(c.schedulerId),run=this.run(s.plan),task=s.plan.tasks.find(t=>t.node.id===c.taskId&&t.generation===c.generation);assertScheduledClaimOrigin(this.db,s,c);ensure(task,'stale task input');return {type:'start',commandId:c.id,workspace:c.workspace,workspaceKind:c.workspaceKind,prompt:scheduledExecutionPrompt(task.step.prompt,c),model:task.step.model,effort:task.step.effort,images:task.step.images??[],timeoutMs:task.step.timeoutMs,tokenLimit:run.budget.limit,reservation:c.reservation,verificationReserve:run.budget.verificationReserve};}
 binding(claimId:string,owner:string):ScheduledBinding{const c=this.claimGet(claimId);this.eligible(c.operationId,owner);return {schedulerId:c.schedulerId,claimId:c.id,operationId:c.operationId,owner,projectId:c.projectId,runId:c.runId,attemptId:c.attemptId,planRevision:c.planRevision,generation:c.generation};}
 private inputSources(claim:ScheduledClaim):ScheduledInputSource[]{const scope={projectId:claim.projectId,runId:claim.runId},ledger=this.results().inspect(scope);return claim.inputBindings.map(binding=>{ensure(binding.minimumState==='submitted','scoped verified inputs unsupported');const pack=this.results().readPublished({...scope,ref:binding.result,minimumState:'submitted'}),version=ledger.versions.find(v=>domain.digest(v.ref)===domain.digest(binding.result));ensure(version,'input manifest missing');return {manifest:version.manifest,package:pack};});}
 prepareInputs(claimId:string,owner:string):ScheduledInputReceipt|null {const claim=this.claimGet(claimId);this.qualifyDispatch(claim.operationId,owner,false);const host=new HostScheduledInputs(),read=()=>this.inputSources(claim),row=this.db.prepare('SELECT record FROM executions WHERE id=?').get(claim.attemptId);if(row){const execution=JSON.parse(String(row.record)) as ExecutionRecord;if(execution.identity||execution.turnIntent)return host.verify(claim,read);}const receipt=host.prepare(claim,read);this.qualifyDispatch(claim.operationId,owner,true);return receipt;}
 eligible(operationId:string,owner:string):void {this.qualifyDispatch(operationId,owner,true);}
 private qualifyDispatch(operationId:string,owner:string,checkInputs:boolean):void{const op=this.operation(operationId),c=this.claimGet(op.claimId),s=this.get(c.schedulerId),run=this.run(s.plan),runtime=this.runtime(s.plan.runtimeId);const now=this.now();ensure(Number.isSafeInteger(now)&&now>=0&&now<s.plan.limits.deadlineMs,'scheduler deadline reached before dispatch');ensure(s.state==='active'&&s.fence==='held'&&!runtime.paused&&!runtime.cancelled&&['ready','running'].includes(run.status),'dispatch closed');ensure(!stoppedLoopTask(this.db,s.id,c.taskId),'loop occurrence stopped');assertScheduledClaimOrigin(this.db,s,c);ensure(c.owner===owner&&['claimed','started'].includes(op.state),'stale or terminal worker qualification');ensure(domain.digest(s.plan)===s.planDigest&&c.contractVersion===run.contract.version&&c.contractDigest===domain.digest(run.contract)&&s.plan.tasks.some(t=>t.node.id===c.taskId&&t.generation===c.generation),'stale generation/contract/plan');ensure(run.attempts.some(a=>a.id===c.attemptId&&a.status==='running'&&!a.settled&&a.reservation===c.reservation)&&run.operations.some(o=>o.id===op.id&&o.attemptId===c.attemptId&&o.status==='pending'),'attempt/effect no longer current');const held=this.leases().filter(l=>l.claimId===c.id&&l.state==='held');ensure(held.length===c.resources.length&&domain.digest(held.map(l=>l.resource))===domain.digest(c.resources),'resource qualification lost');const ledger=this.results().inspect(s.plan),consumer=ledger.consumers.find(x=>x.attemptId===c.attemptId);ensure(consumer&&!consumer.invalidated&&domain.digest(consumer.inputs)===domain.digest(c.inputBindings),'consumer input invalidated');for(const binding of c.inputBindings){ensure(binding.minimumState==='submitted','scoped verification unsupported');this.results().readPublished({projectId:c.projectId,runId:c.runId,ref:binding.result,minimumState:'submitted'});}if(checkInputs)new HostScheduledInputs().verify(c,()=>this.inputSources(c));
 }
 markStarted(binding:ScheduledBinding):ScheduledOperation{safeResultJSON(binding);return this.tx(()=>{ensure(domain.digest(this.binding(binding.claimId,binding.owner))===domain.digest(binding),'foreign binding');const op=this.operation(binding.operationId);if(op.state==='started')return op;op.state='started';this.db.prepare('UPDATE scheduled_outbox SET record=? WHERE id=?').run(canonical(op),op.id);this.save(this.get(binding.schedulerId),'effect-intent',{operationId:op.id,claimId:binding.claimId});return op;});}
 /** Actual ExecutionManager owns completion/usage/stop. This method cannot create
  * those facts or release unknown effects on a caller's claimed outcome. */
 async reconcileExecution(input:{commandId:string;claimId:string;executionId:string}):Promise<ScheduledOperation>{
  safeResultJSON(input);ensure(!this.db.isTransaction,'actual physical inspection must precede transaction');
  const observedRow=this.db.prepare('SELECT record FROM executions WHERE id=?').get(input.executionId);ensure(observedRow,'missing actual execution');const observed=JSON.parse(String(observedRow.record)) as ExecutionRecord;const stopped=observed.identity?(await inspectProcess(observed.identity as ProcessIdentity)).status==='stopped':observed.turnIntent!==true&&observed.turnId===null;
  return this.tx(()=>{const request={method:'scheduled-reconcile',...input},prior=this.prior<ScheduledOperation>(input.commandId,request);if(prior)return prior;const c=this.claimGet(input.claimId),s=this.get(c.schedulerId),run=this.run(s.plan),op=this.operation(c.operationId),row=this.db.prepare('SELECT record FROM executions WHERE id=?').get(input.executionId);ensure(row,'missing actual P2 receipt');ensure(row.record===observedRow.record,'actual execution changed after stop inspection');const e=JSON.parse(String(row.record)) as ExecutionRecord&{scheduledBinding?:ScheduledBinding};ensure(e.id===input.executionId&&e.id===c.attemptId&&e.attemptId===c.attemptId&&e.workspace===c.workspace&&e.projectId===c.projectId&&e.runId===c.runId&&e.scheduledBinding&&domain.digest(e.scheduledBinding)===domain.digest({schedulerId:c.schedulerId,claimId:c.id,operationId:c.operationId,owner:c.owner,projectId:c.projectId,runId:c.runId,attemptId:c.attemptId,planRevision:c.planRevision,generation:c.generation}),'P2 actual binding differs');const a=run.attempts.find(a=>a.id===c.attemptId);ensure(a,'missing attempt');const known=stopped&&e.stopConfirmed&&['completed','failed','cancelled'].includes(e.state)&&e.usageStatus==='reported'&&e.usage&&a.settled&&a.actual===e.usage.totalTokens&&a.status===(e.state==='completed'?'succeeded':e.state==='cancelled'?'cancelled':'failed')&&Number.isSafeInteger(a.actual)&&a.actual!>=0&&run.leases.filter(l=>l.attemptId===a.id).every(l=>l.released)&&run.operations.filter(o=>o.attemptId===a.id).length>0&&run.operations.filter(o=>o.attemptId===a.id).every(o=>o.status==='confirmed');op.executionId=e.id;op.state=known?(e.state==='completed'&&!e.error&&!e.cancelRequested?'confirmed':e.state==='cancelled'?'cancelled':'failed'):'unknown';op.result={executionId:e.id};op.error=e.error;this.db.prepare('UPDATE scheduled_outbox SET record=? WHERE id=?').run(canonical(op),op.id);if(known){this.db.prepare("UPDATE scheduled_leases SET state='released' WHERE claim_id=? AND state='held'").run(c.id);this.db.prepare('UPDATE scheduled_meta SET lease_revision=lease_revision+1 WHERE id=1').run();}this.save(s,'execution-reconciled',{operation:op,known});this.remember(input.commandId,request,op);return op;});}
}
