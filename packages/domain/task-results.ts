import {parseDependencyBindings,parseResultAction,parseTaskResultManifest,safeResultJSON} from '../contracts/p7-results.js';
import type {DependencyBinding,ResultAction,ResultEvent,ResultLedger,ResultProducer,ResultRef,TaskResultManifest,TaskResultVersion} from '../contracts/p7-results.js';
/** Trusted composition supplies actual SHA-256. Never expose this dependency in an action.
 * Domain retains canonical serialization and has no platform implementation/import. */
export function createTaskResultDomain({sha256}:{sha256:(canonicalJSON:string)=>string}) {
 ensure(typeof sha256==='function','trusted SHA-256 dependency required');
function ensure(v:unknown,message:string):asserts v {if(!v)throw new Error(`TaskResult: ${message}`);}
/** Canonical data digest, not a claim that the referenced file exists. */
function resultDigest(value:unknown):string {
 safeResultJSON(value);
 function canonical(v:any):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
 const digest=sha256(canonical(value));
 ensure(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest),'trusted SHA-256 returned invalid digest');
 return digest;
}
function equal(a:unknown,b:unknown):boolean {return resultDigest(a)===resultDigest(b);}
function immutable<T>(value:T):T {if(value&&typeof value==='object'){Object.values(value).forEach(immutable);Object.freeze(value);}return value;}
function createResultLedger():ResultLedger {return immutable({schemaVersion:1,revision:0,versions:[],heads:[],producers:[],consumers:[],events:[],receipts:[]});}
function version(ledger:ResultLedger,ref:ResultRef):TaskResultVersion|undefined {return ledger.versions.find(v=>equal(v.ref,ref));}
function head(ledger:ResultLedger,taskId:string):ResultRef|null {return ledger.heads.find(h=>h.taskId===taskId)?.ref??null;}
/** Exact published head plus requested validation status; draft and stale refs never satisfy inputs. */
function resolveDependencies(ledger:ResultLedger,deps:DependencyBinding[],scope?:Pick<ResultProducer,'projectId'|'runId'|'contractVersion'|'contractDigest'>):{ready:boolean;reasons:string[];inputs:DependencyBinding[]} {
 deps=parseDependencyBindings(deps);const reasons:string[]=[];
 if(new Set(deps.map(d=>d.dependencyNodeId)).size!==deps.length)reasons.push('duplicate dependency');
 for(const d of deps){const v=version(ledger,d.result);
  if(d.dependencyNodeId!==d.result.taskId)reasons.push(`dependency/ref mismatch: ${d.dependencyNodeId}`);
  if(!v||!equal(head(ledger,d.result.taskId),d.result))reasons.push(`missing or stale result: ${d.dependencyNodeId}`);
  else if(scope&&(v.manifest.projectId!==scope.projectId||v.manifest.runId!==scope.runId||v.manifest.contractVersion!==scope.contractVersion||v.manifest.contractDigest!==scope.contractDigest))reasons.push(`dependency scope mismatch: ${d.dependencyNodeId}`);
  else if(v.state==='invalidated'||v.state==='draft'||d.minimumState==='verified'&&v.state!=='verified')reasons.push(`minimum result state not met: ${d.dependencyNodeId}`);
  if(d.minimumState!=='submitted'&&d.minimumState!=='verified')reasons.push(`invalid minimum state: ${d.dependencyNodeId}`);
 }
 return immutable({ready:reasons.length===0,reasons,inputs:structuredClone(deps)});
}
/** Reverse closure over exact historical inputs. Unrelated branches are excluded. */
function affectedConsumers(ledger:ResultLedger,changed:ResultRef):string[] {
 ensure(version(ledger,changed),'unknown result ref');const refs:ResultRef[]=[changed];const affected=new Set<string>();let progress=true;
 while(progress){progress=false;for(const v of ledger.versions){if(refs.some(r=>equal(r,v.ref)))continue;if(v.manifest.inputs.some(i=>refs.some(r=>equal(r,i.result)))){refs.push(v.ref);affected.add(v.manifest.attemptId);progress=true;}}}
 for(const c of ledger.consumers)if(c.inputs.some(i=>refs.some(r=>equal(r,i.result))))affected.add(c.attemptId);
 return [...affected].sort();
}
function producerOf(m:TaskResultManifest):ResultProducer {const {projectId,runId,taskId,attemptId,contractVersion,contractDigest,planRevision,generation}=m;return {projectId,runId,taskId,attemptId,contractVersion,contractDigest,planRevision,generation};}
function newer(a:ResultProducer,b:ResultProducer):boolean {for(const k of ['contractVersion','planRevision','generation'] as const){if(a[k]!==b[k])return a[k]>b[k];}return false;}
function validateLedger(ledger:ResultLedger):void {
 safeResultJSON(ledger);ensure(ledger.schemaVersion===1&&Number.isSafeInteger(ledger.revision)&&ledger.revision>=0,'invalid ledger');
 ensure(new Set(ledger.versions.map(v=>`${v.ref.taskId}:${v.ref.version}`)).size===ledger.versions.length,'duplicate version');
 ensure(new Set(ledger.heads.map(h=>h.taskId)).size===ledger.heads.length&&new Set(ledger.producers.map(p=>p.taskId)).size===ledger.producers.length,'duplicate task head');
 ensure(new Set(ledger.consumers.map(c=>c.attemptId)).size===ledger.consumers.length&&new Set(ledger.receipts.map(c=>c.commandId)).size===ledger.receipts.length,'duplicate identity');
 for(const v of ledger.versions){parseTaskResultManifest(v.manifest);ensure(v.ref.taskId===v.manifest.taskId&&v.ref.manifestDigest===resultDigest(v.manifest)&&Number.isSafeInteger(v.ref.version)&&v.ref.version>0,'manifest ref mismatch');ensure(['draft','submitted','verified','invalidated'].includes(v.state),'invalid state');ensure((v.state==='invalidated')===(v.invalidation!==null),'invalidation mismatch');if(v.state==='verified')ensure(v.verification!==null,'missing proof');}
 for(const h of ledger.heads)ensure(h.taskId===h.ref.taskId&&version(ledger,h.ref)?.state!=='draft'&&version(ledger,h.ref),'invalid head');
}
function applyResultAction(input:ResultLedger,raw:ResultAction):{ledger:ResultLedger;events:ResultEvent[]} {
 validateLedger(input);const action=parseResultAction(raw),requestDigest=resultDigest(action),receipt=input.receipts.find(r=>r.commandId===action.commandId);
 if(receipt){ensure(receipt.requestDigest===requestDigest,'command conflict');return immutable({ledger:structuredClone(input),events:structuredClone(receipt.events)});}
 ensure(action.expectedRevision===input.revision,'revision CAS mismatch');const ledger=structuredClone(input),events:ResultEvent[]=[];
 function emit(type:ResultEvent['type'],ref:ResultRef|null,attemptId:string|null,reason:string|null=null):void {events.push({type,ref:structuredClone(ref),attemptId,reason});}
 function invalidate(ref:ResultRef,reason:string):void {
  const queue:ResultRef[]=[ref];const seen=new Set<string>();while(queue.length){const r=queue.shift()!,key=resultDigest(r);if(seen.has(key))continue;seen.add(key);const v=version(ledger,r)!;
   if(v.state!=='invalidated'){v.state='invalidated';v.invalidation={reason,upstream:equal(r,ref)?null:structuredClone(ref)};emit('invalidated',r,v.manifest.attemptId,reason);}
   for(const derived of ledger.versions)if(derived.manifest.inputs.some(i=>equal(i.result,r)))queue.push(derived.ref);
   for(const c of ledger.consumers)if(!c.invalidated&&c.inputs.some(i=>equal(i.result,r))){c.invalidated=true;emit('consumer-invalidated',r,c.attemptId,reason);}
  }
 }
 if(action.type==='stageDraft'||action.type==='submit'){
  const p=action.currentProducer;ensure(equal(head(ledger,p.taskId),action.expectedHead),'head CAS mismatch');
  const scope=ledger.versions[0]?.manifest;ensure(!scope||scope.projectId===p.projectId&&scope.runId===p.runId,'foreign ledger scope');
  const current=ledger.producers.find(x=>x.taskId===p.taskId);
  if(action.type==='stageDraft'){
   ensure(equal(producerOf(action.manifest),p),'producer generation mismatch');ensure(!current||equal(current,p)||newer(p,current),'late producer generation');
   ensure(!current||current.contractVersion!==p.contractVersion||current.contractDigest===p.contractDigest,'contract digest mismatch');
   ensure(!ledger.versions.some(v=>v.manifest.attemptId===p.attemptId),'attempt already staged');
   const readiness=resolveDependencies(ledger,action.manifest.inputs,p);ensure(readiness.ready,readiness.reasons.join('; '));
   const consumer=ledger.consumers.find(c=>c.attemptId===p.attemptId);if(consumer)ensure(!consumer.invalidated&&consumer.taskId===p.taskId&&equal(consumer.inputs,action.manifest.inputs),'frozen consumer inputs mismatch');
   const ref:ResultRef={taskId:p.taskId,version:Math.max(0,...ledger.versions.filter(v=>v.ref.taskId===p.taskId).map(v=>v.ref.version))+1,manifestDigest:resultDigest(action.manifest)};
   ledger.versions.push({ref,manifest:action.manifest,state:'draft',verification:null,invalidation:null});
   if(current)ledger.producers[ledger.producers.indexOf(current)]=p;else ledger.producers.push(p);emit('draft-staged',ref,p.attemptId);
  }else{
   const v=version(ledger,action.ref);ensure(v&&v.state==='draft','submit requires draft');ensure(current&&equal(current,p)&&equal(producerOf(v.manifest),p),'late producer generation');
   ensure(action.publication.complete&&equal(action.publication.artifacts,v.manifest.artifacts),'incomplete publication descriptor');
   const readiness=resolveDependencies(ledger,v.manifest.inputs,v.manifest);ensure(readiness.ready,readiness.reasons.join('; '));
   if(action.expectedHead){ensure(!affectedConsumers(ledger,action.expectedHead).includes(v.manifest.attemptId),'publication would invalidate its own inputs');invalidate(action.expectedHead,'result head superseded');}v.state='submitted';
   const h=ledger.heads.find(h=>h.taskId===p.taskId);if(h)h.ref=structuredClone(v.ref);else ledger.heads.push({taskId:p.taskId,ref:structuredClone(v.ref)});emit('submitted',v.ref,p.attemptId);
  }
 }else if(action.type==='bindConsumer'){
  ensure(!ledger.consumers.some(c=>c.attemptId===action.consumer.attemptId),'consumer already bound');const ready=resolveDependencies(ledger,action.consumer.inputs);ensure(ready.ready,ready.reasons.join('; '));ledger.consumers.push({...action.consumer,invalidated:false});emit('consumer-bound',null,action.consumer.attemptId);
 }else{
  const v=version(ledger,action.ref);ensure(v,'unknown exact ref');
  if(action.type==='invalidate')invalidate(v.ref,action.reason);
  else{
   ensure(v.state==='submitted'&&equal(head(ledger,v.ref.taskId),v.ref),'verification requires current submitted result');const proof=action.verification;
   ensure(proof.manifestDigest===v.ref.manifestDigest&&proof.contractVersion===v.manifest.contractVersion&&proof.contractDigest===v.manifest.contractDigest&&proof.candidateDigest===resultDigest(v.manifest.artifacts),'proof binding mismatch');
   ensure(proof.scope===v.manifest.taskId,'proof scope mismatch');ensure(proof.stopConfirmed&&proof.usageKnown&&proof.checks.some(c=>c.required)&&proof.checks.every(c=>c.verdict==='passed'),'proof not known passed');
   const ready=resolveDependencies(ledger,v.manifest.inputs,v.manifest);ensure(ready.ready,ready.reasons.join('; '));v.verification=proof;v.state='verified';emit('verified',v.ref,v.manifest.attemptId);
  }
 }
 ledger.revision++;ledger.events.push(...events);ledger.receipts.push({commandId:action.commandId,requestDigest,events:structuredClone(events)});return immutable({ledger,events});
}

 return Object.freeze({createResultLedger,applyResultAction,resolveDependencies,affectedConsumers,resultDigest});
}
