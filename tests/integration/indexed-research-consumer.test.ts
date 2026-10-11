import {IndexedResearchConsumer} from '../../packages/runtime/indexed-research-consumer.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {indexedWorkflowFixture} from '../helpers/indexed-workflow-fixture.js';
import {VerificationProofReader} from '../../packages/verification/proof-reader.js';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {inspectProcess} from '../../packages/process-control/index.js';
import {join} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
/** Real P5 admission/SQLite/FS + managed Node supplier protocol fixture only.
 * No real supplier/model interpretation or stage pass is represented. */
test('P8-IDXC-I01 explicit indexed single analysis automatic author actual controls full final seal and reopen preserve original sources and budget', {timeout:270000},async t=>{
 const f=await indexedWorkflowFixture(t,undefined,undefined,{timestampSyntheticEvents:true,archiveRoot:join(process.cwd(),'..','component-evidence'),preserveOriginalRoot:true});
 assert.equal(f.store.runtime.inspect(f.runtime.id).run.status,'succeeded');
 const producer=f.store.runtime.currentOperations(f.runtime.id).find(op=>op.executionId)!;
 const input=f.store.runtime.researchInput(producer.id)!.package;assert.equal(input.schemaVersion,2);assert.equal(input.context.index.entries.length,5);assert.ok(input.context.index.entries.every(entry=>entry.status==='success'&&entry.text?.complete));
 assert.deepEqual(input.indexed!.view.allowedMaterialIds,input.context.index.inputs.map(source=>source.id));
 assert.equal(input.indexed!.view.sources.length,5);
 assert.throws(()=>Reflect.construct(IndexedResearchConsumer,[Symbol('caller'),input.indexed,'fake-job','fake-attempt','0'.repeat(64),()=>{},()=>{}]),/Host factory required/);
 const native=proposalBinding(f.store.verification.get('proposal',f.final.proposalId));
 await assert.rejects(IndexedResearchConsumer.verification(f.store,f.final.id,native,input.indexed!,'0'.repeat(64),Object.keys(f.final.proofs).find(p=>p.endsWith('/indexed-reader/binding.json'))!.slice(0,-'/indexed-reader/binding.json'.length)),/Indexed consumer: Verification grant expired/);
 // Access to five complete originals does not add an unwarranted read-every-character business condition.
 const proposal=f.store.verification.get('proposal',f.final.proposalId),review=f.store.verification.get('job',proposal.reviewId!);
 assert.deepEqual(review.controls.map(c=>[c.id,c.passed]),[['good',true],['bad',true]]);
 assert.equal(review.controls[1]!.results[0]!.checks[0]!.verdict,'failed');
 for(const job of [review,f.final]){assert.equal(job.stopConfirmed,true);assert.equal(job.usageUnknown,false);await new VerificationProofReader(f.store).assertJob(job);for(const identity of job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');}
 const before=f.store.runtime.inspect(f.runtime.id).run.budget;assert.ok(before.spent>0&&before.spent<=before.limit);
 const archive=Object.keys(f.final.proofs).find(p=>p.endsWith('/indexed-reader/binding.json'))!;assert.ok(archive);
 const original=await readFile(archive);await writeFile(archive,'{}');await assert.rejects(new VerificationProofReader(f.store).assertJob(f.final));await writeFile(archive,original);
 const reopened=new SupervisorStore(f.data);try{const delivery=reopened.verification.get('delivery',f.delivery.id);assert.equal(delivery.jobId,f.final.id);assert.equal(reopened.runtime.inspect(f.runtime.id).run.status,'succeeded');await new VerificationProofReader(reopened).assertJob(reopened.verification.get('job',f.final.id));assert.deepEqual(reopened.runtime.inspect(f.runtime.id).run.budget,before);}finally{reopened.close();}
});

function proposalBinding(proposal:import('../../packages/verification/records.js').Proposal){const v=proposal.spec.cases.find(c=>c.verifier.kind==='material')!.verifier;assert.equal(v.kind,'material');if(v.kind!=='material')throw Error('native fixture missing');return v.binding;}
