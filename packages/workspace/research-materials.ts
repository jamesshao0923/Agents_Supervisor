import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {safeResultJSON} from '../contracts/p7-results.js';
import type {TaskContract} from '../contracts/p1.js';
import type {MaterialIndex,MaterialEntry,MaterialInput,MaterialRefresh} from '../contracts/p8-materials.js';
import type {MaterialRef,ResearchRequirement,ResearchLimits,ResearchEvidenceContext,CitationRequest,BoundCitation} from '../contracts/p8-research.js';
import {MaterialIntake} from './material-intake.js';
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
export const researchCanonical=canonical;
export function researchDigest(value:unknown):string {safeResultJSON(value);return createHash('sha256').update(canonical(value)).digest('hex');}
const shaText=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
function ensure(v:unknown,m:string):asserts v {if(!v)throw Error('Research materials: '+m);}
function exact(v:unknown,keys:string[]):void {ensure(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'unknown or missing fields');}
function ownRequest(input:object,required:string[],optional:string[]=[]):void {
 ensure(input&&[Object.prototype,null].includes(Object.getPrototypeOf(input)),'host request must be a plain object');
 const descriptors=Object.getOwnPropertyDescriptors(input);ensure(required.every(k=>Object.hasOwn(descriptors,k))&&Reflect.ownKeys(input).every(k=>typeof k==='string'&&[...required,...optional].includes(k)&&descriptors[k]!.enumerable&&Object.hasOwn(descriptors[k]!,'value')),'host request requires exact data fields, not accessors');
}
function nonempty(v:unknown,max=12000):asserts v is string {ensure(typeof v==='string'&&v.trim()&&v.length<=max&&!v.includes('\0'),'invalid string');}
function unique(values:string[]):void {ensure(new Set(values).size===values.length,'duplicate references');}
function integer(v:unknown,min:number,max=Number.MAX_SAFE_INTEGER):asserts v is number {ensure(Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max,'invalid bounded integer');}
function validLimits(limits:ResearchLimits):void {
 exact(limits,['maxContextChars','maxClaims','maxCitations','maxQuoteChars']);integer(limits.maxContextChars,1,200000);integer(limits.maxClaims,1,128);integer(limits.maxCitations,1,512);integer(limits.maxQuoteChars,1,12000);
}
function validInputs(contract:TaskContract,requirements:ResearchRequirement[],limits:ResearchLimits,index:MaterialIndex):void {
 safeResultJSON({contract,requirements,limits});validLimits(limits);exact(contract,['version','goal','criteria']);integer(contract.version,1);nonempty(contract.goal,200000);ensure(Array.isArray(contract.criteria)&&contract.criteria.length>0&&contract.criteria.length<=64,'invalid criteria');
 for(const criterion of contract.criteria){exact(criterion,['id','description','required']);nonempty(criterion.id,128);nonempty(criterion.description);ensure(typeof criterion.required==='boolean','invalid criterion necessity');}unique(contract.criteria.map(c=>c.id));
 ensure(Array.isArray(requirements)&&requirements.length>0&&requirements.length<=64,'invalid requirements');unique(requirements.map(r=>r.criterionId));
 const ids=new Set(index.entries.map(e=>e.id));
 for(const req of requirements){exact(req,['criterionId','question','requiredMaterialIds','cutoff','maxSourceAgeMs']);const criterion=contract.criteria.find(c=>c.id===req.criterionId);ensure(criterion&&req.question===criterion.description,'question must retain the exact admitted criterion');ensure(Array.isArray(req.requiredMaterialIds)&&req.requiredMaterialIds.length<=50&&req.requiredMaterialIds.every(id=>ids.has(id)),'unknown required material');unique(req.requiredMaterialIds);ensure(req.cutoff===null||typeof req.cutoff==='string'&&Number.isFinite(Date.parse(req.cutoff)),'invalid cutoff');integer(req.maxSourceAgeMs,1);}
 ensure(contract.criteria.filter(c=>c.required).every(c=>requirements.some(r=>r.criterionId===c.id)),'required criterion omitted');
}
function refOf(index:MaterialIndex):MaterialRef {return {directory:index.directory,generation:index.generation,indexDigest:index.indexDigest,inputDigest:index.inputDigest};}
function checkRef(ref:MaterialRef,index:MaterialIndex):void {safeResultJSON(ref);exact(ref,['directory','generation','indexDigest','inputDigest']);ensure(canonical(ref)===canonical(refOf(index)),'material reference changed');}
export function citableMaterial(entry:MaterialEntry):boolean {return entry.status==='success'&&entry.raw?.complete===true&&entry.text?.complete===true&&entry.representation!==null;}
function groups(index:MaterialIndex):ResearchEvidenceContext['dependencyGroups'] {
 const entries=index.entries,parent=entries.map((_,i)=>i),edges:{a:number;b:number;reason:'same-origin'|'identical-bytes'}[]=[];
 const find=(i:number):number=>parent[i]===i?i:(parent[i]=find(parent[i]!));
 for(let a=0;a<entries.length;a++)for(let b=a+1;b<entries.length;b++){
  const x=entries[a]!,y=entries[b]!;for(const reason of [x.origin&&x.origin===y.origin?'same-origin':null,x.raw?.complete&&y.raw?.complete&&x.raw.sha256===y.raw.sha256?'identical-bytes':null] as const)if(reason){edges.push({a,b,reason});parent[find(b)]=find(a);}
 }
 const out:ResearchEvidenceContext['dependencyGroups']=[];
 for(let a=0;a<entries.length;a++)if(find(a)===a){const members=entries.flatMap((entry,i)=>find(i)===a?[entry.id]:[]);if(members.length>1)out.push({materialIds:members,reasons:[...new Set(edges.filter(e=>find(e.a)===a).map(e=>e.reason))]});}
 return out;
}
export function projectResearchEvidence(contract:TaskContract,requirements:ResearchRequirement[],limits:ResearchLimits,index:MaterialIndex):ResearchEvidenceContext {
 validInputs(contract,requirements,limits,index);
 const body={schemaVersion:1 as const,purpose:'untrusted-research-evidence' as const,contract:structuredClone(contract),contractDigest:researchDigest(contract),material:refOf(index),requirements:structuredClone(requirements),index:structuredClone(index),sources:index.entries.filter(citableMaterial).map(entry=>({materialId:entry.id,textPath:join(index.directory,entry.text!.path),rawDigest:entry.raw!.sha256,textDigest:entry.text!.sha256,size:entry.text!.size})),dependencyGroups:groups(index),limits:structuredClone(limits)};
 const result={...body,digest:researchDigest(body)};ensure(canonical(result).length<=limits.maxContextChars,'complete context exceeds capacity; partition without dropping coverage');return result;
}
export async function captureResearchEvidence(input:{intake:MaterialIntake;material:MaterialRef;contract:TaskContract;requirements:ResearchRequirement[];limits:ResearchLimits}):Promise<ResearchEvidenceContext> {
 ownRequest(input,['intake','material','contract','requirements','limits']);
 safeResultJSON({material:input.material,contract:input.contract,requirements:input.requirements,limits:input.limits});const frozen=structuredClone({material:input.material,contract:input.contract,requirements:input.requirements,limits:input.limits}),index=await input.intake.inspect(frozen.material.directory);checkRef(frozen.material,index);return projectResearchEvidence(frozen.contract,frozen.requirements,frozen.limits,index);
}
/** Reconstruct from actual snapshots; a self-rehashed context is not sufficient. */
export async function assertResearchEvidenceSnapshot(intake:MaterialIntake,context:ResearchEvidenceContext):Promise<void> {
 safeResultJSON(context);exact(context,['schemaVersion','purpose','contract','contractDigest','material','requirements','index','sources','dependencyGroups','limits','digest']);const frozen=structuredClone(context),actual=await captureResearchEvidence({intake,material:frozen.material,contract:frozen.contract,requirements:frozen.requirements,limits:frozen.limits});ensure(canonical(frozen)===canonical(actual),'research context differs from actual material snapshot');
}
function validUTF16(value:string):boolean {return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);}
/** Literal provenance only: independent semantic support remains a P4 concern. */
export async function bindResearchCitation(intake:MaterialIntake,sourceContext:ResearchEvidenceContext,sourceRequest:CitationRequest):Promise<BoundCitation> {
 safeResultJSON(sourceContext);safeResultJSON(sourceRequest);const context=structuredClone(sourceContext),request=structuredClone(sourceRequest);
 await assertResearchEvidenceSnapshot(intake,context);
 safeResultJSON(request);exact(request,['id','materialId','start','end','quote']);nonempty(request.id,128);nonempty(request.quote,context.limits.maxQuoteChars);ensure(validUTF16(request.quote),'quote splits a code point');integer(request.start,0);integer(request.end,1);ensure(request.end>request.start&&request.end-request.start<=context.limits.maxQuoteChars,'invalid quote span');
 const entry=context.index.entries.find(e=>e.id===request.materialId);ensure(entry&&citableMaterial(entry),'citation needs complete supported material');
 const quote=await intake.quote(context.material.directory,request.materialId,request.start,request.end);ensure(quote.indexDigest===context.material.indexDigest&&quote.text===request.quote&&quote.rawDigest===entry.raw!.sha256&&quote.textDigest===entry.text!.sha256,'literal quote or source digest differs');
 await assertResearchEvidenceSnapshot(intake,context);
 return {...structuredClone(request),material:structuredClone(context.material),coordinate:'utf16-code-units',rawDigest:quote.rawDigest,textDigest:quote.textDigest,quoteDigest:shaText(quote.text),acquiredAt:entry.acquiredAt,requestedURL:entry.requestedURL,finalURL:entry.finalURL,representation:entry.representation!};
}
/** Real refresh observation; it never approves a research result or mutates history. */
export async function observeResearchMaterials(input:{intake:MaterialIntake;context:ResearchEvidenceContext;currentInputs:MaterialInput[];signal?:AbortSignal}):Promise<MaterialRefresh> {
 ownRequest(input,['intake','context','currentInputs'],['signal']);
 safeResultJSON(input.context);safeResultJSON(input.currentInputs);const context=structuredClone(input.context),currentInputs=structuredClone(input.currentInputs),intake=input.intake,signal=input.signal;
 await assertResearchEvidenceSnapshot(intake,context);return intake.refresh(context.material.directory,currentInputs,signal);
}
