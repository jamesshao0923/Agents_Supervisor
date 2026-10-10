import {createHash} from 'node:crypto';
import {constants,lstatSync,openSync,closeSync,fstatSync,realpathSync,readSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import type {Proposal,VerificationJob} from './records.js';
import type {VerificationEnvironmentScope} from '../contracts/p4-environment.js';
import {verificationDirectory} from './scoped-environment.js';
import {verificationCanonical as canonical} from './rules.js';
import {assertLegacyControlQualification} from './control-qualification-gates.js';
function ensure(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
function actualFile(path:string,expected:string,maxBytes=128*1024*1024):Buffer {
 ensure(/^[a-f0-9]{64}$/.test(expected)&&lstatSync(path).isFile()&&realpathSync(path)===path,'Legacy control proof file alias or hash invalid');const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=fstatSync(fd);ensure(st.isFile()&&st.size<=maxBytes,'Legacy control proof exceeds bounded file capacity');const buffer=Buffer.alloc(st.size+1);let count=0;while(count<buffer.length){const n=readSync(fd,buffer,count,buffer.length-count,null);if(!n)break;count+=n;}const bytes=buffer.subarray(0,count);ensure(bytes.length===st.size&&createHash('sha256').update(bytes).digest('hex')===expected,'Legacy control proof bytes changed');return bytes;}finally{closeSync(fd);}
}
/** Actual immutable report/individual proof binding. The caller supplies its
 * own database directory, never model-selected paths or another job's evidence. */
export function assertLegacyControlReviewEvidence(input:{dataDir:string;proposal:Proposal;review:VerificationJob}):void {
 const {proposal,review}=input;ensure(review.kind==='review'&&review.proposalId===proposal.id&&review.projectId===proposal.projectId&&review.runId===proposal.runId&&review.runtimeId===proposal.runtimeId&&review.workspace===proposal.candidate.root,'Legacy review identity differs from proposal');assertLegacyControlQualification(proposal.spec,review.controls);
 const scoped=review as VerificationJob&{environmentScope?:VerificationEnvironmentScope};const scopedProposal=proposal as Proposal&{environmentScope?:VerificationEnvironmentScope};ensure(canonical(scoped.environmentScope??null)===canonical(scopedProposal.environmentScope??null),'Legacy review environment scope differs from proposal');const output=resolve(verificationDirectory(input.dataDir,scoped)),reportPath=join(output,'report.json');const reportHash=review.proofs[reportPath];ensure(reportHash,'Legacy review lacks its exact frozen job report');const report=JSON.parse(actualFile(reportPath,reportHash,32*1024*1024).toString('utf8')) as Record<string,unknown>;
 ensure(['controls','results','evaluation','error'].every(key=>Object.hasOwn(report,key))&&canonical(report.controls)===canonical(review.controls)&&canonical(report.results)===canonical(review.results)&&canonical(report.evaluation)===canonical(review.evaluation)&&report.error===review.error,'Legacy control observations differ from actual frozen review report');
 for(const control of review.controls){const controlOutput=join(output,'control-'+createHash('sha256').update(control.id).digest('hex'));for(const result of control.results){ensure(result.proofFiles?.length&&new Set(result.proofFiles).size===result.proofFiles.length,'Legacy control result lacks exact own proof references');for(const path of result.proofFiles){ensure(resolve(path)===path&&path.startsWith(controlOutput+sep)&&path!==reportPath&&review.proofs[path],'Legacy control result proof belongs to another job or is unbound');actualFile(path,review.proofs[path]!);}}}
}
