import {join} from 'node:path';
import type {FrozenQualificationMatrix,QualificationPairResult} from '../contracts/p4-controls.js';
import type {VerificationJob} from './records.js';
import {canonical,digest} from './candidate.js';
import {assertQualificationMatrix} from './control-rules.js';
import {verificationDirectory} from './scoped-environment.js';
import {FrozenReader} from './frozen-reader.js';
import {captureMaintenanceCausalEvidence,type MaintenanceCausalOperation} from './maintenance-causal-evidence.js';
function ensure(value:unknown,message:string):asserts value{if(!value)throw Error('Qualification causal evidence: '+message);}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export interface QualificationCausalEvidenceV1 {
  schemaVersion:1;kind:'qualification-command-causal-evidence';jobId:string;proposalId:string;matrixDigest:string;executionProofsDigest:string;
  scope:string;rows:{rowId:string;resultDigest:string;executions:MaintenanceCausalOperation['executions']}[];
}
/** Reads the full actual frozen pair inventory, not a selected subset. Shared
 * command artifact reader is integrity-only; its internal maintenance role is
 * not exposed as a qualification role or used as authorization. */
export function captureQualificationCausalEvidence(input:{job:VerificationJob;matrix:FrozenQualificationMatrix;pairs:QualificationPairResult[];executionProofs:Record<string,string>;dataDir:string},reader=new FrozenReader(input.dataDir)):QualificationCausalEvidenceV1 {
  const {job,pairs,executionProofs,dataDir}=input,matrix=assertQualificationMatrix(input.matrix);
  ensure(job.kind==='review'&&pairs.length===matrix.rows.length&&new Set(pairs.map(p=>p.rowId)).size===pairs.length,'Missing or duplicate frozen qualification rows');
  const controls=job.controls.filter(c=>c.id.startsWith('qualification:'));
  ensure(controls.length===matrix.rows.length&&new Set(controls.map(c=>c.id)).size===controls.length,'Actual job qualification inventory differs');
  const allProofs=pairs.flatMap(p=>p.results.flatMap(r=>r.proofFiles??[]));
  ensure(same([...new Set(allProofs)].sort(),Object.keys(executionProofs).sort()),'Immutable qualification proof inventory differs');
  const rows:QualificationCausalEvidenceV1['rows']=[];
  for(const row of matrix.rows){
    const pair=pairs.find(p=>p.rowId===row.id),control=controls.find(c=>c.id==='qualification:'+row.id);
    ensure(pair&&pair.results.length===1&&control&&same(control.results,pair.results),'Actual row results differ');
    const result=pair.results[0]!;ensure(result.instanceId===row.instance.id&&result.executionStatus==='executed','Unsupported or unexecuted qualification row');
    const label='qualification/'+row.id,output=join(verificationDirectory(dataDir,job),label,row.instance.id);
    const captured=captureMaintenanceCausalEvidence({proposalId:job.proposalId,reviewId:job.id,replayStageDigest:matrix.digest,operations:[{role:'bad-replay',defectRef:row.id,job,instance:row.instance,candidateDigest:row.specimen.candidateDigest,output,label,result,fixedProofs:executionProofs}]},reader).operations[0]!;
    rows.push({rowId:row.id,resultDigest:digest(canonical(result)),executions:captured.executions});
  }
  return{schemaVersion:1,kind:'qualification-command-causal-evidence',jobId:job.id,proposalId:job.proposalId,matrixDigest:matrix.digest,executionProofsDigest:digest(canonical(executionProofs)),scope:'Complete actual frozen qualification command rows only. Original row roles/definition/specimen/instance and every operation remain distinct. No semantic approval or final product acceptance is claimed.',rows};
}
