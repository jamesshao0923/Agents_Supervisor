import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,realpath} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {parse} from 'smol-toml';
import type {VerificationEnvironmentScope} from '../contracts/p4-environment.js';
export type {VerificationEnvironmentScope} from '../contracts/p4-environment.js';
const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
function ensure(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
const within=(p:string,r:string)=>p===r||p.startsWith(r+sep);
const overlap=(a:string,b:string)=>within(a,b)||within(b,a);
function parseConfig(text:string):Record<string,unknown>{try{return parse(text) as Record<string,unknown>;}catch{throw Error('Invalid TOML environment configuration');}}
const rootName=(projectId:string,runId:string)=>'scoped-'+hash(JSON.stringify([projectId,runId]));
export function parseEnvironmentScope(value:unknown,binding?:{projectId:string;runId:string;workspace?:string;dataDir?:string}):VerificationEnvironmentScope {
 ensure(value!==null&&typeof value==='object'&&!Array.isArray(value),'Invalid verification environment scope');
 const s=value as VerificationEnvironmentScope;
 ensure(Object.keys(s).sort().join(',')==='projectId,runId,verificationRoot,version,workspace'&&s.version===1,'Unsupported verification environment scope');
 ensure(typeof s.projectId==='string'&&s.projectId.length>0&&typeof s.runId==='string'&&s.runId.length>0,'Invalid environment Run binding');
 for(const p of [s.workspace,s.verificationRoot])ensure(typeof p==='string'&&isAbsolute(p)&&resolve(p)===p,'Environment scope path is not canonical absolute');
 ensure(basename(s.verificationRoot)===rootName(s.projectId,s.runId)&&basename(dirname(s.verificationRoot))==='verification','Environment root differs from its Run');
 if(binding){ensure(s.projectId===binding.projectId&&s.runId===binding.runId,'Environment scope belongs to another Run');if(binding.workspace!==undefined)ensure(s.workspace===binding.workspace,'Environment scope belongs to another workspace');if(binding.dataDir!==undefined)ensure(s.verificationRoot===join(resolve(binding.dataDir),'verification',rootName(binding.projectId,binding.runId)),'Environment scope belongs to another store');}
 return {...s};
}
async function canonicalDirectory(p:string):Promise<void>{ensure((await lstat(p)).isDirectory()&&await realpath(p)===p,'Environment directory alias or missing directory');}
export async function createEnvironmentScope(dataDir:string,binding:{projectId:string;runId:string;workspace:string}):Promise<VerificationEnvironmentScope>{
 const data=await realpath(dataDir),workspace=await realpath(binding.workspace),verificationRoot=join(data,'verification',rootName(binding.projectId,binding.runId));
 ensure(workspace===binding.workspace,'Environment workspace alias');await mkdir(verificationRoot,{recursive:true,mode:0o700});await canonicalDirectory(verificationRoot);await canonicalDirectory(dirname(verificationRoot));
 return parseEnvironmentScope({version:1,projectId:binding.projectId,runId:binding.runId,workspace,verificationRoot},{...binding,dataDir:data});
}
export function verificationDirectory(dataDir:string,record:{id:string;projectId:string;runId:string;environmentScope?:VerificationEnvironmentScope}):string {
 ensure(typeof record.id==='string'&&/^[A-Za-z0-9_-]+$/.test(record.id),'Unsafe verification identity');
 if(!record.environmentScope)return join(dataDir,'verification',record.id);
 return join(parseEnvironmentScope(record.environmentScope,{...record,dataDir}).verificationRoot,record.id);
}
/** Canonical typed TOML representation; no JSON NaN/null or date/string collisions. */
export function semanticTOML(value:unknown):string {
 if(typeof value==='number')return Number.isNaN(value)?'number:NaN':value===Infinity?'number:+Inf':value===-Infinity?'number:-Inf':Object.is(value,-0)?'number:-0':'number:'+String(value);
 if(typeof value==='bigint')return 'bigint:'+String(value);
 if(value instanceof Date)throw Error('Date/time TOML values are unsupported in scoped environment configuration');
 if(Array.isArray(value))return '['+value.map(semanticTOML).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+semanticTOML((value as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(value);
}
async function readConfig(path:string):Promise<Buffer|null>{
 let stat;try{stat=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=2*1024*1024&&await realpath(path)===path,'Unsafe or oversized environment config');
 return readFile(path);
}
/** Keep all globals. Only a canonical, provably unrelated supported trust-only entry can be removed. */
export async function scopedConfigDigest(text:string,scope:VerificationEnvironmentScope):Promise<string>{
 const s=parseEnvironmentScope(scope),value=parseConfig(text),projects=value.projects;
 if(projects!==undefined){ensure(projects!==null&&typeof projects==='object'&&!Array.isArray(projects),'Invalid projects configuration');const kept=Object.create(null) as Record<string,unknown>;
  for(const [key,entry]of Object.entries(projects)){
   let omit=false;
   if(entry!==null&&typeof entry==='object'&&!Array.isArray(entry)&&Object.keys(entry).length===1&&Object.hasOwn(entry,'trust_level')&&typeof (entry as Record<string,unknown>).trust_level==='string'&&['trusted','untrusted'].includes((entry as Record<string,unknown>).trust_level as string)&&isAbsolute(key)&&resolve(key)===key){
    try{const actual=await realpath(key);omit=actual===key&&!overlap(key,s.workspace)&&!overlap(key,s.verificationRoot);}catch{/* Unresolved path cannot be proved unrelated. */}
   }
   if(!omit)kept[key]=entry;
  }
  if(Object.keys(kept).length)value.projects=kept;else delete value.projects;
 }
 return hash(semanticTOML(value));
}
/** Frozen Run roots keep review/plan/final fingerprints comparable. All missing
 * ancestor layers are represented; creating/changing a layer invalidates them. */
export async function scopedConfiguration(configPath:string,scope:VerificationEnvironmentScope):Promise<{version:1;scope:VerificationEnvironmentScope;global:string;layers:Record<string,string>}>{
 const s=parseEnvironmentScope(scope);for(const root of [s.workspace,s.verificationRoot])await canonicalDirectory(root);
 const raw=await readConfig(configPath),layers:Record<string,string>={};
 for(const root of [s.workspace,s.verificationRoot]){for(let p=root;;p=dirname(p)){const path=join(p,'.codex','config.toml');if(!Object.hasOwn(layers,path)){if(path===configPath)layers[path]='user-global-scoped-above';else{const bytes=await readConfig(path);layers[path]=bytes?hash(semanticTOML(parseConfig(bytes.toString('utf8')))):'absent';}}if(dirname(p)===p)break;}}
 return {version:1,scope:s,global:raw?await scopedConfigDigest(raw.toString('utf8'),s):'absent',layers};
}
/** Run-specific descendants must remain configuration-free: otherwise a deeper
 * project layer was not included in the frozen root environment. */
export async function assertEnvironmentCwd(scope:VerificationEnvironmentScope,cwd:string):Promise<void>{
 const s=parseEnvironmentScope(scope),actual=await realpath(cwd);ensure(actual===cwd,'Model cwd alias');const roots=[s.workspace,s.verificationRoot].filter(r=>within(cwd,r)).sort((a,b)=>b.length-a.length);ensure(roots.length>0,'Model cwd is outside the frozen environment scope');
 for(let p=cwd;p!==roots[0];p=dirname(p))ensure(await readConfig(join(p,'.codex','config.toml'))===null,'Unfrozen descendant project config affects model cwd');
}

/** Scoped reviews receive complete frozen evidence in their prompt/images. Use
 * the stable admitted workspace as actual model cwd, never each new copy tree.
 * Still validate the evidence tree is inside the same frozen Run scope. */
export async function reviewEnvironmentCwd(record:{projectId:string;runId:string;workspace:string;environmentScope?:VerificationEnvironmentScope},evidenceCwd:string):Promise<string>{
 if(!record.environmentScope)return evidenceCwd;
 const scope=parseEnvironmentScope(record.environmentScope,record);
 await assertEnvironmentCwd(scope,evidenceCwd);await assertEnvironmentCwd(scope,scope.workspace);return scope.workspace;
}
