import type {DatabaseSync} from 'node:sqlite';
import type {ScheduledPlan,ScheduledRecord,ScheduledClaim,ScheduledTask} from '../contracts/p7-dispatch.js';
import type {LoopTaskOrigin} from '../contracts/p7-loop.js';
import {canonical,digest} from '../verification/candidate.js';
const hash=(x:unknown)=>digest(canonical(x));
function ensure(x:unknown,s:string):asserts x {if(!x)throw Error('Scheduled history: '+s);}
export function hasLoopTables(db:DatabaseSync):boolean{return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_plan_revisions'").get();}
/** Exact revision lookup. Legacy revision one remains immutable and untouched. */
export function scheduledPlanAt(db:DatabaseSync,id:string,revision:number):ScheduledPlan {
 const row=revision===1?db.prepare('SELECT digest,record FROM scheduled_plans WHERE id=?').get(id):hasLoopTables(db)?db.prepare('SELECT digest,record,parent_revision FROM scheduled_plan_revisions WHERE scheduler_id=? AND revision=?').get(id,revision):undefined;
 ensure(row,'unknown plan revision');const plan=JSON.parse(String(row.record)) as ScheduledPlan;
 ensure(plan.id===id&&plan.revision===revision&&hash(plan)===row.digest&&canonical(plan)===row.record,'immutable plan revision differs');
 if(revision>1)ensure(Number(row.parent_revision)===revision-1,'plan revision chain broken');return plan;
}
export function assertScheduledProjection(db:DatabaseSync,s:ScheduledRecord):void{ensure(canonical(scheduledPlanAt(db,s.id,s.plan.revision))===canonical(s.plan)&&hash(s.plan)===s.planDigest,'immutable plan projection differs');}
/** Current membership alone is insufficient: original exact task and claim plan
 * must also remain immutable. No lookup of latest matching task is permitted. */
export function assertScheduledClaimOrigin(db:DatabaseSync,s:ScheduledRecord,c:ScheduledClaim):ScheduledTask {
 assertScheduledProjection(db,s);const original=scheduledPlanAt(db,s.id,c.planRevision),task=original.tasks.find(t=>t.node.id===c.taskId&&t.generation===c.generation),current=s.plan.tasks.find(t=>t.node.id===c.taskId&&t.generation===c.generation);
 ensure(c.schedulerId===s.id&&hash(original)===c.planDigest&&task&&current&&canonical(task)===canonical(current)&&c.contractVersion===s.plan.contractVersion&&c.contractDigest===s.plan.contractDigest,'stale task origin/contract/generation');
 if(hasLoopTables(db)&&db.prepare('SELECT 1 FROM scheduled_loop_programs WHERE scheduler_id=?').get(s.id)){const row=db.prepare('SELECT record FROM scheduled_task_origins WHERE scheduler_id=? AND task_id=? AND generation=?').get(s.id,c.taskId,c.generation);ensure(row,'loop task origin missing');const origin=JSON.parse(String(row.record)) as LoopTaskOrigin;ensure(origin.introducedRevision<=c.planRevision&&canonical(origin.task)===canonical(task),'loop origin definition changed');}
 return task;
}
export function loopProgramComplete(db:DatabaseSync,id:string):boolean {
 if(!hasLoopTables(db))return true;const row=db.prepare('SELECT record FROM scheduled_loop_states WHERE scheduler_id=?').get(id);if(!row)return true;const state=JSON.parse(String(row.record));return state.frames.find((f:{key:string})=>f.key===state.rootKey)?.state==='yielded';
}
export function stoppedLoopTask(db:DatabaseSync,id:string,taskId:string):boolean{
 if(!hasLoopTables(db))return false;const row=db.prepare('SELECT record FROM scheduled_loop_states WHERE scheduler_id=?').get(id);if(!row)return false;const state=JSON.parse(String(row.record));const frame=state.frames.find((f:{taskId:string})=>f.taskId===taskId);return ['stopped','blocked'].includes(state.frames.find((f:{key:string})=>f.key===state.rootKey)?.state)||!!frame&&(frame.state==='stopped'||Date.now()>=frame.deadlineMs||frame.ancestry.some((key:string)=>['stopped','blocked'].includes(state.frames.find((f:{key:string})=>f.key===key)?.state)));
}
