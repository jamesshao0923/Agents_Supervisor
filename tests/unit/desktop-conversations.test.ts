import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TaskRelations} from '../../apps/desktop/task-relations.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationInspection } from '../../packages/contracts/p6-actions.js';
import type { GoalSession } from '../../packages/contracts/p5.js';
import type { RuntimeRecord } from '../../packages/contracts/p3.js';
import { createDraftRun } from '../../packages/domain/index.js';
import { activeConversationTaskId, conversationTaskViews } from '../../apps/desktop/presentation.js';

const createdAt = '2026-10-10T12:00:00.000Z';
function goal(id:string, workspace='/project'):GoalSession {
  return {id,projectId:'project',workspace,workspaceKind:'project',revision:1,goal:'Requested result '+id,phase:'ready',messages:[],jobs:[],proposal:null,runtimeId:null,error:null,createdAt,updatedAt:createdAt,config:{model:'model',effort:'high',reservation:20,timeoutMs:1000},maxContextChars:60000};
}
function runtime(session:GoalSession):RuntimeRecord {
  return {id:session.id,engine:'local-v1',workflowVersion:1,projectionVersion:1,projectId:session.projectId,runId:session.id,workspace:session.workspace,workspaceKind:session.workspaceKind,definition:{type:'submit',commandId:'submit-'+session.id,goal:session.goal,tokenLimit:100,verificationReserve:20,steps:[{id:'work',kind:'input',prompt:'Required input'}]},cursor:0,phase:'ready',paused:false,cancelled:false,createdAt,updatedAt:createdAt,error:null,inputs:{},checkpointId:null};
}
function inspection(first:GoalSession,current:GoalSession):ConversationInspection {
  return {conversation:{id:'conversation',projectId:'project',workspace:first.workspace,firstRunId:first.id,activeRunId:current.id,activeSessionId:current.id,authorizedLimit:100,createdAt},rounds:[first,current].map((session,index)=>({conversationId:'conversation',ordinal:index+1,sessionId:session.id,projectId:'project',runId:session.id,predecessorRunId:index?first.id:null,predecessorDeliveryId:index?'preserved-delivery':null,createdAt})),messages:[],assessmentJobs:[],budget:{reasoningSpent:0,reasoningReserved:0,limit:100,spent:17,reserved:0,remaining:83,available:83,rounds:[]},active:{session:current,run:createDraftRun({id:current.id,projectId:'project',goal:current.goal,budget:{unit:'token',limit:83,verificationReserve:20}})}};
}

test('desktop conversation projection shows one active task while preserving old round delivery and unrelated projects',()=>{
  const first={...goal('goal-first'),runtimeId:'goal-first',phase:'admitted' as const};
  const current=goal('goal-current'),unrelated=goal('goal-other','/other-project');
  const conversation=inspection(first,current),before=structuredClone(conversation),oldRuntime=runtime(first);
  const cards=conversationTaskViews([oldRuntime],[],[first,current,unrelated],[conversation]);
  assert.deepEqual(cards.filter(card=>card.workspace==='/project').map(card=>card.id),[current.id]);
  assert.equal(cards.find(card=>card.id===current.id)?.conversationId,conversation.conversation.id);
  assert.equal(cards.find(card=>card.id===current.id)?.session,current);
  assert.equal(cards.find(card=>card.id===current.id)?.roundCount,2);
  assert.ok(cards.some(card=>card.id===unrelated.id));
  assert.equal(activeConversationTaskId([conversation],first.id),current.id,'A selected historical round follows the actual active round');
  assert.equal(activeConversationTaskId([conversation],unrelated.id),unrelated.id,'An unrelated project selection must not move');
  assert.equal(conversation.rounds[1]?.predecessorDeliveryId,'preserved-delivery');
  const markup=renderToStaticMarkup(React.createElement(TaskRelations,{parent:cards.find(c=>c.id===current.id)!,scope:undefined,cards:[],executions:[],connection:'online',conversation}));
  assert.match(markup,/跟进继承/);assert.match(markup,/延续第 1 轮/);assert.match(markup,/承接前轮交付/);assert.ok(!markup.includes('已有独立交付记录'),'Lineage does not claim current verification passed');
  assert.deepEqual(conversation,before,'Card deduplication must preserve history and real budget');
});

test('desktop conversation admission never duplicates or loses active card while runtime polling catches up',()=>{
  const first={...goal('goal-first'),runtimeId:'goal-first',phase:'admitted' as const};
  const current={...goal('goal-current'),runtimeId:'goal-current',phase:'admitted' as const};
  const value=inspection(first,current);
  const early=conversationTaskViews([runtime(first)],[],[first,current],[value]);
  assert.deepEqual(early.map(card=>card.id),[current.id]);
  assert.equal(early[0]?.session,current,'Before runtime-list catches up retain the active backend session');
  assert.equal(early[0]?.runtime,undefined,'Do not manufacture an execution state');
  const synced=conversationTaskViews([runtime(first),runtime(current)],[],[first,current],[value]);
  assert.deepEqual(synced.map(card=>card.id),[current.id]);
  assert.equal(synced[0]?.runtime?.phase,'ready');
  assert.equal(synced[0]?.session,undefined,'When the runtime exists its real state drives task operations');
});
