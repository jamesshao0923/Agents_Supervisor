import {basename,join,relative,resolve,sep} from 'node:path';
import type {VerificationInstance,VerificationResult} from '../contracts/p4.js';
import type {VerificationJob} from './records.js';
import type {ProcessIdentity,ProcessIntent,ProcessResult} from '../process-control/index.js';
import {canonical,digest} from './candidate.js';
import {FrozenReader} from './frozen-reader.js';
import {maintenanceEnsure as ensure} from './control-maintenance-rules.js';
export type MaintenanceCausalRole='original-failure'|'bad-replay'|'good-replay';
export interface MaintenanceCausalOperationInput {
  role:MaintenanceCausalRole;defectRef:string;job:VerificationJob;instance:VerificationInstance;
  candidateDigest:string;output:string;label:string;result:VerificationResult;
  /** Exact immutable stage inventory for current replays, actual source job inventory for originals. */
  fixedProofs:Record<string,string>;
}
export interface MaintenanceCausalFile {path:string;sha256:string;encoding:'utf8'|'base64';content:string}
export interface MaintenanceCausalOperation {
  role:MaintenanceCausalRole;defectRef:string;jobId:string;proposalId:string;environmentDigest:string;
  instance:VerificationInstance;candidateDigest:string;result:VerificationResult;
  executions:{kind:'candidate-entry'|'checker';operationId:string;files:Record<string,MaintenanceCausalFile>}[];
}
export interface MaintenanceCausalEvidenceV1 {
  schemaVersion:1;kind:'maintenance-command-causal-evidence';proposalId:string;reviewId:string;replayStageDigest:string;
  scope:string;operations:MaintenanceCausalOperation[];
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
/** Presentation only. The repository validates actual sources/replays before this
 * reader; paths are restricted to host operation artifacts, never model choices.
 * Complete bytes are retained under the existing FrozenReader capacity limits. */
export function captureMaintenanceCausalEvidence(input:{proposalId:string;reviewId:string;replayStageDigest:string;operations:MaintenanceCausalOperationInput[]},reader:FrozenReader):MaintenanceCausalEvidenceV1 {
  const operations:MaintenanceCausalOperation[]=[];
  for(const operation of input.operations){
    ensure(['original-failure','bad-replay','good-replay'].includes(operation.role),'Unknown maintenance causal role');
    const {job,instance,output,result}=operation,proofs=result.proofFiles??[];
    ensure(resolve(output)===output&&result.instanceId===instance.id&&result.executionStatus==='executed'&&proofs.length>0&&new Set(proofs).size===proofs.length,'Causal evidence lacks an actual exact command instance');
    const groups=new Map<string,string[]>();
    // Validate every path before performing any file read.
    for(const path of proofs){
      ensure(resolve(path)===path&&path.startsWith(output+sep),'Causal evidence path outside actual operation');
      const name=relative(output,path).split(sep).join('/'),match=/^(command|candidate-entries\/entry-([1-8]))\/(configuration\.json|parser-runtime\.json|intent\.json|identity\.json|process\.json|result\.json|stdout\.log|stderr\.log|report\.json)$/.exec(name);
      ensure(match,'Causal evidence only reads fixed command artifacts');
      const directory=match[1]!,list=groups.get(directory)??[];list.push(path);groups.set(directory,list);
      ensure(/^[a-f0-9]{64}$/.test(operation.fixedProofs[path]??'')&&job.proofs[path]===operation.fixedProofs[path],'Causal evidence differs from its actual immutable proof inventory');
    }
    const executions:MaintenanceCausalOperation['executions']=[];
    for(const [directory,paths]of groups){
      const checker=directory==='command',names=checker?['parser-runtime.json','intent.json','identity.json','process.json','report.json','stdout.log','stderr.log']:['configuration.json','intent.json','identity.json','process.json','stdout.log','stderr.log'];
      const root=join(output,directory),expected=names.map(n=>join(root,n));
      ensure(same([...paths].sort(),[...expected,join(root,'result.json')].sort()),'Causal evidence complete command inventory differs');
      const files:Record<string,MaintenanceCausalFile>={};
      for(const name of [...names,'result.json']){
        const path=join(root,name),bytes=reader.read(path,output),sha256=digest(bytes);ensure(sha256===operation.fixedProofs[path],'Causal evidence actual bytes changed');
        const text=bytes.toString('utf8'),utf8=Buffer.from(text,'utf8').equals(bytes);
        files[name]={path,sha256,encoding:utf8?'utf8':'base64',content:utf8?text:bytes.toString('base64')};
      }
      const json=<T>(name:string):T=>JSON.parse(Buffer.from(files[name]!.content,files[name]!.encoding==='utf8'?'utf8':'base64').toString('utf8')) as T;
      const record=json<{proofFiles:string[];executionStatus:string;stopped:boolean;exitCode?:number;passed?:boolean;checks?:unknown;entry?:string}>('result.json');ensure(same(record.proofFiles,expected)&&record.executionStatus==='executed'&&record.stopped===true,'Causal evidence raw result inventory or completion differs');
      const index=checker?null:Number(directory.split('entry-')[1])-1;
      const operationId=(checker?'check-':'entry-')+digest(job.id+operation.label+instance.id+(index===null?'':index)).slice(0,48);
      const intent=json<ProcessIntent>('intent.json'),identity=json<ProcessIdentity>('identity.json'),process=json<ProcessResult>('process.json');
      ensure(intent.operationId===operationId&&intent.cwd===join(output,'candidate')&&basename(intent.command)==='node'
        &&identity.operationId===operationId&&identity.ownerToken===intent.ownerToken&&same(process.identity,identity)
        &&job.intents.filter(i=>same(i,intent)).length===1&&job.identities.filter(i=>same(i,identity)).length===1,
        'Causal evidence belongs to another instance or process');
      ensure(process.reason==='completed'&&process.stopped&&process.signal===null&&process.stop?.status==='stopped'&&process.stop.stopped&&Array.isArray(process.stop.members)&&process.stop.members.length===0,'Causal evidence has unknown process completion or stop');
      if(checker){
        const report=json<{schemaVersion:number;checks:unknown}>('report.json');
        ensure(report.schemaVersion===1&&same(report.checks,record.checks),'Causal evidence checker report differs from raw result');
      }else{
        const configuration=json<{schemaVersion:number;entry:string;cwd:string}>('configuration.json');
        ensure(configuration.schemaVersion===1&&configuration.cwd===join(output,'candidate')&&configuration.entry===record.entry
          &&record.exitCode===process.exitCode&&record.passed===(process.exitCode===0),'Causal evidence entry configuration or exit differs');
      }
      executions.push({kind:checker?'checker':'candidate-entry',operationId,files});
    }
    operations.push({role:operation.role,defectRef:operation.defectRef,jobId:job.id,proposalId:job.proposalId,environmentDigest:job.environmentDigest,instance:structuredClone(instance),candidateDigest:operation.candidateDigest,result:structuredClone(result),executions});
  }
  return {schemaVersion:1,kind:'maintenance-command-causal-evidence',proposalId:input.proposalId,reviewId:input.reviewId,replayStageDigest:input.replayStageDigest,scope:'Actual original failure and current maintenance command executions only. No semantic approval or future final acceptance is claimed.',operations};
}
