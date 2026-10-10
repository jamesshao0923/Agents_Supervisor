import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {SupervisorStore} from '../../packages/persistence/store.js';
import type {VerificationEnvironmentScope} from '../../packages/contracts/p4-environment.js';
import type {Proposal,VerificationJob} from '../../packages/verification/records.js';
import {executeDefinitionControls} from '../../packages/verification/engine.js';
import {digest,environmentFingerprint} from '../../packages/verification/candidate.js';
import {verificationDirectory} from '../../packages/verification/scoped-environment.js';
import {inspectProcess} from '../../packages/process-control/index.js';
/** Actual complete good/bad controls, raw files, stopped processes and same-Run
 * zero-token command accounting. Independent MODEL approval below is declared
 * synthetic metadata for repository/controller mechanisms, never paid evidence. */
export async function recordLegacyControlReviewFixture(store:Pick<SupervisorStore,'verification'>,proposal:Proposal,options:{id?:string;reservation?:number}={}):Promise<VerificationJob>{
 const scope=(proposal as Proposal&{environmentScope?:VerificationEnvironmentScope}).environmentScope;
 const id=options.id??'fixture-review-'+proposal.id,output=verificationDirectory(store.verification.dataDirectory(),{...proposal,id});await mkdir(output,{recursive:true});const run=store.verification.run(proposal.projectId,proposal.runId);
 const job:VerificationJob={id,runtimeId:proposal.runtimeId,projectId:proposal.projectId,runId:proposal.runId,workspace:proposal.candidate.root,kind:'review',proposalId:proposal.id,planId:null,request:{scope:'Real command controls; explicitly synthetic independent model approval metadata'},status:'running',attemptId:id,environmentDigest:(await environmentFingerprint(scope)).digest,config:{model:'repository-fixture-no-model-call',effort:'low',reservation:options.reservation??1,timeoutMs:5000},startedAt:new Date().toISOString(),finishedAt:null,intents:[],identities:[],usage:0,modelStarted:false,usageUnknown:false,results:[],controls:[],evaluation:null,approved:false,stopConfirmed:false,error:null,proofs:{},sources:[]};
 if(scope)Object.assign(job,{environmentScope:structuredClone(scope)});
 store.verification.transaction(()=>{store.verification.act(run.projectId,run.id,{type:'startAttempt',attemptId:id,nodeId:run.nodes.at(-1)!.id,contractVersion:run.contract.version,purpose:'verification',reservation:job.config.reservation,resources:[]});store.verification.insert('job',job);});
 await executeDefinitionControls({job,signal:new AbortController().signal,output,save:()=>store.verification.update('job',job),eligible:()=>{}},proposal.spec,proposal.bundle);
 for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');assert.ok(job.identities.length>0);job.stopConfirmed=true;job.approved=true;job.status='finished';job.finishedAt=new Date().toISOString();
 await writeFile(join(output,'model-approval-fixture.json'),JSON.stringify({scope:'Synthetic independent MODEL approval metadata, no model request',proposalId:proposal.id,definitionDigest:proposal.bundle.digest}));await writeFile(join(output,'report.json'),JSON.stringify({results:job.results,controls:job.controls,evaluation:job.evaluation,error:job.error}));
 async function proofs(dir:string):Promise<void>{for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await proofs(p);else job.proofs[p]=digest(await readFile(p));}}await proofs(output);
 store.verification.transaction(()=>{store.verification.act(run.projectId,run.id,{type:'finishAttempt',attemptId:id,outcome:'succeeded'});store.verification.act(run.projectId,run.id,{type:'settleAttempt',attemptId:id,actual:0});store.verification.update('job',job);});return job;
}
export async function publishLegacyControlReviewFixture(store:SupervisorStore,proposal:Proposal):Promise<VerificationJob>{
 store.verificationLineage.bindProposal({commandId:'fixture-binding-'+proposal.id,proposalId:proposal.id,base:store.verificationLineage.captureBase(proposal.projectId,proposal.runId),definitionFormat:'legacy-v1'});const review=await recordLegacyControlReviewFixture(store,proposal);proposal.reviewId=review.id;store.verification.publish(proposal,'fixture-publication-'+proposal.id);return review;
}
