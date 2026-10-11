import {publishLegacyControlReviewFixture} from './legacy-control-review-fixture.js';
import {verificationDirectory} from '../../packages/verification/scoped-environment.js';
import { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { RuntimeRepository } from '../../packages/persistence/runtime.js';
import { codexStart, type RuntimeRecord } from '../../packages/contracts/p3.js';
import type { RuntimeAppendRepair, RuntimeRetryFailure } from '../../packages/contracts/p6-loop.js';
import type { VerificationSpec } from '../../packages/contracts/p4.js';
import type { FrozenPlan, Proposal, VerificationJob } from '../../packages/verification/records.js';
import { canonical, captureCandidate, digest, environmentFingerprint } from '../../packages/verification/candidate.js';
import { captureDefinition } from '../../packages/verification/definition.js';
import { executeInstances } from '../../packages/verification/engine.js';
import { evaluateVerification, selectInstances } from '../../packages/verification/rules.js';
import { inspectProcess } from '../../packages/process-control/index.js';

const repairStep={id:'repair-1',kind:'codex' as const,prompt:'Repair the observed result while retaining strict original behavior',model:'not-invoked-in-repository-tests',effort:'low',reservation:30,timeoutMs:1000};
async function fixture(t:TestContext,codex=false,entryExit=false){
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-runtime-repair-'))),data=join(root,'data'),workspace=join(root,'workspace');await mkdir(workspace);await writeFile(join(workspace,'result.json'),'{"value":1}\n');
  let store=new SupervisorStore(data);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const runtime=store.runtime.submit({type:'submit',commandId:'fixture',workspace,workspaceKind:'project',goal:entryExit?'Actual node entry.mjs process must exit successfully':'result.json.value must equal 2',tokenLimit:10000,verificationReserve:20,steps:codex?[{...repairStep,id:'initial'}]:[{id:'ready',kind:'input',prompt:'Ready for independent verification'}]});
  if(!codex){store.runtime.control({type:'input',commandId:'ready',runtimeId:runtime.id,stepId:'ready',text:'Ready'});const op=store.runtime.claim(runtime.id,'fixture-owner')!;store.runtime.report(op.id,'fixture-owner',{messageId:'actual-input-report',outcome:'confirmed',result:{text:'Ready'}});}
  const boundary=()=>{const {run}=store.runtime.inspect(runtime.id);return {runtimeId:runtime.id,expectedContractVersion:run.contract.version,expectedRevision:run.revision};};
  return {root,data,workspace,runtime,boundary,get store(){return store;},restart(){store.close();store=new SupervisorStore(data);return store;}};
}

/** Exercise the real P4 command engine and frozen assets. Catalog publication is a
 * repository-boundary fixture; this does not claim an independent live model review. */
export async function failedCandidate(t:TestContext,options:{entryExit?:boolean}={}){
  const f=await fixture(t,false,options.entryExit===true),good=join(f.data,'good'),bad=join(f.data,'bad'),author=join(f.data,'author');
  for(const path of [good,bad,author])await mkdir(path);await writeFile(join(good,'result.json'),'{"value":2}\n');await writeFile(join(bad,'result.json'),'{"value":1}\n');
  const checker="import {readFileSync,writeFileSync} from 'node:fs';\nconst value=JSON.parse(readFileSync(process.argv[2]+'/result.json','utf8')).value;\nconst passed=value===2;\nwriteFileSync(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks:[{obligationId:'correct',verdict:passed?'passed':'failed',reason:'Actual result.json.value is '+value+'; required value is 2'}]}));\nprocess.exitCode=passed?0:1;\n";
  await writeFile(join(author,'check.mjs'),checker);
  const spec:VerificationSpec={schemaVersion:1,contractVersion:1,standardsVersion:'strict-value-2',obligations:[{id:'correct',criterionId:'independent-acceptance',expectation:'value must equal 2',required:true,applicable:true}],cases:[{id:'value',revision:1,obligationIds:['correct'],parameters:[{}],modules:['result'],replaces:[],defectRefs:['WRONG-VALUE'],verifier:{kind:'command',version:'strict-v1',entry:'check.mjs',files:['check.mjs'],timeoutMs:5000}}],controls:[{id:'good',workspace:good,expect:'passed',mustFail:[]},{id:'bad',workspace:bad,expect:'failed',mustFail:['correct']}],moduleDependencies:{}};
  if(options.entryExit){
    spec.obligations[0]!.expectation='Actual node entry.mjs process exits with code zero';
    const verifier=spec.cases[0]!.verifier;if(verifier.kind==='command')verifier.candidateEntries=['entry.mjs'];
    for(const [directory,exit] of [[f.workspace,1],[good,0],[bad,1]] as const)await writeFile(join(directory,'entry.mjs'),'process.exitCode='+exit+';\n');
    await writeFile(join(author,'check.mjs'),"import{writeFileSync}from'node:fs';writeFileSync(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks:[{obligationId:'correct',verdict:'passed',reason:'Declared direct CLI succeeded before checker'}]}));\n");
  }
  const specPath=join(author,'spec.json');await writeFile(specPath,JSON.stringify(spec));const {bundle}=await captureDefinition(specPath,join(f.data,'definition'));
  const candidate=await captureCandidate(f.workspace,join(f.data,'candidate')),run=f.store.runtime.inspect(f.runtime.id).run;
  const proposal:Proposal={id:'proposal-fixture',runtimeId:f.runtime.id,projectId:run.projectId,runId:run.id,baseVersion:0,version:null,spec,bundle,candidate,contractDigest:digest(canonical(run.contract)),status:'proposed',createdAt:new Date().toISOString()};
  const plan:FrozenPlan={id:'plan-fixture',runtimeId:f.runtime.id,projectId:run.projectId,runId:run.id,proposalId:proposal.id,catalogVersion:1,candidate,contractDigest:proposal.contractDigest,definitionDigest:bundle.digest,environmentDigest:'repository-boundary-fixture',selection:selectInstances(spec,{mode:'final'}),createdAt:new Date().toISOString()};
  const job:VerificationJob={id:'job-fixture',runtimeId:f.runtime.id,projectId:run.projectId,runId:run.id,workspace:f.workspace,kind:'verification',proposalId:proposal.id,planId:plan.id,request:{purpose:'real-command-engine-fixture'},status:'running',attemptId:'job-fixture',config:{model:'no-model-needed',effort:'low',reservation:10,timeoutMs:1000},startedAt:new Date().toISOString(),finishedAt:null,environmentDigest:plan.environmentDigest,intents:[],identities:[],usage:0,modelStarted:false,usageUnknown:false,results:[],controls:[],evaluation:null,approved:false,stopConfirmed:false,error:null,proofs:{},sources:[]};
  f.store.verification.insert('proposal',proposal);f.store.verification.artifact(run.projectId,run.id,{id:proposal.id,...f.store.managedSnapshot(canonical(candidate)),contractVersion:run.contract.version});await publishFixtureReview(f.store,proposal,f.data);
  f.store.verification.transaction(()=>{
    f.store.verification.insert('plan',plan);
    f.store.verification.artifact(run.projectId,run.id,{id:plan.id,...f.store.managedSnapshot(canonical(plan)),contractVersion:1});
    f.store.verification.act(run.projectId,run.id,{type:'startAttempt',attemptId:job.id,nodeId:'ready',contractVersion:1,reservation:10,purpose:'verification',resources:[]});f.store.verification.insert('job',job);
  });
  job.results=await executeInstances({job,signal:new AbortController().signal,output:verificationDirectory(f.data,job),save:()=>f.store.verification.update('job',job),eligible:()=>{}},spec,bundle,candidate,plan.selection.instances,'candidate');
  assert.equal(job.results[0]?.executionStatus,'executed',JSON.stringify(job.results));assert.equal(job.results[0]?.checks[0]?.verdict,'failed');
  for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');assert.ok(job.identities.length>0);
  job.evaluation=evaluateVerification(spec,plan.selection,job.results);job.status='finished';job.finishedAt=new Date().toISOString();job.stopConfirmed=true;
  for(const path of job.results.flatMap(r=>r.proofFiles??[]))job.proofs[path]=digest(await readFile(path));
 const actualReport=join(verificationDirectory(f.data,job),'report.json');await writeFile(actualReport,JSON.stringify({results:job.results,controls:job.controls,evaluation:job.evaluation,error:job.error}));job.proofs[actualReport]=digest(await readFile(actualReport));
  f.store.verification.transaction(()=>{f.store.verification.act(run.projectId,run.id,{type:'finishAttempt',attemptId:job.id,outcome:'failed'});f.store.verification.act(run.projectId,run.id,{type:'settleAttempt',attemptId:job.id,actual:0});f.store.verification.update('job',job);});
  const append=(commandId='append'):RuntimeAppendRepair=>({...f.boundary(),commandId,steps:[repairStep],failureJobId:job.id,failedObligationIds:['correct'],reason:'Repair actual failed necessary obligation'});
  return {...f,get store(){return f.store;},job,plan,proposal,append};
}

async function publishFixtureReview(store:SupervisorStore,proposal:Proposal,_root:string):Promise<void>{
  await publishLegacyControlReviewFixture(store,proposal);
}
