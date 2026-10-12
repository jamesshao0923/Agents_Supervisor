import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokenTierSelector } from '../../apps/desktop/token-tier-selector.js';
import { TOKEN_TIERS, tokenCapacity, tokenRemaining, withinTokenReservation } from '../../packages/contracts/token-policy.js';
import { parseCreateRunInput } from '../../packages/contracts/validation.js';
import { parseExecutionAction } from '../../packages/contracts/p2.js';
import { parseRuntimeAction } from '../../packages/contracts/p3.js';
import { parseOrchestrationAction } from '../../packages/contracts/p5.js';
import type { CreateRunInput, Run, RunAction } from '../../packages/contracts/p1.js';
import { applyAction, createRun, readiness } from '../../packages/domain/index.js';

function input(limit:number|null=null):CreateRunInput {
  return {id:'token-run',projectId:'project',contract:{version:1,goal:'Produce a local file',criteria:[{id:'contents',description:'Exact file contents',required:true}]},nodes:[{id:'first',dependencies:[],required:true},{id:'second',dependencies:['first'],required:true}],budget:{unit:'token',limit,verificationReserve:2}};
}
function act(run:Run,action:RunAction):Run {return applyAction(run,action).run;}
function start(attemptId='first-attempt',nodeId='first',reservation=1):RunAction {return {type:'startAttempt',attemptId,nodeId,contractVersion:1,purpose:'execution',reservation,resources:[]};}
const execution={type:'start',commandId:'execution',prompt:'Create one file',model:'gpt-6-astra',effort:'low',timeoutMs:1000,tokenLimit:null,reservation:1,verificationReserve:2};
const runtime={type:'submit',commandId:'runtime',goal:'Create one file',tokenLimit:null,verificationReserve:2,steps:[{id:'one',kind:'codex',prompt:'Create one file',model:'gpt-6-astra',effort:'low',reservation:1,timeoutMs:1000}]};
const goal={type:'start',commandId:'goal',goal:'Create one file',model:'gpt-6-astra',effort:'low',timeoutMs:1000,tokenLimit:null,reservation:1,verificationReserve:2};

test('token tiers expose medium five million high fifty million and explicit unlimited',()=>{
  assert.deepEqual(Object.keys(TOKEN_TIERS),['medium','high','unlimited']);
  assert.equal(TOKEN_TIERS.medium.limit,5_000_000);assert.equal(TOKEN_TIERS.high.limit,50_000_000);assert.equal(TOKEN_TIERS.unlimited.limit,null);
  for(const tier of Object.values(TOKEN_TIERS)){assert.ok(Number.isSafeInteger(tier.reservation)&&tier.reservation>0);assert.ok(Number.isSafeInteger(tier.verificationReserve)&&tier.verificationReserve>0);}
  assert.equal(tokenCapacity(null),Infinity);assert.equal(tokenRemaining(null,9_000_000),null);assert.equal(tokenRemaining(10,3),7);
  assert.equal(JSON.parse(JSON.stringify(TOKEN_TIERS.unlimited)).limit,null);
});

test('token parsers accept explicit null and preserve finite limits without accepting missing or invalid limits',()=>{
  for(const [parse,value] of [[parseExecutionAction,execution],[parseRuntimeAction,runtime],[parseOrchestrationAction,goal]] as const){
    assert.equal((parse(value) as {tokenLimit:number|null}).tokenLimit,null);
    assert.equal((parse({...value,tokenLimit:100}) as {tokenLimit:number|null}).tokenLimit,100);
    const missing:Record<string,unknown>={...value};delete missing.tokenLimit;assert.throws(()=>parse(missing));
    for(const tokenLimit of [undefined,-1,NaN,Infinity,-Infinity,0.5,Number.MAX_SAFE_INTEGER+1,'unlimited','',false,{}])assert.throws(()=>parse({...value,tokenLimit}));
  }
  assert.equal(parseCreateRunInput(input()).budget.limit,null);
  const missing:Record<string,unknown>={...input().budget};delete missing.limit;
  assert.throws(()=>parseCreateRunInput({...input(),budget:missing}));
  for(const limit of [undefined,-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1,'unlimited'])assert.throws(()=>parseCreateRunInput({...input(),budget:{...input().budget,limit}}));
});

test('unlimited requires explicit token accounting and retains finite reservation deadline and verification validation',()=>{
  assert.throws(()=>createRun({...input(),budget:{limit:null,verificationReserve:2}}),/token/);
  assert.throws(()=>createRun({...input(),budget:{unit:'work-unit',limit:null,verificationReserve:2}}),/token/);
  for(const value of [execution,runtime,goal]){
    const parse=value===execution?parseExecutionAction:value===runtime?parseRuntimeAction:parseOrchestrationAction;
    assert.throws(()=>parse({...value,verificationReserve:Infinity}));
  }
  for(const parse of [parseExecutionAction,parseOrchestrationAction]){
    const value=parse===parseExecutionAction?execution:goal;
    for(const reservation of [0,-1,Infinity,NaN,null])assert.throws(()=>parse({...value,reservation}));
    for(const timeoutMs of [999,3_600_001,Infinity,null])assert.throws(()=>parse({...value,timeoutMs}));
  }
  assert.throws(()=>parseRuntimeAction({...runtime,steps:[{...runtime.steps[0],reservation:Infinity}]}));
  assert.throws(()=>parseRuntimeAction({...runtime,steps:[{...runtime.steps[0],timeoutMs:999}]}));
});

test('reservation comparison allows known unlimited overspend and rejects unknown or malformed usage',()=>{
  assert.equal(withinTokenReservation(null,1000,1),true);assert.equal(withinTokenReservation(10,2,1),false);assert.equal(withinTokenReservation(10,1,1),true);
  for(const usage of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1,null,undefined])assert.equal(withinTokenReservation(null,usage as number,1),false);
  for(const reservation of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1,null])assert.equal(withinTokenReservation(null,10,reservation as number),false);
});

test('finite token ceilings still reject oversized reservations and block dispatch after actual overspend',()=>{
  const run=createRun(input(10));assert.throws(()=>act(run,start('too-large','first',9)),/budget/);
  let spent=act(run,start());spent=act(spent,{type:'finishAttempt',attemptId:'first-attempt',outcome:'succeeded'});spent=act(spent,{type:'settleAttempt',attemptId:'first-attempt',actual:12});
  assert.equal(spent.budget.spent,12);assert.equal(readiness(spent).state,'blocked');assert.throws(()=>act(spent,start('next','second')),/budget/);
  assert.throws(()=>parseExecutionAction({...execution,tokenLimit:2}),/Budget/);assert.throws(()=>parseRuntimeAction({...runtime,tokenLimit:2}));assert.throws(()=>parseOrchestrationAction({...goal,tokenLimit:2}),/budget/);
});

test('unlimited token dispatch accounts actual overspend once and permits the next dependent attempt',()=>{
  let run=act(createRun(input()),start());run=act(run,{type:'finishAttempt',attemptId:'first-attempt',outcome:'succeeded'});run=act(run,{type:'settleAttempt',attemptId:'first-attempt',actual:60_000_000});
  assert.equal(run.budget.limit,null);assert.equal(run.budget.spent,60_000_000);assert.equal(run.attempts[0]!.actual,60_000_000);assert.equal(readiness(run).state,'ready');
  const repeat=applyAction(run,{type:'settleAttempt',attemptId:'first-attempt',actual:60_000_000});assert.deepEqual(repeat.events,[]);assert.equal(repeat.run.budget.spent,60_000_000);
  assert.throws(()=>act(run,{type:'settleAttempt',attemptId:'first-attempt',actual:1}),/conflicting/);
  assert.equal(act(run,start('next','second',50_000_000)).attempts.length,2);
});

test('unlimited mode keeps unknown accounting effects cancellation and verification gates',()=>{
  let run=act(createRun(input()),start());run=act(run,{type:'finishAttempt',attemptId:'first-attempt',outcome:'succeeded'});
  assert.equal(readiness(run).state,'blocked');assert.throws(()=>act(run,{...start('reason','@supervisor'),purpose:'reasoning'} as RunAction),/unsettled/);
  run=act(run,{type:'settleAttempt',attemptId:'first-attempt',actual:99});run=act(run,{type:'setOperation',operationId:'effect',attemptId:'first-attempt',status:'unknown'});
  assert.equal(readiness(run).state,'blocked');assert.throws(()=>act(run,start('next','second')),/unresolved/);
  run=act(run,{type:'setOperation',operationId:'effect',attemptId:'first-attempt',status:'confirmed'});run=act(run,start('next','second'));run=act(run,{type:'finishAttempt',attemptId:'next',outcome:'succeeded'});run=act(run,{type:'settleAttempt',attemptId:'next',actual:99});
  assert.throws(()=>act(run,{type:'complete'}),/artifact/);
  run=act(run,{type:'setArtifact',artifact:{id:'artifact',path:'result.txt',digest:'contents',contractVersion:1}});assert.throws(()=>act(run,{type:'complete'}),/passed evidence/);
  const cancelled=act(run,{type:'cancel'});assert.equal(readiness(cancelled).state,'cancelled');assert.throws(()=>act(cancelled,start('again')),/cancelled/);
});

test('token selector renders all three Chinese tiers and the unlimited accounting explanation',()=>{
  const html=renderToStaticMarkup(React.createElement(TokenTierSelector,{value:'unlimited',onChange:()=>{}}));
  for(const text of ['Token 消耗','中','高','无限','累计 500 万','累计 5,000 万','不设 Token 上限','持续统计用量'])assert.ok(html.includes(text),text);
  assert.match(html,/<input[^>]+value="unlimited"[^>]*checked=""|<input[^>]+checked=""[^>]*value="unlimited"/);
  assert.equal((html.match(/type="radio"/g)??[]).length,3);
});
