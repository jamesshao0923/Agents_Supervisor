import { formatTokenLimit } from '../../packages/contracts/token-policy.js';
import React,{useEffect,useState} from 'react';
import type {DesktopTask} from './presentation.js';
import type {ExecutionRecord} from '../../packages/contracts/p2.js';
import type {WorkbenchSnapshot} from '../../packages/contracts/p8-workbench.js';
import {projectAgentCards,parentWorkbenchStatus,workbenchObservationMessage,workbenchResultState,type WorkbenchConnection} from './workbench-projection.js';
export function AgentWorkbench(props:{projectPath:string;parents:DesktopTask[];executions:ExecutionRecord[];snapshot:WorkbenchSnapshot|null;readError:string;connection:WorkbenchConnection;selected:string|null;onSelect:(task:DesktopTask)=>void}){
 const [pinned,setPinned]=useState<string|null>(null);useEffect(()=>setPinned(null),[props.projectPath]);
 const cards=projectAgentCards(props.projectPath,props.parents,props.executions,props.snapshot,props.connection),chosen=cards.find(c=>c.id===pinned);
 return <div className="workbench-board">
  {props.readError&&<div className="notice error" role="alert"><p>本项目的节点与结果暂时无法核对，请重新连接后台。</p><details><summary>查看读取问题的技术详情</summary><pre>{props.readError}</pre></details></div>}
  {props.connection!=='online'&&<p className="notice">后台未连接。以下为最后观察，操作与状态需要重新核对。</p>}
  {props.parents.map(parent=>{const agents=cards.filter(c=>c.parentId===parent.id),scope=props.snapshot?.project.path===props.projectPath?props.snapshot.parents.find(p=>p.runtimeId===parent.id):undefined;return <section key={parent.id} className="workbench-task" aria-label="父任务与子执行">
   <header className="workbench-task-heading"><div><span className="workbench-role">父任务 · {parent.conversationId?'持续跟进':'任务记录'}</span><h3>{parent.prompt}</h3><p>{parentWorkbenchStatus(parent,props.connection)} · {agents.length} 个已记录子 Agent</p></div><button className="button" onClick={()=>props.onSelect(parent)}>跟进 / 任务控制</button></header>
   <p className="form-hint">跟进针对当前任务轮次。暂停仅停止新步骤派发；取消作用于整项父任务，并核对在途进程。子卡片只查看该执行，不能代替父任务取消。</p>
   {scope&&<p className="form-hint">任务账本：已结算 {scope.budget.spent.toLocaleString('zh-CN')} / {formatTokenLimit(scope.budget.limit)} tokens · 验收预留 {scope.budget.verificationReserve.toLocaleString('zh-CN')}</p>}
   {scope?.issues.map((issue,i)=><div className="form-hint" key={i}><p>{workbenchObservationMessage(issue)}</p><details><summary>查看状态核对的技术详情</summary><pre>{issue}</pre></details></div>)}
   {scope?.results&&<p className="form-hint">{scope.results.heads.length} 个当前结果版本 · 仅展示已存记录，发布资格本次尚未复核。{scope.results.heads.map(h=>`${h.ref.taskId} v${h.ref.version}：${workbenchResultState(h.state)}${h.currentContract?'':'（旧要求）'}`).join('；')}</p>}
   {agents.length?<div className="workbench-grid">{agents.map(card=><article key={card.id} className={`workbench-agent ${card.tone} ${pinned===card.id?'pinned':''}`} tabIndex={0} aria-label={`${card.role}：${card.status}`}>
    <div className="workbench-role">{card.role}</div><h4>{card.goal}</h4><p className="workbench-status">{card.status}</p><p className="workbench-progress">{card.execution?`模型 ${card.execution.model} · ${card.execution.effort}`:'已持久记录的计划，尚无真实执行'}</p><div className="workbench-preview"><p>{card.detail}</p><p className="mono">{card.workspace}</p></div><footer><span>{card.usage}</span><button className="button ghost" aria-pressed={pinned===card.id} onClick={()=>setPinned(pinned===card.id?null:card.id)}>{pinned===card.id?'收起详情':'固定详情'}</button></footer>
   </article>)}</div>:<p className="workbench-empty">{scope?.scheduler?'当前还没有子执行记录。':'本任务尚无已连接的子 Agent 计划。选择「跟进 / 任务控制」后，在下方对话框继续。'}</p>}
  </section>})}
  {chosen&&<aside className="workbench-pinned" aria-label="固定的子 Agent 详情"><button className="button ghost" onClick={()=>setPinned(null)}>关闭固定详情</button><h3>{chosen.role}</h3><p>{chosen.status}</p><p>{chosen.detail}</p><p className="mono">{chosen.workspace}</p><p>{chosen.usage}</p>{chosen.execution&&<p className="form-hint">执行 {chosen.execution.id} · 停止{chosen.execution.stopConfirmed?'已确认':'待核对'} · 费用{chosen.execution.usageStatus==='reported'?'已有观察回报':'未知'}。执行结束不表示通过独立验收。</p>}</aside>}
 </div>;
}
