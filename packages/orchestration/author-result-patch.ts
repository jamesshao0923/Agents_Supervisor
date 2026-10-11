import {typedPatchInput,expandTypedAuthorPatch,type TypedAuthorPatchContext} from './author-typed-patch.js';
import {parseAuthorStageInput} from './author-stage-protocol.js';
import {resolveStagedAuthor,assertAuthorStageAssemblyProof} from './author-stage-proofs.js';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,sep} from 'node:path';
import type {SupervisionJob} from '../contracts/p6-supervision.js';
import {safeControlJSON} from '../contracts/p4-controls.js';
import {acceptanceAuthoringSchema,type AcceptanceAuthoringContext,type AcceptanceBundle} from './acceptance-authoring.js';
import {isCommandOnlyAuthorContext} from './acceptance-authoring-presentation.js';
import {parseReasonerOutput} from './reasoner-schema.js';

export const AUTHOR_PATCH_PROTOCOL = 'acceptance-replace-v1';
export const AUTHOR_PATCH_PROMPT = 'Supervisor acceptance-recovery patch presentation v5';
const canonical = (v:unknown):string => Array.isArray(v) ? '['+v.map(canonical).join(',')+']'
  : v && typeof v==='object' ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}' : JSON.stringify(v);
const runtimeCanonical = (v:unknown):string => Array.isArray(v) ? '['+v.map(runtimeCanonical).join(',')+']'
  : v && typeof v==='object' ? '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+runtimeCanonical(x)).join(',')+'}' : JSON.stringify(v);
const sha = (v:string|Buffer):string => createHash('sha256').update(v).digest('hex');
export const authorPatchDigest = (v:unknown):string => {safeControlJSON(v);return sha(canonical(v));};
const same = (a:unknown,b:unknown):boolean => canonical(a)===canonical(b);
function ensure(v:unknown,m:string):asserts v {if(!v)throw Error('Author patch: '+m);}
function exact(v:unknown,keys:string[]):asserts v is Record<string,unknown> {
  ensure(v && typeof v==='object' && !Array.isArray(v) && same(Object.keys(v).sort(),[...keys].sort()),'unexpected fields');
}
export interface AuthorPatchBase {
  jobId:string; jobDigest:string; inputDigest:string; resultDigest:string; bundleDigest:string;
}
export interface AuthorPatchContext {
  schemaVersion:1; base:AuthorPatchBase;
  /** Omitted when the original raw feedback already is the complete base. */
  expandedBase?:AcceptanceBundle;
}
interface PatchInput {
  prompt:string;outputSchema:Record<string,unknown>;
  context:{acceptance:AcceptanceAuthoringContext;candidate:unknown;authorPresentation?:unknown;authorPatch?:AuthorPatchContext|TypedAuthorPatchContext;
    authorFeedback:{previousJobId:string;inputDigest:string;rejection:{kind:string;raw:unknown}};evolution?:unknown};
}
export interface AuthorReplacement {path:string;replacementJSON:string}
export interface AuthorPatch {protocol:typeof AUTHOR_PATCH_PROTOCOL;baseJobId:string;baseResultDigest:string;replacements:AuthorReplacement[]}
const obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
export function authorPatchSchema(base:AuthorPatchBase):Record<string,unknown> {
  return obj({protocol:{type:'string',const:AUTHOR_PATCH_PROTOCOL},baseJobId:{type:'string',const:base.jobId},baseResultDigest:{type:'string',const:base.resultDigest},
    replacements:{type:'array',minItems:1,maxItems:64,items:obj({path:{type:'string',minLength:1,maxLength:4096},replacementJSON:{type:'string',minLength:1,maxLength:200000}})}});
}
/** Unknown/nontruthy markers never fall back to a complete-bundle protocol. */
export function patchInput(value:unknown):PatchInput|null {
  const typed=typedPatchInput(value);if(typed)return typed;
  const input=value as PatchInput,context=input?.context;
  const marker=context?.authorPresentation as {schemaVersion?:unknown;kind?:unknown}|undefined;
  const claimsPatch=input?.prompt===AUTHOR_PATCH_PROMPT || context && Object.hasOwn(context,'authorPatch') || marker?.kind==='acceptance-patch' || marker?.schemaVersion===5;
  if(!claimsPatch)return null;
  safeControlJSON(input);
  exact(marker,['schemaVersion','kind']);
  ensure(marker.schemaVersion===5&&marker.kind==='acceptance-patch'&&input.prompt===AUTHOR_PATCH_PROMPT,'Unknown author presentation version or patch protocol');
  ensure(context && !Object.hasOwn(context,'evolution') && !context.acceptance.workflowMode && isCommandOnlyAuthorContext(context.acceptance),'only ordinary command authors support replacement');
  const p=context.authorPatch;ensure(p,'base binding missing');
  exact(p,Object.hasOwn(p,'expandedBase')?['schemaVersion','base','expandedBase']:['schemaVersion','base']);
  ensure(p.schemaVersion===1,'unknown base protocol');
  exact(p.base,['jobId','jobDigest','inputDigest','resultDigest','bundleDigest']);
  ensure(typeof p.base.jobId==='string'&&p.base.jobId.length>0,'base identity missing');
  for(const k of ['jobDigest','inputDigest','resultDigest','bundleDigest'] as const)ensure(typeof p.base[k]==='string'&&/^[a-f0-9]{64}$/.test(p.base[k]),'invalid base digest');
  ensure(context.authorFeedback?.previousJobId===p.base.jobId&&context.authorFeedback.inputDigest===p.base.inputDigest
    &&['semantic','review'].includes(context.authorFeedback.rejection.kind),'base differs from rejection');
  ensure(authorPatchDigest(context.authorFeedback.rejection.raw)===p.base.resultDigest,'raw base output changed');
  const base=p.expandedBase??context.authorFeedback.rejection.raw;
  ensure(authorPatchDigest(base)===p.base.bundleDigest,'complete base changed');
  parseReasonerOutput(JSON.stringify(base),acceptanceAuthoringSchema(context.acceptance));
  ensure(same(input.outputSchema,authorPatchSchema(p.base)),'patch output schema changed');
  return input;
}
export function authorPatchBinding(job:SupervisionJob,bundle:AcceptanceBundle):AuthorPatchBase {
  return {jobId:job.id,jobDigest:authorPatchDigest(job),inputDigest:job.inputDigest,resultDigest:authorPatchDigest(job.result),bundleDigest:authorPatchDigest(bundle)};
}
function pointer(path:string):string[] {
  ensure(typeof path==='string'&&path.startsWith('/')&&path.length>1&&path.length<=4096,'root or invalid pointer');
  const tokens=path.slice(1).split('/').map(t=>{ensure(!/~(?:[^01]|$)/.test(t),'invalid pointer escape');return t.replace(/~1/g,'/').replace(/~0/g,'~');});
  ensure(tokens.every(t=>t.length>0&&!['__proto__','constructor','prototype'].includes(t)),'unsafe pointer key');
  ensure(tokens[0]!=='contextDigest','contextDigest is immutable');
  return tokens;
}
/** One simultaneous replace set against the old tree. No add/delete/move or implicit nodes. */
export function applyAuthorReplacements(base:unknown,replacements:AuthorReplacement[]):unknown {
  safeControlJSON(base);safeControlJSON(replacements);
  ensure(Array.isArray(replacements)&&replacements.length>0&&replacements.length<=64,'replacement count');
  const changes=replacements.map(r=>{exact(r,['path','replacementJSON']);const tokens=pointer(r.path);
    ensure(typeof r.replacementJSON==='string'&&r.replacementJSON.length>0&&r.replacementJSON.length<=200000,'replacement JSON capacity');
    const value:unknown=JSON.parse(r.replacementJSON);safeControlJSON(value);return {tokens,value};});
  for(let i=0;i<changes.length;i++)for(let j=0;j<i;j++){
    const a=changes[i]!.tokens,b=changes[j]!.tokens;
    ensure(!a.slice(0,Math.min(a.length,b.length)).every((t,n)=>t===b[n]),'duplicate or overlapping pointers');
  }
  const result=structuredClone(base);
  for(const {tokens,value}of changes){
    let node=result as Record<string,unknown>;
    for(const [i,key]of tokens.entries()){
      ensure(node!==null&&typeof node==='object'&&Object.hasOwn(node,key),'replacement target does not exist');
      if(Array.isArray(node))ensure(/^(0|[1-9][0-9]*)$/.test(key)&&Number.isSafeInteger(Number(key))&&Number(key)<node.length,'noncanonical array index');
      if(i===tokens.length-1)node[key]=value;
      else node=node[key] as Record<string,unknown>;
    }
  }
  safeControlJSON(result);ensure(canonical(result).length<=200000,'expanded result exceeds capacity');
  return result;
}
export function expandAuthorPatch(input:unknown,raw:unknown):AcceptanceBundle {
  const typed=typedPatchInput(input);if(typed)return expandTypedAuthorPatch(typed,raw);
  const frozen=patchInput(input);ensure(frozen,'patch input required');safeControlJSON(raw);
  const parsed=parseReasonerOutput(JSON.stringify(raw),frozen.outputSchema) as AuthorPatch;
  const bundle=applyAuthorReplacements(frozen.context.authorPatch!.expandedBase??frozen.context.authorFeedback.rejection.raw,parsed.replacements);
  return parseReasonerOutput(JSON.stringify(bundle),acceptanceAuthoringSchema(frozen.context.acceptance)) as AcceptanceBundle;
}
export type ReadAuthorJob=(id:string)=>SupervisionJob;
/** All runtime consumers use this resolver; raw job/model result remains a patch. */
export function assertAuthorPatchBase(job:SupervisionJob,readJob:ReadAuthorJob,dataDir:string,ancestors=new Set<string>()):AuthorPatchBase|null {
  const input=patchInput(job.input);
  if(!input)return null;
  ensure(job.purpose==='acceptance-authoring'&&!ancestors.has(job.id)&&ancestors.size<3,'invalid recovery ancestry');
  ancestors.add(job.id);
  const binding=input.context.authorPatch!.base,base=readJob(binding.jobId);
  ensure(authorPatchDigest(base)===binding.jobDigest&&base.inputDigest===binding.inputDigest&&authorPatchDigest(base.result)===binding.resultDigest,'stale actual base');
  ensure(base.id!==job.id&&base.status==='finished'&&!base.error&&base.result!==null&&base.modelStarted&&base.stopConfirmed&&base.usage!==null&&base.usage>=0,'base is not a known stopped complete output');
  for(const field of ['loopId','runtimeId','projectId','runId','contractVersion','contractDigest','purpose'] as const)ensure(base[field]===job[field],'base scope differs');
  ensure(sha(runtimeCanonical(base.input))===base.inputDigest&&sha(runtimeCanonical({usage:base.reportedUsage??base.usage,stopConfirmed:base.stopConfirmed,error:base.error,proofs:base.proofs,threadId:base.threadId,result:base.result}))===base.completionDigest,'base completion changed');
  const priorInput=base.input as PatchInput;
  ensure(same(priorInput.context.acceptance,input.context.acceptance)&&same(priorInput.context.candidate,input.context.candidate),'frozen requirements or candidate changed');
  parseReasonerOutput(JSON.stringify(base.result),priorInput.outputSchema);
  const directory=join(realpathSync(dataDir),'supervision-reasoning',sha(base.id));let bytes=0;
  ensure(Object.keys(base.proofs).length>0,'base proof inventory empty');
  for(const [path,hash]of Object.entries(base.proofs)){
    const stat=lstatSync(path),actual=realpathSync(path),suffix=relative(directory,actual);
    ensure(stat.isFile()&&!stat.isSymbolicLink()&&suffix!==''&&suffix!=='..'&&!suffix.startsWith('..'+sep)&&!isAbsolute(suffix),'base proof escaped');
    bytes+=stat.size;ensure(bytes<=64*1024*1024&&sha(readFileSync(path))===hash,'base proof changed');
  }
  const read=(name:string)=>{const path=join(directory,name);ensure(Object.hasOwn(base.proofs,path),'base required proof missing');return readFileSync(path,'utf8');};
  ensure(same(JSON.parse(read('output.txt')),base.result)&&same(JSON.parse(read('result.json')).value,base.result),'base raw output differs');
  const prior=resolveAuthorBundle(base,readJob,dataDir,ancestors);
  if(parseAuthorStageInput(base.input))assertAuthorStageAssemblyProof(base,readJob,dataDir);
  else if(prior.receipt)ensure(same(JSON.parse(read('author-expansion.json')),prior.receipt),'base expansion proof differs');
  ensure(authorPatchDigest(prior.bundle)===binding.bundleDigest,'resolved base bundle differs');
  return binding;
}
export function resolveAuthorBundle(job:SupervisionJob,readJob:ReadAuthorJob,dataDir:string,ancestors=new Set<string>()):{bundle:AcceptanceBundle;receipt:Record<string,unknown>|null} {
  if(parseAuthorStageInput(job.input))return resolveStagedAuthor(job,readJob,dataDir);
  const input=patchInput(job.input);
  if(!input)return {bundle:job.result as AcceptanceBundle,receipt:null};
  const binding=assertAuthorPatchBase(job,readJob,dataDir,ancestors)!;
  const bundle=expandAuthorPatch(input,job.result);
  return {bundle,receipt:{schemaVersion:1,kind:'acceptance-patch-expansion',jobId:job.id,inputDigest:job.inputDigest,base:binding,
    patchDigest:authorPatchDigest(job.result),bundleDigest:authorPatchDigest(bundle),assetsDigest:authorPatchDigest({verifierFiles:bundle.verifierFiles,controls:bundle.controls,spec:bundle.spec})}};
}
/** A rejected expansion preserves the actual schema-valid model patch and its cost. */
export function authorExpansionRecord(job:SupervisionJob,readJob:ReadAuthorJob,dataDir:string):Record<string,unknown>|null {
  const base=assertAuthorPatchBase(job,readJob,dataDir);if(!base)return null;
  try{return resolveAuthorBundle(job,readJob,dataDir).receipt;}
  catch(error){return {schemaVersion:1,kind:'acceptance-patch-expansion-rejected',jobId:job.id,inputDigest:job.inputDigest,base,
    patchDigest:authorPatchDigest(job.result),error:error instanceof Error?error.message:String(error)};}
}
export function assertAuthorExpansionProof(job:SupervisionJob,readJob:ReadAuthorJob,dataDir:string):void {
  const receipt=authorExpansionRecord(job,readJob,dataDir);if(!receipt)return;
  const path=join(realpathSync(dataDir),'supervision-reasoning',sha(job.id),'author-expansion.json'),bytes=readFileSync(path);
  ensure(job.proofs[path]===sha(bytes)&&same(JSON.parse(bytes.toString()),receipt),'expanded result proof differs');
}
