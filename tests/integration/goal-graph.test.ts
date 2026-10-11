import {validateProposal} from '../../packages/orchestration/admission.js';
import {goalProposalSchema} from '../../packages/contracts/p5.js';
import {parseReasonerOutput} from '../../packages/orchestration/reasoner-schema.js';
import {inspectDeclaredWorkspaceChanges} from '../../packages/orchestration/decomposition.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile,readFile,chmod,stat,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {RuntimeRepository} from '../../packages/persistence/runtime.js';
import {TaskSchedulerRepository} from '../../packages/persistence/task-scheduler.js';
import {TaskResultRepository} from '../../packages/persistence/task-results.js';
import {createDraftRun,applyAction} from '../../packages/domain/index.js';
import {canonical,digest} from '../../packages/verification/candidate.js';
import {admittedPlan} from '../../packages/orchestration/admission.js';
import {buildGoalGraphAdmission,compileGoalScheduledPlan} from '../../packages/orchestration/goal-graph.js';
import {prepareGraphWorkspaces,assertPreparedGraphWorkspaces,captureGraphSeed} from '../../packages/workspace/graph-workspaces.js';
import type {Run} from '../../packages/contracts/p1.js';
import type {GoalSession} from '../../packages/contracts/p5.js';
import type {GraphPreparationRequest} from '../../packages/contracts/p7-graph.js';

/** Ready proposal and 7 planning tokens are explicit repository fixtures, not an
 * actual planner/provider result. SQLite/FS/admission/scheduler/Node are real. */
async function fixture(t:TestContext,configure?:(session:GoalSession)=>void){
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-goal-graph-'))),data=join(root,'data'),workspace=join(root,'project'),host=join(root,'owned');
 await mkdir(workspace);await mkdir(host);await mkdir(join(workspace,'src'));await writeFile(join(workspace,'src','seed.mjs'),'export const initial = true;\n');await writeFile(join(workspace,'check.sh'),'#!/bin/sh\nexit 0\n');await chmod(join(workspace,'check.sh'),0o755);
 const store=new SupervisorStore(data),db=new DatabaseSync(join(data,'supervisor.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');const runtimeRepo=new RuntimeRepository(db),scheduler=new TaskSchedulerRepository(db,data),results=new TaskResultRepository(db,data);
 t.after(async()=>{db.close();store.close();await rm(root,{recursive:true,force:true});});
 const goal='Implement sum and double. Preserve every requirement and check.';
 const session:GoalSession={id:'graph-run',projectId:'graph-project',workspace,workspaceKind:'project',revision:1,goal,phase:'ready',messages:[{id:'user-original',role:'user',text:goal,createdAt:'2026-10-01T00:00:00.000Z'}],jobs:[],proposal:{decision:'ready',summary:'Explicit component proposal fixture',questions:[],facts:[{text:goal,sourceId:'user-original',origin:'explicit'}],constraints:['Use exact named exports.'],style:['Retain executable checks.'],criteria:[{id:'sum',description:'Export sum(a,b)',kind:'command',target:'math.test.mjs',checks:['Check positive, negative, and zero addition.']},{id:'double',description:'Export double(x)',kind:'command',target:'math.test.mjs',checks:['Check positive, negative, and zero doubling.']}],steps:[{id:'double-tests',description:'Implement doubling and its checks',dependencies:['sum-module'],acceptanceIds:['double']},{id:'sum-module',description:'Implement sum and its checks',dependencies:[],acceptanceIds:['sum']},{id:'documentation',description:'Document both required APIs',dependencies:[],acceptanceIds:['sum','double']}]},runtimeId:null,error:null,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',config:{model:'explicit-no-provider-fixture',effort:'low',reservation:20,timeoutMs:10000},maxContextChars:100000};
 configure?.(session);
 let baseRun=createDraftRun({id:session.id,projectId:session.projectId,goal,budget:{limit:200,verificationReserve:30}});
 for(const action of [{type:'startAttempt',attemptId:'planning-fixture',nodeId:'@supervisor',contractVersion:1,purpose:'reasoning',reservation:20,resources:[]},{type:'setOperation',operationId:'planning-fixture',attemptId:'planning-fixture',status:'pending'},{type:'finishAttempt',attemptId:'planning-fixture',outcome:'succeeded'},{type:'settleAttempt',attemptId:'planning-fixture',actual:7},{type:'setOperation',operationId:'planning-fixture',attemptId:'planning-fixture',status:'confirmed'}] as const)baseRun=applyAction(baseRun,{...action,...(action.type==='startAttempt'?{resources:[]}: {})} as Parameters<typeof applyAction>[1]).run;
 const admission=buildGoalGraphAdmission(session,baseRun),admitted=applyAction(baseRun,{type:'admit',contract:admission.contract,nodes:[{id:admission.integrationStep.id,dependencies:[],required:true}]}).run;
 db.prepare('INSERT INTO projects(id,name) VALUES(?,?)').run(session.projectId,'Explicit graph fixture');db.prepare('INSERT INTO runs(project_id,id,revision,snapshot) VALUES(?,?,?,?)').run(admitted.projectId,admitted.id,admitted.revision,canonical(admitted));
 const runtime=runtimeRepo.adoptGoal({type:'submit',commandId:'anchor',workspace,workspaceKind:'project',goal:admission.contract.goal,tokenLimit:admitted.budget.limit,verificationReserve:admitted.budget.verificationReserve,steps:[admission.integrationStep]},session.projectId,session.id);
 const seed=await captureGraphSeed(workspace,join(root,'seed-snapshot'));
 const request:GraphPreparationRequest={schemaVersion:1,commandId:'prepare',admissionDigest:admission.digest,projectId:session.projectId,runId:session.id,taskIds:admission.implementationSteps.map(s=>s.id),seed};
 const preparation=await prepareGraphWorkspaces(host,request),policy={schedulerId:'graph',preparationRoot:host,tier:'low' as const,limits:{maxActive:3,maxNodes:10,maxDepth:1,deadlineMs:Date.now()+120000}};
 const run=()=>JSON.parse(String(db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(session.projectId,session.id)!.snapshot)) as Run;
 const input={session,baseRun,run:run(),runtime,admission,preparation,policy},plan=await compileGoalScheduledPlan(input);
 results.initializeScope({commandId:'results',projectId:session.projectId,runId:session.id});
 const install=()=>scheduler.install({commandId:'install',plan,expectedRunRevision:run().revision,expectedResultRevision:results.inspect(plan).revision});
 return {root,data,workspace,host,store,db,runtimeRepo,scheduler,results,session,baseRun,admission,runtime,request,preparation,policy,run,input,plan,install};
}

test('P7-GRAPH-I01 exact original requirements refs and dependency coverage compile into actual SQLite scheduler without a new planning fee',async t=>{
 const f=await fixture(t),original=admittedPlan(f.session,f.baseRun),before=f.run();
 assert.deepEqual(f.admission.contract,original.contract);assert.deepEqual(f.admission.implementationSteps,original.steps);
 for(const value of [canonical(original.contract),canonical(f.session.messages),canonical(f.session.proposal!.steps),canonical({criteria:f.session.proposal!.criteria,constraints:f.session.proposal!.constraints,style:f.session.proposal!.style})])assert.ok(f.admission.integrationStep.prompt.includes(value));
 assert.deepEqual(f.plan.tasks.map(x=>x.node.id),['sum-module','double-tests','documentation']);assert.deepEqual(f.plan.tasks.map(x=>x.node.dependencies),[[],['sum-module'],['double-tests']]);
 for(const task of f.plan.tasks){const old=f.session.proposal!.steps.find(s=>s.id===task.node.id)!;assert.ok(old.dependencies.every(id=>task.node.dependencies.includes(id)));assert.deepEqual(task.node.admission.requirementRefs,old.acceptanceIds);assert.equal(task.node.required,true);assert.equal(task.step.model,f.session.config.model);}
 f.install();assert.deepEqual(f.run().contract,before.contract);assert.deepEqual(f.run().budget,before.budget);assert.deepEqual(f.run().attempts,before.attempts);assert.equal(f.run().budget.spent,7);assert.deepEqual(f.run().nodes.at(-1)!.dependencies,f.plan.tasks.map(t=>t.node.id));
 assert.equal(f.runtimeRepo.claim(f.runtime.id,'main-worker'),null);
 const a=f.scheduler.claim({commandId:'claim-a',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),owner:'worker'});assert.equal(a.kind,'claimed');if(a.kind==='claimed'){assert.equal(a.claim.taskId,'sum-module');assert.equal(a.claim.runId,f.baseRun.id);assert.equal(a.claim.reservation,20);}
 const b=f.scheduler.claim({commandId:'wait-b',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),owner:'worker'});assert.equal(b.kind,'waiting');assert.equal(f.scheduler.claims(f.plan.id).length,1);assert.equal(f.run().attempts.filter(a=>a.purpose==='reasoning').length,1);assert.throws(()=>f.scheduler.releaseIntegration({commandId:'not-delivered',id:f.plan.id,expected:f.scheduler.expected(f.plan.id)}));assert.equal(f.run().artifact,null);assert.equal(f.run().evidence.length,0);
});

test('P7-GRAPH-I02 preparation copies real complete bytes and executable modes and rejects source copy or receipt tampering',async t=>{
 const f=await fixture(t);for(const w of f.preparation.workspaces){assert.equal(await readFile(join(w.path,'src','seed.mjs'),'utf8'),'export const initial = true;\n');assert.equal((await stat(join(w.path,'check.sh'))).mode&0o111,0o111);}
 const other=join(f.root,'other-owned');await mkdir(other);await assert.rejects(async()=>compileGoalScheduledPlan({...f.input,policy:{...f.policy,preparationRoot:other}}),/outside the host-owned/);
 const copy=f.preparation.workspaces[0]!.path;await chmod(join(copy,'check.sh'),0o644);await assert.rejects(async()=>compileGoalScheduledPlan(f.input),/files or modes changed/);await chmod(join(copy,'check.sh'),0o755);
 await writeFile(join(f.workspace,'src','seed.mjs'),'changed\n');await assert.rejects(async()=>compileGoalScheduledPlan(f.input),/workspace differs/);await writeFile(join(f.workspace,'src','seed.mjs'),'export const initial = true;\n');
 await writeFile(join(f.preparation.directory,'complete.json'),'{}');await assert.rejects(async()=>assertPreparedGraphWorkspaces(f.preparation,f.request,f.host),/receipt changed/);assert.equal(f.db.prepare('SELECT count(*) n FROM scheduled_records').get()!.n,0);
});

test('P7-GRAPH-I03 full preparation request is idempotent while incomplete owned staging remains blocked without deletion or false success',async t=>{
 const f=await fixture(t);assert.deepEqual(await prepareGraphWorkspaces(f.host,f.request),f.preparation);
 await assert.rejects(prepareGraphWorkspaces(f.host,{...f.request,admissionDigest:'a'.repeat(64)}),/command conflicts/);
 await unlink(join(f.preparation.directory,'complete.json'));await writeFile(join(f.preparation.directory,'operator-evidence.txt'),'retain this partial preparation');
 await assert.rejects(prepareGraphWorkspaces(f.host,f.request),/Incomplete graph preparation retained/);assert.equal(await readFile(join(f.preparation.directory,'operator-evidence.txt'),'utf8'),'retain this partial preparation');assert.equal(await readFile(join(f.preparation.directory,'intent.json'),'utf8'),canonical(f.request));assert.equal(f.db.prepare('SELECT count(*) n FROM scheduled_records').get()!.n,0);
});

test('P7-GRAPH-I04 altered contract source config refs prompt and insufficient aggregate execution budget cannot compile',async t=>{
 const f=await fixture(t),copy=()=>structuredClone(f.input);
 let x=copy();x.run.contract.criteria[0]!.description+=' weaker';await assert.rejects(async()=>compileGoalScheduledPlan(x),/Actual admitted contract/);
 x=copy();x.session.proposal!.steps[0]!.acceptanceIds=['sum'];await assert.rejects(async()=>compileGoalScheduledPlan(x),/uncovered|admission changed/);
 x=copy();x.session.config.model='model-chosen-without-host';await assert.rejects(async()=>compileGoalScheduledPlan(x),/admission changed/);
 x=copy();x.runtime=structuredClone(x.runtime);x.runtime.definition.steps[0]!.id='new-anchor';await assert.rejects(async()=>compileGoalScheduledPlan(x),/runtime anchor/);
 x=copy();x.run.budget.limit=100;x.baseRun.budget.limit=100;x.runtime.definition.tokenLimit=100;await assert.rejects(async()=>compileGoalScheduledPlan(x),/remaining same-Run execution budget/);
 x=copy();x.session.maxContextChars=100;assert.throws(()=>buildGoalGraphAdmission(x.session,x.baseRun),/context bound/);
 x=copy();x.policy.limits.maxNodes=1;await assert.rejects(async()=>compileGoalScheduledPlan(x),/Host graph limits/);assert.equal(f.run().budget.spent,7);assert.equal(f.db.prepare('SELECT count(*) n FROM scheduled_records').get()!.n,0);
});

test('P7-GRAPH-I05 real parent rollback and reopened exact prepared receipt preserve original anchor fees and retry the same frozen plan',async t=>{
 const f=await fixture(t),before=f.run();f.db.exec('BEGIN IMMEDIATE');assert.deepEqual(compileGoalScheduledPlan(f.input),f.plan);assert.equal(f.db.isTransaction,true);f.install();f.scheduler.claim({commandId:'rolled-claim',id:f.plan.id,expected:f.scheduler.expected(f.plan.id),owner:'worker'});f.db.exec('ROLLBACK');assert.deepEqual(f.run(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM scheduled_records').get()!.n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM scheduled_claims').get()!.n,0);assert.equal(f.results.inspect(f.plan).consumers.length,0);
 const reopened=new DatabaseSync(join(f.data,'supervisor.sqlite'));try{const repository=new TaskSchedulerRepository(reopened,f.data);assert.deepEqual(await prepareGraphWorkspaces(f.host,f.request),f.preparation);const command={commandId:'install',plan:f.plan,expectedRunRevision:f.run().revision,expectedResultRevision:f.results.inspect(f.plan).revision};const installed=repository.install(command);assert.deepEqual(repository.install(command),installed);assert.throws(()=>repository.install({...command,plan:{...f.plan,tier:'high'}}),/command conflict/);assert.deepEqual(f.run().contract,before.contract);assert.deepEqual(f.run().budget,before.budget);}finally{reopened.close();}
});

test('P7-GRAPH-I06 two actual Node SQLite workers race the compiled frontier and only one reservation consumer and lease commits',async t=>{
 const f=await fixture(t);f.install();const expected=f.scheduler.expected(f.plan.id),module=new URL('../../packages/persistence/task-scheduler.js',import.meta.url).href;
 const source=`import {DatabaseSync} from 'node:sqlite';import {TaskSchedulerRepository} from ${JSON.stringify(module)};const db=new DatabaseSync(${JSON.stringify(join(f.data,'supervisor.sqlite'))});db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');const repo=new TaskSchedulerRepository(db,${JSON.stringify(f.data)});process.stdin.once('data',()=>{try{console.log(JSON.stringify({ok:true,value:repo.claim({commandId:process.argv[1],id:'graph',expected:${JSON.stringify(expected)},owner:process.argv[1]})}));}catch(e){console.log(JSON.stringify({ok:false,error:String(e)}));}finally{db.close();}});console.log('READY');`;
 const launch=(id:string)=>{const child=spawn(process.execPath,['--input-type=module','-e',source,id],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());let stdout='',stderr='';child.stderr.on('data',b=>stderr+=b);const ready=new Promise<void>((resolve,reject)=>{child.stdout.on('data',b=>{stdout+=b;if(stdout.includes('READY'))resolve();});child.on('error',reject);});const done=new Promise<string>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve(stdout):reject(Error(stderr)));});return {child,ready,done};};
 const a=launch('first'),b=launch('second');await Promise.all([a.ready,b.ready]);a.child.stdin.end('go');b.child.stdin.end('go');const values=(await Promise.all([a.done,b.done])).map(s=>JSON.parse(s.trim().split('\n').at(-1)!));assert.equal(values.filter(v=>v.ok).length,1);assert.match(values.find(v=>!v.ok).error,/CAS/);assert.equal(f.scheduler.claims(f.plan.id).length,1);assert.equal(f.run().attempts.filter(a=>!a.settled).length,1);assert.equal(f.results.inspect(f.plan).consumers.length,1);assert.equal(f.scheduler.leases().filter(l=>l.state==='held').length,1);assert.equal(f.run().budget.spent,7);
});


test('P7-EXPLORE-I01 optional proposal keeps exact required core and freezes scoped supplemental work without more planning cost',async t=>{
 const f=await fixture(t,session=>{session.proposal!.exploration=[{id:'alternatives',description:'Compare optional implementation alternatives',dependencies:[],relatedCriterionIds:['sum'],reads:[{path:'src',kind:'tree'}],writes:[{path:'exploration/alternatives/report.txt',kind:'file'}],quality:'supported',value:'exploratory',qualityReason:'Existing source can be inspected',valueReason:'An optional comparison may reveal alternatives',sources:[{messageId:'user-original',quote:'Implement sum and double.'}]}];});
 const proposal=f.session.proposal!;
 parseReasonerOutput(JSON.stringify({...proposal,decomposition:null,iteration:null}),goalProposalSchema(['user-original'],'graph-exploration-v1'));
 assert.deepEqual(f.admission.contract,admittedPlan(f.session,f.baseRun).contract);
 assert.deepEqual(f.admission.implementationSteps.slice(0,-1),admittedPlan(f.session,f.baseRun).steps);
 assert.equal(f.plan.tasks.at(-1)!.node.required,false);
 assert.ok(f.plan.tasks.slice(0,-1).every(task=>task.node.required));
 assert.equal(f.plan.tasks.at(-1)!.node.admission.value,'exploratory');
 assert.equal(f.run().budget.spent,7);
 f.install();assert.equal(f.scheduler.exploration(f.plan.id).counts.optional,1);
 const task=f.plan.tasks.at(-1)!,binding=task.scopeBinding!;
 await writeFile(join(task.workspace,'outside.txt'),'actual undeclared write');
 assert.deepEqual(inspectDeclaredWorkspaceChanges(binding.seed,task.workspace,binding.declaration).violations,['outside.txt']);
 const old=structuredClone(proposal);
 for(const mutate of [(p:typeof proposal)=>p.exploration![0]!.sources[0]!.quote='not a user quote',(p:typeof proposal)=>p.exploration![0]!.id=p.steps[0]!.id,(p:typeof proposal)=>p.exploration![0]!.writes[0]!.path='src/core.mjs',(p:typeof proposal)=>p.steps[0]!.dependencies.push('alternatives')]){const changed=structuredClone(old);mutate(changed);assert.throws(()=>validateProposal(changed,f.session));}
});

test('P7-EXPLORE-I02 unknown sources native research and loops cannot gain optional authorization and legacy proposals still parse',async t=>{
 const f=await fixture(t),p=f.session.proposal!;assert.doesNotThrow(()=>validateProposal(p,f.session));
 const candidate={id:'notes',description:'Optional notes',dependencies:[],relatedCriterionIds:['sum'],reads:[],writes:[{path:'exploration/notes/readme.txt',kind:'file' as const}],quality:'uncertain' as const,value:'supported' as const,qualityReason:'Explicit uncertainty',valueReason:'A supplementary explanation',sources:[{messageId:'user-original',quote:'Implement sum'}]};
 p.exploration=[candidate];
 // Direct validator assertions use explicit proposal fixtures, never live model claims.
 const {validateExploration}=await import('../../packages/orchestration/exploration.js');
 p.iteration={} as NonNullable<typeof p.iteration>;assert.throws(()=>validateExploration(p,f.session),/iteration with exploration/);delete p.iteration;
 assert.throws(()=>validateExploration(p,{...f.session,research:{} as NonNullable<GoalSession['research']>}),/native research exploration/);
 p.exploration[0]!.relatedCriterionIds=['invented'];assert.throws(()=>validateExploration(p,f.session),/unknown criteria/);
 delete p.exploration;parseReasonerOutput(JSON.stringify(p),goalProposalSchema(['user-original']));
});
