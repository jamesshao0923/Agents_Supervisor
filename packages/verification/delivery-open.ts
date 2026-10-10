import {mkdir,readFile,readdir,rename,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import type {Candidate} from './candidate.js';
import {assertCandidate,canonical,digest} from './candidate.js';
import {FullstackHost,assertOwnedApplication} from './fullstack-host.js';
import {inspectProcess,terminateProcess,type ProcessIntent,type ProcessIdentity,type ProcessResult} from '../process-control/index.js';
export interface DeliveryOpenRequest {type:'open';commandId:string;deliveryId:string;caseId:string;timeoutMs:number}
export interface DeliveryOpenSession {schemaVersion:1;id:string;request:DeliveryOpenRequest;deliveryId:string;candidateDigest:string;entry:string;state:'opening'|'running'|'closed'|'blocked';origin:string|null;dataDirectory:string;intents:ProcessIntent[];identities:ProcessIdentity[];results:ProcessResult[];error:string|null;createdAt:string}
/** Explicit user session over an already authorized delivery snapshot. No Run or P4 mutations. */
export class DeliveryOpenSessions {
 private writes:Promise<unknown>=Promise.resolve();
 private readonly live=new Map<string,FullstackHost>();
 constructor(private readonly root:string){}
 private path(id:string){if(!/^open-[a-f0-9]{64}$/.test(id))throw Error('Invalid open session id');return join(this.root,id,'session.json');}
 private async save(value:DeliveryOpenSession){const path=this.path(value.id),text=canonical(value);const next=this.writes.then(async()=>{await writeFile(path+'.next',text,{mode:0o600});await rename(path+'.next',path);});this.writes=next.catch(()=>{});await next;}
 async get(id:string):Promise<DeliveryOpenSession>{const path=this.path(id),st=await lstat(path);if(!st.isFile()||st.isSymbolicLink())throw Error('Unsafe open receipt');const session=JSON.parse(await readFile(path,'utf8')) as DeliveryOpenSession;if(session.id!==id||session.schemaVersion!==1)throw Error('Invalid open receipt');if(session.state==='running'){const identity=session.identities.at(-1);if(!session.origin||!identity)throw Error('Missing open application identity');try{await assertOwnedApplication(session.origin,identity);}catch(error){session.state='blocked';session.error=String(error);await this.save(session);}}return session;}
 async initialize():Promise<void>{await mkdir(this.root,{recursive:true});for(const name of await readdir(this.root)){if(!/^open-[a-f0-9]{64}$/.test(name))throw Error('Unknown open-session directory');await this.close(name);}}
 async open(request:DeliveryOpenRequest,candidate:Candidate,entry:string):Promise<DeliveryOpenSession>{
  const id='open-'+digest(request.commandId);try{const prior=await this.get(id);if(canonical(prior.request)!==canonical(request)||prior.candidateDigest!==candidate.digest||prior.entry!==entry)throw Error('Open command payload changed');return prior;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!Number.isSafeInteger(request.timeoutMs)||request.timeoutMs<1000||request.timeoutMs>600000)throw Error('Open session requires a bounded deadline');
  await assertCandidate(candidate,false);await mkdir(this.root,{recursive:true});const directory=join(this.root,id);await mkdir(directory,{recursive:false});
  const session:DeliveryOpenSession={schemaVersion:1,id,request:structuredClone(request),deliveryId:request.deliveryId,candidateDigest:candidate.digest,entry,state:'opening',origin:null,dataDirectory:join(directory,'service','database'),intents:[],identities:[],results:[],error:null,createdAt:new Date().toISOString()};await this.save(session);
  const host=new FullstackHost(candidate,entry,join(directory,'service'),request.timeoutMs,undefined,{
   onIntent:async value=>{session.intents.push(value);await this.save(session);},onIdentity:async value=>{session.identities.push(value);await this.save(session);},onComplete:async value=>{session.results.push(value);session.origin=null;session.state=value.stopped&&session.intents.length===session.identities.length?'closed':'blocked';if(value.reason==='timeout')session.error='Open session deadline reached';await this.save(session);}
  });this.live.set(id,host);
  try{session.origin=await host.start();if(session.results.length)throw Error('Application stopped before open acknowledgement');await assertOwnedApplication(session.origin,session.identities.at(-1)!);session.state='running';await this.save(session);return structuredClone(session);}catch(error){session.error=String(error);try{await host.close();}catch(stop){session.error+='; '+String(stop);}session.state=session.intents.length===session.identities.length&&session.results.length===session.identities.length&&session.results.every(r=>r.stopped)?'closed':'blocked';await this.save(session);throw error;}
 }
 async close(id:string):Promise<DeliveryOpenSession>{
  const host=this.live.get(id);if(host){await host.close();this.live.delete(id);}
  const session=await this.get(id);let stopped=session.intents.length===session.identities.length;
  for(const identity of session.identities){try{const state=await inspectProcess(identity);if(state.status!=='stopped')stopped=(await terminateProcess(identity)).stopped&&stopped;}catch{stopped=false;}}
  session.state=stopped?'closed':'blocked';session.origin=null;if(!stopped)session.error='Open session stop unresolved; automatic replay forbidden';await this.save(session);return session;
 }
 async closeAll():Promise<void>{await mkdir(this.root,{recursive:true});for(const name of await readdir(this.root))await this.close(name);}
}
