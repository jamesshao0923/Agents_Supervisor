import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { canonical, digest, exclusions } from '../verification/candidate.js';
import type { GraphPreparationReceipt, GraphPreparationRequest } from '../contracts/p7-graph.js';
function ensure(v:unknown,s:string):asserts v {if(!v)throw Error(s);}
function same(a:unknown,b:unknown):boolean{return canonical(a)===canonical(b);}
function validate(r:GraphPreparationRequest):void {
 ensure(r.seed.schemaVersion===1&&r.seed.kind==='graph-seed'&&same(r.seed.excluded,exclusions),'Not an exact graph-only seed snapshot');
 ensure(r.schemaVersion===1&&r.commandId.trim()&&r.commandId.length<=200,'Invalid preparation command');
 ensure(/^[a-f0-9]{64}$/.test(r.admissionDigest)&&r.projectId&&r.runId,'Invalid preparation scope');
 ensure(r.taskIds.length>0&&r.taskIds.length<=32&&new Set(r.taskIds).size===r.taskIds.length&&r.taskIds.every(id=>id.trim()&&id.length<=200),'Invalid preparation task IDs');
}
const child=(root:string,path:string)=>path.startsWith(root+sep);
const directoryFor=(hostRoot:string,r:GraphPreparationRequest)=>join(hostRoot,'graph-'+digest(canonical({commandId:r.commandId,projectId:r.projectId,runId:r.runId})));
async function actualDirectory(path:string):Promise<void>{ensure(!(await lstat(path)).isSymbolicLink()&&await realpath(path)===resolve(path),'Graph directory has a path alias');}
function paths(directory:string,r:GraphPreparationRequest){return r.taskIds.map(taskId=>({taskId,path:join(directory,'tasks',digest(taskId),'workspace'),candidateDigest:r.seed.digest}));}
/** Graph seeds may be empty because new user projects have no deliverable yet.
 * This is preparation evidence only, never a P4 candidate/acceptance grant. */
function scanGraphFiles(root:string):Record<string,string>{
 const files:Record<string,string>=Object.create(null) as Record<string,string>;let bytes=0;
 const walk=(path:string)=>{for(const name of readdirSync(path).sort()){
  if(exclusions.includes(name))continue;const absolute=join(path,name),info=lstatSync(absolute);ensure(!info.isSymbolicLink(),'Graph seed contains a symbolic link');
  if(info.isDirectory())walk(absolute);else{ensure(info.isFile(),'Graph seed contains unsupported file type');bytes+=info.size;ensure(Object.keys(files).length<10000&&bytes<=256*1024*1024,'Graph seed exceeds snapshot capacity');files[relative(root,absolute).split(sep).join('/')]=digest(Buffer.concat([readFileSync(absolute),Buffer.from('\0executable:'+String(info.mode&0o111))]));}
 }};walk(root);return files;
}
function assertGraphSeed(seed:GraphPreparationRequest['seed']):void{
 ensure(realpathSync(seed.root)===seed.root&&realpathSync(seed.tree)===seed.tree&&!lstatSync(seed.root).isSymbolicLink()&&!lstatSync(seed.tree).isSymbolicLink(),'Graph seed path alias');
 ensure(digest(canonical(seed.files))===seed.digest&&same(scanGraphFiles(seed.tree),seed.files),'Frozen candidate snapshot is invalid');
 ensure(same(scanGraphFiles(seed.root),seed.files),'Current workspace differs from the verified candidate');
}
export async function captureGraphSeed(root:string,destination:string):Promise<GraphPreparationRequest['seed']>{
 root=await realpath(root);ensure(destination!==root&&!child(root,destination),'Graph seed snapshot must be outside the project');
 const files=scanGraphFiles(root),tree=join(destination,'tree');await mkdir(destination,{mode:0o700});await mkdir(tree,{mode:0o700});
 for(const name of Object.keys(files)){await mkdir(dirname(join(tree,name)),{recursive:true,mode:0o700});await copyFile(join(root,name),join(tree,name));}
 const seed={schemaVersion:1 as const,kind:'graph-seed' as const,root,tree,digest:digest(canonical(files)),files,excluded:[...exclusions],createdAt:new Date().toISOString()};assertGraphSeed(seed);await writeFile(join(destination,'candidate.json'),canonical(seed),{flag:'wx',mode:0o600});return seed;
}
/** Exclusive intent is deliberately retained on partial failure. A restart never
 * treats partially copied files as a complete preparation or deletes user data. */
export async function prepareGraphWorkspaces(hostRoot:string,request:GraphPreparationRequest):Promise<GraphPreparationReceipt>{
 validate(request);await actualDirectory(hostRoot);hostRoot=await realpath(hostRoot);
 ensure(hostRoot!==request.seed.root&&!child(request.seed.root,hostRoot),'Preparation root must be outside the project');
 assertGraphSeed(request.seed);
 const directory=directoryFor(hostRoot,request),intent=join(directory,'intent.json');
 let created=false;try{await mkdir(directory,{mode:0o700});created=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 await actualDirectory(directory);
 if(!created){
  let saved:unknown;try{saved=JSON.parse(await readFile(intent,'utf8'));}catch{throw Error('Incomplete graph preparation retained; intent is unavailable');}
  ensure(same(saved,request),'Graph preparation command conflicts with frozen request');
  let receipt:GraphPreparationReceipt;try{receipt=JSON.parse(await readFile(join(directory,'complete.json'),'utf8')) as GraphPreparationReceipt;}catch{throw Error('Incomplete graph preparation retained; explicit recovery or unused-owned cleanup required');}
  await assertPreparedGraphWorkspaces(receipt,request,hostRoot);return receipt;
 }
 await writeFile(intent,canonical(request),{flag:'wx',mode:0o600});
 const workspaces=paths(directory,request);
 for(const item of workspaces){
  await mkdir(item.path,{recursive:true,mode:0o700});
  for(const name of Object.keys(request.seed.files)){
   const target=join(item.path,name);ensure(child(item.path,target),'Seed file escapes prepared workspace');
   await mkdir(dirname(target),{recursive:true,mode:0o700});await copyFile(join(request.seed.tree,name),target);
  }
  ensure(same(scanGraphFiles(item.path),request.seed.files),'Prepared files or modes differ from frozen seed');
 }
 assertGraphSeed(request.seed);
 const value={schemaVersion:1 as const,state:'complete' as const,request:structuredClone(request),hostRoot,directory,workspaces};
 const receipt={...value,receiptDigest:digest(canonical(value))};
 await writeFile(join(directory,'complete.json'),canonical(receipt),{flag:'wx',mode:0o600});
 await assertPreparedGraphWorkspaces(receipt,request,hostRoot);return receipt;
}
/** Synchronous final revalidation can participate in the existing synchronous
 * P5/SQLite parent transaction. Preparation/copying always happens beforehand. */
export function assertPreparedGraphWorkspaces(receipt:GraphPreparationReceipt,expected:GraphPreparationRequest,hostRoot:string):void{
 const directory=(path:string)=>ensure(lstatSync(path).isDirectory()&&!lstatSync(path).isSymbolicLink()&&realpathSync(path)===resolve(path),'Graph directory has a path alias');
 validate(expected);ensure(receipt.schemaVersion===1&&receipt.state==='complete'&&same(receipt.request,expected),'Preparation scope changed');
 const {receiptDigest,...body}=receipt;ensure(digest(canonical(body))===receiptDigest,'Preparation receipt digest mismatch');
 directory(hostRoot);ensure(receipt.hostRoot===hostRoot&&receipt.directory===directoryFor(hostRoot,expected),'Preparation is outside the host-owned command directory');
 ensure(hostRoot!==expected.seed.root&&!child(expected.seed.root,hostRoot),'Preparation root must be outside the project');
 directory(receipt.directory);
 ensure(same(JSON.parse(readFileSync(join(receipt.directory,'intent.json'),'utf8')),expected),'Preparation intent changed');
 ensure(same(JSON.parse(readFileSync(join(receipt.directory,'complete.json'),'utf8')),receipt),'Preparation receipt changed');
 ensure(same(receipt.workspaces,paths(receipt.directory,expected)),'Prepared workspace mapping changed');
 assertGraphSeed(expected.seed);
 for(const w of receipt.workspaces){directory(w.path);ensure(same(scanGraphFiles(w.path),expected.seed.files),'Prepared files or modes changed');}
}
