import {basename,isAbsolute,join,resolve,sep} from 'node:path';
import type {VerificationInstance,VerificationResult} from '../contracts/p4.js';
import type {ProcessIdentity,ProcessIntent,ProcessResult} from '../process-control/index.js';
import type {CandidateEntryResult,CommandResult} from './command.js';
import type {Proposal,VerificationJob} from './records.js';
import {canonical,digest} from './candidate.js';
import {FrozenReader} from './frozen-reader.js';
import {maintenanceEnsure as ensure} from './control-maintenance-rules.js';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

/** Reconstruct a supported replay from the host's individual process artifacts.
 * The aggregate controls/report and mutable proof manifest cannot substitute for
 * the actual checker report. Used both before publication and on historical reads.
 */
export function assertMaintenanceCommandEvidence(input:{
  proposal:Proposal;job:VerificationJob;instance:VerificationInstance;
  label:string;output:string;result:VerificationResult;reader:FrozenReader;
}):void {
  const {proposal,job,instance,label,output,result,reader}=input;
  const definition=proposal.spec.cases.find(c=>c.id===instance.caseId&&c.revision===instance.revision);
  ensure(definition?.verifier.kind==='command'&&!definition.verifier.build,
    'Regression evidence supports command detectors without build only');
  const verifier=definition.verifier,tree=join(output,'candidate');
  const read=(path:string):Buffer=>{
    ensure(path.startsWith(output+sep)&&resolve(path)===path&&job.proofs[path],
      'Regression command proof lacks its exact operation manifest');
    const bytes=reader.read(path,output);
    ensure(digest(bytes)===job.proofs[path],'Regression command proof bytes changed');
    return bytes;
  };
  const json=<T>(path:string):T=>JSON.parse(read(path).toString()) as T;
  const paths:string[]=[],reasons:string[]=[];
  function inventory(directory:string,names:string[],record:{proofFiles:string[]}):string[]{
    const expected=names.map(name=>join(directory,name));
    ensure(same(record.proofFiles,expected),'Regression raw result proof inventory differs');
    const complete=[...expected,join(directory,'result.json')];
    for(const path of complete)read(path);
    return complete;
  }
  function process(directory:string,operationId:string,expectedArgs:(intent:ProcessIntent)=>string[]):ProcessResult {
    const intent=json<ProcessIntent>(join(directory,'intent.json'));
    const identity=json<ProcessIdentity>(join(directory,'identity.json'));
    const outcome=json<ProcessResult>(join(directory,'process.json'));
    ensure(intent.operationId===operationId&&intent.cwd===tree
      &&isAbsolute(intent.command)&&basename(intent.command)==='node'
      &&same(intent.args,expectedArgs(intent)), 'Regression command frozen invocation differs');
    ensure(job.intents.filter(value=>same(value,intent)).length===1
      &&job.identities.filter(value=>same(value,identity)).length===1
      &&identity.operationId===operationId&&identity.ownerToken===intent.ownerToken
      &&same(outcome.identity,identity), 'Regression command actual job ownership differs');
    ensure(outcome.reason==='completed'&&outcome.stopped===true&&outcome.signal===null
      &&outcome.stop?.status==='stopped'&&outcome.stop.stopped===true
      &&Array.isArray(outcome.stop.members)&&outcome.stop.members.length===0,
      'Regression command lacks an actual completed stopped process');
    return outcome;
  }
  function guard(path:unknown):string {
    ensure(typeof path==='string'&&isAbsolute(path)&&resolve(path)===path
      &&basename(path)==='command-guard.js','Regression command guard path is invalid');
    return path;
  }
  for(const [index,entry] of (verifier.candidateEntries??[]).entries()){
    const directory=join(output,'candidate-entries','entry-'+(index+1));
    const record=json<CandidateEntryResult>(join(directory,'result.json'));
    ensure(record.executionStatus==='executed'&&record.stopped===true&&record.passed===true
      &&record.exitCode===0&&record.entry===entry,
      'Regression candidate entry must succeed before specific checker attribution');
    const configuration=json<{schemaVersion:number;entry:string;entryDigest:string;cwd:string;node:string;permissions:unknown}>(join(directory,'configuration.json'));
    const outcome=process(directory,'entry-'+digest(job.id+label+instance.id+index).slice(0,48),intent=>{
      const g=guard(intent.args[4]);
      ensure(configuration.schemaVersion===1&&configuration.entry===entry
        &&configuration.cwd===tree&&configuration.entryDigest===digest(reader.read(join(tree,entry)))
        &&same(configuration.permissions,{read:[tree,g],write:[],network:false,childProcess:false}),
        'Regression candidate entry configuration differs');
      return ['--permission','--allow-fs-read='+tree,'--allow-fs-read='+g,'--import',g,join(tree,entry)];
    });
    ensure(outcome.exitCode===0,'Regression candidate entry exit differs');
    const expectedReason=`Actual candidate Node entry ${entry}: exit 0, stopped true`;
    ensure(record.reason===expectedReason,'Regression candidate entry reason differs');
    reasons.push(expectedReason);
    paths.push(...inventory(directory,['configuration.json','intent.json','identity.json','process.json','stdout.log','stderr.log'],record));
  }
  const directory=join(output,'command'),record=json<CommandResult>(join(directory,'result.json'));
  ensure(record.executionStatus==='executed'&&record.stopped===true
    &&record.reason==='Actual independent Node verifier completed',
    'Regression command raw execution did not complete');
  const parser=json<{schemaVersion:number;version:string;module:string;moduleDigest:string;packageRoot:string;grant:string;selectedBy:string}>(join(directory,'parser-runtime.json'));
  ensure(parser.schemaVersion===1&&parser.version==='6.0.3'&&parser.grant==='read-only'
    &&parser.selectedBy==='Supervisor fixed dependency'&&isAbsolute(parser.packageRoot)
    &&parser.module===join(parser.packageRoot,'lib','typescript.js')
    &&/^[a-f0-9]{64}$/.test(parser.moduleDigest),'Regression parser evidence differs');
  const outcome=process(directory,'check-'+digest(job.id+label+instance.id).slice(0,48),intent=>{
    const g=guard(intent.args[7]),parameters=intent.args[10];
    // Repository canonical ordering and frozen sidecar ordering can differ.
    // Bind the exact parsed parameter object, retaining the actual argument text.
    ensure(typeof parameters==='string'&&same(JSON.parse(parameters),instance.parameters),
      'Regression command frozen invocation differs');
    return ['--permission','--allow-fs-read='+proposal.bundle.directory,'--allow-fs-read='+tree,
      '--allow-fs-read='+g,'--allow-fs-read='+parser.packageRoot,'--allow-fs-write='+directory,
      '--import',g,join(proposal.bundle.directory,verifier.entry),tree,parameters];
  });
  const report=json<{schemaVersion:number;checks:CommandResult['checks']}>(join(directory,'report.json'));
  ensure(report.schemaVersion===1&&Array.isArray(report.checks)
    &&same(report.checks,record.checks)&&report.checks.length===instance.obligationIds.length
    &&new Set(report.checks.map(check=>check.obligationId)).size===report.checks.length
    &&report.checks.every(check=>instance.obligationIds.includes(check.obligationId)
      &&['passed','failed'].includes(check.verdict)&&typeof check.reason==='string'&&check.reason.trim()),
    'Regression command actual report differs from its raw result or frozen checks');
  ensure(outcome.exitCode===(report.checks.some(check=>check.verdict==='failed')?1:0),
    'Regression command process exit conflicts with specific checks');
  reasons.push(record.reason);
  paths.push(...inventory(directory,['parser-runtime.json','intent.json','identity.json','process.json','report.json','stdout.log','stderr.log'],record));
  const reconstructed:VerificationResult={instanceId:instance.id,executionStatus:'executed',checks:report.checks,reason:reasons.join('; '),proofFiles:paths};
  ensure(same(result,reconstructed),'Regression aggregate differs from actual command result');
}
