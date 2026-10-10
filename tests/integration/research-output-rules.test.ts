import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {MaterialIntake} from '../../packages/workspace/material-intake.js';
import {captureResearchEvidence,citableMaterial,researchDigest} from '../../packages/workspace/research-materials.js';
import {researchExecutionPrompt} from '../../packages/workspace/research-runtime-files.js';
import {researchOutputInstructions} from '../../packages/orchestration/research-instructions.js';
import {researchProposalSchema,parseResearchProposal,validateResearchProposal} from '../../packages/orchestration/research-proposal.js';
import {parseReasonerOutput} from '../../packages/orchestration/reasoner-schema.js';
import type {ResearchEvidenceContext,ResearchProposal} from '../../packages/contracts/p8-research.js';
const source='Visible α😀 facts.\nUnknown usage keeps its original budget reservation.\n';
const workflow='Analysis proposes citations; verification independently checks meaning.\n';
const limits={maxContextChars:200000,maxClaims:8,maxCitations:8,maxQuoteChars:1000};

async function fixture(t:TestContext){
 const root=await realpath(await mkdtemp('/tmp/sv-research-output-rules-')),data=join(root,'data');await mkdir(data);
 const inputs=[{id:'intake',kind:'local' as const,path:join(root,'intake.md')},{id:'workflow',kind:'local' as const,path:join(root,'workflow.md')},{id:'duplicate',kind:'local' as const,path:join(root,'duplicate.md')},{id:'opaque',kind:'local' as const,path:join(root,'opaque.bin')},{id:'missing',kind:'local' as const,path:join(root,'missing.md')}];
 await writeFile(inputs[0]!.path,source);await writeFile(inputs[1]!.path,workflow);await writeFile(inputs[2]!.path,source);await writeFile(inputs[3]!.path,Buffer.from([255,254,0,129]));
 const intake=new MaterialIntake(data),index=await intake.acquire({commandId:'real-output-rules-acquisition',inputs}),material={directory:index.directory,generation:index.generation,indexDigest:index.indexDigest,inputDigest:index.inputDigest},contract={version:1,goal:'Preserve all admitted materials and both original requirements.',criteria:[{id:'research',description:'Classify all admitted materials with explicit partial coverage.',required:true},{id:'roles',description:'Propose the workflow roles supported by the workflow source.',required:true}]},requirements=[{criterionId:'research',question:contract.criteria[0]!.description,requiredMaterialIds:inputs.map(i=>i.id),cutoff:null,maxSourceAgeMs:3600000},{criterionId:'roles',question:contract.criteria[1]!.description,requiredMaterialIds:['workflow'],cutoff:null,maxSourceAgeMs:3600000}],context=await captureResearchEvidence({intake,material,contract,requirements,limits});
 t.after(()=>rm(root,{recursive:true,force:true}));return {root,data,intake,index,context};
}
function proposal(context:ResearchEvidenceContext):ResearchProposal {
 const citations=context.index.entries.filter(citableMaterial).map(e=>({id:'cite-'+e.id,materialId:e.id,start:0,end:(e.id==='workflow'?workflow:source).length,quote:e.id==='workflow'?workflow:source}));
 return {schemaVersion:1,contextDigest:context.digest,categories:[{id:'source',description:'Proposed classification of retained evidence.'}],citations,
  claims:[{id:'claim-intake',criterionIds:['research'],kind:'fact',text:'The intake source discusses retained unknown usage reservation.',supportCitationIds:['cite-intake'],counterCitationIds:[],limitations:[]},{id:'claim-role',criterionIds:['roles'],kind:'fact',text:'Workflow describes analysis and independent verification.',supportCitationIds:['cite-workflow'],counterCitationIds:[],limitations:[]},{id:'claim-dependence',criterionIds:['research'],kind:'inference',text:'The intake and duplicate provide dependent evidence.',supportCitationIds:['cite-intake','cite-duplicate'],counterCitationIds:[],limitations:['Literal provenance alone does not prove the proposed relationship.']}],
  questions:[{criterionId:'research',status:'gap',claimIds:['claim-intake','claim-dependence'],unresolved:['Required opaque and missing materials are unavailable; supported interpretations remain partial.']},{criterionId:'roles',status:'proposed-answer',claimIds:['claim-role'],unresolved:[]}],
  materials:context.index.entries.map(e=>({materialId:e.id,categoryIds:citableMaterial(e)?['source']:[],summary:citableMaterial(e)?'Proposed summary of this material only.':null,citationIds:citableMaterial(e)?['cite-'+e.id]:[],unresolved:citableMaterial(e)?[]:['Actual '+e.status+' material cannot be interpreted; no summary or citation is asserted.']})),conflicts:[],followups:[{criterionIds:['research'],reason:'Obtain interpretable required material only through separately authorized acquisition.'}]};
}
function constraintBlock(prompt:string):Record<string,unknown>{const marker='FROZEN OUTPUT CONSTRAINTS (the host derived these from the actual material archive):\n',text=prompt.split(marker)[1]?.split('\n\nFrozen source context and actual texts:')[0];assert.ok(text);return JSON.parse(text);}

test('P8-RRULE-I01 actual material intake drives full prompt rules ordered scope per-question gaps and literal untrusted positive',async t=>{
 const f=await fixture(t),p=proposal(f.context),prompt=researchExecutionPrompt('Classify the admitted materials; unsupported binary may remain explicitly unsupported.',f.context),block=constraintBlock(prompt);
 assert.deepEqual(f.index.entries.map(e=>[e.id,e.status]),[['intake','success'],['workflow','success'],['duplicate','success'],['opaque','unsupported'],['missing','failed']]);
 assert.deepEqual(block.materialOrder,['intake','workflow','duplicate','opaque','missing']);assert.deepEqual(block.requirementOrder,['research','roles']);assert.deepEqual(block.limits,limits);assert.equal(block.contextDigest,f.context.digest);
 const req=block.requirements as {criterionId:string;unavailableRequiredMaterialIds:string[];allowedQuestionStatuses:string[]}[];assert.deepEqual(req.map(r=>[r.criterionId,r.unavailableRequiredMaterialIds,r.allowedQuestionStatuses]),[['research',['opaque','missing'],['gap']],['roles',[],['gap','proposed-answer']]]);
 const materials=block.materials as {materialId:string;citable:boolean;unavailableRule:string|null}[];assert.deepEqual(materials.map(m=>[m.materialId,m.citable]),[['intake',true],['workflow',true],['duplicate',true],['opaque',false],['missing',false]]);assert.ok(materials.slice(3).every(m=>m.unavailableRule?.includes('summary=null, citationIds=[]')));
 assert.deepEqual(block.dependentEvidenceGroups,f.context.dependencyGroups);assert.ok(f.context.dependencyGroups.some(g=>g.materialIds.includes('intake')&&g.materialIds.includes('duplicate')));
 const texts=JSON.parse(prompt.split('Frozen source context and actual texts:\n\n')[1]!) as {context:ResearchEvidenceContext;sources:{materialId:string;text:string}[]};assert.deepEqual(texts.context,f.context);assert.deepEqual(texts.sources.map(s=>[s.materialId,s.text]),[['intake',source],['workflow',workflow],['duplicate',source]]);
 assert.match(prompt,/Each row's citationIds must ONLY contain citations whose materialId is that row's own materialId/);assert.match(prompt,/Cross-material comparisons.*belong in a claim/);assert.match(prompt,/that question MUST have status="gap"/);assert.match(prompt,/never omit a required field/);assert.match(prompt,/not independent votes/);assert.match(prompt,/half-open UTF16/);
 assert.deepEqual(parseReasonerOutput(JSON.stringify(p),researchProposalSchema(f.context)),p);const draft=await validateResearchProposal({intake:f.intake,context:f.context,output:p});assert.equal(draft.authority,'untrusted-draft-only');assert.equal(draft.acquisition.completeness,'partial');assert.deepEqual(draft.proposal.questions.map(q=>q.status),['gap','proposed-answer']);assert.equal(draft.citations[0]!.quote,source);
 const schemaBefore=researchDigest(researchProposalSchema(f.context));researchOutputInstructions(f.context);assert.equal(researchDigest(researchProposalSchema(f.context)),schemaBefore,'Instructions do not change schema or validator rules');
});

test('P8-RRULE-I02 actual foreign-material and hidden unsupported-answer regressions remain rejected while own citations and partial claims survive',async t=>{
 const f=await fixture(t),base=proposal(f.context),foreign=structuredClone(base);foreign.materials[2]!.citationIds.push('cite-intake','cite-workflow');await assert.rejects(validateResearchProposal({intake:f.intake,context:f.context,output:foreign}),/citation classified under a different material/);
 const hidden=structuredClone(base);hidden.questions[0]!.status='proposed-answer';await assert.rejects(validateResearchProposal({intake:f.intake,context:f.context,output:hidden}),/required unavailable material prevents proposed answer/);
 const originalBytes=await readFile(join(f.index.directory,f.index.entries[0]!.raw!.path));const draft=await validateResearchProposal({intake:f.intake,context:f.context,output:base});assert.deepEqual(draft.proposal.claims[2]!.supportCitationIds,['cite-intake','cite-duplicate']);assert.deepEqual(draft.proposal.materials[2]!.citationIds,['cite-duplicate']);assert.equal(draft.proposal.questions[0]!.claimIds.length,2);assert.deepEqual(await readFile(join(f.index.directory,f.index.entries[0]!.raw!.path)),originalBytes);assert.equal(draft.status,'proposed');
});

test('P8-RRULE-I03 real schema and reference gates reject all described ID claim question conflict and followup violations',async t=>{
 const f=await fixture(t),base=proposal(f.context);
 const cases:[string,(p:ResearchProposal)=>void,RegExp][]=[
  ['duplicate category',p=>p.categories.push({...p.categories[0]!}),/duplicate category/],
  ['empty category',p=>p.categories[0]!.description=' ',/empty category/],
  ['duplicate citation',p=>p.citations.push({...p.citations[0]!}),/duplicate citation/],
  ['duplicate claim',p=>p.claims.push({...p.claims[0]!}),/duplicate claim/],
  ['empty claim',p=>p.claims[0]!.text=' ',/empty claim/],
  ['duplicate criterion',p=>p.claims[0]!.criterionIds=['research','research'],/duplicate claim criterion/],
  ['unknown support',p=>p.claims[0]!.supportCitationIds=['unknown'],/unknown support citation/],
  ['duplicate support',p=>p.claims[0]!.supportCitationIds=['cite-intake','cite-intake'],/duplicate support citation/],
  ['unknown counter',p=>p.claims[0]!.counterCitationIds=['unknown'],/unknown counter citation/],
  ['duplicate counter',p=>p.claims[0]!.counterCitationIds=['cite-workflow','cite-workflow'],/duplicate counter citation/],
  ['overlap support counter',p=>p.claims[0]!.counterCitationIds=['cite-intake'],/both support and counter/],
  ['uncited fact',p=>p.claims[0]!.supportCitationIds=[],/fact proposal needs literal evidence/],
  ['unlimited inference',p=>p.claims[2]!.limitations=[' '],/interpretation must retain explicit limitations/],
  ['unlimited hypothesis',p=>{p.claims[2]!.kind='hypothesis';p.claims[2]!.limitations=[];},/interpretation must retain explicit limitations/],
  ['unknown question claim',p=>p.questions[0]!.claimIds=['unknown'],/unknown question claim/],
  ['duplicate question claim',p=>p.questions[0]!.claimIds.push('claim-intake'),/duplicate question claim/],
  ['wrong criterion claim',p=>p.questions[0]!.claimIds.push('claim-role'),/belongs to another requirement/],
  ['blank gap',p=>p.questions[0]!.unresolved=[' '],/explicit gap or proposed claims/],
  ['empty answer',p=>p.questions[1]!.claimIds=[],/explicit gap or proposed claims/],
  ['orphan claim',p=>p.questions[0]!.claimIds=['claim-intake'],/claim omitted from requirement/],
  ['unordered questions',p=>p.questions.reverse(),/ordered requirement coverage/],
  ['unknown conflict claim',p=>p.conflicts=[{claimIds:['claim-intake','unknown'],citationIds:['cite-intake'],explanation:'Proposed conflict.'}],/unknown conflict claim/],
  ['duplicate conflict claim',p=>p.conflicts=[{claimIds:['claim-intake','claim-intake'],citationIds:['cite-intake'],explanation:'Proposed conflict.'}],/duplicate conflict claim/],
  ['unknown conflict citation',p=>p.conflicts=[{claimIds:['claim-intake','claim-role'],citationIds:['unknown'],explanation:'Proposed conflict.'}],/unknown conflict citation/],
  ['duplicate conflict citation',p=>p.conflicts=[{claimIds:['claim-intake','claim-role'],citationIds:['cite-intake','cite-intake'],explanation:'Proposed conflict.'}],/duplicate conflict citation/],
  ['empty conflict',p=>p.conflicts=[{claimIds:['claim-intake','claim-role'],citationIds:['cite-intake'],explanation:' '}],/empty conflict/],
  ['duplicate followup criterion',p=>p.followups[0]!.criterionIds=['research','research'],/duplicate followup criterion/],
  ['empty followup',p=>p.followups[0]!.reason=' ',/empty followup reason/]
 ];
 for(const [label,mutate,pattern]of cases){const p=structuredClone(base);mutate(p);await assert.rejects(validateResearchProposal({intake:f.intake,context:f.context,output:p}),pattern,label);}
 const schemaCases:unknown[]=[{...base,contextDigest:'0'.repeat(64)},{...base,schemaVersion:2},{...base,verified:true},{...base,categories:[{id:'bad/id',description:'Invalid symbolic ID'}]},{...base,claims:base.claims.map((c,i)=>i===0?{...c,criterionIds:['invented']}:c)},{...base,followups:[{criterionIds:['invented'],reason:'Invalid scope'}]},{...base,conflicts:[{claimIds:['claim-intake'],citationIds:[],explanation:'Insufficient refs'}]},{...base,citations:[{...base.citations[0]!,materialId:'opaque'}]},{...base,citations:Array.from({length:limits.maxCitations+1},()=>base.citations[0]!)},{...base,claims:Array.from({length:limits.maxClaims+1},()=>base.claims[0]!)},{...base,questions:base.questions.slice(0,1)},{...base,claims:base.claims.map((c,i)=>i===0?{...c,text:'x'.repeat(12001)}:c)}];
 for(const p of schemaCases)assert.throws(()=>parseResearchProposal(p,f.context));
 const hostile=structuredClone(base);let reads=0;Object.defineProperty(hostile.claims[0]!,'text',{enumerable:true,get(){reads++;return 'spoof';}});assert.throws(()=>parseResearchProposal(hostile,f.context),/unsafe JSON/);assert.equal(reads,0);
});

test('P8-RRULE-I04 real material coverage gates reject omission misclassification foreign evidence and unsupported invented summaries',async t=>{
 const f=await fixture(t),base=proposal(f.context);
 const cases:[string,(p:ResearchProposal)=>void,RegExp][]=[
  ['wrong order',p=>p.materials.reverse(),/ordered material coverage/],
  ['unknown category',p=>p.materials[0]!.categoryIds=['unknown'],/unknown material category/],
  ['duplicate category reference',p=>p.materials[0]!.categoryIds=['source','source'],/duplicate material category/],
  ['unknown citation',p=>p.materials[0]!.citationIds=['unknown'],/unknown material citation/],
  ['duplicate citation reference',p=>p.materials[0]!.citationIds.push('cite-intake'),/duplicate material citation/],
  ['summary has no category',p=>p.materials[0]!.categoryIds=[],/summary needs classification/],
  ['summary has no evidence',p=>p.materials[0]!.citationIds=[],/summary needs classification/],
  ['empty summary',p=>p.materials[0]!.summary=' ',/summary needs classification/],
  ['supported omission hidden',p=>{p.materials[0]!.summary=null;p.materials[0]!.unresolved=[];},/omitted supported material needs explicit gap/],
  ['unsupported summary',p=>p.materials[3]!.summary='Imagined binary meaning',/unsupported or incomplete/],
  ['unsupported citation',p=>p.materials[3]!.citationIds=['cite-intake'],/different material/],
  ['unsupported unresolved hidden',p=>p.materials[3]!.unresolved=[' '],/unsupported or incomplete/],
  ['failed unresolved hidden',p=>p.materials[4]!.unresolved=[],/unsupported or incomplete/],
  ['citation orphan',p=>{p.materials[2]!.summary=null;p.materials[2]!.citationIds=[];p.materials[2]!.unresolved=['Supported material not interpreted.'];},/citation absent from material coverage/]
 ];for(const [label,mutate,pattern]of cases){const p=structuredClone(base);mutate(p);await assert.rejects(validateResearchProposal({intake:f.intake,context:f.context,output:p}),pattern,label);}
 const omitted=structuredClone(base);omitted.materials.pop();assert.throws(()=>parseResearchProposal(omitted,f.context),/array length/);
 const supportedGap=structuredClone(base);supportedGap.materials[2]!.summary=null;supportedGap.materials[2]!.unresolved=['Supported source omitted from interpretation, retaining evidence provenance.'];assert.equal((await validateResearchProposal({intake:f.intake,context:f.context,output:supportedGap})).authority,'untrusted-draft-only');
});

test('P8-RRULE-I05 actual UTF16 snapshot checks and whole prompt capacity keep exact source bytes and refuse truncation',async t=>{
 const f=await fixture(t),base=proposal(f.context),invalidQuotes:[string,(p:ResearchProposal)=>void][]=[['whitespace quote',p=>p.citations[0]!.quote=' '],['NUL quote',p=>p.citations[0]!.quote='\0'],['changed literal',p=>p.citations[0]!.quote='Invented quote'],['outside range',p=>p.citations[0]!.end=100000],['reversed range',p=>p.citations[0]!.start=p.citations[0]!.end],['newline lost',p=>p.citations[0]!.quote=source.trimEnd()],['split codepoint',p=>{const start=source.indexOf('😀');p.citations[0]={...p.citations[0]!,start,end:start+1,quote:source.slice(start,start+1)};}]];
 for(const [label,mutate]of invalidQuotes){const p=structuredClone(base);mutate(p);await assert.rejects(validateResearchProposal({intake:f.intake,context:f.context,output:p}),error=>error instanceof Error,label);}
 const bad=structuredClone(base);bad.citations[0]!.quote='x'.repeat(limits.maxQuoteChars+1);assert.throws(()=>parseResearchProposal(bad,f.context));
 const snapshotPath=join(f.index.directory,f.index.entries[0]!.text!.path),actual=await readFile(snapshotPath);await writeFile(snapshotPath,'Changed archived source');await assert.rejects(validateResearchProposal({intake:f.intake,context:f.context,output:base}),/snapshot changed/);await writeFile(snapshotPath,actual);
 const prompt=researchExecutionPrompt('Full sources only.',f.context);assert.throws(()=>researchExecutionPrompt('x'.repeat(limits.maxContextChars),f.context),/Complete research prompt exceeds capacity; no source was truncated/);assert.equal(researchExecutionPrompt('Full sources only.',f.context),prompt);
 const forged=structuredClone(f.context);forged.limits.maxContextChars=prompt.length-100;assert.throws(()=>researchExecutionPrompt('Full sources only.',forged),/Complete research prompt exceeds capacity/);
});
