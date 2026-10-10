import type { TaskContract } from './p1.js';
import type { MonitorState,MonitorDecision,MonitorInput } from '../orchestration/loop-policy.js';

export interface MonitorEnvelopeV1 {
  schemaVersion:1;policyVersion:'p6-monitor-v1';contractVersion:number;contractDigest:string;
  state:MonitorState;activeJobId:string|null;
}
export interface InspectionBinding {
  schemaVersion:1;loopId:string;runtimeId:string;projectId:string;runId:string;
  contractVersion:number;contractDigest:string;intentId:string;window:number;evidenceCursor:string;snapshotDigest:string;
}
export type MonitorEvidenceRef = {kind:'runtime-event';seq:number}|{kind:'execution-event';executionId:string;seq:number};
export interface InspectionSnapshot {
  schemaVersion:1;contract:TaskContract;
  runtime:{id:string;phase:string;cursor:number;operations:{id:string;attemptId:string;contractVersion:number;state:string;executionId:string|null}[]};
  executions:{id:string;attemptId:string;state:string;stopConfirmed:boolean;usageStatus:string;usage:unknown;identity:unknown}[];
  evidence:{id:string;reference:MonitorEvidenceRef;digest:string;value:unknown}[];
}
export interface InspectionResult {
  summary:string;assessment:'progress'|'concern'|'insufficient-evidence';
  observations:{evidenceId:string;text:string}[];concerns:{evidenceIds:string[];description:string}[];
  recommendation:'continue-observing'|'request-diagnosis-at-safe-boundary';
}
export interface FrozenInspectionInput {prompt:string;outputSchema:Record<string,unknown>;context:{binding:InspectionBinding;snapshot:InspectionSnapshot}}
export type InspectionDisposition='applied'|'failed'|'unknown'|'discarded-stale-contract'|'discarded-inactive'|'discarded-pending-followup'|'discarded-by-runner';
export interface MonitorEvent {
  seq:number;loopId:string;kind:'health'|'window'|'transition'|'disposition';window:number|null;jobId:string|null;
  record:{observedAt:string;decision?:MonitorDecision['inspection'];healthScan?:boolean;evidenceCursor?:string;signals?:string[];missedWindows?:number;disposition?:InspectionDisposition;reason?:string};
}
export type MonitorObservationInput=MonitorInput;
const string={type:'string',minLength:1,maxLength:12000};
const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const INSPECTION_RESULT_SCHEMA:Record<string,unknown>=object({summary:string,assessment:{type:'string',enum:['progress','concern','insufficient-evidence']},observations:{type:'array',maxItems:128,items:object({evidenceId:string,text:string})},concerns:{type:'array',maxItems:64,items:object({evidenceIds:{type:'array',minItems:1,maxItems:128,items:string},description:string})},recommendation:{type:'string',enum:['continue-observing','request-diagnosis-at-safe-boundary']}});

/** Strict data-only validation; candidate text cannot introduce new authority. */
export function safeMonitorJSON(value:unknown):void {
  let nodes=0;const seen=new Set<object>();
  function walk(item:unknown,depth:number):void{
    if(depth>64||++nodes>100000)throw new Error('Monitor JSON exceeds structural capacity');
    if(item===null||typeof item==='string'||typeof item==='boolean')return;
    if(typeof item==='number'&&Number.isFinite(item))return;
    if(!item||typeof item!=='object'||seen.has(item)||(Array.isArray(item)?Object.getPrototypeOf(item)!==Array.prototype:![Object.prototype,null].includes(Object.getPrototypeOf(item))))throw new Error('Invalid monitor JSON');
    seen.add(item);const keys=Reflect.ownKeys(item);
    for(const key of keys){if(Array.isArray(item)&&key==='length')continue;const d=Object.getOwnPropertyDescriptor(item,key)!;if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key)||!d.enumerable||!('value'in d))throw new Error('Unsafe monitor JSON field');if(Array.isArray(item)&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))throw new Error('Invalid monitor array');walk(d.value,depth+1);}
    if(Array.isArray(item)&&keys.length!==item.length+1)throw new Error('Sparse monitor array');seen.delete(item);
  }walk(value,0);
}
export function parseInspectionResult(value:unknown,evidenceIds:string[]):InspectionResult {
  safeMonitorJSON(value);
  const obj=(v:unknown,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new Error('Invalid inspection result fields');return v as Record<string,unknown>;};
  const text=(v:unknown)=>{if(typeof v!=='string'||!v.trim()||v.length>12000||v.includes('\0'))throw new Error('Invalid inspection result text');return v;};
  const o=obj(value,['summary','assessment','observations','concerns','recommendation']);text(o.summary);
  if(!['progress','concern','insufficient-evidence'].includes(String(o.assessment))||!['continue-observing','request-diagnosis-at-safe-boundary'].includes(String(o.recommendation)))throw new Error('Inspection cannot authorize business actions');
  if(!Array.isArray(o.observations)||o.observations.length>128||!Array.isArray(o.concerns)||o.concerns.length>64)throw new Error('Invalid inspection result arrays');
  for(const item of o.observations){const row=obj(item,['evidenceId','text']);if(!evidenceIds.includes(text(row.evidenceId)))throw new Error('Unknown inspection evidence');text(row.text);}
  for(const item of o.concerns){const row=obj(item,['evidenceIds','description']);text(row.description);if(!Array.isArray(row.evidenceIds)||!row.evidenceIds.length||row.evidenceIds.length>128||new Set(row.evidenceIds).size!==row.evidenceIds.length||row.evidenceIds.some(id=>!evidenceIds.includes(text(id))))throw new Error('Unknown inspection concern evidence');}
  return structuredClone(value) as InspectionResult;
}
