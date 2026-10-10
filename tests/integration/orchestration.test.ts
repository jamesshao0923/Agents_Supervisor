import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SupervisorStore } from '../../packages/persistence/store.js';
import type { GoalProposal,OrchestrationAction } from '../../packages/contracts/p5.js';
function fixture(){const root=mkdtempSync(join(tmpdir(),'sv-p5-store-')),workspace=join(root,'project');mkdirSync(workspace);return {root,workspace,store:new SupervisorStore(join(root,'data'))};}
const input:Extract<OrchestrationAction,{type:'start'}>={type:'start',commandId:'start',goal:'Produce a local sum function',model:'model',effort:'low',reservation:30,timeoutMs:1000,tokenLimit:200,verificationReserve:20};
function ready(id:string):GoalProposal{return {decision:'ready',summary:'sum',questions:[],facts:[{text:input.goal,sourceId:`${id}:message:1`,origin:'explicit'}],constraints:[],style:[],criteria:[{id:'sum',description:'sum(2,3)=5',kind:'command',target:'sum.test.mjs',checks:['exact 5']}],steps:[{id:'build',description:'Create sum module and assertions',dependencies:[],acceptanceIds:['sum']}]};}
test('P5 real SQLite admission is atomic idempotent and retains the reasoning ledger after reopen',()=>{const f=fixture();let st=f.store;try{const x=st.goals.start(input,f.workspace,'project'),j=x.session.jobs[0]!;assert.equal(st.isManagedRun(x.session.projectId,x.session.id),true);assert.deepEqual(st.goals.start(input,f.workspace,'project'),x);assert.throws(()=>st.goals.start({...input,goal:'different'},f.workspace,'project'),/Conflicting/);const ended=st.goals.finish(x.session.id,j.id,job=>{job.usage=17;job.stopConfirmed=true;job.proposal=ready(x.session.id);});assert.throws(()=>st.goals.control({type:'admit',commandId:'stale',sessionId:x.session.id,expectedRevision:0}),/revision/);const a={type:'admit' as const,commandId:'admit',sessionId:x.session.id,expectedRevision:ended.session.revision};const admitted=st.goals.control(a);assert.equal(admitted.run.budget.spent,17);assert.equal(admitted.session.runtimeId,x.session.id);assert.deepEqual(st.goals.control(a),admitted);assert.equal(st.runtime.inspect(x.session.id).run.id,x.run.id);st.close();st=new SupervisorStore(join(f.root,'data'));assert.deepEqual(st.goals.inspect(x.session.id),admitted);assert.equal(st.runtime.operations(x.session.id).length,1);}finally{st.close();}});
test('P5 unknown usage blocks admission and retry without resetting reservations',()=>{const f=fixture();try{const x=f.store.goals.start(input,f.workspace,'project');const ended=f.store.goals.finish(x.session.id,x.session.jobs[0]!.id,j=>{j.usage=null;j.stopConfirmed=true;j.error='interrupted';});assert.equal(ended.session.phase,'blocked');assert.equal(ended.run.attempts[0]!.settled,false);assert.equal(ended.run.attempts[0]!.reservation,30);assert.throws(()=>f.store.goals.control({type:'restore',commandId:'retry',sessionId:x.session.id,expectedRevision:ended.session.revision}),/unsettled/);assert.throws(()=>f.store.goals.control({type:'admit',commandId:'admit',sessionId:x.session.id,expectedRevision:ended.session.revision}),/not ready/);}finally{f.store.close();}});
test('P5 cancelled reasoning accepts late accounting but never revives or admits',()=>{const f=fixture();try{const x=f.store.goals.start(input,f.workspace,'project');f.store.goals.control({type:'cancel',commandId:'cancel',sessionId:x.session.id});const final=f.store.goals.finish(x.session.id,x.session.jobs[0]!.id,j=>{j.usage=21;j.stopConfirmed=true;j.proposal=ready(x.session.id);});assert.equal(final.session.phase,'cancelled');assert.equal(final.run.budget.spent,21);assert.equal(final.run.status,'cancelled');assert.throws(()=>f.store.goals.control({type:'answer',commandId:'answer',sessionId:x.session.id,expectedRevision:final.session.revision,text:'continue'}),/cancelled/);assert.equal(f.store.runtime.list().length,0);}finally{f.store.close();}});
test('P5 service recovery blocks direct domain mutation and settles confirmed pre-model interruption without replay',async()=>{const f=fixture(),x=f.store.goals.start(input,f.workspace,'project');f.store.close();const {startService}=await import('../../apps/supervisor/server.js');const {request}=await import('../../apps/cli/client.js');const data=join(f.root,'data'),service=await startService(data);try{const check=await request(data,{id:'inspect',method:'orchestration',action:{type:'inspect',sessionId:x.session.id}});assert.equal(check.ok,true);const value=check.value as import('../../packages/contracts/p5.js').GoalInspection;assert.equal(value.session.phase,'blocked');assert.equal(value.run.attempts[0]?.actual,0);const denied=await request(data,{id:'act',method:'command',command:{type:'act',commandId:'external',projectId:x.session.projectId,runId:x.session.id,expectedRevision:value.run.revision,action:{type:'admit',contract:{version:2,goal:'Bypass',criteria:[{id:'fake',description:'fake',required:true}]},nodes:[{id:'fake',dependencies:[],required:true}]}}});assert.equal(denied.ok,false);assert.match(denied.error,/controller/);const again=await request(data,{id:'again',method:'orchestration',action:{type:'inspect',sessionId:x.session.id}});assert.equal(again.ok,true);assert.deepEqual(again.value,value);}finally{await service.close();}});

test('P5 managed directory rejects redirection and root while durable start retries never recreate files',async()=>{
  const { symlink,realpath,mkdir,rm,lstat }=await import('node:fs/promises');
  const { createHash }=await import('node:crypto');
  const { OrchestrationController }=await import('../../packages/orchestration/controller.js');
  const { LocalRuntimeAdapter }=await import('../../packages/runtime/index.js');
  const f=fixture(),data=join(f.root,'data'),root=join(f.root,'managed'),runtime=new LocalRuntimeAdapter(f.store,data);
  const controller=new OrchestrationController(f.store,data,runtime,undefined,{managedWorkspaceRoot:root});
  try{
    await mkdir(root);const leaf=join(root,createHash('sha256').update(input.commandId).digest('hex').slice(0,24));
    await symlink(f.workspace,leaf);
    await assert.rejects(controller.dispatch(input),/symbolic link/);
    await assert.rejects(controller.dispatch({...input,workspace:'/'}),/project directory/);
    assert.equal(f.store.goals.list().length,0);
    await assert.rejects(lstat(join(f.workspace,'.supervisor')),/ENOENT/);
    await rm(leaf);await mkdir(leaf);
    const x=f.store.goals.start(input,await realpath(leaf),'managed');
    const ended=f.store.goals.finish(x.session.id,x.session.jobs[0]!.id,j=>{j.usage=0;j.stopConfirmed=true;j.error='Stopped before any model turn';});
    await rm(leaf,{recursive:true});
    assert.deepEqual(await controller.dispatch(input),ended);
    await assert.rejects(lstat(leaf),/ENOENT/);
    await assert.rejects(controller.dispatch({...input,goal:'Changed goal'}),/Conflicting/);
    await assert.rejects(lstat(leaf),/ENOENT/);
    assert.equal(f.store.runtime.list().length,0);
  }finally{await controller.close();await runtime.close();f.store.close();}
});

test('P5 restoring persisted requirements never reactivates explicitly invalidated memory',async()=>{
  const { OrchestrationController }=await import('../../packages/orchestration/controller.js');
  const { LocalRuntimeAdapter }=await import('../../packages/runtime/index.js');
  const { MemoryStore }=await import('../../packages/context/index.js');
  const { setTimeout:delay }=await import('node:timers/promises');
  const f=fixture(),data=join(f.root,'data'),runtime=new LocalRuntimeAdapter(f.store,data),controller=new OrchestrationController(f.store,data,runtime);
  try{
    const x=f.store.goals.start({...input,maxContextChars:8000},f.workspace,'project');
    const ended=f.store.goals.finish(x.session.id,x.session.jobs[0]!.id,j=>{j.usage=0;j.stopConfirmed=true;j.proposal=ready(x.session.id);});
    const memory=new MemoryStore(f.workspace,x.session.projectId),ids=[x.session.messages[0]!.id,`${x.session.id}:plan`];
    const p=await memory.propose({baseVersion:0,reason:'Persist actual goal records before invalidation',changes:ids.map(id=>({type:'upsert' as const,record:{id,scope:{level:'project' as const},kind:'fact' as const,text:id===ids[0]?input.goal:JSON.stringify(ready(x.session.id)),attribution:id===ids[0]?'explicit' as const:'inferred' as const,sources:[{kind:id===ids[0]?'user' as const:'model' as const,ref:id===ids[0]?x.session.messages[0]!.id:x.session.jobs[0]!.id}],validity:{taskId:x.session.id,contractVersion:1}}}))});await memory.publish(p.id,p.digest);
    const invalid=await memory.propose({baseVersion:1,reason:'Record explicit withdrawal pending re-confirmation',changes:ids.map(id=>({type:'invalidate' as const,id,reason:'No longer valid; require a new sourced confirmation',sources:[{kind:'user' as const,ref:'withdrawal'}]}))});await memory.publish(invalid.id,invalid.digest);
    const before=await memory.read();
    await controller.dispatch({type:'restore',commandId:'restore-invalid-memory',sessionId:x.session.id,expectedRevision:ended.session.revision});
    const deadline=Date.now()+5000;
    while(f.store.goals.get(x.session.id).phase==='thinking'&&Date.now()<deadline)await delay(10);
    const after=f.store.goals.inspect(x.session.id);
    assert.equal(after.session.phase,'blocked');assert.match(after.session.error??'',/context.*capacity|reserve.*capacity/i);
    assert.deepEqual(await memory.read(),before,'Re-reading old user/model data must not silently publish it as active again');
    assert.equal(after.session.jobs.at(-1)!.modelStarted,false);assert.equal(after.session.jobs.at(-1)!.usage,0);
    assert.equal(after.session.jobs.at(-1)!.intents.length,0,'Capacity fails before a real model process; no substitute adapter was used');
  }finally{await controller.close();await runtime.close();f.store.close();}
});
