import {mkdir,readFile,writeFile,realpath,lstat,rename} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {spawnManagedProcess,inspectProcess,type ProcessIdentity,type ProcessIntent,type ProcessResult} from '../process-control/index.js';
import {assertCandidate,relativeFile,digest,type Candidate} from './candidate.js';

const exec=promisify(execFile);
function ensure(v:unknown,message:string):asserts v{if(!v)throw Error(message);}
export async function assertOwnedApplication(origin:string,identity:ProcessIdentity):Promise<void>{
 ensure(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin),'Invalid local application origin');const physical=await inspectProcess(identity);ensure(physical.status==='verified'&&physical.members.length>0,'Local application physical ownership unavailable');const port=new URL(origin).port;let found=false;
 for(const member of physical.members){try{const {stdout}=await exec('/usr/sbin/lsof',['-nP','-a','-p',String(member.pid),'-iTCP:'+port,'-sTCP:LISTEN','-Fpn'],{timeout:5000});if(stdout.includes('p'+member.pid+'\n')&&stdout.includes('n127.0.0.1:'+port))found=true;}catch{/* Other owned group members need not listen. */}}
 ensure(found,'Local listener is outside actual managed ownership');
}
export interface ApplicationHooks {assertEligible?():void;onIntent?(intent:ProcessIntent):void|Promise<void>;onIdentity?(identity:ProcessIdentity):void|Promise<void>;onComplete?(result:ProcessResult):void|Promise<void>}
export interface ApplicationRequest {method:'GET'|'POST'|'PUT'|'DELETE';path:string;body?:unknown}
export interface ApplicationResponse {request:ApplicationRequest;status:number;body:string;sha256:string}
export interface ApplicationProcessProof {generation:number;origin:string|null;identity:ProcessIdentity|null;readyPath:string;stdout:string;stderr:string;result:Awaited<ReturnType<typeof spawnManagedProcess>> extends {completion:Promise<infer R>}?R|null:never}
/** Local, bounded Node application host. Physical process and database facts
 * carry no business acceptance; P4 controls and review remain separate. */
export class FullstackHost {
 private child:Awaited<ReturnType<typeof spawnManagedProcess>>|null=null;
 private deadline=0;
 private closed=false;
 private generation=0;
 private writes:Promise<void>=Promise.resolve();
 private stopping:Promise<void>|null=null;
 private completionWork:Promise<void>|null=null;
 private root='';
 private database='';
 readonly processes:ApplicationProcessProof[]=[];
 readonly requests:ApplicationResponse[]=[];
 constructor(private readonly candidate:Candidate,private readonly entry:string,private readonly output:string,private readonly timeoutMs:number,private readonly signal?:AbortSignal,private readonly hooks:ApplicationHooks={}){}
 private abort=()=>{void this.stop().catch(()=>{});};
 private save(){const bytes=JSON.stringify({schemaVersion:1,candidateDigest:this.candidate.digest,entry:this.entry,databasePath:this.database,processes:this.processes,requests:this.requests},null,2);this.writes=this.writes.then(async()=>{await writeFile(join(this.root,'facts.next.json'),bytes);await rename(join(this.root,'facts.next.json'),join(this.root,'facts.json'));});return this.writes;}
 async start():Promise<string>{
  ensure(!this.closed&&!this.child,'Application host already running or closed');
  if(!this.root){ensure(Number.isSafeInteger(this.timeoutMs)&&this.timeoutMs>=1000&&this.timeoutMs<=600000,'Invalid application host deadline');this.deadline=Date.now()+this.timeoutMs;await assertCandidate(this.candidate,false);const requested=resolve(this.output);const relation=relative(this.candidate.tree,requested);ensure(relation!==''&&(relation==='..'||relation.startsWith('..'+sep)||isAbsolute(relation)),'Application data must be outside frozen candidate');let ancestor=requested;const suffix:string[]=[];for(;;){try{ensure(join(await realpath(ancestor),...suffix)===requested,'Application output ancestor alias');break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;suffix.unshift(basename(ancestor));ancestor=dirname(ancestor);}}await mkdir(dirname(requested),{recursive:true,mode:0o700});await mkdir(requested,{mode:0o700});this.root=await realpath(requested);ensure(this.root===requested,'Application evidence alias');await mkdir(join(this.root,'database'),{mode:0o700});this.database=join(this.root,'database','application.sqlite');this.signal?.addEventListener('abort',this.abort,{once:true});}
  this.hooks.assertEligible?.();this.signal?.throwIfAborted();ensure(Date.now()<this.deadline,'Application deadline exhausted');await assertCandidate(this.candidate,false);
  const entry=await relativeFile(this.candidate.tree,this.entry),launcher=fileURLToPath(new URL('./fullstack-launcher.js',import.meta.url));
  const generation=++this.generation,readyPath=join(this.root,'ready-'+generation+'.json'),nonce=randomUUID();
  const proof:ApplicationProcessProof={generation,origin:null,identity:null,readyPath,stdout:'',stderr:'',result:null};this.processes.push(proof);await this.save();
  try{
   const child=await spawnManagedProcess({operationId:'webapp-'+nonce,command:process.execPath,args:['--permission','--allow-fs-read='+this.candidate.tree,'--allow-fs-read='+launcher,'--allow-fs-read='+join(this.root,'database'),'--allow-fs-write='+join(this.root,'database'),'--allow-fs-write='+readyPath,launcher,entry,this.database,readyPath,nonce],cwd:this.candidate.tree,env:{PATH:process.env.PATH,TMPDIR:this.root,NODE_ENV:'test'},timeoutMs:this.deadline-Date.now(),onBeforeSpawn:async intent=>{await writeFile(join(this.root,'intent-'+generation+'.json'),JSON.stringify(intent),{flag:'wx'});await this.hooks.onIntent?.(intent);this.hooks.assertEligible?.();this.signal?.throwIfAborted();},onIdentity:async identity=>{proof.identity=identity;await this.save();await this.hooks.onIdentity?.(identity);this.signal?.throwIfAborted();}});
   this.child=child;
   child.stdout.on('data',(bytes:Buffer)=>{proof.stdout+=bytes.toString();if(proof.stdout.length>1024*1024)void this.stop();});
   child.stderr.on('data',(bytes:Buffer)=>{proof.stderr+=bytes.toString();if(proof.stderr.length>1024*1024)void this.stop();});
   this.completionWork=child.completion.then(async result=>{proof.result=result;await this.save();await this.hooks.onComplete?.(result);});void this.completionWork.catch(()=>{});
   for(;;){this.signal?.throwIfAborted();ensure(Date.now()<this.deadline&&!proof.result,'Application did not become ready');try{const stat=await lstat(readyPath);ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<4096,'Invalid readiness receipt');const ready=JSON.parse(await readFile(readyPath,'utf8'));ensure(ready.schemaVersion===1&&ready.nonce===nonce&&ready.databasePath===this.database&&Number.isSafeInteger(ready.pid)&&/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.origin),'Application readiness mismatch');const port=new URL(ready.origin).port;const {stdout}=await exec('/usr/sbin/lsof',['-nP','-a','-p',String(ready.pid),'-iTCP:'+port,'-sTCP:LISTEN','-Fpn'],{timeout:5000});ensure(stdout.includes('p'+ready.pid+'\n')&&stdout.includes('n127.0.0.1:'+port),'Actual owned listener absent');const physical=await inspectProcess(proof.identity!);ensure(physical.members.some(member=>member.pid===ready.pid),'Listener is outside managed ownership');proof.origin=ready.origin;await this.save();return ready.origin;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await delay(25);}
  }catch(error){await this.stop();throw error;}
 }
 async request(request:ApplicationRequest):Promise<ApplicationResponse>{
  this.hooks.assertEligible?.();const proof=this.processes.at(-1);ensure(this.child&&proof?.origin&&!proof.result&&!this.closed,'Application is not ready');ensure(['GET','POST','PUT','DELETE'].includes(request.method)&&request.path.startsWith('/')&&!request.path.startsWith('//')&&!/[\\#]/.test(request.path),'Unsupported local application request');this.signal?.throwIfAborted();const url=new URL(request.path,proof.origin);ensure(url.origin===proof.origin,'Application request escapes owned origin');
  ensure(proof.identity,'Application process identity unavailable');await assertOwnedApplication(proof.origin,proof.identity);ensure(this.child&&!proof.result&&!this.closed&&Date.now()<this.deadline,'Application no longer available');
  const response=await fetch(url,{method:request.method,redirect:'error',headers:request.body===undefined?{}:{'content-type':'application/json'},...(request.body===undefined?{}:{body:JSON.stringify(request.body)}),signal:AbortSignal.any([AbortSignal.timeout(Math.max(1,Math.min(10000,this.deadline-Date.now()))),...(this.signal?[this.signal]:[])])});
  const chunks:Buffer[]=[];let size=0;for await(const bytes of response.body??[]){const b=Buffer.from(bytes);size+=b.length;ensure(size<=1024*1024,'Application response exceeds bound');chunks.push(b);}const raw=Buffer.concat(chunks),text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
  await assertOwnedApplication(proof.origin,proof.identity);ensure(this.child&&!proof.result&&!this.closed,'Application no longer available');this.signal?.throwIfAborted();
  const result={request:structuredClone(request),status:response.status,body:text,sha256:digest(raw)};this.requests.push(result);await this.save();return result;
 }
 async stop():Promise<void>{if(this.stopping)return this.stopping;this.stopping=this.stopOnce();try{await this.stopping;}finally{this.stopping=null;}}
 private async stopOnce():Promise<void>{const child=this.child;if(!child)return;const proof=this.processes.at(-1)!;const stopped=await child.terminate();proof.result=await child.completion;await this.completionWork;await this.save();ensure(stopped.stopped&&proof.result.stopped,'Application stop unresolved');this.child=null;await assertCandidate(this.candidate,false);}
 async restart():Promise<string>{await this.stop();return this.start();}
 async close():Promise<void>{this.closed=true;this.signal?.removeEventListener('abort',this.abort);await this.stop();}
}
