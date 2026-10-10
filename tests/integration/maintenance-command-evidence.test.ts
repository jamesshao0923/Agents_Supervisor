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
});
