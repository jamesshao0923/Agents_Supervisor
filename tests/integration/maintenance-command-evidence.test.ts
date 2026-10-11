import {captureMaintenanceCausalEvidence,type MaintenanceCausalOperationInput} from '../../packages/verification/maintenance-causal-evidence.js';
import {failedCandidate} from '../helpers/control-maintenance-fixture.js';
import {regressionRef} from '../../packages/verification/control-maintenance-rules.js';
import {verificationDirectory} from '../../packages/verification/scoped-environment.js';
import {inspectProcess} from '../../packages/process-control/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureCandidate,digest,canonical} from '../../packages/verification/candidate.js';
import {captureDefinition} from '../../packages/verification/definition.js';
import {selectInstances} from '../../packages/verification/rules.js';
import {executeInstances} from '../../packages/verification/engine.js';
import {FrozenReader} from '../../packages/verification/frozen-reader.js';
import {assertMaintenanceCommandEvidence} from '../../packages/verification/maintenance-command-evidence.js';
import type {Proposal,VerificationJob} from '../../packages/verification/records.js';
import type {VerificationSpec} from '../../packages/contracts/p4.js';

// Actual Node/P4 engine files and process ownership; the job metadata is a local
// mechanism fixture, never a model result or independent acceptance approval.
test('P6-MAINT-I09 actual candidate entry and command evidence bind one specific fault while early entry failure stays unsupported',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'sv-maintenance-command-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const d of ['workspace','good','bad','definition'])await mkdir(join(root,d));
  for(const [d,value] of [['workspace',1],['good',2],['bad',1]] as const){
    await writeFile(join(root,d,'result.json'),JSON.stringify({value}));
    await writeFile(join(root,d,'entry.mjs'),"import assert from 'node:assert/strict';assert.equal(1+1,2);\n");
  }
  await writeFile(join(root,'definition/check.mjs'),"import{readFileSync,writeFileSync}from'node:fs';const value=JSON.parse(readFileSync(process.argv[2]+'/result.json')).value;const verdict=value===2?'passed':'failed';writeFileSync(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks:[{obligationId:'value',verdict,reason:'Actual value '+value}]}));process.exitCode=value===2?0:1;");
  const spec:VerificationSpec={schemaVersion:1,contractVersion:1,standardsVersion:'unchanged',obligations:[{id:'value',criterionId:'value',expectation:'value equals two',required:true,applicable:true}],cases:[{id:'check',revision:1,obligationIds:['value'],parameters:[{z:'last',A:'first',é:'unicode'}],modules:[],replaces:[],defectRefs:['actual-wrong-value'],verifier:{kind:'command',version:'v1',entry:'check.mjs',files:['check.mjs'],candidateEntries:['entry.mjs'],timeoutMs:5000}}],controls:[{id:'good',workspace:join(root,'good'),expect:'passed',mustFail:[]},{id:'bad',workspace:join(root,'bad'),expect:'failed',mustFail:['value']}],moduleDependencies:{}};
  await writeFile(join(root,'definition/spec.json'),JSON.stringify(spec));
  const captured=await captureDefinition(join(root,'definition/spec.json'),join(root,'frozen-definition'));
  const candidate=await captureCandidate(join(root,'workspace'),join(root,'candidate'));
  const proposal:Proposal={id:'proposal',runtimeId:'runtime',projectId:'project',runId:'run',baseVersion:0,version:null,spec:captured.spec,bundle:captured.bundle,candidate,contractDigest:digest('fixture contract'),status:'proposed',createdAt:new Date().toISOString()};
  const instance=selectInstances(spec,{mode:'final'}).instances[0]!;
  const job:VerificationJob={id:'job',runtimeId:'runtime',projectId:'project',runId:'run',workspace:candidate.root,kind:'review',proposalId:proposal.id,planId:null,request:{fixture:'No model provider'},status:'running',attemptId:'fixture',environmentDigest:digest('fixture environment'),config:{model:'unused',effort:'low',reservation:100,timeoutMs:5000},startedAt:new Date().toISOString(),finishedAt:null,intents:[],identities:[],usage:0,modelStarted:false,usageUnknown:false,results:[],controls:[],evaluation:null,approved:false,stopConfirmed:false,error:null,proofs:{},sources:[]};
  const output=join(root,'output'),context={job,output,save(){},eligible(){},signal:new AbortController().signal};
  const label='specific',result=(await executeInstances(context,spec,proposal.bundle,candidate,[instance],label))[0]!;
  for(const path of result.proofFiles??[])job.proofs[path]=digest(await readFile(path));
  const check=()=>assertMaintenanceCommandEvidence({proposal,job,instance:JSON.parse(canonical(instance)),label,output:join(output,label,instance.id),result,reader:new FrozenReader(root)});
  assert.equal(result.executionStatus,'executed');assert.equal(result.checks[0]!.verdict,'failed');check();
  const entryPath=result.proofFiles!.find(path=>path.endsWith('/entry-1/result.json'))!,original=await readFile(entryPath),raw=JSON.parse(original.toString());
  raw.passed=false;const bytes=Buffer.from(JSON.stringify(raw));await writeFile(entryPath,bytes);job.proofs[entryPath]=digest(bytes);
  assert.throws(check,/candidate entry must succeed/);await writeFile(entryPath,original);job.proofs[entryPath]=digest(original);check();
  await writeFile(join(root,'workspace/entry.mjs'),"import assert from 'node:assert/strict';assert.equal(1,2);\n");
  const failedEntryCandidate=await captureCandidate(join(root,'workspace'),join(root,'failed-entry'));
  const earlyLabel='early-entry',early=(await executeInstances(context,spec,proposal.bundle,failedEntryCandidate,[instance],earlyLabel))[0]!;
  for(const path of early.proofFiles??[])job.proofs[path]=digest(await readFile(path));
  assert.equal(early.executionStatus,'executed');assert.equal(early.checks[0]!.verdict,'failed');
  assert.ok(!early.proofFiles!.some(path=>path.endsWith('/command/result.json')),'Actual engine did not run checker after entry failure');
  assert.throws(()=>assertMaintenanceCommandEvidence({proposal,job,instance,label:earlyLabel,output:join(output,earlyLabel,instance.id),result:early,reader:new FrozenReader(root)}),/candidate entry must succeed/);
  // Separate real SQLite/legacy publication + actual original entry-exit source.
  // Synthetic independent reviewer metadata is explicit in the existing helper;
  // no model, direct database success seed or archive rewriting is introduced.
  const f=await failedCandidate(t,{entryExit:true});f.store.runtime.appendRepair(f.append());
  const repairEvent=f.store.runtime.events(f.runtime.id,0).find(e=>e.kind==='repair-appended')!;
  const source={defectRef:regressionRef(f.job.id,f.plan.selection.instances[0]!,f.job.results[0]!),failureJobId:f.job.id,repairEventSeq:repairEvent.seq,candidate:f.plan.candidate,instance:f.plan.selection.instances[0]!,result:f.job.results[0]!,obligationIds:['correct']};
  const old=f.store.verification.get('proposal',f.proposal.id),nextSpec=structuredClone(old.spec);
  nextSpec.cases.push({...structuredClone(nextSpec.cases[0]!),revision:2,defectRefs:[...nextSpec.cases[0]!.defectRefs,source.defectRef]});
  const nextRoot=join(f.data,'cli-next-author');await mkdir(nextRoot);await writeFile(join(nextRoot,'check.mjs'),await readFile(join(old.bundle.directory,'check.mjs')),{mode:0o600});await writeFile(join(nextRoot,'spec.json'),JSON.stringify(nextSpec));
  const nextFrozen=await captureDefinition(join(nextRoot,'spec.json'),join(f.data,'cli-next-definition'));
  const target:Proposal={...old,id:'cli-regression-proposal',baseVersion:old.version!,version:null,status:'proposed',spec:nextFrozen.spec,bundle:nextFrozen.bundle};delete target.reviewId;
  f.store.verification.insert('proposal',target);
  const mapped=selectInstances(target.spec,{mode:'final'}).instances.find(i=>i.revision===2)!;
  const replayJob:VerificationJob={...structuredClone(f.job),id:'cli-replay',proposalId:target.id,kind:'review',planId:null,status:'running',intents:[],identities:[],results:[],controls:[],proofs:{},error:null,usageUnknown:false,stopConfirmed:false};
  const replayOutput=verificationDirectory(f.data,replayJob),replayContext={job:replayJob,output:replayOutput,save(){},eligible(){},signal:new AbortController().signal};
  const badLabel='closed-bad',badResult=(await executeInstances(replayContext,target.spec,target.bundle,source.candidate,[mapped],badLabel))[0]!;
  for(const path of badResult.proofFiles??[])replayJob.proofs[path]=digest(await readFile(path));
  const badBinding=f.store.controlMaintenance.executionRegressionSource(source,target.id,mapped,'bad');assert.ok(badBinding);
  assertMaintenanceCommandEvidence({proposal:target,job:replayJob,instance:mapped,label:badLabel,output:join(replayOutput,badLabel,mapped.id),result:badResult,reader:new FrozenReader(f.data),originalExecution:badBinding});
  assert.equal(badResult.checks[0]!.verdict,'failed');assert.equal(badResult.checks.length,1);assert.ok(!badResult.proofFiles!.some(path=>path.includes('/command/')));
  const checkerOperation='check-'+digest(replayJob.id+badLabel+mapped.id).slice(0,48);
  const memoryCheck=(memoryJob:VerificationJob)=>assertMaintenanceCommandEvidence({proposal:target,job:memoryJob,instance:mapped,label:badLabel,output:join(replayOutput,badLabel,mapped.id),result:badResult,reader:new FrozenReader(f.data),originalExecution:badBinding});
  const phantomIntent=structuredClone(replayJob);phantomIntent.intents.push({...phantomIntent.intents[0]!,operationId:checkerOperation});assert.throws(()=>memoryCheck(phantomIntent),/cannot contain an unperformed checker/);
  const phantomIdentity=structuredClone(replayJob);phantomIdentity.identities.push({...phantomIdentity.identities[0]!,operationId:checkerOperation});assert.throws(()=>memoryCheck(phantomIdentity),/cannot contain an unperformed checker/);
  const phantomProof=structuredClone(replayJob);phantomProof.proofs[join(replayOutput,badLabel,mapped.id,'command','not-created.json')]=digest('not-created');assert.throws(()=>memoryCheck(phantomProof),/cannot contain an unperformed checker/);
  const unrelated=structuredClone(replayJob);unrelated.intents.push({...unrelated.intents[0]!,operationId:'other-instance-checker'});unrelated.identities.push({...unrelated.identities[0]!,operationId:'other-instance-checker'});unrelated.proofs[join(replayOutput,'other-instance','command','not-read.json')]=digest('not-read');assert.doesNotThrow(()=>memoryCheck(unrelated));

  const goodCandidate=await captureCandidate(join(f.data,'good'),join(f.data,'closed-good'));
  const goodLabel='closed-good',goodResult=(await executeInstances(replayContext,target.spec,target.bundle,goodCandidate,[mapped],goodLabel))[0]!;
  for(const path of goodResult.proofFiles??[])replayJob.proofs[path]=digest(await readFile(path));
  const goodBinding=f.store.controlMaintenance.executionRegressionSource(source,target.id,mapped,'good');assert.ok(goodBinding);
  assertMaintenanceCommandEvidence({proposal:target,job:replayJob,instance:mapped,label:goodLabel,output:join(replayOutput,goodLabel,mapped.id),result:goodResult,reader:new FrozenReader(f.data),originalExecution:goodBinding});
  assert.equal(goodResult.checks[0]!.verdict,'passed');assert.ok(goodResult.proofFiles!.some(path=>path.endsWith('/command/report.json')));
  for(const identity of replayJob.identities)assert.equal((await inspectProcess(identity)).status,'stopped');
  assert.equal(replayJob.usage,0);assert.equal(replayJob.usageUnknown,false);
  const originalJob=f.store.verification.get('job',source.failureJobId);
  const causalOperations:MaintenanceCausalOperationInput[]=[
    {role:'original-failure',defectRef:source.defectRef,job:originalJob,instance:source.instance,candidateDigest:source.candidate.digest,output:join(verificationDirectory(f.data,originalJob),'candidate',source.instance.id),label:'candidate',result:source.result,fixedProofs:originalJob.proofs},
    {role:'bad-replay',defectRef:source.defectRef,job:replayJob,instance:mapped,candidateDigest:source.candidate.digest,output:join(replayOutput,badLabel,mapped.id),label:badLabel,result:badResult,fixedProofs:replayJob.proofs},
    {role:'good-replay',defectRef:source.defectRef,job:replayJob,instance:mapped,candidateDigest:goodCandidate.digest,output:join(replayOutput,goodLabel,mapped.id),label:goodLabel,result:goodResult,fixedProofs:replayJob.proofs}
  ];
  const causalInput={proposalId:target.id,reviewId:replayJob.id,replayStageDigest:digest('Explicit fixture source+replay inventory; not a sealed review'),operations:causalOperations};
  const causal=captureMaintenanceCausalEvidence(causalInput,new FrozenReader(f.data));
  assert.deepEqual(causal.operations.map(o=>o.role),['original-failure','bad-replay','good-replay']);
  assert.equal(causal.operations[0]!.jobId,originalJob.id);assert.deepEqual(causal.operations[0]!.instance,source.instance);assert.deepEqual(causal.operations[2]!.instance,mapped);
  assert.equal(causal.operations[0]!.executions.length,1);assert.equal(causal.operations[1]!.executions.length,1);assert.equal(causal.operations[2]!.executions.length,2);
  for(const operation of causal.operations)for(const execution of operation.executions)for(const file of Object.values(execution.files)){
    const content=Buffer.from(file.content,file.encoding==='utf8'?'utf8':'base64');assert.deepEqual(content,await readFile(file.path));assert.equal(digest(content),file.sha256);
  }
  const badFiles=causal.operations[1]!.executions[0]!.files,goodFiles=causal.operations[2]!.executions;
  assert.equal(JSON.parse(badFiles['process.json']!.content).exitCode,1);assert.equal(JSON.parse(goodFiles[0]!.files['process.json']!.content).exitCode,0);
  assert.equal(JSON.parse(goodFiles[1]!.files['report.json']!.content).checks[0].verdict,'passed');
  const unrelatedPath=join(f.root,'not-created-causal-path.json'),outside=structuredClone(causalInput);outside.operations[0]!.result.proofFiles!.push(unrelatedPath);outside.operations[0]!.job.proofs[unrelatedPath]=digest('not-created');outside.operations[0]!.fixedProofs[unrelatedPath]=digest('not-created');
  assert.throws(()=>captureMaintenanceCausalEvidence(outside,new FrozenReader(f.data)),/path outside actual operation/,'Reject undeclared path before any arbitrary file read');
  const missing=structuredClone(causalInput);missing.operations[0]!.result.proofFiles=missing.operations[0]!.result.proofFiles!.filter(p=>!p.endsWith('/identity.json'));
  assert.throws(()=>captureMaintenanceCausalEvidence(missing,new FrozenReader(f.data)),/complete command inventory differs/);
  const wrongInstance=structuredClone(causalInput);wrongInstance.operations[0]!.instance={...wrongInstance.operations[0]!.instance,id:'different-instance'};
  assert.throws(()=>captureMaintenanceCausalEvidence(wrongInstance,new FrozenReader(f.data)),/exact command instance/);
  f.restart();assert.ok(f.store.controlMaintenance.executionRegressionSource(source,target.id,mapped,'bad'),'Readonly authority reloaded after actual SQLite reopen');

});
