import test from 'node:test';
import assert from 'node:assert/strict';
import { reasonerWebSearchPolicy, type ReasonerInput } from '../../packages/orchestration/reasoner.js';
import { createReasonerEventState, reduceReasonerEvent } from '../../packages/orchestration/reasoner-events.js';
import { normalizeNotification } from '../../packages/executor-codex/index.js';
import { executionWebSearchPolicy } from '../../packages/execution/manager.js';

test('native search reasoning policy stays disabled by default and rejects indexed/live combinations', () => {
  assert.equal(reasonerWebSearchPolicy({}), 'disabled');
  assert.equal(reasonerWebSearchPolicy({webSearch:'live'}), 'live');
  assert.throws(() => reasonerWebSearchPolicy({webSearch:'cached'} as unknown as ReasonerInput), /Invalid reasoner web search policy/);
  // Presence alone must reject the incompatible capability before any grant or process is used.
  assert.throws(() => reasonerWebSearchPolicy({webSearch:'live',indexed:{}} as unknown as ReasonerInput), /Indexed material reasoning cannot enable/);
});

test('native search execution policy excludes indexed and legacy inline frozen material evidence', () => {
  assert.equal(executionWebSearchPolicy({indexedMaterialReader:false,runtimeResearch:false,researchGroup:false}),'live');
  assert.equal(executionWebSearchPolicy({indexedMaterialReader:true,runtimeResearch:false,researchGroup:false}),'disabled');
  assert.equal(executionWebSearchPolicy({indexedMaterialReader:false,runtimeResearch:true,researchGroup:false}),'disabled','Legacy inline runtime evidence remains isolated');
  assert.equal(executionWebSearchPolicy({indexedMaterialReader:false,runtimeResearch:false,researchGroup:true}),'disabled','Legacy inline scheduled group evidence remains isolated');
  assert.equal(executionWebSearchPolicy({indexedMaterialReader:true,runtimeResearch:true,researchGroup:true}),'disabled');
});

test('real notification reducer permits native search only for live policy and retains isolation and accounting', () => {
  const event=(method:string,type:string,threadId='thread') => normalizeNotification({method,params:{threadId,turnId:'turn',item:{id:'action',type}}},1);
  for(const method of ['item/started','item/completed']) {
    assert.throws(() => reduceReasonerEvent(createReasonerEventState(),event(method,'webSearch')), /prohibited or unknown/);
    assert.throws(() => reduceReasonerEvent(createReasonerEventState(),event(method,'webSearch'),'disabled'), /prohibited or unknown/);
    const state=createReasonerEventState();
    assert.equal(reduceReasonerEvent(state,event(method,'webSearch'),'live').finished,false);
    assert.equal(state.threadId,'thread');assert.equal(state.turnId,'turn');
    assert.throws(() => reduceReasonerEvent(state,event(method,'webSearch','other'),'live'), /another thread/);
    for(const type of ['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentSpawn','futureTool']) {
      assert.throws(() => reduceReasonerEvent(createReasonerEventState(),event(method,type),'live'), /prohibited or unknown/);
    }
  }
  const state=createReasonerEventState();
  reduceReasonerEvent(state,event('item/completed','webSearch'),'live');
  assert.deepEqual(state.completedMessages,[],'Search completion is not the structured final answer');
  const usage={inputTokens:2,cachedInputTokens:0,outputTokens:3,reasoningOutputTokens:0,totalTokens:5};
  const tokens=normalizeNotification({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'turn',tokenUsage:{total:usage,last:usage}}},2);
  assert.equal(reduceReasonerEvent(state,tokens,'live').usageChanged,true);assert.equal(state.usage,5);
  assert.throws(() => reduceReasonerEvent(state,{sequence:3,method:'item/tool/call',kind:'server-request',raw:{}},'live'), /cannot request/);
  assert.throws(() => reduceReasonerEvent(state,normalizeNotification({method:'thread/status/changed',params:{threadId:'thread',status:{type:'active',activeFlags:['waitingOnUserInput']}}},3),'live'), /cannot request/);
});
