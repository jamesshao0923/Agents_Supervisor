import type {SourceRefreshControlContext,SourceRefreshAdaptation,HistoricalMaterialEpoch} from './p4-source-refresh.js';
import type { TaskContract } from './p1.js';
import type { AppliedContractTransition } from './p4-lineage.js';
import { parseVerificationSpec } from './p4.js';
import type { VerificationInstance, VerificationResult, VerificationSpec } from './p4.js';

/** Frozen evidence references, never author supplied semantic authorization. */
export interface SpecimenRef { id:string; revision:number; candidateDigest:string }
export interface FailureWitness {
  id:string; obligationId:string; expectationDigest:string; candidateDigest:string;
  definitionDigest:string; instance:VerificationInstance;
  result:VerificationResult; proofs:Record<string,string>;
}
export interface SpecimenRevision {
  ref:SpecimenRef; controlId:string; kind:'positive-full'|'negative';
  introducedDefinitionDigest:string; predecessor:SpecimenRef|null;
  scope:{obligationId:string;expectationDigest:string}[];
  witnesses:FailureWitness[];
}
export interface ControlEvolutionEntry {
  specimen:SpecimenRef; disposition:'current'|'historical'|'retired';
  successor:SpecimenRef|null;
  retiredScopes:{obligationId:string;transitionId:string}[];
}
export interface ControlEvolutionManifest {
  schemaVersion:1;lineageId:string;baseDefinitionDigest:string|null;
  targetDefinitionDigest:string;transitionIds:string[];entries:ControlEvolutionEntry[];
}
export interface QualifiedDefinitionV2 { schemaVersion:2;finalSpec:VerificationSpec;evolution:ControlEvolutionManifest }
export interface ControlDefinitionBinding { spec:VerificationSpec;contract:TaskContract;definitionDigest:string }
export interface QualificationRow {
  id:string;specimen:SpecimenRef;definitionDigest:string;instance:VerificationInstance;
  role:'current'|'historical-witness';
  context?:{role:'current';digest:string}|{role:'historical';digest:string;epoch:HistoricalMaterialEpoch};
  expected:{obligationId:string;verdict:'passed'|'failed'|'not-applicable';witnessId:string|null}[];
}
export interface FrozenQualificationMatrix {
  schemaVersion:1|2;sourceRefresh?:{context:SourceRefreshControlContext;adaptations:SourceRefreshAdaptation[]};manifestDigest:string;baseDefinitionDigest:string|null;
  targetDefinitionDigest:string;transitionIds:string[];
  rows:QualificationRow[];
  exclusions:{specimen:SpecimenRef;obligationId:string;transitionId:string|null;reason:string}[];
  digest:string;
}
export interface QualificationPairResult { rowId:string;results:VerificationResult[] }
export interface QualificationResult {
  qualified:boolean;matrixDigest:string;reasons:string[];
  rows:{rowId:string;qualified:boolean;reasons:string[]}[];
}
export interface QualificationMatrixInput {
  sourceRefresh?:SourceRefreshControlContext;
  base:ControlDefinitionBinding|null;target:ControlDefinitionBinding;
  transitions:AppliedContractTransition[];manifest:ControlEvolutionManifest;
  specimens:SpecimenRevision[];historicalDefinitions?:ControlDefinitionBinding[];
  /** Exact already-published ancestry; cannot authorize a new scope retirement. */
  historicalTransitions?:AppliedContractTransition[];historicalManifest?:ControlEvolutionManifest;
}

export function safeControlJSON(value:unknown):void {
  let nodes=0;const seen=new Set<object>();
  function walk(item:unknown,depth:number):void {
    if(depth>64||++nodes>200000)throw new Error('Control JSON exceeds structural capacity');
    if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
    if(!item||typeof item!=='object'||seen.has(item)||![Object.prototype,Array.prototype,null].includes(Object.getPrototypeOf(item)))throw new Error('Invalid control JSON');
    seen.add(item);const keys=Reflect.ownKeys(item);
    for(const key of keys){if(Array.isArray(item)&&key==='length')continue;const d=Object.getOwnPropertyDescriptor(item,key)!;if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key)||!d.enumerable||!('value'in d))throw new Error('Unsafe control JSON field');if(Array.isArray(item)&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))throw new Error('Invalid control array');walk(d.value,depth+1);}
    if(Array.isArray(item)&&keys.length!==item.length+1)throw new Error('Sparse control array');seen.delete(item);
  }walk(value,0);
}
function object(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new Error('Invalid control fields');return v as Record<string,unknown>;}
function text(v:unknown):asserts v is string{if(typeof v!=='string'||!v.trim()||v.includes('\0')||v.length>200000)throw new Error('Invalid control text');}
function hash(v:unknown){if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw new Error('Invalid control digest');}
function list(v:unknown,check:(v:unknown)=>void,min=0){if(!Array.isArray(v)||v.length<min||v.length>10000)throw new Error('Invalid control array');for(const x of v)check(x);}
function strings(v:unknown){list(v,text);if(new Set(v as string[]).size!==(v as string[]).length)throw new Error('Duplicate control value');}
function ref(v:unknown){const o=object(v,['id','revision','candidateDigest']);text(o.id);if(!Number.isSafeInteger(o.revision)||(o.revision as number)<1)throw new Error('Invalid specimen revision');hash(o.candidateDigest);}
function instance(v:unknown){const o=object(v,['id','caseId','revision','parameters','obligationIds','required']);text(o.id);text(o.caseId);if(!Number.isSafeInteger(o.revision)||(o.revision as number)<1||typeof o.required!=='boolean')throw new Error('Invalid detector instance');if(!o.parameters||typeof o.parameters!=='object'||Array.isArray(o.parameters))throw new Error('Invalid detector parameters');for(const [k,x]of Object.entries(o.parameters)){text(k);if(typeof x!=='string'||x.includes('\0'))throw new Error('Invalid detector parameter');}strings(o.obligationIds);if(!(o.obligationIds as string[]).length)throw new Error('Empty detector scope');}
export function parseControlResult(value:unknown):VerificationResult {
  safeControlJSON(value);const o=value as Record<string,unknown>;if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!['instanceId','executionStatus','checks','reason','proofFiles'].includes(k))||!['instanceId','executionStatus','checks','reason'].every(k=>Object.hasOwn(o,k)))throw new Error('Invalid control result');text(o.instanceId);text(o.reason);if(!['executed','environment-blocked','verifier-error','not-run'].includes(String(o.executionStatus)))throw new Error('Invalid control execution status');list(o.checks,x=>{const c=object(x,['obligationId','verdict','reason']);text(c.obligationId);text(c.reason);if(!['passed','failed','unknown','not-applicable'].includes(String(c.verdict)))throw new Error('Invalid control verdict');});if(o.proofFiles!==undefined)strings(o.proofFiles);return structuredClone(value) as VerificationResult;
}
export function parseSpecimenRevision(value:unknown):SpecimenRevision {
  safeControlJSON(value);const o=object(value,['ref','controlId','kind','introducedDefinitionDigest','predecessor','scope','witnesses']);ref(o.ref);text(o.controlId);hash(o.introducedDefinitionDigest);if(!['positive-full','negative'].includes(String(o.kind)))throw new Error('Invalid specimen kind');if(o.predecessor!==null)ref(o.predecessor);
  list(o.scope,x=>{const c=object(x,['obligationId','expectationDigest']);text(c.obligationId);hash(c.expectationDigest);},1);if(new Set((o.scope as {obligationId:string}[]).map(x=>x.obligationId)).size!==(o.scope as unknown[]).length)throw new Error('Duplicate specimen scope');
  list(o.witnesses,x=>{const w=object(x,['id','obligationId','expectationDigest','candidateDigest','definitionDigest','instance','result','proofs']);text(w.id);text(w.obligationId);hash(w.expectationDigest);hash(w.candidateDigest);hash(w.definitionDigest);instance(w.instance);parseControlResult(w.result);if(!w.proofs||typeof w.proofs!=='object'||Array.isArray(w.proofs)||!Object.keys(w.proofs).length)throw new Error('Missing witness proof');for(const [path,digest]of Object.entries(w.proofs)){text(path);if(!path.startsWith('/'))throw new Error('Witness proof path must be absolute');hash(digest);}});
  const s=structuredClone(value) as SpecimenRevision;if(new Set(s.witnesses.map(w=>w.id)).size!==s.witnesses.length)throw new Error('Duplicate witness id');if(s.kind==='positive-full'&&s.witnesses.length||s.kind==='negative'&&!s.witnesses.length)throw new Error('Specimen kind lacks exact failure witnesses');return s;
}
export function parseControlEvolutionManifest(value:unknown):ControlEvolutionManifest {
  safeControlJSON(value);const o=object(value,['schemaVersion','lineageId','baseDefinitionDigest','targetDefinitionDigest','transitionIds','entries']);if(o.schemaVersion!==1)throw new Error('Unsupported control evolution version');text(o.lineageId);if(o.baseDefinitionDigest!==null)hash(o.baseDefinitionDigest);hash(o.targetDefinitionDigest);strings(o.transitionIds);
  list(o.entries,x=>{const e=object(x,['specimen','disposition','successor','retiredScopes']);ref(e.specimen);if(!['current','historical','retired'].includes(String(e.disposition)))throw new Error('Invalid specimen disposition');if(e.successor!==null)ref(e.successor);list(e.retiredScopes,x=>{const r=object(x,['obligationId','transitionId']);text(r.obligationId);text(r.transitionId);});const retired=e.retiredScopes as {obligationId:string}[];if(new Set(retired.map(r=>r.obligationId)).size!==retired.length)throw new Error('Duplicate retired control scope');},2);return structuredClone(value) as ControlEvolutionManifest;
}
export function parseQualifiedDefinition(value:unknown):QualifiedDefinitionV2 {
  safeControlJSON(value);const o=object(value,['schemaVersion','finalSpec','evolution']);if(o.schemaVersion!==2)throw new Error('Unsupported qualified definition');return {schemaVersion:2,finalSpec:parseVerificationSpec(o.finalSpec),evolution:parseControlEvolutionManifest(o.evolution)};
}
export function parseFrozenQualificationMatrix(value:unknown):FrozenQualificationMatrix {
  safeControlJSON(value);const refresh=(value as FrozenQualificationMatrix).schemaVersion===2;const o=object(value,['schemaVersion',...(refresh?['sourceRefresh']:[]),'manifestDigest','baseDefinitionDigest','targetDefinitionDigest','transitionIds','rows','exclusions','digest']);if(o.schemaVersion!==1&&o.schemaVersion!==2)throw new Error('Unsupported qualification matrix');hash(o.manifestDigest);hash(o.targetDefinitionDigest);hash(o.digest);if(o.baseDefinitionDigest!==null)hash(o.baseDefinitionDigest);strings(o.transitionIds);
  list(o.rows,x=>{const hasContext=Object.hasOwn(x as object,'context');const r=object(x,['id','specimen','definitionDigest','instance','role','expected',...(hasContext?['context']:[])]);if(refresh&&!hasContext||!refresh&&hasContext)throw new Error('Qualification context role mismatch');if(hasContext){const role=(r.context as {role?:unknown})?.role;if(role!=='current'&&role!=='historical')throw new Error('Invalid qualification context role');const context=object(r.context,['role','digest',...(role==='historical'?['epoch']:[])]);hash(context.digest);if(role==='historical'){const epoch=object(context.epoch,['role','binding','originalJobId','originalProposalId','originalProofs','originalObservation','modelEventsPath','observedAt','specimen','witnessId','digest']);if(epoch.role!=='historical')throw new Error('Invalid historical epoch role');hash(epoch.digest);ref(epoch.specimen);for(const k of ['originalJobId','originalProposalId','modelEventsPath','observedAt','witnessId'])text(epoch[k]);if(!Number.isFinite(Date.parse(epoch.observedAt as string)))throw new Error('Invalid historical observation time');}}text(r.id);ref(r.specimen);hash(r.definitionDigest);instance(r.instance);if(!['current','historical-witness'].includes(String(r.role)))throw new Error('Invalid qualification role');list(r.expected,x=>{const c=object(x,['obligationId','verdict','witnessId']);text(c.obligationId);if(!['passed','failed','not-applicable'].includes(String(c.verdict)))throw new Error('Invalid expected control verdict');if(c.witnessId!==null)text(c.witnessId);},1);},1);
  list(o.exclusions,x=>{const e=object(x,['specimen','obligationId','transitionId','reason']);ref(e.specimen);text(e.obligationId);text(e.reason);if(e.transitionId!==null)text(e.transitionId);});const m=structuredClone(value) as FrozenQualificationMatrix;if(new Set(m.rows.map(r=>r.id)).size!==m.rows.length)throw new Error('Duplicate qualification row');return m;
}
