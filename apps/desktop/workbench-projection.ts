import type {DesktopTask} from './presentation.js';
import type {ExecutionRecord} from '../../packages/contracts/p2.js';
import type {WorkbenchSnapshot,WorkbenchParent} from '../../packages/contracts/p8-workbench.js';
export type WorkbenchConnection='connecting'|'online'|'offline'|'detached';
export interface AgentCard {id:string;parentId:string;role:string;goal:string;workspace:string;status:string;tone:'warning'|'error'|'neutral';detail:string;usage:string;execution:ExecutionRecord|null;taskId:string|null;generation:number|null}
const terminal=new Set(['completed','cancelled','failed','interrupted','unknown']);
export function agentExecutionStatus(execution:ExecutionRecord,connection:WorkbenchConnection):Pick<AgentCard,'status'|'tone'|'detail'|'usage'>{
 const usage=execution.usageStatus==='reported'&&execution.usage?`${execution.usage.totalTokens.toLocaleString('zh-CN')} tokens · 已观察用量`:'用量尚未回报';
 const detail=execution.error||execution.message||'等待真实执行事件';
 if(connection!=='online')return {status:connection==='detached'?'监控已断开 · 最后观察':'后台离线 · 最后观察',tone:'warning',detail,usage};
 if(execution.state==='unknown'||execution.state==='interrupted'||terminal.has(execution.state)&&(!execution.stopConfirmed||execution.usageStatus!=='reported'))return {status:'停止／结果／费用待核对',tone:'warning',detail,usage};
 if(execution.error||execution.state==='failed')return {status:'执行失败',tone:'error',detail,usage};
 if(execution.cancelRequested&&!execution.stopConfirmed)return {status:'取消已请求 · 待停止核对',tone:'warning',detail,usage};
 const labels:Record<ExecutionRecord['state'],string>={queued:'等待执行',starting:'启动中',running:'执行中',waiting:'等待工具结果',cancelling:'取消核对中',completed:'执行已结束 · 尚不表示验收',cancelled:'执行已停止',failed:'执行失败',interrupted:'执行中断',unknown:'状态待核对'};
 return {status:labels[execution.state],tone:'neutral',detail,usage};
}
/** A child's isolated workspace is never mistaken for a separate user project. */
export function projectAgentCards(projectPath:string,parents:DesktopTask[],executions:ExecutionRecord[],snapshot:WorkbenchSnapshot|null,connection:WorkbenchConnection):AgentCard[]{
 if(snapshot&&snapshot.project.path!==projectPath)return [];
 const cards:AgentCard[]=[];
 for(const parent of parents.filter(p=>p.workspace===projectPath&&p.runtime)){
  const runtime=parent.runtime!,scope:WorkbenchParent|undefined=snapshot?.parents.find(p=>p.runtimeId===runtime.id&&p.projectId===runtime.projectId&&p.runId===runtime.runId);
  const children=executions.filter(e=>e.scheduledBinding&&e.scheduledBinding.projectId===runtime.projectId&&e.scheduledBinding.runId===runtime.runId&&e.projectId===runtime.projectId&&e.runId===runtime.runId&&e.scheduledBinding.attemptId===e.attemptId);
  for(const execution of children){
   const binding=execution.scheduledBinding!,scheduler=scope?.scheduler,claim=scheduler?.claims.find(c=>c.id===binding.claimId&&c.attemptId===execution.attemptId&&c.schedulerId===binding.schedulerId&&c.operationId===binding.operationId&&c.owner===binding.owner&&c.workspace===execution.workspace&&c.projectId===runtime.projectId&&c.runId===runtime.runId&&c.runtimeId===runtime.id&&c.planDigest===scheduler.record.planDigest&&c.generation===binding.generation&&c.planRevision===binding.planRevision);
   const task=claim&&scheduler?.record.plan.tasks.find(t=>t.node.id===claim.taskId&&t.generation===claim.generation),status=agentExecutionStatus(execution,connection),operation=claim&&scheduler?.operations.find(o=>o.claimId===claim.id);
   cards.push({id:execution.id,parentId:parent.id,role:task?`子 Agent · ${task.node.id}`:'子执行 · 计划归属待核对',goal:task?.step.prompt??execution.prompt,workspace:execution.workspace,...status,...(!claim&&connection==='online'?{status:'计划归属待核对',tone:'warning' as const}:{}),...(operation?.state==='unknown'&&connection==='online'?{status:'派发副作用待核对',tone:'warning' as const}:{}),execution,taskId:claim?.taskId??null,generation:claim?.generation??null});
  }
  if(scope?.scheduler){const scheduler=scope.scheduler;for(const task of scheduler.record.plan.tasks){
   const claim=scheduler.claims.find(c=>c.taskId===task.node.id&&c.generation===task.generation),execution=claim&&children.find(e=>e.attemptId===claim.attemptId);
   if(execution)continue;const operation=claim&&scheduler.operations.find(o=>o.claimId===claim.id);
   const closedOptional=!claim&&!task.node.required&&scheduler.record.state==='drained'&&scheduler.record.fence==='released';
   cards.push({id:`${scheduler.record.id}:${task.node.id}:${task.generation}`,parentId:parent.id,role:`计划子 Agent · ${task.node.id}`,goal:task.step.prompt,workspace:task.workspace,status:connection!=='online'?'后台离线 · 最后观察':closedOptional?'未执行 · 本轮已收束':operation?.state==='unknown'?'副作用待核对':operation?.state==='failed'?'派发失败 · 尚无执行记录':operation?.state==='cancelled'?'派发已取消':operation?.state==='confirmed'?'执行记录待核对':claim?'已领取 · 尚无执行记录':scheduler.record.state==='blocked'?'计划阻塞 · 未派发':scheduler.record.state==='paused'?'计划暂停 · 尚未领取':scheduler.record.state==='cancelled'?'计划已取消 · 未派发':'计划已记录 · 尚未领取',tone:operation?.state==='failed'||scheduler.record.state==='blocked'?'error':operation?.state==='unknown'||operation?.state==='confirmed'?'warning':'neutral',detail:closedOptional?'此可选候选没有执行记录，不计为完成；准入条件与预算原因可在探索面板核对。':`${scheduler.record.state==='blocked'?'计划阻塞':scheduler.record.state==='active'?'当前计划':scheduler.record.state==='paused'?'计划已暂停':scheduler.record.state==='cancelled'?'计划已取消':'计划已收束'} · ${task.node.dependencies.length} 项依赖；没有真实执行记录，不显示执行进度。`,usage:'尚无执行费用记录',execution:null,taskId:task.node.id,generation:task.generation});
  }}
 }
 return cards;
}
export function workbenchColumns(width:number,minCard=210,gap=16):number {if(!Number.isFinite(width)||width<=0)return 1;return Math.max(1,Math.floor((width+gap)/(minCard+gap)));}

export function parentWorkbenchStatus(parent:DesktopTask,connection:WorkbenchConnection):string {
 if(connection!=='online')return '最后观察 · 后台状态待核对';
 if(!parent.runtime&&parent.execution)return agentExecutionStatus(parent.execution,connection).status;
 if(parent.error)return '任务受阻 · 查看真实原因';
 if(parent.runtime?.cancelled)return '取消已请求 · 停止情况需核对';
 const labels:Record<string,string>={ready:'待派发',running:'执行中','waiting-input':'等待输入',paused:'已暂停新派发',cancelled:'任务已取消',blocked:'任务受阻','awaiting-verification':'执行已结束 · 待独立验收',thinking:'主控分析中',clarifying:'等待补充要求',admitted:'已准入执行',queued:'等待执行',starting:'启动中',waiting:'等待工具结果',completed:'执行已结束 · 尚不表示验收',interrupted:'执行中断 · 待核对',unknown:'状态待核对'};
 return labels[parent.state]??'状态待核对';
}

/** Keep raw diagnostics available without treating an uninitialized ledger as failure. */
export function workbenchObservationMessage(issue:string):string {
 if(issue==='Result observation unavailable: TaskResult repository: scope uninitialized')return '尚无共享结果，子任务提交后将在这里显示。';
 if(issue.startsWith('Result observation unavailable:'))return '共享结果暂时无法核对，请重新连接后查看；现有任务记录仍保留。';
 if(issue==='Multiple scheduler records require reconciliation')return '检测到多份调度记录，暂时不能确认当前执行计划。';
 if(issue.startsWith('Scheduler observation unavailable:'))return '当前执行计划需要重新核对，暂不显示未经确认的节点状态。';
 return '项目状态暂时无法核对，请查看详情或重新连接后台。';
}
export function workbenchResultState(state:string):string {
 const labels:Record<string,string>={draft:'草稿，尚未提交',submitted:'已提交，待独立验证',verified:'已记录验证，当前资格待核对',invalidated:'已失效，需重新验证'};
 return labels[state]??'状态待核对';
}
