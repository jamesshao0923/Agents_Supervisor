import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNotification} from '../../packages/executor-codex/index.js';
test('P6-EXEC-WARN-U01 retry flags remain diagnostic and only authoritative turn status supplies terminal classification',()=>{
 for(const willRetry of [true,false]){const event=normalizeNotification({method:'error',params:{threadId:'thread',turnId:'turn',error:{message:'Explicit synthetic protocol fixture'},willRetry}},1);assert.equal(event.kind,'error');assert.equal(event.willRetry,willRetry);assert.equal(event.terminal,false);}
 assert.equal(normalizeNotification({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[],error:null}}},2).terminal,true);
 assert.throws(()=>normalizeNotification({method:'error',params:{error:{message:'missing flag'}}},3),/willRetry/);
});

import {readExecutionEventsThrough} from '../../packages/execution/manager.js';
import type {ExecutionEvent} from '../../packages/contracts/p2.js';
test('P6-EXEC-WARN-U02 frozen paginated evidence denies missing tails nonadvancing cursors and oversized histories',()=>{
 const event=(seq:number):ExecutionEvent=>({seq,executionId:'e',receivedAt:'fixture',kind:'fixture',payload:{}});
 const all=Array.from({length:712},(_,i)=>event(i+1));assert.deepEqual(readExecutionEventsThrough('e',712,after=>all.filter(e=>e.seq>after).slice(0,500)),all);
 assert.equal(readExecutionEventsThrough('e',713,after=>all.filter(e=>e.seq>after).slice(0,500)),null);
 assert.equal(readExecutionEventsThrough('e',712,()=>all.slice(0,500)),null);
 assert.equal(readExecutionEventsThrough('e',50001,after=>Array.from({length:Math.min(500,50001-after)},(_,i)=>event(after+i+1))),null);
 assert.equal(readExecutionEventsThrough('e',1,()=>[{...event(1),payload:{oversized:'x'.repeat(8*1024*1024)}}]),null);
 assert.equal(readExecutionEventsThrough('e',2,()=>[event(1),event(3)]),null);
});
