// Ordinary actual FS/managed-Node checker qualification only. The metadata below
// is an explicit local fixture, not P5 output, provider approval or P4 delivery.
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareFollowupVerifier,controlModule,deferredAsyncControlTests} from './running-followup-verifier.js';
import {runCandidateEntry,runCommandVerifier} from '../../packages/verification/command.js';
import {inspectProcess,type ProcessIdentity,type ProcessIntent} from '../../packages/process-control/index.js';
export async function preflightFollowupVerifier(){
 const root=await realpath(await mkdtemp('/tmp/sv-followup-verifier-'));
 const criteria=(['sum','multiply'] as const).map(id=>({id,description:id==='sum'?'Finite numbers add; invalid inputs throw TypeError.':'Finite numbers multiply; invalid inputs throw TypeError.',kind:'command' as const,target:'math.test.mjs',checks:id==='sum'?['2+3=5 and -1+1=0','NaN, Infinity, -Infinity and string inputs throw TypeError at both positions','Actual assert/strict tests cover these examples']:['3*4=12 and -2*3=-6','Invalid values at both positions throw TypeError','Actual assert/strict tests cover these examples']}));
 const contract={version:3,goal:'Explicit fixed fixture sum plus multiply',criteria:criteria.map(c=>({id:c.id,description:[c.description,...c.checks].join('\n'),required:true}))};
 const supplied=await prepareFollowupVerifier(root,{criteria},{contract});
 const identities:ProcessIdentity[]=[],intents:ProcessIntent[]=[],results:unknown[]=[],proofs:Record<string,string>={};
 const hooks={onIntent:(value:ProcessIntent)=>{intents.push(value);},onIdentity:(value:ProcessIdentity)=>{identities.push(value);}};
 try{
  for(const control of supplied.spec.controls){
   const entry=await runCandidateEntry({id:control.id+'-entry',cwd:control.workspace,entry:'math.test.mjs',timeoutMs:30000,output:join(root,'evidence',control.id,'entry'),...hooks});
   results.push({control:control.id,entry});
   assert.equal(entry.executionStatus,'executed',entry.reason);assert.ok(entry.stopped);
   if(control.expect==='passed')assert.equal(entry.passed,true,entry.reason);
   for(const instance of supplied.spec.cases){
    const result=await runCommandVerifier({id:control.id+'-'+instance.id,bundle:join(root,'supplied-verifier'),entry:'check.mjs',cwd:control.workspace,parameters:instance.parameters[0]!,obligationIds:instance.obligationIds,timeoutMs:30000,output:join(root,'evidence',control.id,instance.id),...hooks});
    results.push({control:control.id,caseId:instance.id,result});
    assert.equal(result.executionStatus,'executed',result.reason);assert.ok(result.stopped);
    assert.deepEqual(result.checks.map(c=>c.obligationId),instance.obligationIds);
    if(control.expect==='passed')assert.ok(result.checks.every(c=>c.verdict==='passed'),JSON.stringify(result.checks));
    for(const obligation of control.mustFail.filter(id=>instance.obligationIds.includes(id)))assert.ok(result.checks.some(c=>c.obligationId===obligation&&c.verdict==='failed'),control.id+': '+obligation);
    if(control.id.endsWith('-missing-tests')&&!control.mustFail.includes(instance.obligationIds[0]!))assert.ok(result.checks.every(c=>c.verdict==='passed'),'Missing one function test must not fail the independent other function checks');
    for(const path of [...entry.proofFiles,...result.proofFiles])proofs[path]=createHash('sha256').update(await readFile(path)).digest('hex');
   }
  }
  // Deferred wider-scope sample stays legal; unsupported must be unknown, never a qualified negative.
  const deferred=join(root,'deferred-async');await mkdir(deferred);await writeFile(join(deferred,'math.mjs'),controlModule());await writeFile(join(deferred,'math.test.mjs'),deferredAsyncControlTests);
  const unknown=await runCommandVerifier({id:'deferred-async-unsupported',bundle:join(root,'supplied-verifier'),entry:'check.mjs',cwd:deferred,parameters:{name:'sum',obligationId:'sum-complete'},obligationIds:['sum-complete'],timeoutMs:30000,output:join(root,'evidence','deferred-async'),...hooks});
  results.push({deferred:true,result:unknown});assert.equal(unknown.executionStatus,'executed',unknown.reason);assert.ok(unknown.stopped);assert.deepEqual(unknown.checks.map(c=>({id:c.obligationId,verdict:c.verdict})),[{id:'sum-complete',verdict:'unknown'}]);
  for(const path of unknown.proofFiles)proofs[path]=createHash('sha256').update(await readFile(path)).digest('hex');
 }finally{
  const physical=[];for(const identity of identities){const actual=await inspectProcess(identity);physical.push({identity,actual});assert.equal(actual.status,'stopped');}
  await writeFile(join(root,'preflight.json'),JSON.stringify({scope:'actual component only; synthetic criteria metadata; no model/ledger/P4 approval',supplied,intents,identities,results,proofs,physical},null,2));
 }
 assert.equal(results.length,supplied.spec.controls.length*(1+supplied.spec.cases.length)+1);
 assert.equal(identities.length,intents.length);
 return{root,controlCount:supplied.spec.controls.length,commandInstances:supplied.spec.controls.length*supplied.spec.cases.length,deferredUnknownChecks:1,actualProcessCount:identities.length,proofCount:Object.keys(proofs).length};
}
