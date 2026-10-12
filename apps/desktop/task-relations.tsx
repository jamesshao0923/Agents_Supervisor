import React,{useRef} from 'react';
import type {DesktopTask} from './presentation.js';
import type {ExecutionRecord} from '../../packages/contracts/p2.js';
import type {ConversationInspection} from '../../packages/contracts/p6-actions.js';
import type {WorkbenchParent} from '../../packages/contracts/p8-workbench.js';
import {agentExecutionStatus,type AgentCard,type WorkbenchConnection} from './workbench-projection.js';
export interface RelationNode {instruction?:string;id:string;title:string;kind:string;dependencies:string[];executions:ExecutionRecord[];status:string;cards:AgentCard[]}
/** Relations use persisted identities only, never title similarity or guessed operation IDs. */
export function taskRelationNodes(parent:DesktopTask,scope:WorkbenchParent|undefined,cards:AgentCard[],executions:ExecutionRecord[],conversation?:ConversationInspection):RelationNode[]{
 const runtime=parent.runtime;
 const session=parent.session??(conversation&&conversation.conversation.id===parent.conversationId&&conversation.conversation.workspace===parent.workspace&&conversation.active.run.id===(runtime?.runId??parent.id)?conversation.active.session:undefined);
 const title=(id:string,fallback:string)=>session?.proposal?.steps.find(s=>s.id===id)?.description??fallback;
 const owned=scope&&runtime&&scope.runtimeId===runtime.id&&scope.runId===runtime.runId&&scope.projectId===runtime.projectId?scope:undefined;
 const nodes:RelationNode[]=(owned?.scheduler?.record.plan.tasks??[]).map(task=>({id:task.node.id,title:title(task.node.id,task.node.id),instruction:task.step.prompt,kind:'子任务',dependencies:[...task.node.dependencies],executions:[],status:'已记录计划',cards:cards.filter(c=>c.parentId===parent.id&&c.taskId===task.node.id)}));
 if(runtime){
  for(const [index,step] of runtime.definition.steps.entries()){
   const previous=runtime.definition.steps[index-1];
   const integration=owned?.scheduler?.record.plan.integrationNodeId===step.id;
   const dependencies=integration&&owned?.scheduler?owned.scheduler.record.plan.tasks.filter(t=>t.node.required).map(t=>t.node.id):previous?[previous.id]:[];
   const node:RelationNode={id:step.id,title:title(step.id,step.kind==='codex'?step.id:'prompt' in step?step.prompt:step.kind==='http'?step.url:step.id),...(step.kind==='codex'?{instruction:step.prompt}:{}),kind:integration?'汇总 / 集成':'执行步骤',dependencies,executions:[],status:'已记录步骤 · 执行状态待核对',cards:[]};
   for(const e of executions){const b=e.runtimeBinding;
    if(!b||b.runtimeId!==runtime.id||b.projectId!==runtime.projectId||b.runId!==runtime.runId||e.projectId!==runtime.projectId||e.runId!==runtime.runId||b.attemptId!==e.attemptId)continue;
    if(owned?.operations?.some(o=>o.contractVersion===owned.contractVersion&&o.stepIndex===index&&o.id===b.operationId&&o.executionId===e.id&&o.attemptId===e.attemptId&&o.owner===b.owner))node.executions.push(e);
   }
   const existing=nodes.find(n=>n.id===node.id);
   if(existing){existing.executions.push(...node.executions);}else nodes.push(node);
  }
 }else{
  for(const step of session?.proposal?.steps??[])nodes.push({id:step.id,title:step.description,kind:'计划提案 · 未执行',dependencies:[...step.dependencies],executions:[],status:'等待执行准入',cards:[]});
 }
 const attached=new Set(nodes.flatMap(n=>[...n.executions.map(e=>e.id),...n.cards.map(c=>c.id)]));
 for(const card of cards.filter(c=>c.parentId===parent.id&&!attached.has(c.id)))nodes.push({id:'unbound:'+card.id,title:card.goal,kind:'子执行 · 节点关联待核对',dependencies:[],executions:[],cards:[card],status:card.status});
 // Old backends can lack operation metadata. Preserve the execution, without guessing its step.
 if(runtime)for(const e of executions){const b=e.runtimeBinding;if(b&&b.runtimeId===runtime.id&&b.projectId===runtime.projectId&&b.runId===runtime.runId&&e.projectId===runtime.projectId&&e.runId===runtime.runId&&b.attemptId===e.attemptId&&!attached.has(e.id))nodes.push({id:'execution:'+e.id,title:e.prompt,kind:'任务执行 · 步骤关联待核对',dependencies:[],executions:[e],cards:[],status:''});}
 return nodes;
}
export function TaskRelations({parent,scope,cards,executions,connection,conversation}:{parent:DesktopTask;scope:WorkbenchParent|undefined;cards:AgentCard[];executions:ExecutionRecord[];connection:WorkbenchConnection;conversation:ConversationInspection|undefined}){
 const nodes=taskRelationNodes(parent,scope,cards,executions,conversation),refs=useRef(new Map<string,HTMLDetailsElement>());
 const rounds=conversation&&conversation.conversation.id===parent.conversationId&&conversation.conversation.workspace===parent.workspace?conversation.rounds:[];
 function locate(id:string){const target=refs.current.get(id);if(target){target.open=true;target.scrollIntoView({block:'nearest'});target.querySelector('summary')?.focus();}}
 return <div className="task-relations" aria-label="任务继承与依赖关系">
  {rounds.length>1&&<details className="relation-rounds"><summary>跟进继承 · {rounds.length} 轮</summary><ol>{[...rounds].sort((a,b)=>a.ordinal-b.ordinal).map(round=>{const predecessor=rounds.find(r=>r.runId===round.predecessorRunId);return <li key={round.runId}><strong>第 {round.ordinal} 轮{round.runId===conversation!.conversation.activeRunId?' · 当前':''}</strong><span>{round.predecessorRunId?predecessor?`← 延续第 ${predecessor.ordinal} 轮`:'前序轮次记录待核对':'初始任务'}</span>{round.predecessorDeliveryId&&<span className="pill">承接前轮交付</span>}</li>;})}</ol></details>}
  <div className="relation-legend"><span><i/>父任务 → 子任务 → 执行记录</span><span>前置依赖单独标注，可点击定位</span></div>
  {nodes.length?<ul className="relation-branches">{nodes.map(node=><li key={node.id}><details className="relation-node" ref={element=>{if(element)refs.current.set(node.id,element);else refs.current.delete(node.id);}}>
   <summary><span className="relation-node-copy"><span className="workbench-role">{node.kind} · {node.id}</span><strong>{node.title}</strong><span className="subtle">{connection!=='online'?'最后观察 · 后台状态待核对':node.cards.at(-1)?.status??(node.executions.length?agentExecutionStatus(node.executions.at(-1)!,connection).status:node.status)}</span></span><span className="pill">展开详情</span></summary>
   <div className="relation-node-body"><p className="relation-full-title">{node.title}</p>{node.instruction&&<details className="relation-instructions"><summary>查看原始执行指令</summary><pre>{node.instruction}</pre></details>}<div className="relation-dependencies"><span>前置依赖</span>{node.dependencies.length?node.dependencies.map(id=>nodes.some(n=>n.id===id)?<button className="button ghost" key={id} onClick={()=>locate(id)}>↗ {id}</button>:<span className="pill" key={id}>{id} · 记录待核对</span>):<span className="subtle">无已记录的前置依赖</span>}</div>
   {node.cards.length+node.executions.length>0?<ul className="relation-attempts" aria-label="该子任务的执行记录">{[...node.cards.map(c=>({id:c.id,detail:c.detail,workspace:c.workspace,status:c.status,usage:c.usage})),...node.executions.map(e=>({id:e.id,workspace:e.workspace,...agentExecutionStatus(e,connection)}))].map(e=><li key={e.id}><strong>{e.status}</strong><p>{e.detail}</p><span>{e.usage}</span><details><summary>执行位置与编号</summary><p className="mono">{e.workspace}</p><p className="mono">{e.id}</p></details></li>)}</ul>:<p className="form-hint">尚无已关联的真实执行记录。</p>}
   </div></details></li>)}</ul>:<p className="workbench-empty">主控尚未生成子任务。计划形成后，会在这里展示拆分关系和前置依赖。</p>}
 </div>;
}
