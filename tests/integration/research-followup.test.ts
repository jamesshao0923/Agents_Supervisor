import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {researchWorkflowFixture,fixtureProposal} from '../helpers/research-workflow-fixture.js';
import {spawnManagedProcess,inspectProcess} from '../../packages/process-control/index.js';
import {parseFollowupEvolution,followupEvolutionReviewSchema} from '../../packages/orchestration/followup-evolution.js';
import {ControlQualificationRepository} from '../../packages/persistence/control-qualification.js';
import {ResearchWorkflowRepository} from '../../packages/persistence/research-workflow.js';
import {ResearchRuntimeActivity} from '../../packages/runtime/research-activity.js';
import {ExecutionManager} from '../../packages/execution/manager.js';
import {captureMaterialBinding,readMaterialBinding,materialProjectionReviewEvidence} from '../../packages/verification/material.js';
import {captureCandidate,canonical,digest,environmentFingerprint} from '../../packages/verification/candidate.js';
import {createEnvironmentScope} from '../../packages/verification/scoped-environment.js';
import {acceptanceAuthoringContextDigest,type AcceptanceAuthoringContext} from '../../packages/orchestration/acceptance-authoring.js';
import {captureControlEvolutionContext,controlEvolutionContextDigest,controlEvolutionAuthoringSchema,buildControlEvolutionAuthoringPrompt,materializeControlEvolutionBundle,type ControlEvolutionBundle} from '../../packages/orchestration/acceptance-authoring-v2.js';
import {controlSpecimenKey} from '../../packages/verification/control-bootstrap.js';
import {prepareResearchWorkflowEvolution} from '../../packages/verification/research-evolution.js';
import {RESEARCH_HOST_GATES} from '../../packages/verification/research-workflow.js';
import type {ResearchProposal} from '../../packages/contracts/p8-research.js';
import type {Proposal,VerificationJob,FrozenPlan,Delivery} from '../../packages/verification/records.js';
import type {GoalProposal} from '../../packages/contracts/p5.js';
import type {SupervisorStore} from '../../packages/persistence/store.js';
import type {TaskContract} from '../../packages/contracts/p1.js';
import type {RuntimeOperation,RuntimeRecord} from '../../packages/contracts/p3.js';

// Real SQLite, actual P5 continuation/authorization repositories, actual P2
// finalizer/materialization and P4 V2 engines/proof reader/publication/delivery.
// Planner/author/review protocol and token values are explicit synthetic fixture
// inputs. Actual managed Node processes stop; no provider semantic proof claimed.
async function hashes(root:string):Promise<Record<string,string>>{
 const values:Record<string,string>={};
 for(const entry of await readdir(root,{withFileTypes:true})){
  const path=join(root,entry.name);
  if(entry.isDirectory())Object.assign(values,await hashes(path));
  else values[path]=digest(await readFile(path));
 }
 return values;
}
async function producer(f:Awaited<ReturnType<typeof researchWorkflowFixture>>,runtime:RuntimeRecord){
 const activity=new ResearchRuntimeActivity(f.store,f.data),owner='followup-owner';
 const acquire=f.store.runtime.claim(runtime.id,owner)!;await activity.acquire(acquire,owner);
 const op=f.store.runtime.claim(runtime.id,owner)!;await activity.prepare(op.id,owner);
 const input=f.store.runtime.researchInput(op.id)!,report=fixtureProposal(input.package.context);
 report.claims.push({id:'bounded-detail',criterionIds:['detail'],kind:'fact',text:'The document describes bounded operation.',supportCitationIds:['quote'],counterCitationIds:[],limitations:[]});
 report.questions.push({criterionId:'detail',status:'proposed-answer',claimIds:['bounded-detail'],unresolved:[]});
 f.store.runtime.markStarted(op.id,owner);
 const record=f.store.executionCreate({...f.store.runtime.executionInput(op.id,owner),workspace:f.workspace,workspaceKind:'project'},f.store.runtime.binding(op.id,owner)).record;
 const child=await spawnManagedProcess({operationId:record.id,command:process.execPath,args:['-e','process.stdout.write('+JSON.stringify('Actual followup component producer process\n')+')'],cwd:f.workspace,timeoutMs:3000,
  onBeforeSpawn:intent=>{f.store.executionUpdate(record.id,{},'process-intent',intent);},
  onIdentity:identity=>{f.store.executionUpdate(record.id,{identity,pid:identity.pid},'process-identity',identity);}});
 const result=await child.completion;assert.equal(result.exitCode,0);const stop=await child.terminate();assert.equal(stop.stopped,true);
 const text=JSON.stringify(report),threadId='explicit-followup-producer-thread',turnId='explicit-followup-producer-turn';
 f.store.executionUpdate(record.id,{threadId,turnId,turnIntent:true,terminalStatus:'completed',message:text,
  usageStatus:'reported',usage:{inputTokens:5,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:7}},'explicit-synthetic-accounting',{notProvider:true});
 f.store.executionUpdate(record.id,{},'codex-event',{kind:'message',method:'item/completed',threadId,turnId,text,
  raw:{method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',text}}}});
 f.store.executionUpdate(record.id,{},'codex-event',{kind:'turn-status',method:'turn/completed',threadId,turnId,terminal:true,status:'completed',
  raw:{method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',error:null}}}});
 // Actual host processes crash after each directory rename. No model turn
 // is reissued, and no execution/usage history is rewritten during recovery.
 const entry=join(f.root,'round-crash.mjs');
 const storeURL=new URL('../../packages/persistence/store.js',import.meta.url).href;
 const activityURL=new URL('../../packages/runtime/research-activity.js',import.meta.url).href;
 await writeFile(entry,`import {SupervisorStore} from ${JSON.stringify(storeURL)};
import {ResearchRuntimeActivity} from ${JSON.stringify(activityURL)};
const [data,id,point]=process.argv.slice(2),store=new SupervisorStore(data);
const hooks=point==='preserve'?{afterPreserve:async()=>process.exit(79)}:{afterActivate:async()=>process.exit(80)};
try{await new ResearchRuntimeActivity(store,data,hooks).materialize(store.executionGet(id));throw Error('Crash hook did not fire');}finally{store.close();}`);
 const immutableBefore=canonical(f.store.executionGet(record.id));
 for(const [point,code]of [['preserve',79],['activate',80]] as const){
  const crash=await spawnManagedProcess({operationId:record.id+'-host-'+point,command:process.execPath,
   args:[entry,f.data,record.id,point],cwd:f.root,timeoutMs:30000,
   onBeforeSpawn:intent=>writeFile(join(f.root,'round-host-'+point+'-intent.json'),JSON.stringify(intent),{flag:'wx'}),
   onIdentity:identity=>writeFile(join(f.root,'round-host-'+point+'-identity.json'),JSON.stringify(identity),{flag:'wx'})});
  const outcome=await crash.completion;
  assert.equal(outcome.exitCode,code);assert.equal(outcome.stopped,true);
  assert.equal(canonical(f.store.executionGet(record.id)),immutableBefore);
 }
 const recovered=await new ResearchRuntimeActivity(f.store,f.data).materialize(f.store.executionGet(record.id));
 assert.equal(recovered.executionId,record.id);
 assert.equal(canonical(f.store.executionGet(record.id)),immutableBefore);
 await new ResearchRuntimeActivity(f.store,f.data).materialize(f.store.executionGet(record.id));
 // Pause is real host state, and a foreign edit is preserved on rejection.
 f.store.runtime.control({type:'pause',runtimeId:runtime.id,commandId:'pause-round-publication'});
 await assert.rejects(new ResearchRuntimeActivity(f.store,f.data).materialize(f.store.executionGet(record.id)),/paused\/cancelled/);
 f.store.runtime.control({type:'resume',runtimeId:runtime.id,commandId:'resume-round-publication'});
 const reportPath=join(f.workspace,input.package.reportDirectory,'report.json'),ownedBytes=await readFile(reportPath);
 await writeFile(reportPath,'Foreign subsequent user edit');
 await assert.rejects(new ResearchRuntimeActivity(f.store,f.data).materialize(f.store.executionGet(record.id)),/ownership changed/);
 assert.equal(await readFile(reportPath,'utf8'),'Foreign subsequent user edit');
 // Only this isolated fixture restores its deliberate fault injection. The
 // production helper never overwrites, repairs or authorizes a foreign edit.
 await writeFile(reportPath,ownedBytes);
 const manager=new ExecutionManager(f.store,f.data);
 await (manager as unknown as {finalize(id:string,state:'completed',stop:boolean,evidence:unknown,launched:boolean,authoritative:boolean):Promise<void>}).finalize(record.id,'completed',true,stop,true,true);
 await manager.close({cancel:false});assert.equal(f.store.executionGet(record.id).state,'completed',f.store.executionGet(record.id).error??'');
 f.store.runtime.report(op.id,owner,{messageId:'followup-result',outcome:'confirmed',result:{executionId:record.id}});
 return {op,report,input,binding:await captureMaterialBinding(f.store,f.data,op.id)};
}
// This executable implements only the finite synthetic transport used by this
// mechanism test. Local installed schema/version probes call no model provider.
function protocolFixture(){
 const cp=require('node:child_process'),fs=require('node:fs'),a=process.argv.slice(2);
 if(a.includes('--version')||a.includes('generate-json-schema')){process.stdout.write(cp.execFileSync('codex',a));process.exit(0);}
 if(a.includes('mcp')){console.log('[]');process.exit(0);}
 const threadId='synthetic-qualification-'+process.pid,turnId='synthetic-turn',send=(x:unknown)=>console.log(JSON.stringify(x));
 require('node:readline').createInterface({input:process.stdin}).on('line',(line:string)=>{
  const m=JSON.parse(line);if(m.id===undefined)return;
  if(m.method==='initialize')return send({id:m.id,result:{userAgent:'explicit-fixture',codexHome:'fixture',platformFamily:'unix',platformOs:'test'}});
  if(m.method==='model/list')return send({id:m.id,result:{data:[{id:'explicit-synthetic-protocol-fixture-no-provider',model:'explicit-synthetic-protocol-fixture-no-provider',inputModalities:['text'],supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low',isDefault:true}],nextCursor:null}});
  if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:threadId,turns:[]}}});
  if(m.method==='turn/start'){
   const text=m.params.input.find((i:{type:string})=>i.type==='text').text;
   const payload=JSON.parse(text.slice(text.indexOf('\n')+1));let passed=true;
   if(payload.proposed?.proposal){
    const criterion=payload.obligations[0].criterionId;
    const claim=payload.proposed.proposal.claims.find((c:{criterionIds:string[]})=>c.criterionIds.includes(criterion));
    passed=claim?.text===(criterion==='meaning'?'The document describes a bounded read-only tool.':'The document describes bounded operation.');
   }
   fs.appendFileSync(process.env.SYNTHETIC_RESEARCH_TURNS!,JSON.stringify({threadId,input:m.params})+'\n');
   send({id:m.id,result:{turn:{id:turnId,status:'inProgress',items:[]}}});
   const usage={inputTokens:1,cachedInputTokens:0,outputTokens:1,reasoningOutputTokens:0,totalTokens:2};
   send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total:usage,last:usage}}});
   const output=JSON.stringify({verdict:passed?'passed':'failed',reason:'Explicit finite synthetic judgment; no provider semantic approval',observations:[]});
   send({method:'item/completed',params:{threadId,turnId,item:{id:'message',type:'agentMessage',text:output}}});
   send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{type:'agentMessage',text:output}]}}});return;
  }
  throw Error('Unexpected fixture request '+m.method);
 });
}

async function actualFollowup(
 f:{store:SupervisorStore;root:string;workspace:string},sessionId:string,messageId:string,
 originalContract:TaskContract,originalProposal:GoalProposal,rawFollowup:unknown
){
 const begun=f.store.goals.beginFollowup(sessionId,messageId);
 const context={originalContract:originalContract,originalProposal:originalProposal,
  frozenMessages:f.store.conversations.messages(f.store.conversations.message(messageId).conversationId),newMessageId:messageId,session:begun.session};
 const followup=parseFollowupEvolution(rawFollowup,context,[]);
 const reviewSchema=followupEvolutionReviewSchema(followup,context,[]) as {properties:{proposalDigest:{const:string};sourceDigest:{const:string}}};
 const review={approved:true,proposalDigest:reviewSchema.properties.proposalDigest.const,sourceDigest:reviewSchema.properties.sourceDigest.const,
  changes:followup.criterionChanges!.map(change=>({kind:change.kind,criterionId:change.criterionId,authorized:true,reasons:['Explicit synthetic authorization review of actual new user quotation; no model approval claimed']}))};
 const followupJob=begun.session.jobs.at(-1)!,followupProof=join(f.root,followupJob.id+'-authorization.process.json');
 let followupIntent:unknown,followupIdentity:unknown;
 const reasonNode=await spawnManagedProcess({operationId:followupJob.id,command:process.execPath,args:['-e','process.exit(0)'],cwd:f.workspace,timeoutMs:3000,
  onBeforeSpawn:i=>{followupIntent=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.intents.push(i);});},
  onIdentity:i=>{followupIdentity=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.identities.push(i);});}});
 const reasonStop=await reasonNode.completion;assert.equal(reasonStop.stopped,true);
 await writeFile(followupProof,JSON.stringify({intent:followupIntent,identity:followupIdentity,result:reasonStop,output:rawFollowup}));
 const reviewProof=join(f.root,followupJob.id+'-review.process.json');let reviewIntent:unknown,reviewIdentity:unknown;
 const reviewNode=await spawnManagedProcess({operationId:followupJob.id+'-review',command:process.execPath,args:['-e','process.exit(0)'],cwd:f.workspace,timeoutMs:3000,
  onBeforeSpawn:i=>{reviewIntent=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.intents.push(i);});},
  onIdentity:i=>{reviewIdentity=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.identities.push(i);});}});
 const reviewStop=await reviewNode.completion;assert.equal(reviewStop.stopped,true);
 await writeFile(reviewProof,JSON.stringify({intent:reviewIntent,identity:reviewIdentity,result:reviewStop,output:review}));
 const proofMap={[followupProof]:digest(readFileSyncCompatible(followupProof)),[reviewProof]:digest(readFileSyncCompatible(reviewProof))};
 f.store.goals.finish(sessionId,followupJob.id,j=>{j.modelStarted=true;j.usage=2;j.stopConfirmed=true;j.threadId='synthetic-followup-author';j.proofs=proofMap;j.followupResult=followup;j.context={input:context,acceptanceReview:review,callReceipts:[{id:followupJob.id,output:rawFollowup,outputDigest:digest(canonical(rawFollowup)),threadId:'synthetic-proposal-thread',usage:1,stopConfirmed:true,proofs:{[followupProof]:proofMap[followupProof]}},{id:followupJob.id+'-review',output:review,outputDigest:digest(canonical(review)),threadId:'synthetic-authorization-review-thread',usage:1,stopConfirmed:true,proofs:{[reviewProof]:proofMap[reviewProof]}}]};});
 return f.store.goals.applyFollowup(sessionId,followupJob.id);
}

test('P8-RV2-I07 actual authorized research continuation new producer full V2 original-witness replay and ALL-OF sealed second delivery preserve original scope history and total budget', {timeout:480000},async t=>{
 const began=Date.now();
 // Both jobs share this test's existing total bound; each model call retains 15s.
 const observationDeadline=began+480000;
 const phase=(name:string)=>console.log('P8-RV2-I07 phase',name,Date.now()-began);
 // Trace actual original methods; no verdict, result, gate or I/O is replaced.
 const restore:(()=>void)[]=[];
 for(const [prototype,names]of [[ResearchWorkflowRepository.prototype,['captureArtifact','sealDelivery','assertCommittedCurrent']],
 [ControlQualificationRepository.prototype,['assertPublicationBinding','qualificationForReview']]] as const){
  const target=prototype as unknown as Record<string,(...args:unknown[])=>unknown>;
  for(const name of names){
   const original=target[name]!;
   target[name]=function(this:unknown,...args:unknown[]){
    const start=Date.now();phase(name+' begin');
    const done=()=>console.log('P8-RV2-I07 duration',name,Date.now()-start);
    try{const result=Reflect.apply(original,this,args);
     if(result instanceof Promise)return result.finally(done);done();return result;
    }catch(error){done();throw error;}
   };
   restore.push(()=>{target[name]=original;});
  }
 }
 t.after(()=>{for(const reset of restore.reverse())reset();});
 const f=await researchWorkflowFixture(t,undefined,async(store,runtime,root,workspace)=>{
  const session=store.goals.get(runtime.runId),conversation=store.conversations.ensureForGoal(session.id);
  const originalContract=store.runtime.inspect(runtime.id).run.contract;
  assert.equal(originalContract.version,2);
  const message=store.conversations.receive({conversationId:conversation.id,commandId:'retain-before-first-producer',
   source:'user',kind:'change',text:'Retain every original check, source and cutoff. Keep the report faithful to the same bounded read-only document.'});
  const unchanged=structuredClone(session.proposal!);
  await actualFollowup({store,root,workspace},session.id,message.id,originalContract,session.proposal!,{
   decision:'revise',response:'Keep the complete original acceptance unchanged.',proposal:unchanged,
   retiredCriterionIds:[],retirementSources:[],criterionChanges:[]});
  assert.equal(store.runtime.inspect(runtime.id).run.contract.version,3);
  assert.deepEqual(store.goals.get(session.id).proposal!.criteria,unchanged.criteria);
 },{timestampSyntheticEvents:true,archiveRoot:join(process.cwd(),'.supervisor-dev','research-followup-evidence',String(began))}),conversation=f.store.conversations.ensureForGoal(f.runtime.runId);
 phase('initial fixture finished');
 const first=await f.p4.dispatch({type:'deliver',commandId:'first-delivery',jobId:f.final.id}) as Delivery;
 const firstSeal=canonical(f.store.researchWorkflow.committed('first-delivery',{type:'deliver',commandId:'first-delivery',jobId:f.final.id}));
 const originalHistory=canonical({proposal:f.store.verification.get('proposal',f.proposal.id),review:f.store.verification.get('job',f.proposal.reviewId!),final:f.store.verification.get('job',f.final.id),run:f.store.runtime.inspect(f.runtime.id).run});
 const originalFiles=await hashes(f.proposal.bundle.root),originalBudget=f.store.conversations.budget(conversation.id);
 const message=f.store.conversations.receive({conversationId:conversation.id,commandId:'append-question',source:'user',kind:'change',text:'Also explain the bounded nature using the same original source. Preserve all original checks.'});
 const child=f.store.goals.createContinuation(conversation.id,'child-round');
 const proposal=structuredClone(child.session.proposal!);
 proposal.criteria.push({id:'detail',description:'Explain bounded operation using the same original source.',kind:'material',target:'research-report/report.json',checks:['The report faithfully answers the added bounded-operation question without weakening original meaning.']});
 proposal.steps=[{id:'analyze',description:'Reanalyse every original and appended question from the same source.',dependencies:[],acceptanceIds:['meaning','detail']}];
 const rawFollowup={decision:'revise',response:'Retain every original check and append the bounded-operation question.',proposal,
  retiredCriterionIds:[],retirementSources:[],criterionChanges:[{kind:'add',criterionId:'detail',sources:[{messageId:message.id,quote:'Also explain the bounded nature using the same original source.'}]}]};
 const applied=await actualFollowup(f,child.session.id,message.id,f.context.contract,child.session.proposal!,rawFollowup),
  runtime=f.store.runtime.get(applied.session.runtimeId!);
 assert.equal(f.context.contract.version,3);assert.equal(applied.run.contract.version,2);
 assert.equal(f.store.conversations.message(message.id).state,'applied');assert.equal(f.store.conversations.rounds(conversation.id).length,2);
 assert.deepEqual(applied.run.contract.criteria[0],f.context.contract.criteria[0]);
 phase('authorized continuation applied');
 const current=await producer(f,runtime);phase('new producer/crash recovery finished');
 const candidate=await captureCandidate(f.workspace,join(f.root,'current-author-candidate'));
 const source=await readMaterialBinding(current.binding),scope=await createEnvironmentScope(f.data,runtime);
 const acceptance:AcceptanceAuthoringContext={contract:applied.run.contract,criteria:applied.session.proposal!.criteria,
  candidate:{workspace:f.workspace,digest:candidate.digest,files:await Promise.all(Object.keys(candidate.files).map(async path=>{const content=await readFile(join(candidate.tree,path),'utf8');return {path,content,sha256:digest(content)};}))},
  environment:{...await environmentFingerprint(scope),scope},failureContext:null,previousSpec:null,workflowMode:'native-host-v1',
  materials:applied.session.proposal!.criteria.map(c=>({target:c.target,binding:current.binding,evidence:{context:source.input.context,sources:source.input.context.sources.map(s=>({materialId:s.materialId,text:readFileSyncCompatible(s.textPath).toString('utf8')}))}}))};
 const base=f.store.verificationLineage.captureBase(runtime.projectId,runtime.runId),history=f.store.controlQualification.loadHistory(f.proposal.id);
 const evolution=await captureControlEvolutionContext({current:acceptance,base,transitions:base.transitionIds.map(id=>f.store.verificationLineage.transition(id)),history});
 const oldCase=structuredClone(f.proposal.spec.cases[0]!),currentCase={...structuredClone(oldCase),revision:2,verifier:{kind:'material' as const,version:'native-followup-v2',claimFile:'research-report/report.json',binding:current.binding,timeoutMs:15000}};
 const goodFiles=[{path:'research-report/report.json',content:JSON.stringify(current.report)}];
 const wrongOld=structuredClone(current.report);wrongOld.claims[0]!.text='The document requires unbounded writes.';
 const wrongNew=structuredClone(current.report);wrongNew.claims[1]!.text='The document describes unbounded operation.';
 const assets:ControlEvolutionBundle['assets']={contextDigest:acceptanceAuthoringContextDigest(acceptance),
  spec:{schemaVersion:1,contractVersion:applied.run.contract.version,standardsVersion:'native-followup-v2',
   obligations:[...f.proposal.spec.obligations,{id:'bounded-detail',criterionId:'detail',expectation:'The report faithfully answers the added bounded-operation question without weakening original meaning.',required:true,applicable:true}],
   cases:[oldCase,currentCase,{...currentCase,id:'bounded-detail',revision:1,obligationIds:['bounded-detail'],modules:['detail'],defectRefs:['inverted-bounded-detail']}],
   controls:[{id:'good-current',workspace:'good-current',expect:'passed',mustFail:[]},{id:'bad-current',workspace:'bad-current',expect:'failed',mustFail:['faithful-meaning']},{id:'bad-added',workspace:'bad-added',expect:'failed',mustFail:['bounded-detail']}],moduleDependencies:{meaning:[],detail:[]}},
  verifierFiles:[],controls:[{id:'good-current',files:goodFiles},{id:'bad-current',files:[{path:'research-report/report.json',content:JSON.stringify(wrongOld)}]},{id:'bad-added',files:[{path:'research-report/report.json',content:JSON.stringify(wrongNew)}]}],
  coverageExplanation:[...f.bundle.coverageExplanation,{criterionId:'detail',check:proposal.criteria[1]!.checks[0]!,caseIds:['bounded-detail'],explanation:'Independent scoped artifact meaning plus original closed host gates, no semantic exemption.'}],
  researchWorkflow:{schemaVersion:1,mappings:[...f.bundle.researchWorkflow!.mappings,{criterionId:'detail',checkIndex:0,artifactObligationIds:['bounded-detail'],hostGates:[...RESEARCH_HOST_GATES]}]}};
 const oldGood=history.specimens.find(s=>s.revision.kind==='positive-full')!,oldBad=history.specimens.find(s=>s.revision.kind==='negative')!;
 const bundle:ControlEvolutionBundle={contextDigest:controlEvolutionContextDigest(evolution),assets,plan:{
  controlPlan:[{controlId:'good-current',kind:'positive-full',predecessorKey:controlSpecimenKey(oldGood.revision.ref)},
   {controlId:'bad-current',kind:'negative',predecessorKey:controlSpecimenKey(oldBad.revision.ref)},
   {controlId:'bad-added',kind:'negative',predecessorKey:null}],
  historyPlan:[{specimenKey:controlSpecimenKey(oldGood.revision.ref),successorControlId:'good-current',retireObligationIds:[]},
   {specimenKey:controlSpecimenKey(oldBad.revision.ref),successorControlId:'bad-current',retireObligationIds:[]}],evolutionExplanation:'Exact old fault on current successor plus complete appended question, no scope change.'}};
 const loop=f.store.supervision.attach({commandId:'followup-loop',runtimeId:runtime.id,config:{...f.config,timeoutMs:15000},limits:{maxRepairs:0,maxReasoningCalls:4,maxDurationMs:600000,maxContextChars:200000}});
 const author=f.store.supervision.beginJob({commandId:'followup-native-author',loopId:loop.id,expectedRevision:loop.revision,purpose:'acceptance-authoring',context:{prompt:buildControlEvolutionAuthoringPrompt(evolution),outputSchema:controlEvolutionAuthoringSchema(evolution),context:{acceptance,candidate,evolution}}});
 const authorRoot=join(f.data,'supervision-reasoning',digest(author.id));await mkdir(authorRoot,{recursive:true});
 let authorIntent:unknown,authorIdentity:unknown;
 const node=await spawnManagedProcess({operationId:author.id,command:process.execPath,args:['-e','process.exit(0)'],cwd:authorRoot,timeoutMs:3000,
  onBeforeSpawn:i=>{authorIntent=i;f.store.supervision.observeJob(author.id,{intents:[i]});},
  onIdentity:i=>{authorIdentity=i;f.store.supervision.observeJob(author.id,{identities:[i]});}});
 const stopped=await node.completion;assert.equal(stopped.stopped,true);
 await writeFile(join(authorRoot,'author.process.json'),JSON.stringify({intent:authorIntent,identity:authorIdentity,result:stopped}));
 await writeFile(join(authorRoot,'output.json'),JSON.stringify(bundle));f.store.supervision.observeJob(author.id,{modelStarted:true,observedUsage:2});
 f.store.supervision.finishJob(author.id,{usage:2,stopConfirmed:true,error:null,proofs:await hashes(authorRoot),threadId:'synthetic-native-v2-author',result:bundle});
 const durableAuthor=f.store.supervision.job(author.id);
 const material=await materializeControlEvolutionBundle({privateRoot:join(f.data,'supervision','authoring'),jobId:author.id,context:(durableAuthor.input as {context:{evolution:typeof evolution}}).context.evolution,bundle:durableAuthor.result});
 const p=await f.p4.dispatch({type:'propose',commandId:'native-followup-proposal',runtimeId:runtime.id,specPath:material.assets.specPath,controlDeclarationPath:material.declarationPath,controlAuthorJobId:author.id,researchAuthorJobId:author.id}) as Proposal;
 phase('V2 propose finished');
 const native=f.store.researchWorkflow.proposal(p.id);assert.equal(native.evolution!.rule,'append-same-source-lossless-v1');
 const wrongMapping=structuredClone(native.proofPlan);wrongMapping.originalChecks[0]!.hostRequirements=[];
 assert.throws(()=>prepareResearchWorkflowEvolution({previous:f.store.researchWorkflow.proposal(f.proposal.id),previousSpec:f.proposal.spec,currentPlan:wrongMapping,currentSpec:p.spec,currentContract:applied.run.contract,base,transitions:evolution.transitions}),/original check or its ALL-OF/);
 const binary=join(f.root,'explicit-research-protocol.cjs'),turns=join(f.root,'actual-synthetic-turns.jsonl');
 await writeFile(binary,'#!'+process.execPath+'\n('+protocolFixture.toString()+')();\n',{mode:0o700});
 const oldBinary=process.env.SUPERVISOR_CODEX_PATH,oldTurns=process.env.SYNTHETIC_RESEARCH_TURNS;
 process.env.SUPERVISOR_CODEX_PATH=binary;process.env.SYNTHETIC_RESEARCH_TURNS=turns;
 try{
  const config={...f.config,timeoutMs:15000};
  async function finished(action:Parameters<typeof f.p4.dispatch>[0]){
   let job=await f.p4.dispatch(action) as VerificationJob;
   while(job.status==='running'){assert.ok(Date.now()<observationDeadline,'Actual V2 control execution observer elapsed');await delay(25);job=f.store.verification.get('job',job.id);}
   assert.equal(job.approved,true,job.error??JSON.stringify(job));assert.equal(job.stopConfirmed,true);assert.equal(job.usageUnknown,false);return job;
  }
  const checked=await finished({type:'review',commandId:'followup-review',proposalId:p.id,...config});
  phase('V2 review finished');
  const qualification=f.store.controlQualification.qualificationForReview(checked.id);
  assert.equal(qualification.execution.evaluation.qualified,true);
  assert.equal(qualification.execution.pairs.length,qualification.assembled.matrix.rows.length);
  const projected=materialProjectionReviewEvidence(qualification.execution.pairs,checked.materials??[],qualification.assembled);
  assert.ok(projected.length>0,'Actual original detector must inspect current successor subview');
  const prompt=JSON.parse((await readFile(join(Object.keys(checked.proofs).find(path=>path.endsWith('/definition-review/result.json'))!,'..','events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).find(e=>e.kind==='review-input').value.prompt.split('\n').slice(1).join('\n'));
  assert.equal(prompt.researchWorkflow.previous.proposalId,f.proposal.id);assert.equal(prompt.materialProjections.length,projected.length);
  await f.p4.dispatch({type:'publish',commandId:'followup-publish',proposalId:p.id,reviewId:checked.id});
  const plan=await f.p4.dispatch({type:'freeze',commandId:'followup-freeze',runtimeId:runtime.id,mode:'final'}) as FrozenPlan;
  phase('publication/freeze finished');
  const final=await finished({type:'run',commandId:'followup-final',planId:plan.id,...config});
  assert.equal(final.evaluation!.complete,true);assert.equal(final.approvalScope,'research-artifact');
  phase('final finished');
  const evidence=new URL('../../../.supervisor-dev/research-followup-evidence/'+began+'/',import.meta.url);
  await mkdir(new URL('..',evidence),{recursive:true});
  await cp(f.root,evidence,{recursive:true,errorOnExist:true,force:false});
  const delivered=await f.p4.dispatch({type:'deliver',commandId:'second-delivery',jobId:final.id}) as Delivery;
  phase('second delivery finished');
  assert.notEqual(delivered.id,first.id);assert.equal(f.store.runtime.inspect(runtime.id).run.status,'succeeded');
  assert.deepEqual(await f.p4.dispatch({type:'deliver',commandId:'second-delivery',jobId:final.id}),delivered);phase('idempotent delivery finished');
  assert.equal(canonical({proposal:f.store.verification.get('proposal',f.proposal.id),review:f.store.verification.get('job',f.proposal.reviewId!),final:f.store.verification.get('job',f.final.id),run:f.store.runtime.inspect(f.runtime.id).run}),originalHistory);
  assert.equal(canonical(f.store.researchWorkflow.committed('first-delivery',{type:'deliver',commandId:'first-delivery',jobId:f.final.id})),firstSeal);
  assert.deepEqual(await hashes(f.proposal.bundle.root),originalFiles);
  const budget=f.store.conversations.budget(conversation.id);assert.equal(budget.limit,originalBudget.limit);assert.ok(budget.spent>originalBudget.spent);assert.ok(budget.spent<=budget.limit);assert.equal(budget.reserved,0);
  for(const job of f.store.verification.list('job'))for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');
 }finally{
  if(oldBinary===undefined)delete process.env.SUPERVISOR_CODEX_PATH;else process.env.SUPERVISOR_CODEX_PATH=oldBinary;
  if(oldTurns===undefined)delete process.env.SYNTHETIC_RESEARCH_TURNS;else process.env.SYNTHETIC_RESEARCH_TURNS=oldTurns;
 }
});
import {readFileSync as readFileSyncCompatible} from 'node:fs';
