import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {GoalSession} from '../../packages/contracts/p5.js';
import type {RuntimeRecord} from '../../packages/contracts/p3.js';
import type {ExecutionRecord} from '../../packages/contracts/p2.js';
import {taskViews} from '../../apps/desktop/presentation.js';
import {taskRelationNodes,TaskRelations} from '../../apps/desktop/task-relations.js';
import {AgentWorkbench} from '../../apps/desktop/agent-workbench.js';
import {agentExecutionStatus,projectAgentCards,workbenchColumns,parentWorkbenchStatus,workbenchObservationMessage,workbenchResultState} from '../../apps/desktop/workbench-projection.js';
const createdAt = '2026-10-10T12:00:00.000Z';
function goal(id:string, workspace='/project'):GoalSession {
  return {id,projectId:'project',workspace,workspaceKind:'project',revision:1,goal:'Requested result '+id,phase:'ready',messages:[],jobs:[],proposal:null,runtimeId:null,error:null,createdAt,updatedAt:createdAt,config:{model:'model',effort:'high',reservation:20,timeoutMs:1000},maxContextChars:60000};
}
function runtime(session:GoalSession):RuntimeRecord {
  return {id:session.id,engine:'local-v1',workflowVersion:1,projectionVersion:1,projectId:session.projectId,runId:session.id,workspace:session.workspace,workspaceKind:session.workspaceKind,definition:{type:'submit',commandId:'submit-'+session.id,goal:session.goal,tokenLimit:100,verificationReserve:20,steps:[{id:'work',kind:'input',prompt:'Required input'}]},cursor:0,phase:'ready',paused:false,cancelled:false,createdAt,updatedAt:createdAt,error:null,inputs:{},checkpointId:null};
}

function execution(parent:RuntimeRecord):ExecutionRecord{return {id:'child',commandId:'claim',projectId:parent.projectId,runId:parent.runId,attemptId:'child',workspace:'/isolated-child',workspaceKind:'project',prompt:'<script>untrusted task text</script>',model:'fixture-no-model',effort:'low',images:[],state:'completed',createdAt,updatedAt:createdAt,deadline:createdAt,timeoutMs:1000,tokenLimit:100,reservation:20,verificationReserve:20,identity:null,pid:null,threadId:null,turnId:null,lastEventSeq:0,message:'Explicit projection fixture, never process evidence',diff:'',error:null,usage:null,usageStatus:'unknown',stopConfirmed:false,cancelRequested:false,artifactId:null,protocolVersion:null,schemaDigest:null,scheduledBinding:{schedulerId:'scheduler',claimId:'claim',operationId:'operation',owner:'fixture',projectId:parent.projectId,runId:parent.runId,attemptId:'child',planRevision:1,generation:1}};}
test('P8-WBENCH-U01 terminal unknown stop and fees outrank completion while offline remains last observation',()=>{
 const parent=runtime(goal('parent')),e=execution(parent);assert.match(agentExecutionStatus(e,'online').status,/待核对/);assert.equal(agentExecutionStatus(e,'online').tone,'warning');
 e.usageStatus='reported';e.usage={totalTokens:7,inputTokens:7,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0};assert.match(agentExecutionStatus(e,'online').status,/待核对/);e.stopConfirmed=true;assert.match(agentExecutionStatus(e,'online').status,/尚不表示验收/);assert.match(agentExecutionStatus(e,'offline').status,/离线/);e.state='interrupted';assert.match(agentExecutionStatus(e,'online').status,/待核对/);
});
test('P8-WBENCH-U02 actual child binding scopes cards and React escapes untrusted text without child cancel controls',()=>{
 const parent=runtime(goal('parent')),parents=taskViews([parent],[]),e=execution(parent);assert.equal(projectAgentCards('/project',parents,[e],null,'online').length,1);assert.equal(projectAgentCards('/other',parents,[e],null,'online').length,0);
 const foreign=structuredClone(e);foreign.scheduledBinding!.runId='other';assert.equal(projectAgentCards('/project',parents,[foreign],null,'online').length,0);
 const markup=renderToStaticMarkup(React.createElement(AgentWorkbench,{projectPath:'/project',parents,executions:[e],snapshot:null,readError:'真实读取失败',connection:'offline',selected:null,onSelect:()=>{throw Error('SSR must not mutate');}}));assert.ok(markup.includes('&lt;script&gt;'));assert.ok(!markup.includes('<script>'));assert.match(markup,/任务关系/);assert.match(markup,/展开详情/);assert.match(markup,/最后观察/);assert.ok(!markup.includes('取消此Agent'));
 assert.match(workbenchObservationMessage('Result observation unavailable: TaskResult repository: scope uninitialized'),/尚无共享结果/);
 assert.match(workbenchObservationMessage('Result observation unavailable: hash mismatch'),/无法核对/);assert.match(workbenchObservationMessage('Scheduler observation unavailable: older contract'),/执行计划需要重新核对/);assert.match(workbenchResultState('submitted'),/待独立验证/);assert.match(workbenchResultState('verified'),/当前资格待核对/);assert.match(workbenchResultState('invalidated'),/已失效/);
 assert.ok(markup.includes('<details><summary>查看读取问题的技术详情</summary><pre>真实读取失败</pre></details>'),'Technical read error remains in collapsed details');
 assert.equal(workbenchColumns(660),2);assert.equal(workbenchColumns(888),4);assert.equal(workbenchColumns(180),1);
});

test('P8-WBENCH-U03 standalone parent retains unknown stop and cost warnings while runtime pause block and cancel remain scoped',()=>{
 const r=runtime(goal('parent')),e=execution(r);delete e.scheduledBinding;
 const project=()=>taskViews([],[e])[0]!;assert.match(parentWorkbenchStatus(project(),'online'),/核对/);e.stopConfirmed=true;assert.match(parentWorkbenchStatus(project(),'online'),/核对/,'Known stop does not clear unknown accounting');e.usageStatus='reported';e.usage={totalTokens:7,inputTokens:7,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0};assert.match(parentWorkbenchStatus(project(),'online'),/尚不表示验收/);e.stopConfirmed=false;assert.match(parentWorkbenchStatus(project(),'online'),/核对/,'Known cost does not confirm the writer stopped');assert.match(parentWorkbenchStatus(project(),'offline'),/最后观察/);
 r.phase='paused';r.paused=true;assert.match(parentWorkbenchStatus(taskViews([r],[])[0]!,'online'),/暂停/);r.error='Explicit runtime block';assert.match(parentWorkbenchStatus(taskViews([r],[])[0]!,'online'),/受阻/);r.error=null;r.cancelled=true;assert.match(parentWorkbenchStatus(taskViews([r],[])[0]!,'online'),/取消.*核对/);
});


test('P8-WBENCH-U04 relation tree preserves provisional dependencies without fabricating executions or nesting dependent siblings',()=>{
 const session=goal('draft');session.proposal={decision:'ready',summary:'Plan only',facts:[],questions:[],constraints:[],style:[],criteria:[],steps:[{id:'front',description:'Frontend <script>',dependencies:[],acceptanceIds:[]},{id:'back',description:'Backend',dependencies:[],acceptanceIds:[]},{id:'join',description:'Integrate',dependencies:['front','back'],acceptanceIds:[]}]};
 const parent=taskViews([],[],[session])[0]!,before=structuredClone(parent),nodes=taskRelationNodes(parent,undefined,[],[]);
 assert.equal(nodes.length,3);assert.deepEqual(nodes[2]!.dependencies,['front','back']);assert.ok(nodes.every(n=>n.executions.length===0&&n.kind.includes('未执行')));assert.deepEqual(parent,before);
 const markup=renderToStaticMarkup(React.createElement(TaskRelations,{parent,scope:undefined,cards:[],executions:[],connection:'offline',conversation:undefined}));assert.match(markup,/前置依赖/);assert.match(markup,/↗ front/);assert.match(markup,/↗ back/);assert.match(markup,/最后观察/);assert.ok(markup.includes('&lt;script&gt;'));assert.equal((markup.match(/class="relation-node"/g)||[]).length,3);
});

test('P8-WBENCH-U05 sequential execution links require matching run operation owner and attempt; old metadata remains unassociated',()=>{
 const r=runtime(goal('parent')),parent=taskViews([r],[])[0]!,e=execution(r);delete e.scheduledBinding;e.projectId=r.projectId;e.runId=r.runId;e.runtimeBinding={runtimeId:r.id,operationId:'op',owner:'owner',projectId:r.projectId,runId:r.runId,attemptId:e.attemptId};
 const scope={runtimeId:r.id,projectId:r.projectId,runId:r.runId,contractVersion:1,budget:{unit:'token' as const,limit:100,spent:0,reserved:0,verificationReserve:20},scheduler:null,results:null,issues:[],operations:[{id:'op',contractVersion:1,stepIndex:0,attemptId:e.attemptId,owner:'owner',executionId:e.id,state:'started' as const}]};
 r.definition.steps[0]={id:'work',kind:'codex',prompt:'Implement this admitted Supervisor task: internal instructions',model:'fixture',effort:'low',reservation:1,timeoutMs:1000};
 const linked=taskRelationNodes(parent,scope,[],[e]);assert.equal(linked[0]!.title,'work','Opaque worker instructions are not a node title');assert.equal(linked.length,1);assert.equal(linked[0]!.executions[0]!.id,e.id);
 for(const broken of [{...scope,operations:[]},{...scope,contractVersion:2},{...scope,runId:'foreign'},{...scope,operations:[{...scope.operations[0]!,owner:'foreign'}]}]){const nodes=taskRelationNodes(parent,broken,[],[e]);assert.equal(nodes[0]!.executions.length,0);assert.ok(nodes.some(n=>n.kind.includes('关联待核对')));}
 const foreign=structuredClone(e);foreign.runtimeBinding!.runId='foreign';assert.ok(taskRelationNodes(parent,scope,[],[foreign]).every(n=>n.executions.length===0));
});
