/** Pure P7 value protocol. Publication/proof descriptors must be derived by a future
 * trusted repository; parsing these values does not establish filesystem or P4 authority. */
export type ResultState = 'draft'|'submitted'|'verified'|'invalidated';
export interface ResultRef {taskId:string;version:number;manifestDigest:string}
export interface DependencyBinding {dependencyNodeId:string;result:ResultRef;minimumState:'submitted'|'verified'}
export interface ResultArtifact {relativePath:string;digest:string;size:number}
export interface ResultProducer {projectId:string;runId:string;taskId:string;attemptId:string;contractVersion:number;contractDigest:string;planRevision:number;generation:number}
export interface TaskResultManifest extends ResultProducer {
  schemaVersion:1;inputs:DependencyBinding[];artifacts:ResultArtifact[];conclusion:string;
  sources:{id:string;reference:string;digest:string}[];
  checks:{evidenceId:string;verdict:'passed'|'failed'|'unknown'}[];limitations:string[];unresolved:string[];
}
export interface ResultVerification {
  scope:string;manifestDigest:string;candidateDigest:string;contractVersion:number;contractDigest:string;
  frozenPlanId:string;proofDigest:string;stopConfirmed:boolean;usageKnown:boolean;
  checks:{evidenceId:string;required:boolean;verdict:'passed'|'failed'|'unknown'}[];
}
export interface TaskResultVersion {ref:ResultRef;manifest:TaskResultManifest;state:ResultState;verification:ResultVerification|null;invalidation:{reason:string;upstream:ResultRef|null}|null}
export interface ResultConsumer {attemptId:string;taskId:string;inputs:DependencyBinding[];invalidated:boolean}
export interface ResultEvent {type:'draft-staged'|'submitted'|'verified'|'invalidated'|'consumer-bound'|'consumer-invalidated';ref:ResultRef|null;attemptId:string|null;reason:string|null}
export interface ResultReceipt {commandId:string;requestDigest:string;events:ResultEvent[]}
export interface ResultLedger {schemaVersion:1;revision:number;versions:TaskResultVersion[];heads:{taskId:string;ref:ResultRef}[];producers:ResultProducer[];consumers:ResultConsumer[];events:ResultEvent[];receipts:ResultReceipt[]}
type Base={commandId:string;expectedRevision:number};
type ProducerAction={currentProducer:ResultProducer;expectedHead:ResultRef|null};
export type ResultAction =
 |(Base&ProducerAction&{type:'stageDraft';manifest:TaskResultManifest})
 |(Base&ProducerAction&{type:'submit';ref:ResultRef;publication:{artifacts:ResultArtifact[];complete:boolean}})
 |(Base&{type:'recordVerification';ref:ResultRef;verification:ResultVerification})
 |(Base&{type:'invalidate';ref:ResultRef;reason:string})
 |(Base&{type:'bindConsumer';consumer:{attemptId:string;taskId:string;inputs:DependencyBinding[]}});
function fail(message:string):never {throw new Error(`TaskResult: ${message}`);}
export function safeResultJSON(value:unknown):void {
  const seen=new Set<object>();let count=0;
  function visit(v:unknown,depth:number):void {
    if(++count>100000||depth>64)fail('JSON capacity exceeded');
    if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
    if(!v||typeof v!=='object'||seen.has(v)||!(Array.isArray(v)?Object.getPrototypeOf(v)===Array.prototype:[Object.prototype,null].includes(Object.getPrototypeOf(v))))fail('unsafe JSON value');
    seen.add(v);const keys=Reflect.ownKeys(v);
    for(const k of keys){if(Array.isArray(v)&&k==='length')continue;const d=Object.getOwnPropertyDescriptor(v,k)!;
      if(typeof k!=='string'||['__proto__','prototype','constructor'].includes(k)||!d.enumerable||!('value'in d))fail('unsafe JSON field');
      if(Array.isArray(v)&&(!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=v.length))fail('unsafe array');visit(d.value,depth+1);
    }
    if(Array.isArray(v)&&keys.length!==v.length+1)fail('sparse array');seen.delete(v);
  }visit(value,0);
}
type Obj=Record<string,unknown>;
function obj(v:unknown,keys:string[]):Obj {if(!v||typeof v!=='object'||Array.isArray(v))fail('expected object');const o=v as Obj;if(Object.keys(o).length!==keys.length||keys.some(k=>!Object.hasOwn(o,k)))fail('unknown or missing fields');return o;}
function str(v:unknown):asserts v is string {if(typeof v!=='string'||v.trim().length===0||v.length>12000)fail('invalid string');}
function num(v:unknown,min=1):asserts v is number {if(!Number.isSafeInteger(v)||Number(v)<min)fail('invalid integer');}
function digest(v:unknown):void {if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail('invalid digest');}
function bool(v:unknown):void {if(typeof v!=='boolean')fail('invalid boolean');}
function list(v:unknown,check:(item:unknown)=>void,key?:(item:any)=>string):void {if(!Array.isArray(v)||v.length>1024)fail('invalid array');v.forEach(check);if(key&&new Set(v.map(key)).size!==v.length)fail('duplicate array identity');}
const producerKeys=['projectId','runId','taskId','attemptId','contractVersion','contractDigest','planRevision','generation'];
function producerFields(o:Obj):void {for(const k of ['projectId','runId','taskId','attemptId'])str(o[k]);for(const k of ['contractVersion','planRevision','generation'])num(o[k]);digest(o.contractDigest);}
function producer(v:unknown):void {producerFields(obj(v,producerKeys));}
function ref(v:unknown):void {const o=obj(v,['taskId','version','manifestDigest']);str(o.taskId);num(o.version);digest(o.manifestDigest);}
function binding(v:unknown):void {const o=obj(v,['dependencyNodeId','result','minimumState']);str(o.dependencyNodeId);ref(o.result);if(o.dependencyNodeId!==(o.result as ResultRef).taskId)fail('dependency node/ref mismatch');if(o.minimumState!=='submitted'&&o.minimumState!=='verified')fail('invalid minimum state');}
function inputs(v:unknown):void {list(v,binding,i=>i.dependencyNodeId);}
function artifact(v:unknown):void {const o=obj(v,['relativePath','digest','size']);str(o.relativePath);const p=o.relativePath;if(p.startsWith('/')||p.includes('\\')||p.includes('\0')||p.split('/').some(s=>s===''||s==='.'||s==='..')||/^[A-Za-z]:/.test(p))fail('unsafe artifact path');digest(o.digest);num(o.size,0);}
function manifest(v:unknown):void {const o=obj(v,[...producerKeys,'schemaVersion','inputs','artifacts','conclusion','sources','checks','limitations','unresolved']);if(o.schemaVersion!==1)fail('invalid manifest schema');producerFields(o);inputs(o.inputs);list(o.artifacts,artifact,a=>a.relativePath);str(o.conclusion);
 list(o.sources,s=>{const x=obj(s,['id','reference','digest']);str(x.id);str(x.reference);digest(x.digest);},s=>s.id);
 list(o.checks,c=>{const x=obj(c,['evidenceId','verdict']);str(x.evidenceId);if(!['passed','failed','unknown'].includes(String(x.verdict)))fail('invalid verdict');},c=>c.evidenceId);
 list(o.limitations,str);list(o.unresolved,str);
 if((o.inputs as DependencyBinding[]).some(i=>i.result.taskId===o.taskId))fail('self dependency');
}
function verification(v:unknown):void {const o=obj(v,['scope','manifestDigest','candidateDigest','contractVersion','contractDigest','frozenPlanId','proofDigest','stopConfirmed','usageKnown','checks']);for(const k of ['scope','frozenPlanId'])str(o[k]);for(const k of ['manifestDigest','candidateDigest','contractDigest','proofDigest'])digest(o[k]);num(o.contractVersion);bool(o.stopConfirmed);bool(o.usageKnown);list(o.checks,c=>{const x=obj(c,['evidenceId','required','verdict']);str(x.evidenceId);bool(x.required);if(!['passed','failed','unknown'].includes(String(x.verdict)))fail('invalid verdict');},c=>c.evidenceId);}
export function parseDependencyBindings(v:unknown):DependencyBinding[] {safeResultJSON(v);inputs(v);return structuredClone(v) as DependencyBinding[];}
export function parseTaskResultManifest(v:unknown):TaskResultManifest {safeResultJSON(v);manifest(v);return structuredClone(v) as TaskResultManifest;}
export function parseResultAction(v:unknown):ResultAction {
 safeResultJSON(v);if(!v||typeof v!=='object')fail('expected action');const a=v as Obj;
 const common=['type','commandId','expectedRevision'];
 const extra:Record<string,string[]>={stageDraft:['currentProducer','expectedHead','manifest'],submit:['currentProducer','expectedHead','ref','publication'],recordVerification:['ref','verification'],invalidate:['ref','reason'],bindConsumer:['consumer']};
 if(typeof a.type!=='string'||!Object.hasOwn(extra,a.type))fail('unknown action');obj(a,[...common,...extra[a.type]!]);str(a.commandId);num(a.expectedRevision,0);
 if(a.type==='stageDraft'||a.type==='submit'){producer(a.currentProducer);if(a.expectedHead!==null)ref(a.expectedHead);}
 if(a.type==='stageDraft')manifest(a.manifest);
 if(a.type==='submit'){ref(a.ref);const p=obj(a.publication,['artifacts','complete']);bool(p.complete);list(p.artifacts,artifact,x=>x.relativePath);}
 if(a.type==='recordVerification'){ref(a.ref);verification(a.verification);}
 if(a.type==='invalidate'){ref(a.ref);str(a.reason);}
 if(a.type==='bindConsumer'){const c=obj(a.consumer,['attemptId','taskId','inputs']);str(c.attemptId);str(c.taskId);inputs(c.inputs);if((c.inputs as DependencyBinding[]).some(i=>i.result.taskId===c.taskId))fail('self dependency');}
 return structuredClone(a) as ResultAction;
}
