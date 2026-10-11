import {createHash} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import type {ScheduledClaim,ScheduledExecutionBrief} from '../contracts/p7-dispatch.js';
import type {TaskResultManifest} from '../contracts/p7-results.js';
import {canonical} from '../verification/candidate.js';
import {assertResultDirectory,inspectResultPackage,materializeResultPackage,type ResultPackage} from './result-package.js';

export interface ScheduledInputSource {manifest:TaskResultManifest;package:ResultPackage}
export interface ScheduledInputReceipt {schemaVersion:1;claimId:string;planDigest:string;indexPath:string;indexDigest:string}
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function ensure(ok:unknown,message:string):asserts ok {if(!ok)throw Error('Scheduled inputs: '+message);}
function sync(path:string):void {const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function immutable(path:string,value:unknown):void {const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,canonical(value));fsyncSync(fd);}finally{closeSync(fd);}}
function locations(claim:ScheduledClaim){ensure(/^claim-[a-f0-9]{64}$/.test(claim.id),'invalid host claim id');return {root:join(claim.workspace,'.supervisor','task-inputs'),id:claim.id};}

/** Informational snapshot only. Permission/alias uncertainty never grants authority. */
function workspaceMode(workspace:string):ScheduledExecutionBrief['workspaceMode'] {
 try {
  assertResultDirectory(workspace);
  for(let path=workspace;;path=dirname(path)){
   try {const stat=lstatSync(join(path,'.git'));return stat.isSymbolicLink()?'unknown':stat.isFile()||stat.isDirectory()?'git-metadata-present':'unknown';}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return 'unknown';}
   // Bare repositories have no .git child; conservatively do not call them plain.
   if(existsSync(join(path,'HEAD'))&&existsSync(join(path,'objects'))&&existsSync(join(path,'config')))return 'git-metadata-present';
   if(dirname(path)===path)break;
  }
  return 'plain-directory';
 }catch{return 'unknown';}
}

/** Host copies complete submitted packages into this branch's excluded input
 * directory. Source callbacks must revalidate current publication provenance;
 * this filesystem helper never grants claim, budget or verification authority. */
export class HostScheduledInputs {
 private briefInputs(claim:ScheduledClaim,sources:ScheduledInputSource[]):ScheduledExecutionBrief['inputs'] {
  this.index(claim,sources);
  return claim.inputBindings.map(binding=>{
   const source=sources.find(s=>s.manifest.taskId===binding.dependencyNodeId)!;
   return {dependencyNodeId:binding.dependencyNodeId,manifestDigest:binding.result.manifestDigest,
    files:source.package.files.map(file=>({path:'.supervisor/task-inputs/'+claim.id+'/packages/'+source.package.id+'/files/'+file.relativePath,digest:file.digest,size:file.size}))};
  });
 }
 /** Invoked only for a newly created actual host claim, never from caller fields. */
 captureBrief(claim:ScheduledClaim,readCurrent:()=>ScheduledInputSource[]):ScheduledExecutionBrief {
  return {schemaVersion:1,workspaceMode:workspaceMode(claim.workspace),reservation:claim.reservation,inputs:this.briefInputs(claim,readCurrent())};
 }
 private assertBrief(claim:ScheduledClaim,sources:ScheduledInputSource[]):void {
  if(!Object.hasOwn(claim,'hostExecutionBrief'))return;
  const brief=claim.hostExecutionBrief;
  ensure(brief&&brief.schemaVersion===1&&brief.reservation===claim.reservation&&hash(brief.inputs)===hash(this.briefInputs(claim,sources)),'host brief differs from actual sealed inputs');
 }

 private index(claim:ScheduledClaim,sources:ScheduledInputSource[]):unknown {
  ensure(sources.length===claim.inputBindings.length,'incomplete input set');
  return {schemaVersion:1,claimId:claim.id,planDigest:claim.planDigest,contractDigest:claim.contractDigest,
   inputs:claim.inputBindings.map(binding=>{const source=sources.find(s=>s.manifest.taskId===binding.dependencyNodeId);ensure(source&&source.package.manifestDigest===binding.result.manifestDigest&&hash(source.manifest)===binding.result.manifestDigest,'source differs from frozen reference');ensure(source.manifest.projectId===claim.projectId&&source.manifest.runId===claim.runId&&source.manifest.contractVersion===claim.contractVersion&&source.manifest.contractDigest===claim.contractDigest,'foreign source scope');return {binding,directory:'packages/'+source.package.id+'/files',manifest:source.manifest,packageIndexDigest:source.package.indexDigest};})};
 }
 prepare(claim:ScheduledClaim,readCurrent:()=>ScheduledInputSource[]):ScheduledInputReceipt|null {
  if(!claim.inputBindings.length&&!Object.hasOwn(claim,'hostExecutionBrief'))return null;
  const sources=readCurrent();this.assertBrief(claim,sources);
  if(!claim.inputBindings.length)return null;
  const index=this.index(claim,sources),{root,id}=locations(claim);
  assertResultDirectory(claim.workspace);
  for(const path of [join(claim.workspace,'.supervisor'),root]){if(!existsSync(path))mkdirSync(path,{mode:0o700});assertResultDirectory(path);}
  const directory=join(root,id),staging=directory+'.staging';
  if(existsSync(directory))return this.verify(claim,readCurrent);
  ensure(!existsSync(staging),'partial input copy requires explicit recovery; not overwritten');
  mkdirSync(staging,{mode:0o700});mkdirSync(join(staging,'packages'),{mode:0o700});
  for(const source of sources){const copy=materializeResultPackage({root:join(staging,'packages'),id:source.package.id,sourceRoot:join(source.package.directory,'files'),manifest:source.manifest});ensure(copy.indexDigest===source.package.indexDigest,'copied modes or inventory differ');}
  ensure(hash(this.index(claim,readCurrent()))===hash(index),'upstream changed during input copy');
  immutable(join(staging,'manifest.json'),index);sync(join(staging,'packages'));sync(staging);renameSync(staging,directory);sync(root);
  return this.verify(claim,readCurrent);
 }
 verify(claim:ScheduledClaim,readCurrent:()=>ScheduledInputSource[]):ScheduledInputReceipt|null {
  if(!claim.inputBindings.length&&!Object.hasOwn(claim,'hostExecutionBrief'))return null;
  const sources=readCurrent();this.assertBrief(claim,sources);
  if(!claim.inputBindings.length)return null;
  const index=this.index(claim,sources),{root,id}=locations(claim),directory=join(root,id),indexPath=join(directory,'manifest.json');
  assertResultDirectory(directory);ensure(readdirSync(directory).sort().join(',')==='manifest.json,packages','input receipt has unexpected entries');
  const stat=lstatSync(indexPath);ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=2*1024*1024,'invalid input index');ensure(readFileSync(indexPath,'utf8')===canonical(index),'input index changed');
  const packageRoot=join(directory,'packages');assertResultDirectory(packageRoot);
  ensure(readdirSync(packageRoot).sort().join(',')===[...new Set(sources.map(s=>s.package.id))].sort().join(','),'input package set changed');
  for(const source of sources){const actual=inspectResultPackage({root:packageRoot,id:source.package.id,manifest:source.manifest});ensure(actual.indexDigest===source.package.indexDigest,'input package bytes or modes changed');}
  return {schemaVersion:1,claimId:claim.id,planDigest:claim.planDigest,indexPath,indexDigest:hash(index)};
 }
}
