import {safeResultJSON} from '../contracts/p7-results.js';
import type {ResearchEvidenceContext,ResearchProposal,ValidatedResearchDraft} from '../contracts/p8-research.js';
import type {MaterialIntake} from '../workspace/material-intake.js';
import {assertResearchEvidenceSnapshot,bindResearchCitation,citableMaterial,researchDigest} from '../workspace/research-materials.js';
import {SYMBOLIC_ID_PATTERN,parseReasonerOutput,validateReasonerSchema} from './reasoner-schema.js';
type Schema=Record<string,unknown>;
const object=(properties:Record<string,Schema>):Schema=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text=(max=12000):Schema=>({type:'string',minLength:1,maxLength:max});
const id=():Schema=>({type:'string',pattern:SYMBOLIC_ID_PATTERN,minLength:1,maxLength:128});
const array=(items:Schema,max:number,min=0):Schema=>({type:'array',items,minItems:min,maxItems:max});
const enumeration=(values:string[]):Schema=>({type:'string',enum:values});
function ensure(value:unknown,message:string):asserts value {if(!value)throw Error('Research proposal: '+message);}
function unique(values:string[],label:string):void {ensure(new Set(values).size===values.length,'duplicate '+label);}
function refs(values:string[],allowed:Set<string>,label:string):void {unique(values,label);ensure(values.every(v=>allowed.has(v)),'unknown '+label);}

/** All literals have explicit types. Local subset validation is real; provider
 * acceptance is not inferred from it. No model field can claim host authority. */
export function researchProposalSchema(context:ResearchEvidenceContext):Schema {
 safeResultJSON(context);const frozen=structuredClone(context),materials=frozen.index.entries.map(e=>e.id),criteria=frozen.requirements.map(r=>r.criterionId),supported=frozen.index.entries.filter(citableMaterial).map(e=>e.id);
 ensure(materials.length>0&&criteria.length>0,'context has no materials or requirements');unique(materials,'context material IDs');unique(criteria,'context criterion IDs');
 const limits=frozen.limits;
 const schema=object({
  schemaVersion:{type:'integer',const:1},contextDigest:{type:'string',const:frozen.digest,minLength:64,maxLength:64},
  categories:array(object({id:id(),description:text()}),64),
  citations:array(object({id:id(),materialId:enumeration(supported.length?supported:materials),start:{type:'integer',minimum:0},end:{type:'integer',minimum:1},quote:text(limits.maxQuoteChars)}),supported.length?limits.maxCitations:0),
  claims:array(object({id:id(),criterionIds:array(enumeration(criteria),criteria.length,1),kind:{type:'string',enum:['fact','inference','hypothesis']},text:text(),supportCitationIds:array(id(),limits.maxCitations),counterCitationIds:array(id(),limits.maxCitations),limitations:array(text(),32)}),limits.maxClaims),
  questions:array(object({criterionId:enumeration(criteria),status:{type:'string',enum:['proposed-answer','gap']},claimIds:array(id(),limits.maxClaims),unresolved:array(text(),32)}),criteria.length,criteria.length),
  materials:array(object({materialId:enumeration(materials),categoryIds:array(id(),64),summary:{anyOf:[text(),{type:'null'}]},citationIds:array(id(),limits.maxCitations),unresolved:array(text(),32)}),materials.length,materials.length),
  conflicts:array(object({claimIds:array(id(),limits.maxClaims,2),citationIds:array(id(),limits.maxCitations,1),explanation:text()}),128),
  followups:array(object({criterionIds:array(enumeration(criteria),criteria.length,1),reason:text()}),128)
 });
 return validateReasonerSchema(schema);
}

/** Pure schema + reference/coverage rules only; actual bytes are checked below. */
export function parseResearchProposal(output:unknown,sourceContext:ResearchEvidenceContext):ResearchProposal {
 safeResultJSON(sourceContext);const context=structuredClone(sourceContext);safeResultJSON(output);
 const proposal=parseReasonerOutput(typeof output==='string'?output:JSON.stringify(output),researchProposalSchema(context)) as ResearchProposal;
 for(const category of proposal.categories)ensure(category.description.trim(),'empty category description');
 unique(proposal.categories.map(c=>c.id),'category IDs');unique(proposal.citations.map(c=>c.id),'citation IDs');unique(proposal.claims.map(c=>c.id),'claim IDs');
 const categoryIds=new Set(proposal.categories.map(c=>c.id)),citationIds=new Set(proposal.citations.map(c=>c.id)),claimIds=new Set(proposal.claims.map(c=>c.id)),criterionIds=new Set(context.requirements.map(r=>r.criterionId));
 ensure(proposal.materials.every((m,i)=>m.materialId===context.index.entries[i]!.id),'complete ordered material coverage required');
 ensure(proposal.questions.every((q,i)=>q.criterionId===context.requirements[i]!.criterionId),'complete ordered requirement coverage required');
 for(const claim of proposal.claims){
  ensure(claim.text.trim(),'empty claim text');refs(claim.criterionIds,criterionIds,'claim criterion');refs(claim.supportCitationIds,citationIds,'support citation');refs(claim.counterCitationIds,citationIds,'counter citation');
  ensure(claim.supportCitationIds.every(id=>!claim.counterCitationIds.includes(id)),'same citation cannot be both support and counter evidence');
  ensure(claim.kind!=='fact'||claim.supportCitationIds.length>0,'fact proposal needs literal evidence');
  ensure(claim.kind==='fact'||claim.limitations.some(v=>v.trim()),'interpretation must retain explicit limitations');
 }
 for(const question of proposal.questions){
  refs(question.claimIds,claimIds,'question claim');ensure(question.claimIds.every(id=>proposal.claims.find(c=>c.id===id)!.criterionIds.includes(question.criterionId)),'question claim belongs to another requirement');
  ensure(question.status==='gap'?question.unresolved.some(v=>v.trim()):question.claimIds.length>0,'question needs explicit gap or proposed claims');
 }
 ensure(proposal.claims.every(c=>proposal.questions.some(q=>q.claimIds.includes(c.id))),'claim omitted from requirement coverage');
 for(const material of proposal.materials){
  const entry=context.index.entries.find(e=>e.id===material.materialId)!;refs(material.categoryIds,categoryIds,'material category');refs(material.citationIds,citationIds,'material citation');
  ensure(material.citationIds.every(id=>proposal.citations.find(c=>c.id===id)!.materialId===entry.id),'citation classified under a different material');
  if(!citableMaterial(entry))ensure(material.summary===null&&material.citationIds.length===0&&material.unresolved.some(v=>v.trim()),'unsupported or incomplete material needs explicit unresolved coverage without summary/evidence');
  else if(material.summary===null)ensure(material.unresolved.some(v=>v.trim()),'omitted supported material needs explicit gap');
  else ensure(material.summary.trim()&&material.citationIds.length>0&&material.categoryIds.length>0,'proposed summary needs classification and literal citations');
 }
 ensure(proposal.citations.every(c=>proposal.materials.some(m=>m.materialId===c.materialId&&m.citationIds.includes(c.id))),'citation absent from material coverage');
 for(const conflict of proposal.conflicts){refs(conflict.claimIds,claimIds,'conflict claim');refs(conflict.citationIds,citationIds,'conflict citation');ensure(conflict.explanation.trim(),'empty conflict explanation');}
 for(const followup of proposal.followups){refs(followup.criterionIds,criterionIds,'followup criterion');ensure(followup.reason.trim(),'empty followup reason');}
 // Required materials that are unavailable cannot be concealed behind a
 // proposed answer. This checks acquisition coverage, not semantic support.
 for(const req of context.requirements){
  const unavailable=req.requiredMaterialIds.filter(id=>!citableMaterial(context.index.entries.find(e=>e.id===id)!)),question=proposal.questions.find(q=>q.criterionId===req.criterionId)!;
  if(unavailable.length)ensure(question.status==='gap'&&question.unresolved.some(v=>v.trim()),'required unavailable material prevents proposed answer coverage');
 }
 return proposal;
}

/** Host re-reads exact frozen snapshots, spans and metadata. The returned draft
 * remains untrusted interpretation. No Run, TaskResult or P4 action is invoked. */
export async function validateResearchProposal(input:{intake:MaterialIntake;context:ResearchEvidenceContext;output:unknown}):Promise<ValidatedResearchDraft> {
 ensure(input&&[Object.prototype,null].includes(Object.getPrototypeOf(input)),'host request must be a plain object');const fields=Object.getOwnPropertyDescriptors(input);
 ensure(['intake','context','output'].every(k=>Object.hasOwn(fields,k))&&Reflect.ownKeys(input).every(k=>typeof k==='string'&&['intake','context','output'].includes(k)&&fields[k]!.enumerable&&Object.hasOwn(fields[k]!,'value')),'host request requires exact data fields, not accessors');
 safeResultJSON(input.context);safeResultJSON(input.output);const intake=input.intake,context=structuredClone(input.context),output=structuredClone(input.output),proposal=parseResearchProposal(output,context);
 await assertResearchEvidenceSnapshot(intake,context);
 const citations=[];
 for(const citation of proposal.citations)citations.push(await bindResearchCitation(intake,context,citation));
 await assertResearchEvidenceSnapshot(intake,context);
 const body={authority:'untrusted-draft-only' as const,status:'proposed' as const,contextDigest:context.digest,proposal,citations,coverage:structuredClone(context.index.entries),acquisition:{disposition:context.index.disposition,completeness:context.index.completeness}};
 return {...body,digest:researchDigest(body)};
}
