import type {TestContext} from 'node:test';
import type {ReasonerResult} from '../../packages/orchestration/reasoner.js';
import type {SupervisionJob} from '../../packages/contracts/p6-supervision.js';
import type {AcceptanceAuthoringContext,AcceptanceBundle} from '../../packages/orchestration/acceptance-authoring.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {AuthorRoutingRepository} from '../../packages/persistence/author-routing.js';
import {captureCandidate} from '../../packages/verification/candidate.js';
import {runtimeCanonical as canonical} from '../../packages/persistence/runtime.js';
import {acceptanceAuthoringSchema,buildAcceptanceAuthoringPrompt} from '../../packages/orchestration/acceptance-authoring.js';
import {authorWireInput} from '../../packages/orchestration/author-presentation.js';
import {authorWireReceipt} from '../../packages/orchestration/author-presentation-proofs.js';
import {parseFinalReasonerOutput} from '../../packages/orchestration/reasoner.js';
import {spawnManagedProcess,inspectProcess} from '../../packages/process-control/index.js';
import {CodexAdapter} from '../../packages/executor-codex/index.js';
import {readRoutingCapabilities} from '../../packages/orchestration/supervision-routing-capabilities.js';
const fixtureContext=():AcceptanceAuthoringContext=>{
 const content='export const value=2;\n',checks=['Named value export equals two.'];
 const item={id:'value',description:'Export the exact value',kind:'command' as const,target:'value.mjs',checks};
 return {contract:{version:2,goal:'Explicit component fixture: retain value requirement',criteria:[{id:item.id,description:[item.description,'Acceptance kind: command; target: value.mjs',...checks].join('\n'),required:true}]},criteria:[item],candidate:{workspace:'/fixture',digest:'0'.repeat(64),files:[{path:'value.mjs',content,sha256:sha(content)}]},environment:{fixture:'synthetic accounting and model JSON'},failureContext:null,previousSpec:null};
};
const fixtureBundle=(digest:string):AcceptanceBundle=>({contextDigest:digest,spec:{schemaVersion:1,contractVersion:2,standardsVersion:'component-fixture',obligations:[{id:'value-check pred: false; rejected fixture',criterionId:'value',expectation:'Value equals two',required:true,applicable:true}],cases:[{id:'case',revision:1,status:'active',obligationIds:['value-check'],parameters:[{}],modules:['value'],replaces:[],defectRefs:[],verifier:{kind:'command',version:'fixture',entry:'check.mjs',files:['check.mjs'],timeoutMs:1000}}],controls:[{id:'good',workspace:'good',expect:'passed',mustFail:[]},{id:'bad',workspace:'bad',expect:'failed',mustFail:['value-check']}],moduleDependencies:{value:[]}},verifierFiles:[{path:'check.mjs',content:'// Explicit fixture only; no P4 review or execution claim.\n'}],controls:[{id:'good',files:[{path:'value.mjs',content:'export const value=2;\n'}]},{id:'bad',files:[{path:'value.mjs',content:'export const value=3;\n'}]}],coverageExplanation:[{criterionId:'value',check:'Named value export equals two.',caseIds:['case'],explanation:'Fixture only; independent P4 is not performed here.'}]});
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
// Synthetic JSON/model-list and 7-token accounting are explicit repository fixtures.
// Actual SQLite, process ownership/stop, files, schema parser and CodexAdapter are real.
export async function capabilities(data:string){
 const dir=join(data,'routing-capabilities',randomUUID());mkdirSync(dir,{recursive:true});const script=join(dir,'protocol.cjs'),proofPath=join(dir,'events.jsonl'),snapshotPath=join(dir,'latest.json');
 const models=['gpt-5.6-sol','gpt-6-astra'].map(model=>({id:model,model,isDefault:model==='gpt-5.6-sol',displayName:model,inputModalities:['text'],supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'},{reasoningEffort:'xhigh'}],defaultReasoningEffort:'low'}));
 writeFileSync(script,`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',s=>{const r=JSON.parse(s);if(r.id===undefined)return;console.log(JSON.stringify({id:r.id,result:r.method==='initialize'?{userAgent:'synthetic-node-fixture',codexHome:'fixture',platformFamily:'unix',platformOs:'test'}:{data:${JSON.stringify(models)},nextCursor:null}}))});`);
 const save=(x:unknown)=>appendFileSync(proofPath,JSON.stringify(x)+'\n');
 const child=await spawnManagedProcess({operationId:'capabilities-'+randomUUID(),command:process.execPath,args:[script,'app-server','--stdio'],cwd:dir,timeoutMs:5000,onBeforeSpawn:intent=>save({kind:'intent',intent}),onIdentity:identity=>save({kind:'identity',identity})});
 const lines=createInterface({input:child.stdout});const adapter=new CodexAdapter({transport:{write:line=>{child.stdin.write(line);},onLine:cb=>{lines.on('line',cb);return()=>lines.off('line',cb)},onClose:cb=>{const done=()=>cb('closed');lines.on('close',done);return()=>lines.off('close',done)}},onRawEvent:save,onEvent:()=>{},requestTimeoutMs:3000});
 try{await adapter.initialize();await adapter.listModels();const value={version:'synthetic-node',schemaDigest:sha('fixture'),models:models.map(m=>({id:m.model,label:m.displayName,inputModalities:m.inputModalities,reasoningEfforts:['low','high','xhigh'],defaultEffort:'low'})),imageInput:false,checkedAt:new Date().toISOString()};writeFileSync(snapshotPath,JSON.stringify(value));adapter.dispose();const stop=await child.terminate();await child.completion;save({kind:'stop',stop});const proofDigest=sha(readFileSync(proofPath)),snapshotDigest=sha(readFileSync(snapshotPath));const receipt={id:'routing-capabilities-'+sha(proofDigest+snapshotDigest).slice(0,24),capabilities:value,proofPath,proofDigest,snapshotPath,snapshotDigest,identity:child.identity};assert.deepEqual(readRoutingCapabilities(data,receipt),value);return receipt;}finally{adapter.dispose();await child.terminate();await child.completion;}
}
export async function fixture(t:TestContext,options:{limit?:number;calls?:number;kind?:string;capacity?:boolean}={}){
 const root=realpathSync(mkdtempSync('/tmp/sv-author-route-component-')),workspace=join(root,'workspace'),data=join(root,'data');mkdirSync(workspace);
 const context=fixtureContext();for(const file of context.candidate.files){writeFileSync(join(workspace,file.path),file.content);}
 let store=new SupervisorStore(data);const runtime=store.runtime.submit({type:'submit',commandId:'workflow',workspace,workspaceKind:'project',goal:'Fixture original requirement contract',tokenLimit:options.limit??200,verificationReserve:20,steps:[{id:'input',kind:'input',prompt:'Fixture input'}]});
 store.runtime.revise({commandId:'revise',runtimeId:runtime.id,expectedContractVersion:1,contract:context.contract,nodes:[{id:'input',required:true,dependencies:[]}],steps:[{id:'input',kind:'input',prompt:'Fixture input'}],reason:'Explicit mechanism fixture, not live implementation'});
 store.runtime.control({type:'input',commandId:'input',runtimeId:runtime.id,stepId:'input',text:'Ready'});const operation=store.runtime.claim(runtime.id,'fixture')!;store.runtime.report(operation.id,'fixture',{messageId:'report',outcome:'confirmed',result:'Ready'});
 const candidate=await captureCandidate(workspace,join(data,'candidate'));context.candidate.workspace=workspace;context.candidate.digest=candidate.digest;
 const config={model:'gpt-5.6-sol',effort:'low',reservation:30,timeoutMs:5000};const loop=store.supervision.attach({commandId:'attach',runtimeId:runtime.id,config,limits:{maxRepairs:1,maxReasoningCalls:options.calls??3,maxDurationMs:120000,maxContextChars:options.capacity?canonical({prompt:buildAcceptanceAuthoringPrompt(context),outputSchema:acceptanceAuthoringSchema(context),context:{acceptance:context,candidate}}).length+6001:200000}});
 let db=new DatabaseSync(join(data,'supervisor.sqlite'));let repo=new AuthorRoutingRepository(db,data);
 async function create(kind='schema', existing?:SupervisionJob){
  let input={prompt:buildAcceptanceAuthoringPrompt(context),outputSchema:acceptanceAuthoringSchema(context),context:{acceptance:context,candidate}};
  const rawValue=fixtureBundle((input.outputSchema as any).properties.contextDigest.const);
  if(kind==='valid'||kind==='review-valid')rawValue.spec.obligations[0]!.id='value-check';
  if(kind==='review-valid')rawValue.verifierFiles[0]!.content="import {writeFile} from 'node:fs/promises';import {join} from 'node:path';import {pathToFileURL} from 'node:url';const {value}=await import(pathToFileURL(join(process.argv[2],'value.mjs')).href),pass=value===2;await writeFile(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks:[{obligationId:'value-check',verdict:pass?'passed':'failed',reason:'Actual fixture value checked'}]}));process.exitCode=pass?0:1;";
  if(kind==='semantic')rawValue.spec.obligations[0]!.id='declared-but-not-referenced';
  if(kind==='semantic')for(let i=1;i<rawValue.spec.obligations.length;i++)rawValue.spec.obligations[i]!.id=rawValue.spec.cases[0]!.obligationIds[i]!;
  const job=existing??store.supervision.beginJob({commandId:randomUUID(),loopId:loop.id,expectedRevision:store.supervision.get(loop.id).revision,purpose:'acceptance-authoring',context:input});if(existing)input=existing.input as typeof input;
  const dir=join(data,'supervision-reasoning',sha(job.id));mkdirSync(dir,{recursive:true});const raw=JSON.stringify(rawValue),eventsPath=join(dir,'events.jsonl'),outputPath=join(dir,'output.txt');
  const save=(kind:string,value:unknown)=>appendFileSync(eventsPath,JSON.stringify({kind,value})+'\n');
  const wire=authorWireInput(input,job.purpose),wireReceipt=authorWireReceipt(job);
  if(wireReceipt)writeFileSync(join(dir,'author-wire.json'),JSON.stringify(wireReceipt));
  save('reasoner-input',{id:job.id,prompt:wire.prompt,outputSchema:input.outputSchema,model:job.config.model,effort:job.config.effort});
  store.supervision.observeJob(job.id,{modelStarted:true,observedUsage:7});
  const notification={method:'turn/completed',params:{threadId:'fixture-'+job.id,turn:{id:'turn-'+job.id,status:kind==='transport'?'failed':'completed',items:[{type:'agentMessage',text:raw}]}}};
  const child=await spawnManagedProcess({operationId:job.id+'-reasoner',command:process.execPath,args:['-e','console.log(process.argv[1])',JSON.stringify(notification)],cwd:workspace,timeoutMs:5000,onBeforeSpawn:intent=>{const current=store.supervision.job(job.id);store.supervision.observeJob(job.id,{intents:[...current.intents,intent]});},onIdentity:identity=>{const current=store.supervision.job(job.id);store.supervision.observeJob(job.id,{identities:[...current.identities,identity]});}});
  save('reasoner-turn-intent',{threadId:notification.params.threadId,input:[{type:'text',text:wire.prompt}],model:job.config.model,effort:job.config.effort});
  save('reasoner-turn-started',{turn:{id:notification.params.turn.id}});
  let stdout='';child.stdout.on('data',c=>stdout+=c);const stop=await child.completion;assert.equal((await inspectProcess(child.identity)).status,'stopped');save('process-stop',{result:stop});const actual=JSON.parse(stdout);save('codex-event',{method:actual.method,threadId:actual.params.threadId,raw:actual});writeFileSync(outputPath,actual.params.turn.items[0].text);
  const result:ReasonerResult={value:null,usage:kind==='unknown'?null:7,threadId:notification.params.threadId,turnId:notification.params.turn.id,proofFiles:[],stopConfirmed:true,modelStarted:true};let error:string|null=null;
  try{result.value=parseFinalReasonerOutput(raw,input.outputSchema,result);}catch(caught){const e=caught as Error;error=e.message;writeFileSync(join(dir,'error.json'),JSON.stringify({name:e.name,message:e.message}));}
  if(kind==='transport'){error='Explicit transport failure fixture';delete result.outputRejection;}
  if(kind==='unknown')error='Explicit unknown usage fixture';
  writeFileSync(join(dir,'result.json'),JSON.stringify(result));const proofs=Object.fromEntries(['events.jsonl','output.txt','result.json',...(wireReceipt?['author-wire.json']:[]),...(error&&kind!=='transport'?['error.json']:[])].map(name=>[join(dir,name),sha(readFileSync(join(dir,name)))]));
  const done=store.supervision.finishJob(job.id,{usage:result.usage,stopConfirmed:true,error,proofs,threadId:result.threadId,result:error?null:result.value});const l=store.supervision.get(loop.id);store.supervision.update(l.id,l.revision,{phase:'authoring',references:{authorJobId:job.id}});return done;
 }
 const old=await create(options.kind??'schema');
 t.after(()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,data,workspace,runtime,loop,old,context,create,get store(){return store},get repo(){return repo},get db(){return db},reopen(){db.close();store.close();store=new SupervisorStore(data);db=new DatabaseSync(join(data,'supervisor.sqlite'));repo=new AuthorRoutingRepository(db,data);},async request(){return {commandId:'recover',loopId:loop.id,previousJobId:old.id,expectedRevision:store.supervision.get(loop.id).revision,rejection:await repo.assess(loop.id,old.id),capabilities:await capabilities(data)}}};
}
