import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {TaskSchedulerRepository} from '../../packages/persistence/task-scheduler.js';
import {TaskResultRepository} from '../../packages/persistence/task-results.js';
import {createScheduledDispatch} from '../../packages/domain/scheduled-dispatch.js';
import type {Run,Request} from '../../packages/contracts/p1.js';
import type {ScheduledPlan} from '../../packages/contracts/p7-dispatch.js';
import {readWorkbench} from '../../packages/orchestration/workbench-reader.js';
import {startService} from '../../apps/supervisor/server.js';
import {request} from '../../apps/cli/client.js';
import type {WorkbenchSnapshot} from '../../packages/contracts/p8-workbench.js';
import {projectAgentCards} from '../../apps/desktop/workbench-projection.js';
import {taskViews} from '../../apps/desktop/presentation.js';
const sha256=(s:string)=>createHash('sha256').update(s).digest('hex'),domain=createScheduledDispatch({sha256});
function canonical(value:any):string{return Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);}
// Real SQLite repositories and read protocol. Scheduled execution metadata is
// explicitly a queued repository fixture; no process/model execution or approval.
async function fixture(t:TestContext){
 const root=await realpath(await mkdtemp('/tmp/sv-wb-')),data=join(root,'data');await mkdir(data);const store=new SupervisorStore(data),db=new DatabaseSync(join(data,'supervisor.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');const repository=new TaskSchedulerRepository(db,data),results=new TaskResultRepository(db,data);
 t.after(async()=>{db.close();store.close();await rm(root,{recursive:true,force:true});});
 const workspace=join(root,'integration');await mkdir(workspace);const runtime=store.runtime.submit({type:'submit',commandId:'original',workspace,workspaceKind:'project',goal:'Same required criterion',tokenLimit:100,verificationReserve:30,steps:[{id:'integrate',kind:'codex',prompt:'Integrate after branches',model:'mechanism-no-model',effort:'low',reservation:10,timeoutMs:10000}]});
 results.initializeScope({commandId:'results',projectId:runtime.projectId,runId:runtime.runId});
 const run=()=>JSON.parse(String(db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(runtime.projectId,runtime.runId)!.snapshot)) as Run;
 const required=run().contract.criteria.filter(c=>c.required).map(c=>c.id);assert.ok(required.length);
 const plan:ScheduledPlan={schemaVersion:1,engine:'scheduled-v1',workflowVersion:2,id:'scheduled',runtimeId:runtime.id,projectId:runtime.projectId,runId:runtime.runId,revision:1,contractVersion:run().contract.version,contractDigest:domain.digest(run().contract),integrationNodeId:'integrate',tasks:[],tier:'low',loops:[],limits:{maxActive:2,maxNodes:10,maxDepth:3,deadlineMs:Date.now()+100000}};
 for(const id of ['A','B','C']){const workspace=join(root,id);await mkdir(workspace);plan.tasks.push({node:{id,dependencies:[],required:true,admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:required,quality:'strong',value:'strong',reasons:['Frozen same contract decomposition']},resources:[{kind:'path',key:workspace,mode:'write'}],reservation:20,loopIds:[]},inputRequirements:[],step:{id,kind:'codex',prompt:'Mechanism only no model invoked',model:'mechanism-no-model',effort:'low',reservation:20,timeoutMs:10000},workspace,workspaceKind:'project',generation:1});}
 const install=(p=plan)=>repository.install({commandId:'install',plan:p,expectedRunRevision:run().revision,expectedResultRevision:results.inspect(p).revision});
 const claim=(commandId='claim',owner='owner')=>repository.claim({commandId,id:plan.id,expected:repository.expected(plan.id),owner});
 return {root,data,store,db,repository,results,run,plan,install,claim};
}

test('P8-WBENCH-I01 immutable real scheduler plan and queued execution project under parent without read-side mutations',async t=>{
 const f=await fixture(t);f.install();const result=f.claim();assert.equal(result.kind,'claimed');if(result.kind!=='claimed')throw Error('fixture claim failed');
 const c=result.claim;f.store.executionCreate({...f.repository.executionInput(c.id),workspace:c.workspace},{schedulerId:c.schedulerId,claimId:c.id,operationId:c.operationId,owner:c.owner,projectId:c.projectId,runId:c.runId,attemptId:c.attemptId,planRevision:c.planRevision,generation:c.generation});
 const runtime=f.store.runtime.get(f.plan.runtimeId),before=f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>[row.name,f.db.prepare('SELECT count(*) n FROM '+String(row.name)).get()!.n]);const runBefore=f.run(),claims=f.repository.claims(f.plan.id),ledger=f.results.inspect(f.plan);
 const snapshot=await readWorkbench(f.store,{type:'read',projectPath:runtime.workspace});assert.equal(snapshot.parents.length,1);assert.equal(snapshot.parents[0]!.scheduler!.record.plan.tasks.length,3);assert.equal(snapshot.parents[0]!.results!.revision,ledger.revision);
 const parents=taskViews([runtime],[]),cards=projectAgentCards(runtime.workspace,parents,f.store.executionList(),snapshot,'online');assert.equal(cards.length,3);assert.equal(cards.filter(card=>card.execution).length,1);assert.equal(cards.find(card=>card.execution)!.taskId,c.taskId);assert.ok(cards.filter(card=>!card.execution).every(card=>/尚未领取/.test(card.status)));assert.ok(!parents.some(p=>p.workspace===c.workspace),'Child isolated workspace cannot become a user project');
 assert.deepEqual(f.run(),runBefore);assert.deepEqual(f.repository.claims(f.plan.id),claims);assert.deepEqual(f.results.inspect(f.plan),ledger);assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>[row.name,f.db.prepare('SELECT count(*) n FROM '+String(row.name)).get()!.n]),before);
 const foreign=await realpath(await mkdtemp('/tmp/sv-wb-other-'));t.after(()=>rm(foreign,{recursive:true,force:true}));assert.equal((await readWorkbench(f.store,{type:'read',projectPath:foreign})).parents.length,0);assert.equal(projectAgentCards(foreign,parents,f.store.executionList(),snapshot,'online').length,0);
 await assert.rejects(readWorkbench(f.store,{type:'read',projectPath:runtime.workspace,approved:true}),/Invalid/);
});
test('P8-WBENCH-I02 actual typed Unix service read rejects extra fields and missing directory without creating tasks',async t=>{
 const root=await realpath(await mkdtemp('/tmp/sv-wb-service-')),data=join(root,'data'),project=join(root,'project');await mkdir(project);const service=await startService(data);t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const setup=new SupervisorStore(data);const waiting=setup.runtime.submit({type:'submit',commandId:'input-only',workspace:project,workspaceKind:'project',goal:'Real read-only service fixture',tokenLimit:100,verificationReserve:20,steps:[{id:'input',kind:'input',prompt:'No model request is authorized'}]});setup.close();
 const input:Request={id:'workbench-read',method:'workbench',action:{type:'read',projectPath:project}};const response=await request(data,input);assert.equal(response.ok,true,JSON.stringify(response));const value=response.value as WorkbenchSnapshot;assert.equal(value.project.path,project);assert.equal(value.parents.length,1);assert.equal(value.parents[0]!.runtimeId,waiting.id);assert.equal(value.parents[0]!.results,null);assert.ok(value.parents[0]!.issues.some(i=>/scope uninitialized/.test(i)));
 const extra=await request(data,{...input,id:'extra',action:{...input.action,passed:true}} as Request);assert.equal(extra.ok,false);
 const missing=await request(data,{id:'missing',method:'workbench',action:{type:'read',projectPath:join(root,'missing')}});assert.equal(missing.ok,false);
 const store=new SupervisorStore(data);try{assert.equal(store.runtime.list().length,1);assert.equal(store.executionList().length,0);assert.equal(store.scheduler.list().length,0);}finally{store.close();}
});
