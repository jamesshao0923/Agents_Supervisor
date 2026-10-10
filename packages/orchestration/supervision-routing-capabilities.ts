import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { ExecutionManager } from '../execution/manager.js';
import type { SupervisorStore } from '../persistence/store.js';
import { runtimeCanonical } from '../persistence/runtime.js';
import { inspectProcess } from '../process-control/index.js';
import type { ProcessIdentity } from '../process-control/index.js';
import type { ExecutorCapabilities } from '../contracts/p2.js';
import type { RoutingCapabilities } from '../contracts/p6-routing.js';
import { REASONING_EFFORTS } from './loop-policy.js';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const same=(a:unknown,b:unknown)=>runtimeCanonical(a)===runtimeCanonical(b);
function ensure(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
function read(root:string,path:string):Buffer {const real=realpathSync(path),info=lstatSync(path),suffix=relative(realpathSync(root),real);ensure(path===real&&info.isFile()&&!info.isSymbolicLink()&&suffix&&!isAbsolute(suffix)&&suffix!=='..'&&!suffix.startsWith('..'+sep)&&info.size<=8*1024*1024,'Routing capability proof escaped private root/capacity');return readFileSync(path);}
/** Synchronous real-file validation for transaction-time rechecks. No `available` input. */
export function readRoutingCapabilities(dataDir:string,snapshot:RoutingCapabilities):ExecutorCapabilities {
  const root=join(realpathSync(dataDir),'routing-capabilities'),bytes=read(root,snapshot.proofPath),saved=read(root,snapshot.snapshotPath);
  ensure(hash(bytes)===snapshot.proofDigest&&hash(saved)===snapshot.snapshotDigest,'Routing capability proof digest changed');
  const actual=JSON.parse(saved.toString()) as ExecutorCapabilities;ensure(same(actual,snapshot.capabilities),'Routing capability snapshot changed');
  const events=bytes.toString().trim().split('\n').map(line=>JSON.parse(line) as any),intents=events.filter(e=>e.kind==='intent'),identities=events.filter(e=>e.kind==='identity'),stops=events.filter(e=>e.kind==='stop');
  ensure(intents.length===1&&identities.length===1&&stops.length===1,'Capability probe ownership/stop is incomplete');
  const intent=intents[0].intent,identity=identities[0].identity,result=stops[0].stop,stop=result.stop;
  ensure(same(identity,snapshot.identity)&&identity.operationId===intent.operationId&&identity.ownerToken===intent.ownerToken&&intent.operationId.startsWith('capabilities-')&&Array.isArray(intent.args)&&intent.args.includes('app-server')&&intent.args.includes('--stdio'),'Capability probe is not the original managed discovery process');
  ensure(same(result.identity,identity)&&result.stopped&&stop?.stopped&&stop.status==='stopped'&&Array.isArray(stop.members)&&stop.members.length===0,'Capability probe stop is unknown');
  const pages=events.filter(e=>Array.isArray(e.message?.result?.data)).map(e=>e.message.result);
  ensure(pages.length>0&&pages.length<=10&&!pages.at(-1).nextCursor&&pages.slice(0,-1).every(p=>typeof p.nextCursor==='string'&&p.nextCursor)&&new Set(pages.slice(0,-1).map(p=>p.nextCursor)).size===pages.length-1,'Capability pagination was not complete');
  const models=pages.flatMap(p=>p.data).map((m:any)=>({id:m.model,label:typeof m.displayName==='string'?m.displayName:m.model,inputModalities:m.inputModalities??[],reasoningEfforts:Array.isArray(m.supportedReasoningEfforts)?m.supportedReasoningEfforts.map((e:any)=>e.reasoningEffort):[],defaultEffort:typeof m.defaultReasoningEffort==='string'?m.defaultReasoningEffort:'medium'}));
  ensure(models.length>0&&models.length<=256&&new Set(models.map(m=>m.id)).size===models.length&&models.every(m=>typeof m.id==='string'&&m.id.trim()&&Array.isArray(m.inputModalities)&&m.inputModalities.every((v:unknown)=>typeof v==='string')&&m.reasoningEfforts.length>0&&new Set(m.reasoningEfforts).size===m.reasoningEfforts.length&&m.reasoningEfforts.every((e:any)=>REASONING_EFFORTS.includes(e))),'Invalid advertised model capabilities');
  ensure(same(models,actual.models)&&Number.isFinite(Date.parse(actual.checkedAt))&&Date.parse(actual.checkedAt)>=Date.parse(intent.createdAt)&&Date.parse(actual.checkedAt)<=Date.parse(stop.checkedAt),'Normalized capabilities differ from actual advertised responses');
  ensure(snapshot.id==='routing-capabilities-'+hash(snapshot.proofDigest+snapshot.snapshotDigest).slice(0,24),'Capability identity changed');return actual;
}
/** Fresh instance avoids the execution manager's lifetime cache. capabilities()
 * owns/stops only its probe. Do not call manager.close(), which owns runtime work. */
export async function captureRoutingCapabilities(store:SupervisorStore,dataDir:string):Promise<RoutingCapabilities> {
  const directory=join(realpathSync(dataDir),'routing-capabilities',randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
  const manager=new ExecutionManager(store,directory);const capabilities=await manager.capabilities(),root=join(directory,'capabilities'),logs=(await readdir(root)).filter(path=>path.endsWith('.jsonl'));ensure(logs.length===1,'Capability discovery produced ambiguous evidence');
  const proofPath=join(root,logs[0]!),snapshotPath=join(root,'latest.json'),proofDigest=hash(readFileSync(proofPath)),snapshotDigest=hash(readFileSync(snapshotPath));
  const events=readFileSync(proofPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)),identity=events.find(e=>e.kind==='identity')?.identity as ProcessIdentity;ensure(identity,'Capability process identity missing');
  const value:RoutingCapabilities={id:'routing-capabilities-'+hash(proofDigest+snapshotDigest).slice(0,24),capabilities,proofPath,proofDigest,identity,snapshotPath,snapshotDigest};readRoutingCapabilities(dataDir,value);ensure((await inspectProcess(identity)).status==='stopped','Capability probe has not actually stopped');return value;
}
