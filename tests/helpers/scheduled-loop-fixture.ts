import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {ScheduledLoopController} from '../../packages/runtime/scheduled-loop-advance.js';
import {ScheduledRuntimeWorker} from '../../packages/runtime/scheduled-worker.js';
import {captureGraphSeed} from '../../packages/workspace/graph-workspaces.js';
import {canonical,digest} from '../../packages/verification/candidate.js';
import {applyAction,futureExecutionFloor} from '../../packages/domain/index.js';
import type {Run} from '../../packages/contracts/p1.js';
import type {ScheduledPlan} from '../../packages/contracts/p7-dispatch.js';
import type {LoopProgramSource,LoopProgramNode} from '../../packages/contracts/p7-loop.js';
import {inspectProcess,type ProcessIdentity} from '../../packages/process-control/index.js';
export const hash=(v:unknown)=>digest(canonical(v));
/** This actual executable is an EXPLICIT SYNTHETIC protocol supplier, not Codex
 * reasoning or a paid provider. Only local --version/schema generation delegates
 * to the installed CLI. Node creates real files, reads real dependency copies,
 * emits fixed 5-token receipts; real ExecutionManager/process/DB/FS do all work. */
async function supplier(path:string){await writeFile(path,`#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),rl=require('node:readline');
const args=process.argv.slice(2);
if(args.includes('--version')||args.includes('generate-json-schema')){process.stdout.write(cp.execFileSync('codex',args));process.exit(0);}
if(args.includes('mcp')){console.log('[]');process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n'),thread='explicit-node-'+process.pid,usage={inputTokens:3,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:5};
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
 if(m.method==='initialize')return send({id:m.id,result:{userAgent:'explicit-fixture',codexHome:process.cwd(),platformFamily:'unix',platformOs:'darwin'}});
 if(m.method==='model/list')return send({id:m.id,result:{data:[{id:'node-fixture',model:'node-fixture',isDefault:true,inputModalities:['text'],supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],nextCursor:null}});
 if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:thread,turns:[]}}});
 if(m.method==='turn/interrupt')return send({id:m.id,result:{}});
 if(m.method!=='turn/start')throw Error('Unexpected protocol '+m.method);
 const text=m.params.input[0].text,config=JSON.parse(text.split('\\n\\n')[0]);send({id:m.id,result:{turn:{id:'turn',status:'inProgress',items:[]}}});
 setTimeout(()=>{let value=0;const inputs=p.join(process.cwd(),'.supervisor/task-inputs');if(fs.existsSync(inputs))for(const id of fs.readdirSync(inputs)){const root=p.join(inputs,id),index=JSON.parse(fs.readFileSync(p.join(root,'manifest.json')));for(const input of index.inputs){const f=p.join(root,input.directory,'state.json');if(fs.existsSync(f))value=Math.max(value,JSON.parse(fs.readFileSync(f)).value);}}
 if(config.task==='transform')value=config.constant?0:value+1;
 const output=config.task==='left'?'left.json':config.task==='right'?'right.json':'state.json';fs.writeFileSync(output,JSON.stringify({value}));fs.chmodSync(output,0o700);
 send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:'turn',delta:'Actual Node output; synthetic supplier accounting.'}});
 if(!config.unknown)send({method:'thread/tokenUsage/updated',params:{threadId:thread,turnId:'turn',tokenUsage:{total:usage,last:usage}}});
 send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn',status:config.fail?'failed':'completed',items:[]}}});
 },config.delay??20);
});
`,{mode:0o700});await chmod(path,0o700);}
export async function fixture(t:TestContext,mode:'normal'|'constant'|'cap'|'unknown'|'failure'='normal',shared?:{data:string;suffix:string}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-nested-'))),workspace=join(root,'integration'),data=shared?.data??join(root,'data'),binary=join(root,'explicit-node-supplier');await mkdir(workspace);await writeFile(join(workspace,'seed.txt'),'Unchanged original project bytes');await supplier(binary);
 let store=new SupervisorStore(data);const db=new DatabaseSync(join(data,'supervisor.sqlite'));db.exec('PRAGMA busy_timeout=5000');let worker:ScheduledRuntimeWorker|null=null,parallelOverlap=false;
 t.after(async()=>{await worker?.close();for(const e of store.executionList())if(e.identity&&!e.stopConfirmed){const {terminateProcess}=await import('../../packages/process-control/index.js');await terminateProcess(e.identity as ProcessIdentity);}db.close();store.close();await rm(root,{recursive:true,force:true});});
 const runtime=store.runtime.submit({type:'submit',commandId:'original'+(shared?.suffix??''),workspace,workspaceKind:'project',goal:'Transform data under bounded nested strategy then combine both reports; independent original P4 remains mandatory.',tokenLimit:1000,verificationReserve:30,steps:[{id:'integrate',kind:'codex',prompt:'Integrate all required original outputs and independently required checks.',model:'node-fixture',effort:'low',reservation:20,timeoutMs:15000}]}),scope={projectId:runtime.projectId,runId:runtime.runId};store.taskResults.initializeScope({commandId:'results'+(shared?.suffix??''),...scope});
 const run=()=>store.query({type:'run',...scope}) as Run;const op=store.runtime.operations(runtime.id)[0]!;const protectedRun=applyAction(run(),{type:'setFutureExecution',allocation:{allocationId:'final-floor',contractVersion:run().contract.version,nodeId:'integrate',attemptId:op.attemptId,amount:20},reason:'Original final runtime attempt'}).run;db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(canonical(protectedRun),protectedRun.revision,scope.projectId,scope.runId);
 const plan:ScheduledPlan={schemaVersion:1,engine:'scheduled-v1',workflowVersion:2,id:'nested'+(shared?.suffix??''),runtimeId:runtime.id,...scope,revision:1,contractVersion:run().contract.version,contractDigest:hash(run().contract),integrationNodeId:'integrate',tier:'low',loops:[],limits:{maxActive:2,maxNodes:64,maxDepth:3,deadlineMs:Date.now()+120000},tasks:[]};
 for(const id of ['seed','transform','summarize','left','right']){const branch=join(root,id);await mkdir(branch);const dependencies=id==='seed'?[]:id==='transform'?['seed']:id==='summarize'?['transform']:['summarize'];plan.tasks.push({node:{id,dependencies,required:true,admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:run().contract.criteria.filter(c=>c.required).map(c=>c.id),quality:'strong',value:'strong',reasons:['Explicit host-reviewed same-contract strategy, no product acceptance']},resources:[{kind:'path',key:branch,mode:'write'}],reservation:20,loopIds:[]},inputRequirements:dependencies.map(dependencyNodeId=>({dependencyNodeId,minimumState:'submitted'})),step:{id,kind:'codex',prompt:JSON.stringify({task:id,constant:mode==='constant',unknown:mode==='unknown'&&id==='transform',fail:mode==='failure'&&id==='transform',delay:id==='left'||id==='right'?2000:20}),model:'node-fixture',effort:'low',reservation:20,timeoutMs:15000},workspace:branch,workspaceKind:'managed',generation:1});}
 const task=(taskId:string):LoopProgramNode=>({kind:'task',id:taskId,taskId}),limits={iterations:mode==='cap'?1:5,tokens:300,nodes:20,durationMs:100000,unchangedIterations:1},tree:LoopProgramNode={kind:'sequence',id:'root-sequence',children:[task('seed'),{kind:'loop',id:'outer',limits:{...limits,tokens:600,nodes:40},until:{taskId:'summarize',path:'state.json',field:'value',atLeast:3},body:{kind:'sequence',id:'outer-body',children:[{kind:'loop',id:'inner',limits,until:{taskId:'transform',path:'state.json',field:'value',atLeast:2},body:task('transform')},task('summarize')]}},{kind:'parallel',id:'reports',children:[task('left'),task('right')]}]};
 const seed=await captureGraphSeed(workspace,join(root,'seed-snapshot')),source:LoopProgramSource={templatePlan:plan,program:{schemaVersion:1,policyVersion:'bounded-data-loop-v1',sourceDigest:hash(plan),tree},seed,preparationRoot:join(data,'loop-workspaces'),startedAtMs:Date.now()},controller=()=>new ScheduledLoopController(store);
 async function install(){return controller().install({commandId:'install-program'+(shared?.suffix??''),source,expectedRunRevision:run().revision,expectedResultRevision:store.taskResults.inspect(scope).revision});}
 function openWorker(){worker=new ScheduledRuntimeWorker(store,data,'same-owner',binary);return worker;}
 async function until(predicate:()=>boolean,timeout=80000){const deadline=Date.now()+timeout;while(!predicate()){assert.ok(Date.now()<deadline,'actual worker timeout: '+JSON.stringify({errors:worker?.errors(),state:store.scheduledLoops.inspect(plan.id),executions:store.executionList().map(e=>({id:e.id,state:e.state,error:e.error}))}));await worker!.tick();const reports=store.executionList().filter(e=>e.identity&&!e.stopConfirmed&&['left','right'].includes(JSON.parse(e.prompt.split('\n\n')[0]!).task));if(reports.length===2&&(await Promise.all(reports.map(e=>inspectProcess(e.identity as ProcessIdentity)))).every(p=>p.status==='verified'))parallelOverlap=true;await new Promise(resolve=>setTimeout(resolve,30));}}
 async function reopen(){await worker?.close();worker=null;store.close();store=new SupervisorStore(data);openWorker();await worker!.initialize();}
 return {root,data,db,workspace,binary,runtime,scope,source,plan,run,controller,install,openWorker,until,reopen,get parallelOverlap(){return parallelOverlap},get store(){return store},get worker(){return worker!}};
}
