import {resolveAuthorBundle,assertAuthorExpansionProof,AUTHOR_PATCH_PROMPT,authorPatchDigest,authorExpansionRecord} from '../../packages/orchestration/author-result-patch.js';
import {materializeAcceptanceBundle,validateAcceptanceBundle} from '../../packages/orchestration/acceptance-authoring.js';
import {setTimeout as delay} from 'node:timers/promises';
import {SupervisionReasoningRunner} from '../../packages/orchestration/supervision-reasoning.js';
import {ReasonerError,type ReasonerInput} from '../../packages/orchestration/reasoner.js';
import {authorRouteDispatch,parseAuthorRouteReceipt,assertAuthorRouteProof} from '../../packages/orchestration/author-route-binding.js';
import {expectedAuthorRouteConfig} from '../../packages/orchestration/acceptance-authoring-route.js';
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
async function capabilities(data:string,efforts=['low','high']){
 const dir=join(data,'routing-capabilities',randomUUID());mkdirSync(dir,{recursive:true});const script=join(dir,'protocol.cjs'),proofPath=join(dir,'events.jsonl'),snapshotPath=join(dir,'latest.json');
 const models=['gpt-5.6-sol','gpt-6-astra'].map(model=>({id:model,model,isDefault:model==='gpt-5.6-sol',displayName:model,inputModalities:['text'],supportedReasoningEfforts:efforts.map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'low'}));
 writeFileSync(script,`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',s=>{const r=JSON.parse(s);if(r.id===undefined)return;console.log(JSON.stringify({id:r.id,result:r.method==='initialize'?{userAgent:'synthetic-node-fixture',codexHome:'fixture',platformFamily:'unix',platformOs:'test'}:{data:${JSON.stringify(models)},nextCursor:null}}))});`);
 const save=(x:unknown)=>appendFileSync(proofPath,JSON.stringify(x)+'\n');
 const child=await spawnManagedProcess({operationId:'capabilities-'+randomUUID(),command:process.execPath,args:[script,'app-server','--stdio'],cwd:dir,timeoutMs:5000,onBeforeSpawn:intent=>save({kind:'intent',intent}),onIdentity:identity=>save({kind:'identity',identity})});
 const lines=createInterface({input:child.stdout});const adapter=new CodexAdapter({transport:{write:line=>{child.stdin.write(line);},onLine:cb=>{lines.on('line',cb);return()=>lines.off('line',cb)},onClose:cb=>{const done=()=>cb('closed');lines.on('close',done);return()=>lines.off('close',done)}},onRawEvent:save,onEvent:()=>{},requestTimeoutMs:3000});
 try{await adapter.initialize();await adapter.listModels();const value={version:'synthetic-node',schemaDigest:sha('fixture'),models:models.map(m=>({id:m.model,label:m.displayName,inputModalities:m.inputModalities,reasoningEfforts:efforts,defaultEffort:'low'})),imageInput:false,checkedAt:new Date().toISOString()};writeFileSync(snapshotPath,JSON.stringify(value));adapter.dispose();const stop=await child.terminate();await child.completion;save({kind:'stop',stop});const proofDigest=sha(readFileSync(proofPath)),snapshotDigest=sha(readFileSync(snapshotPath));const receipt={id:'routing-capabilities-'+sha(proofDigest+snapshotDigest).slice(0,24),capabilities:value,proofPath,proofDigest,snapshotPath,snapshotDigest,identity:child.identity};assert.deepEqual(readRoutingCapabilities(data,receipt),value);return receipt;}finally{adapter.dispose();await child.terminate();await child.completion;}
}
/** Synthetic protocol/accounting with actual managed Node lifecycle, never live Codex. */
function nodeAuthorTransport(hold=false,returned?:unknown){
 return {calls:0,requested:null as ReasonerInput|null,async request(input:ReasonerInput):Promise<ReasonerResult>{
  this.calls++;this.requested=input;input.assertEligible?.();await input.onTurnIntent?.();
  const value=returned??fixtureBundle((input.outputSchema as any).properties.contextDigest.const);if(!returned)(value as AcceptanceBundle).spec.obligations[0]!.id='value-check';
  const raw=JSON.stringify(value),threadId='actual-node-thread-'+input.id,turnId='actual-node-turn';
  const result:ReasonerResult={value:null,usage:null,threadId,turnId,proofFiles:[],modelStarted:true,stopConfirmed:false};
  const events=join(input.logDir,'events.jsonl'),output=join(input.logDir,'output.txt');
  const record=(kind:string,value:unknown)=>appendFileSync(events,JSON.stringify({kind,value})+'\n');
  record('reasoner-input',{id:input.id,prompt:input.prompt,outputSchema:input.outputSchema,model:input.model,effort:input.effort,timeoutMs:input.timeoutMs,absoluteDeadlineMs:input.absoluteDeadlineMs});
  record('reasoner-turn-intent',{threadId,input:[{type:'text',text:input.prompt}],model:input.model,effort:input.effort});record('reasoner-turn-started',{turn:{id:turnId}});
  const child=await spawnManagedProcess({operationId:input.id+'-synthetic-node',command:process.execPath,args:['-e',hold?'setInterval(()=>{},1000)':'console.log(process.argv[1])',raw],cwd:input.cwd,timeoutMs:Math.max(1,Math.min(input.timeoutMs,input.absoluteDeadlineMs!-Date.now())),onBeforeSpawn:i=>input.onIntent?.(i),onIdentity:i=>input.onIdentity?.(i)});
  let text='';child.stdout.on('data',c=>text+=c);const stop=await child.completion;result.stopConfirmed=stop.stopped;assert.equal((await inspectProcess(child.identity)).status,'stopped');record('process-stop',{result:stop});
  result.proofFiles=[events];
  if(hold)throw new ReasonerError('Explicit synthetic deadline without authoritative usage',result);
  const actual=JSON.parse(text);writeFileSync(output,JSON.stringify(actual));result.value=parseFinalReasonerOutput(JSON.stringify(actual),input.outputSchema,result);result.usage=7;
  record('codex-event',{method:'turn/completed',threadId,raw:{method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{type:'agentMessage',text:JSON.stringify(actual)}]}}}});
  const path=join(input.logDir,'result.json');writeFileSync(path,JSON.stringify(result));result.proofFiles.push(output,path);await input.onUsage?.(7);return result;
 }};
}
async function fixture(t:TestContext,options:{limit?:number;calls?:number;kind?:string;capacity?:boolean;largeFeedback?:boolean;durationMs?:number;efforts?:string[]}={}){
 const root=realpathSync(mkdtempSync('/tmp/sv-author-route-component-')),workspace=join(root,'workspace'),data=join(root,'data');mkdirSync(workspace);
 const context=fixtureContext();for(const file of context.candidate.files){writeFileSync(join(workspace,file.path),file.content);}
 let store=new SupervisorStore(data);const runtime=store.runtime.submit({type:'submit',commandId:'workflow',workspace,workspaceKind:'project',goal:'Fixture original requirement contract',tokenLimit:options.limit??200,verificationReserve:20,steps:[{id:'input',kind:'input',prompt:'Fixture input'}]});
 store.runtime.revise({commandId:'revise',runtimeId:runtime.id,expectedContractVersion:1,contract:context.contract,nodes:[{id:'input',required:true,dependencies:[]}],steps:[{id:'input',kind:'input',prompt:'Fixture input'}],reason:'Explicit mechanism fixture, not live implementation'});
 store.runtime.control({type:'input',commandId:'input',runtimeId:runtime.id,stepId:'input',text:'Ready'});const operation=store.runtime.claim(runtime.id,'fixture')!;store.runtime.report(operation.id,'fixture',{messageId:'report',outcome:'confirmed',result:'Ready'});
 const candidate=await captureCandidate(workspace,join(data,'candidate'));context.candidate.workspace=workspace;context.candidate.digest=candidate.digest;
 const config={model:'gpt-5.6-sol',effort:'low',reservation:30,timeoutMs:5000};const loop=store.supervision.attach({commandId:'attach',runtimeId:runtime.id,config,limits:{maxRepairs:1,maxReasoningCalls:options.calls??3,maxDurationMs:options.durationMs??120000,maxContextChars:options.capacity?canonical({prompt:buildAcceptanceAuthoringPrompt(context),outputSchema:acceptanceAuthoringSchema(context),context:{acceptance:context,candidate}}).length+6001:200000}});
 let db=new DatabaseSync(join(data,'supervisor.sqlite'));let repo=new AuthorRoutingRepository(db,data);
 async function create(kind='schema', existing?:SupervisionJob){
  let input={prompt:buildAcceptanceAuthoringPrompt(context),outputSchema:acceptanceAuthoringSchema(context),context:{acceptance:context,candidate}};
  const rawValue=fixtureBundle((input.outputSchema as any).properties.contextDigest.const);
  if(options.largeFeedback)rawValue.verifierFiles[0]!.content+='// Complete rejected fixture source retained.\n'.repeat(1500);
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
 return {root,data,workspace,runtime,loop,old,context,create,get store(){return store},get repo(){return repo},get db(){return db},reopen(){db.close();store.close();store=new SupervisorStore(data);db=new DatabaseSync(join(data,'supervisor.sqlite'));repo=new AuthorRoutingRepository(db,data);},async request(){return {commandId:'recover',loopId:loop.id,previousJobId:old.id,expectedRevision:store.supervision.get(loop.id).revision,rejection:await repo.assess(loop.id,old.id),capabilities:await capabilities(data,options.efforts)}}};
}
test('schema rejection: actual stopped Node, SQLite rollback, bounded route and reopen preserve old fees and exact receipt',async t=>{
 const f=await fixture(t),request=await f.request(),before=f.store.runtime.inspect(f.runtime.id),old=f.db.prepare('SELECT record FROM supervision_jobs WHERE id=?').get(f.old.id)!.record;
 assert.equal(request.rejection.kind,'schema');assert.throws(()=>f.repo.transaction(()=>{f.repo.begin(request);throw Error('parent rollback')}),/parent rollback/);assert.equal(f.repo.routes(f.loop.id).length,0);assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);
 const next=f.repo.begin(request);assert.equal(next.job.config.model,'gpt-6-astra');assert.equal(next.job.config.effort,'high');assert.equal(next.job.config.reservation,f.old.config.reservation);assert.equal(next.job.config.timeoutMs,f.old.config.timeoutMs);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,7);assert.equal(f.db.prepare('SELECT record FROM supervision_jobs WHERE id=?').get(f.old.id)!.record,old);assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,2);
 f.reopen();assert.deepEqual(f.repo.begin(request),next);assert.deepEqual(f.repo.beginV2(request),next);assert.equal(f.store.supervision.jobs(f.loop.id).length,2);assert.throws(()=>f.repo.begin({...request,expectedRevision:request.expectedRevision+1}),/Conflicting/);assert.throws(()=>f.db.prepare('DELETE FROM supervision_author_routes').run(),/Immutable/);
 const v2=await fixture(t,{efforts:['low','medium','high']}),r=await v2.request(),beforeV2=v2.store.runtime.inspect(v2.runtime.id);
 assert.throws(()=>v2.repo.transaction(()=>{v2.repo.beginV2(r);throw Error('v2 parent rollback')}),/v2 parent rollback/);
 assert.deepEqual(v2.store.runtime.inspect(v2.runtime.id),beforeV2);assert.equal(v2.repo.routes(v2.loop.id).length,0);
 const routed=v2.repo.beginV2(r);assert.equal(routed.receipt.schemaVersion,2);assert.equal(routed.job.config.effort,'medium');
 assert.deepEqual((routed.job.input as any).context.authorPresentation,{schemaVersion:4,kind:'acceptance-recovery'});
 assert.deepEqual((routed.job.input as any).context.authorFeedback.rejection.raw,r.rejection.raw);
 assert.deepEqual((routed.job.input as any).context.acceptance,v2.context);
 assert.match(authorWireInput(routed.job.input as any,'acceptance-authoring').prompt,/never a case ID/);

 assert.deepEqual(routed.job.config,expectedAuthorRouteConfig(routed.receipt));assert.equal(routed.job.config.reservation,v2.old.config.reservation);
 assert.equal(v2.store.runtime.inspect(v2.runtime.id).run.budget.spent,7);
 for(const version of [null,false,0,3])assert.throws(()=>parseAuthorRouteReceipt({...routed.receipt,schemaVersion:version}),/Unknown/);
 v2.reopen();assert.deepEqual(v2.repo.beginV2(r),routed);assert.deepEqual(v2.repo.begin(r),routed);
 const oldBytes=canonical(v2.store.supervision.job(v2.old.id));
 const transport=nodeAuthorTransport(),runner=new SupervisionReasoningRunner(v2.store,v2.data,transport);
 const done=await runner.run(routed.job.id);assert.equal(done.usage,7);assert.equal(done.stopConfirmed,true);assert.equal(transport.calls,1);
 assert.deepEqual(done.config,routed.job.config);assert.ok(transport.requested!.absoluteDeadlineMs);assert.ok(transport.requested!.timeoutMs<=done.config.timeoutMs);
 assertAuthorRouteProof(routed.receipt,done,join(v2.data,'supervision-reasoning',sha(done.id)));
 assert.equal(canonical(v2.store.supervision.job(v2.old.id)),oldBytes);
 await runner.close();v2.reopen();const restored=new SupervisionReasoningRunner(v2.store,v2.data,transport);await restored.run(done.id);assert.equal(transport.calls,1);await restored.close();
});
test('semantic rejection uses the exact schema-valid raw bundle and never returns approved assets',async t=>{
 const f=await fixture(t,{kind:'semantic'}),request=await f.request();assert.equal(request.rejection.kind,'semantic');assert.equal(f.old.error,null);assert.match(request.rejection.message,/unknown obligation/);
 const old=String(f.db.prepare('SELECT record FROM supervision_jobs WHERE id=?').get(f.old.id)!.record);
 const patch={protocol:'acceptance-replace-v1',baseJobId:f.old.id,baseResultDigest:authorPatchDigest(f.old.result),replacements:[{path:'/spec/obligations/0/id',replacementJSON:JSON.stringify('value-check')}]};
 const transport=nodeAuthorTransport(false,patch),runner=new SupervisionReasoningRunner(f.store,f.data,transport);await runner.initialize();
 const result=f.repo.beginV2(request);assert.equal(result.job.result,null);assert.deepEqual(f.store.runtime.inspect(f.runtime.id).run.contract,f.context.contract);
 const input=result.job.input as any;assert.equal(input.prompt,AUTHOR_PATCH_PROMPT);assert.deepEqual(input.context.authorFeedback.rejection.raw,f.old.result);
 assert.equal(JSON.stringify(input).split(JSON.stringify((f.old.result as AcceptanceBundle).verifierFiles[0]!.content)).length,2,'Original complete checker stored once');
 try{const done=await runner.run(result.job.id);assert.deepEqual(done.result,patch);assert.equal(done.error,null);assert.equal(done.usage,7);assert.equal(done.stopConfirmed,true);
  const resolved=resolveAuthorBundle(done,id=>f.store.supervision.job(id),f.data);assert.ok(resolved.receipt);assert.equal(validateAcceptanceBundle(resolved.bundle,f.context).spec.obligations[0]!.id,'value-check');
  assert.deepEqual(JSON.parse(readFileSync(join(f.data,'supervision-reasoning',sha(done.id),'output.txt'),'utf8')),patch);
  assertAuthorExpansionProof(done,id=>f.store.supervision.job(id),f.data);
  // Pure derived-input negatives; never change the actual job, archive or receipt.
  const invalid={...done,result:{...patch,replacements:[{path:'/contextDigest',replacementJSON:'"unchanged-is-still-forbidden"'}]}};
  assert.equal(authorExpansionRecord(invalid,id=>f.store.supervision.job(id),f.data)!.kind,'acceptance-patch-expansion-rejected');
  assert.throws(()=>resolveAuthorBundle(invalid,id=>f.store.supervision.job(id),f.data),/contextDigest/);
  const stale=structuredClone(done) as any;stale.input.context.authorPatch.base.jobDigest='0'.repeat(64);
  assert.throws(()=>resolveAuthorBundle(stale,id=>f.store.supervision.job(id),f.data),/stale actual base/);
  assert.deepEqual(f.store.supervision.job(done.id).result,patch);

  const assets=await materializeAcceptanceBundle({privateRoot:join(f.data,'supervision','authoring'),jobId:done.id,context:f.context,bundle:resolved.bundle});assert.equal(assets.status,'proposed');
  assert.equal(f.store.verification.list('proposal').length,0,'Expanded assets alone grant no P4 proposal or approval');
  assert.equal(String(f.db.prepare('SELECT record FROM supervision_jobs WHERE id=?').get(f.old.id)!.record),old);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,14);
 }finally{await runner.close();}
 f.reopen();assert.deepEqual(f.repo.beginV2(request),{receipt:result.receipt,job:f.store.supervision.job(result.job.id)});
 const recovered=new SupervisionReasoningRunner(f.store,f.data,transport);await recovered.initialize();try{const reread=await recovered.run(result.job.id);assert.deepEqual(reread.result,patch);assert.equal(transport.calls,1);assertAuthorExpansionProof(reread,id=>f.store.supervision.job(id),f.data);}finally{await recovered.close();}
});
test('tampered raw proof, changed candidate and forged advertised models cannot reserve replacement',async t=>{const f=await fixture(t),request=await f.request();const forged=structuredClone(request);forged.capabilities.capabilities.models.push({id:'gpt-6.1-sol',label:'forged',inputModalities:['text'],reasoningEfforts:['high'],defaultEffort:'high'});assert.throws(()=>f.repo.begin(forged),/snapshot changed/);appendFileSync(request.rejection.rawOutputPath,' ');assert.throws(()=>f.repo.begin(request),/proof changed/);assert.equal(f.repo.routes(f.loop.id).length,0);writeFileSync(request.rejection.rawOutputPath,JSON.stringify(request.rejection.raw));writeFileSync(join(f.workspace,'value.mjs'),'changed');assert.throws(()=>f.repo.begin(request),/candidate changed/);});
test('transport failure and unknown usage remain blocked rather than typed author recovery',async t=>{for(const kind of ['transport','unknown']){const f=await fixture(t,{kind});await assert.rejects(f.repo.assess(f.loop.id,f.old.id),kind==='transport'?/not completed/:/unresolved/);assert.equal(f.repo.routes(f.loop.id).length,0);assert.equal(f.store.supervision.jobs(f.loop.id).length,1);}
 // Prepare all actual prior-author/capability evidence before entering the
 // short dispatch window. This fixture's original absolute deadline never moves.
 const timed=await fixture(t,{durationMs:30000,efforts:['low','medium','high']}),r=await timed.request();
 const timedLoop=timed.store.supervision.get(timed.loop.id);
 const timedDeadline=Date.parse(timedLoop.createdAt)+timedLoop.limits.maxDurationMs;
 t.diagnostic('V2 timed fixture prepared: '+JSON.stringify({at:Date.now(),deadline:timedDeadline}));
 assert.ok(timedDeadline-Date.now()>4000,'Actual fixture preparation exhausted the dispatch window');
 await delay(timedDeadline-Date.now()-4000);
 const remainingBeforeBegin=timedDeadline-Date.now();
 t.diagnostic('V2 timed fixture begin: '+JSON.stringify({at:Date.now(),remainingBeforeBegin}));
 assert.ok(remainingBeforeBegin>=1000&&remainingBeforeBegin<timed.old.config.timeoutMs,'Actual dispatch window is outside original config bounds');
 const next=timed.repo.beginV2(r);
 if(next.receipt.schemaVersion!==2)assert.fail('Expected V2 author route');
 assert.equal(next.receipt.authorization.absoluteDeadlineMs,timedDeadline);
 assert.equal(next.job.config.timeoutMs,Math.min(timed.old.config.timeoutMs,timedDeadline-Date.parse(next.receipt.authorization.observedAt)));
 assert.ok(next.job.config.timeoutMs>=1000);
 assert.equal(next.receipt.schemaVersion,2);assert.ok(next.job.config.timeoutMs<timed.old.config.timeoutMs);
 const transport=nodeAuthorTransport(true),runner=new SupervisionReasoningRunner(timed.store,timed.data,transport);
 await assert.rejects(runner.run(next.job.id));const failed=timed.store.supervision.job(next.job.id);
 assert.equal(transport.calls,1);assert.equal(failed.modelStarted,true);assert.equal(failed.stopConfirmed,true);assert.equal(failed.usage,null);
 assert.equal(failed.identities.length,1);assert.equal(failed.intents.length,1);
 assert.equal((await inspectProcess(failed.identities[0]!)).status,'stopped');
 assert.equal(transport.requested!.absoluteDeadlineMs,timedDeadline);
 assert.ok(transport.requested!.timeoutMs<=next.job.config.timeoutMs);
 assert.ok(Date.now()>=timedDeadline,'Silent Node must reach the actual original deadline');
 t.diagnostic('V2 timed fixture stopped: '+JSON.stringify({at:Date.now(),deadline:timedDeadline,usage:failed.usage,identities:failed.identities.length}));
 assert.deepEqual(failed.config,next.job.config);const accounting=canonical(timed.store.runtime.inspect(timed.runtime.id).run.budget);
 assert.equal(timed.store.runtime.inspect(timed.runtime.id).run.attempts.find(a=>a.id===failed.id)!.settled,false);
 await runner.close();timed.reopen();const restored=new SupervisionReasoningRunner(timed.store,timed.data,transport);await restored.initialize();
 await assert.rejects(restored.run(failed.id));assert.equal(transport.calls,1);assert.equal(canonical(timed.store.runtime.inspect(timed.runtime.id).run.budget),accounting);
 await assert.rejects(timed.repo.assess(timed.loop.id,failed.id),/exhausted|unresolved/);await restored.close();
 const expired=await fixture(t,{durationMs:30000}),expiredRequest=await expired.request();
 const expiredLoop=expired.store.supervision.get(expired.loop.id);
 const expiredDeadline=Date.parse(expiredLoop.createdAt)+expiredLoop.limits.maxDurationMs;
 t.diagnostic('V2 expiry fixture prepared: '+JSON.stringify({at:Date.now(),deadline:expiredDeadline}));
 assert.ok(Date.now()<expiredDeadline,'Actual fixture preparation already exhausted the expiry boundary');
 await delay(expiredDeadline-Date.now()+10);
 assert.ok(Date.now()>=expiredDeadline,'Actual original expiry boundary has not elapsed');
 const beforeExpiry=expired.store.runtime.inspect(expired.runtime.id);assert.throws(()=>expired.repo.beginV2(expiredRequest),/duration exhausted/);
 assert.deepEqual(expired.store.runtime.inspect(expired.runtime.id),beforeExpiry);assert.equal(expired.repo.routes(expired.loop.id).length,0);
});
test('second rejected output is retained and cannot start a third author; pause cannot reserve',async t=>{const f=await fixture(t),request=await f.request();const l=f.store.supervision.get(f.loop.id);f.store.supervision.update(l.id,l.revision,{paused:true});assert.throws(()=>f.repo.begin(request),/disabled/);const paused=f.store.supervision.get(f.loop.id);f.store.supervision.update(paused.id,paused.revision,{paused:false});const current={...request,expectedRevision:f.store.supervision.get(f.loop.id).revision};const next=f.repo.begin(current);await f.create('schema',next.job);await assert.rejects(f.repo.assess(f.loop.id,next.job.id),/replacement limit/);assert.equal(f.store.supervision.jobs(f.loop.id).length,2);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,14);});
test('complete JSON schema errors get typed markers; malformed JSON and exhausted calls cannot be reclassified',async t=>{const result:ReasonerResult={value:null,usage:0,threadId:null,turnId:null,proofFiles:[],stopConfirmed:true,modelStarted:false};assert.throws(()=>parseFinalReasonerOutput('{',{type:'object'},result));assert.equal(result.outputRejection,undefined);const f=await fixture(t,{calls:1}),request=await f.request();assert.throws(()=>f.repo.begin(request),/reasoning limit/);assert.equal(f.repo.routes(f.loop.id).length,0);assert.equal(f.store.supervision.jobs(f.loop.id).length,1);});

test('protected shared balance and full recovery context limits fail without a new reservation',async t=>{
 const f=await fixture(t),request=await f.request(),run=f.store.runtime.inspect(f.runtime.id).run;
 f.store.runtime.setFutureVerification({commandId:'all-protected',runtimeId:f.runtime.id,expectedContractVersion:run.contract.version,expectedRevision:run.revision,allocationId:'protect-remaining',amount:run.budget.limit-run.budget.spent,reason:'Explicit fixture protects remaining balance'});
 assert.throws(()=>f.repo.begin(request),/budget|reserve|verification/i);assert.throws(()=>f.repo.beginV2(request),/budget|reserve|verification/i);assert.equal(f.repo.routes(f.loop.id).length,0);assert.equal(f.store.supervision.jobs(f.loop.id).length,1);
 const small=await fixture(t,{capacity:true}),limited=await small.request();assert.throws(()=>small.repo.begin(limited),/Rendered author input exceeds capacity/);assert.throws(()=>small.repo.beginV2(limited),/Rendered author input exceeds capacity/);assert.equal(small.repo.routes(small.loop.id).length,0);assert.equal(small.store.supervision.jobs(small.loop.id).length,1);
 // Distinct actual rejected-output fixture exercises storage capacity, while the
 // original small fixture now reaches the independent rendered-wire ceiling.
 const large=await fixture(t,{capacity:true,largeFeedback:true}),largeRequest=await large.request(),beforeLarge=large.store.runtime.inspect(large.runtime.id);
 assert.throws(()=>large.repo.begin(largeRequest),/Author recovery exceeds complete context capacity/);assert.throws(()=>large.repo.beginV2(largeRequest),/Author recovery exceeds complete context capacity/);
 assert.deepEqual(large.store.runtime.inspect(large.runtime.id),beforeLarge);
 assert.equal(large.repo.routes(large.loop.id).length,0);assert.equal(large.store.supervision.jobs(large.loop.id).length,1);
});

test('cross-Run workspace queued or unknown effects block assess and late begin without consuming the one author replacement',async t=>{
 for(const relation of ['same','child','parent'] as const){
  const f=await fixture(t),request=await f.request(),before=f.store.runtime.inspect(f.runtime.id),count=f.store.supervision.get(f.loop.id).reasoningCount;
  const workspace=relation==='same'?f.workspace:relation==='child'?join(f.workspace,'.supervisor','foreign'):f.root;if(relation==='child')mkdirSync(workspace,{recursive:true});
  const foreign=f.store.executionCreate({type:'start',commandId:'foreign-'+relation,workspace,workspaceKind:'project',prompt:'Explicit queued P2 repository fixture; no provider called',model:'no-provider',effort:'low',reservation:20,timeoutMs:1000,tokenLimit:100,verificationReserve:20}).record;
  assert.notEqual(foreign.runId,f.old.runId);
  await assert.rejects(f.repo.assess(f.loop.id,f.old.id),/Workspace has active or unverified execution/);
  assert.throws(()=>f.repo.begin(request),/Workspace has active or unverified execution/);
  f.store.executionUpdate(foreign.id,{state:'interrupted',stopConfirmed:true},'explicit-fixture-known-stop-unknown-cost',{});
  await assert.rejects(f.repo.assess(f.loop.id,f.old.id),/Workspace execution accounting unresolved/);
  assert.throws(()=>f.repo.begin(request),/Workspace execution accounting unresolved/);
  assert.equal(f.repo.routes(f.loop.id).length,0);assert.equal(f.store.supervision.jobs(f.loop.id).length,1);assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,count);assert.deepEqual(f.store.runtime.inspect(f.runtime.id),before);
 }
});

test('overlapping actual live Node is rejected despite terminal accounting and late stopped receipts require fresh physical assessment',async t=>{
 const f=await fixture(t),stale=await f.request(),foreign=f.store.executionCreate({type:'start',commandId:'foreign-physical',workspace:f.workspace,workspaceKind:'project',prompt:'Explicit synthetic receipt with actual Node process',model:'no-provider',effort:'low',reservation:20,timeoutMs:5000,tokenLimit:100,verificationReserve:20}).record;
 const child=await spawnManagedProcess({operationId:foreign.id,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.workspace,timeoutMs:10000,onBeforeSpawn:()=>{},onIdentity:()=>{}});t.after(async()=>{await child.terminate();});
 const usage={inputTokens:1,cachedInputTokens:0,outputTokens:1,reasoningOutputTokens:0,totalTokens:2};
 f.store.executionUpdate(foreign.id,{identity:child.identity,pid:child.identity.pid,state:'completed',stopConfirmed:true,usage,usageStatus:'reported'},'explicit-synthetic-accounting-before-physical-stop',{});
 await assert.rejects(f.repo.assess(f.loop.id,f.old.id),/ledger is unsettled/);
 f.store.executionUpdate(foreign.id,{},'explicit-synthetic-settled-ledger',{},[{type:'finishAttempt',attemptId:foreign.attemptId,outcome:'succeeded'},{type:'settleAttempt',attemptId:foreign.attemptId,actual:2},{type:'setOperation',operationId:foreign.id,attemptId:foreign.attemptId,status:'confirmed'},{type:'releaseLease',attemptId:foreign.attemptId,resource:'workspace:'+f.workspace}]);
 await assert.rejects(f.repo.assess(f.loop.id,f.old.id),/not physically stopped/);
 assert.throws(()=>f.repo.begin(stale),/rejection binding changed/);assert.equal(f.repo.routes(f.loop.id).length,0);
 await child.terminate();await child.completion;
 assert.throws(()=>f.repo.begin(stale),/rejection binding changed/);
 const fresh={...stale,rejection:await f.repo.assess(f.loop.id,f.old.id)};const routed=f.repo.begin(fresh);assert.equal(routed.job.config.model,'gpt-6-astra');assert.equal(f.repo.routes(f.loop.id).length,1);assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,2);assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent,7);
});

test('nonoverlapping queued execution does not consume or block author scope and duplicate route does not allocate again',async t=>{
 const f=await fixture(t),request=await f.request(),elsewhere=join(f.root,'elsewhere');mkdirSync(elsewhere);
 f.store.executionCreate({type:'start',commandId:'foreign-unrelated',workspace:elsewhere,workspaceKind:'project',prompt:'Explicit queued unrelated workspace; no provider',model:'no-provider',effort:'low',reservation:20,timeoutMs:1000,tokenLimit:100,verificationReserve:20});
 assert.deepEqual(await f.repo.assess(f.loop.id,f.old.id),request.rejection);const result=f.repo.begin(request);assert.equal(result.job.config.model,'gpt-6-astra');assert.deepEqual(f.repo.begin(request),result);assert.equal(f.repo.routes(f.loop.id).length,1);assert.equal(f.store.supervision.get(f.loop.id).reasoningCount,2);
});
