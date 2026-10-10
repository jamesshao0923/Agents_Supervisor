import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MaterialIntake} from '../../packages/workspace/material-intake.js';
import {captureResearchEvidence,assertResearchEvidenceSnapshot,bindResearchCitation,observeResearchMaterials,researchDigest,citableMaterial} from '../../packages/workspace/research-materials.js';
import {researchProposalSchema,parseResearchProposal,validateResearchProposal} from '../../packages/orchestration/research-proposal.js';
import {validateReasonerSchema,parseReasonerOutput} from '../../packages/orchestration/reasoner-schema.js';
import type {ResearchEvidenceContext,ResearchProposal} from '../../packages/contracts/p8-research.js';
import type {MaterialInput} from '../../packages/contracts/p8-materials.js';
const original='Visible α😀 facts.\nSecond literal line.\n';
const quote=original.split('\n')[0]!;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const limits={maxContextChars:100000,maxClaims:8,maxCitations:8,maxQuoteChars:12000};
async function fixture(t:TestContext,mixed=false){
 const root=await realpath(await mkdtemp('/tmp/sv-research-bind-')),data=join(root,'data');await mkdir(data);const source=join(root,'notes.md'),pdf=join(root,'unsupported.pdf');await writeFile(source,original);await writeFile(pdf,'%PDF real retained unsupported bytes');
 const server=createServer((request,response)=>{response.writeHead(request.url==='/missing'?503:200,{'content-type':'text/plain'});response.end(request.url==='/missing'?'Actual failure bytes':original);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const url='http://127.0.0.1:'+address.port;
 const intake=new MaterialIntake(data,{allowLoopbackHTTP:true}),inputs:MaterialInput[]=mixed?[{id:'webA',kind:'url',url:url+'/a'},{id:'webB',kind:'url',url:url+'/b'},{id:'local',kind:'local',path:source},{id:'pdf',kind:'local',path:pdf},{id:'missing',kind:'url',url:url+'/missing'}]:[{id:'local',kind:'local',path:source}],index=await intake.acquire({commandId:'actual-acquisition',inputs}),material={directory:index.directory,generation:index.generation,indexDigest:index.indexDigest,inputDigest:index.inputDigest},contract={version:2,goal:'Propose traceable research with complete material coverage.',criteria:[{id:'research',description:'Preserve each material and trace every proposed claim to literal source evidence.',required:true}]},requirements=[{criterionId:'research',question:contract.criteria[0]!.description,requiredMaterialIds:inputs.map(i=>i.id),cutoff:null,maxSourceAgeMs:86400000}],context=await captureResearchEvidence({intake,material,contract,requirements,limits});
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});return {root,data,source,intake,inputs,index,material,contract,requirements,context};
}
function proposal(context:ResearchEvidenceContext):ResearchProposal {
 const entry=context.index.entries.find(citableMaterial),citation=entry?{id:'quote1',materialId:entry.id,start:0,end:quote.length,quote}:null;
 const unavailable=context.requirements[0]!.requiredMaterialIds.some(id=>!citableMaterial(context.index.entries.find(e=>e.id===id)!));
 return {schemaVersion:1,contextDigest:context.digest,categories:entry?[{id:'source',description:'Proposed evidence classification, not semantic approval.'}]:[],citations:citation?[citation]:[],claims:citation?[{id:'claim1',criterionIds:['research'],kind:'fact',text:'Untrusted interpretation of the cited source.',supportCitationIds:['quote1'],counterCitationIds:[],limitations:[]}]:[],questions:[{criterionId:'research',status:unavailable||!entry?'gap':'proposed-answer',claimIds:entry?['claim1']:[],unresolved:unavailable||!entry?['Required material is unavailable or unsupported; analysis remains incomplete.']:[]}],materials:context.index.entries.map(e=>({materialId:e.id,categoryIds:citation?.materialId===e.id?['source']:[],summary:citation?.materialId===e.id?'Proposed summary attached to a real source span.':null,citationIds:citation?.materialId===e.id?['quote1']:[],unresolved:citation?.materialId===e.id?[]:[citableMaterial(e)?'This supported material has not yet been interpreted.':'Original material status retained; no supported interpretation available.']})),conflicts:[],followups:unavailable?[{criterionIds:['research'],reason:'Obtain interpretable required materials; independent semantic review still required.'}]:[]};
}

test('P8-RBIND-I01 real five-material snapshots schema projection span digests and dependent sources remain proposed with explicit partial coverage',async t=>{
 const f=await fixture(t,true),p=proposal(f.context),schema=researchProposalSchema(f.context);assert.deepEqual(validateReasonerSchema(schema),schema);assert.deepEqual(parseReasonerOutput(JSON.stringify(p),schema),p);
 const result=await validateResearchProposal({intake:f.intake,context:f.context,output:JSON.stringify(p)});assert.equal(result.authority,'untrusted-draft-only');assert.equal(result.status,'proposed');assert.deepEqual(result.coverage.map(e=>[e.id,e.status]),[['webA','success'],['webB','success'],['local','success'],['pdf','unsupported'],['missing','failed']]);assert.equal(result.acquisition.completeness,'partial');assert.equal(result.proposal.questions[0]!.status,'gap');
 const bound=result.citations[0]!;assert.equal(bound.quote,quote);assert.equal(bound.quoteDigest,sha(quote));assert.equal(bound.rawDigest,f.index.entries[0]!.raw!.sha256);assert.equal(bound.textDigest,f.index.entries[0]!.text!.sha256);assert.equal(bound.acquiredAt,f.index.entries[0]!.acquiredAt);assert.equal(bound.finalURL,f.index.entries[0]!.finalURL);assert.equal(bound.coordinate,'utf16-code-units');assert.deepEqual(bound.material,f.material);
 assert.ok(f.context.dependencyGroups.some(g=>g.materialIds.includes('webA')&&g.materialIds.includes('webB')&&g.reasons.includes('same-origin')));assert.ok(f.context.dependencyGroups.some(g=>g.materialIds.includes('local')&&g.materialIds.includes('webA')&&g.reasons.includes('identical-bytes')));assert.equal(f.context.index.entries.length,5,'Duplicates do not remove input coverage');assert.equal(Object.hasOwn(result,'independentVotes'),false);
 const semantic=structuredClone(p);semantic.claims[0]!.text='A deliberately unsupported interpretation of those same literal bytes.';const stillUntrusted=await validateResearchProposal({intake:f.intake,context:f.context,output:semantic});assert.equal(stillUntrusted.status,'proposed');assert.equal(stillUntrusted.authority,'untrusted-draft-only');assert.equal(Object.hasOwn(stillUntrusted,'verification'),false);assert.equal(Object.hasOwn(stillUntrusted,'producer'),false);
});

test('P8-RBIND-I02 wrong literal outside span split surrogate unknown source and invented authority are rejected by actual schema and byte binding',async t=>{
 const f=await fixture(t),p=proposal(f.context),citation=p.citations[0]!;
 await assert.rejects(bindResearchCitation(f.intake,f.context,{...citation,quote:'Wrong literal quote'}),/literal quote/);
 await assert.rejects(bindResearchCitation(f.intake,f.context,{...citation,end:100000}),/span/);
 const start=original.indexOf('😀');await assert.rejects(bindResearchCitation(f.intake,f.context,{...citation,start,end:start+1,quote:original.slice(start,start+1)}),/code point/);
 // Positive astral span preserves UTF16 coordinates and exact UTF8 quote SHA.
 const emoji=await bindResearchCitation(f.intake,f.context,{...citation,start,end:start+2,quote:'😀'});assert.equal(emoji.quoteDigest,sha('😀'));
 for(const bad of [{...p,verified:true},{...p,contextDigest:'0'.repeat(64)},{...p,citations:[{...citation,materialId:'hallucinated'}]},{...p,citations:[{...citation,rawDigest:'0'.repeat(64)}]}])assert.throws(()=>parseResearchProposal(bad,f.context));
});

test('P8-RBIND-I03 actual snapshot corruption and self-rehashed metadata cannot authorize a citation or redirect its material scope',async t=>{
 const f=await fixture(t),entry=f.index.entries[0]!,rawPath=join(f.index.directory,entry.raw!.path),textPath=join(f.index.directory,entry.text!.path),raw=await readFile(rawPath),text=await readFile(textPath),request=proposal(f.context).citations[0]!;
 await writeFile(textPath,'Tampered text');await assert.rejects(bindResearchCitation(f.intake,f.context,request),/snapshot changed/);await writeFile(textPath,text);
 await writeFile(rawPath,'Tampered original bytes');await assert.rejects(validateResearchProposal({intake:f.intake,context:f.context,output:proposal(f.context)}),/snapshot changed/);await writeFile(rawPath,raw);
 const forged=structuredClone(f.context);forged.index.entries[0]!.acquiredAt='2000-01-01T00:00:00.000Z';forged.sources[0]!.textPath=f.source;const {digest:old,...body}=forged;void old;forged.digest=researchDigest(body);
 await assert.rejects(bindResearchCitation(f.intake,forged,request),/differs from actual/);await assert.rejects(assertResearchEvidenceSnapshot(f.intake,forged),/differs from actual/);
 await assert.rejects(captureResearchEvidence({intake:f.intake,material:{...f.material,directory:f.root},contract:f.contract,requirements:f.requirements,limits}),/outside managed/);await assert.rejects(captureResearchEvidence({intake:f.intake,material:{...f.material,generation:'other'},contract:f.contract,requirements:f.requirements,limits}),/reference changed/);
 assert.equal((await bindResearchCitation(f.intake,f.context,request)).acquiredAt,entry.acquiredAt);assert.deepEqual(await f.intake.inspect(f.index.directory),f.index);
});

test('P8-RBIND-I04 context request and model objects freeze before async material reads and never inherit late caller metadata',async t=>{
 const f=await fixture(t),context=structuredClone(f.context),request=structuredClone(proposal(context).citations[0]!),pending=bindResearchCitation(f.intake,context,request);context.index.entries[0]!.acquiredAt='2000-01-01T00:00:00.000Z';context.material.generation='changed';request.quote='Late changed literal';request.start=999;
 const bound=await pending;assert.equal(bound.quote,quote);assert.equal(bound.start,0);assert.equal(bound.acquiredAt,f.index.entries[0]!.acquiredAt);assert.equal(bound.material.generation,f.index.generation);
 const output=proposal(f.context),other=structuredClone(f.context),validating=validateResearchProposal({intake:f.intake,context:other,output});output.claims[0]!.text='Late changed claim';output.citations[0]!.quote='Late changed literal';other.sources[0]!.rawDigest='0'.repeat(64);
 const result=await validating;assert.equal(result.proposal.claims[0]!.text,'Untrusted interpretation of the cited source.');assert.equal(result.citations[0]!.quote,quote);assert.equal(result.citations[0]!.rawDigest,f.index.entries[0]!.raw!.sha256);
});

test('P8-RBIND-I05 typed schema bounds and safe JSON reject executable accessors sparse arrays duplicate references and empty answers',async t=>{
 const f=await fixture(t),p=proposal(f.context);let accessed=0;const hostile=structuredClone(f.context);Object.defineProperty(hostile.index.entries[0]!,'acquiredAt',{enumerable:true,get(){accessed++;return 'spoof';}});await assert.rejects(bindResearchCitation(f.intake,hostile,p.citations[0]!),/unsafe JSON field/);assert.equal(accessed,0);
 const output=structuredClone(p);Object.defineProperty(output.claims[0]!,'text',{enumerable:true,get(){accessed++;return 'spoof';}});assert.throws(()=>parseResearchProposal(output,f.context),/unsafe JSON field/);assert.equal(accessed,0);
 const envelope={intake:f.intake,context:f.context,output:p};Object.defineProperty(envelope,'context',{enumerable:true,get(){accessed++;return f.context;}});await assert.rejects(validateResearchProposal(envelope),/data fields, not accessors/);assert.equal(accessed,0);
 const capturing={intake:f.intake,material:f.material,contract:f.contract,requirements:f.requirements,limits};Object.defineProperty(capturing,'material',{enumerable:true,get(){accessed++;return f.material;}});await assert.rejects(captureResearchEvidence(capturing),/data fields, not accessors/);assert.equal(accessed,0);
 const sparse=structuredClone(p);delete sparse.materials[0];assert.throws(()=>parseResearchProposal(sparse,f.context),/sparse array/);
 const duplicate=structuredClone(p);duplicate.claims[0]!.supportCitationIds=['quote1','quote1'];assert.throws(()=>parseResearchProposal(duplicate,f.context),/duplicate support/);
 const empty=structuredClone(p);empty.questions[0]!.claimIds=[];assert.throws(()=>parseResearchProposal(empty,f.context),/proposed claims/);
 const tooMany=structuredClone(p);tooMany.citations=Array.from({length:limits.maxCitations+1},()=>p.citations[0]!);assert.throws(()=>parseResearchProposal(tooMany,f.context),/array length/);
 const schema=researchProposalSchema(f.context);const walk=(node:unknown)=>{if(!node||typeof node!=='object')return;const s=node as Record<string,unknown>;if(s.type==='object'){assert.equal(s.additionalProperties,false);assert.deepEqual(s.required,Object.keys(s.properties as object));}if(s.enum||Object.hasOwn(s,'const'))assert.ok(s.type,'Literal schema has a type');for(const value of Object.values(s))if(Array.isArray(value))value.forEach(walk);else walk(value);};walk(schema);
});

test('P8-RBIND-I06 missing unsupported and cancelled material coverage cannot become a complete answer or erase required criteria',async t=>{
 const f=await fixture(t,true),p=proposal(f.context),omitted=structuredClone(p);omitted.materials.pop();assert.throws(()=>parseResearchProposal(omitted,f.context),/array length/);
 const duplicate=structuredClone(p);duplicate.materials[1]=duplicate.materials[0]!;assert.throws(()=>parseResearchProposal(duplicate,f.context),/ordered material/);
 const hidden=structuredClone(p);hidden.materials.find(m=>m.materialId==='pdf')!.summary='Invented PDF summary';assert.throws(()=>parseResearchProposal(hidden,f.context),/unsupported or incomplete/);
 const answered=structuredClone(p);answered.questions[0]!.status='proposed-answer';answered.questions[0]!.unresolved=[];assert.throws(()=>parseResearchProposal(answered,f.context),/required unavailable/);
 await assert.rejects(captureResearchEvidence({intake:f.intake,material:f.material,contract:{...f.contract,criteria:[...f.contract.criteria,{id:'another',description:'Another original required criterion',required:true}]},requirements:f.requirements,limits}),/required criterion omitted/);
 await assert.rejects(captureResearchEvidence({intake:f.intake,material:f.material,contract:f.contract,requirements:[{...f.requirements[0]!,question:'Weakened question'}],limits}),/exact admitted/);
 await assert.rejects(captureResearchEvidence({intake:f.intake,material:f.material,contract:f.contract,requirements:f.requirements,limits:{...limits,maxContextChars:10}}),/complete context exceeds/);
 const abort=new AbortController();abort.abort();const index=await f.intake.acquire({commandId:'actual-pre-abort',inputs:f.inputs,signal:abort.signal}),material={directory:index.directory,generation:index.generation,indexDigest:index.indexDigest,inputDigest:index.inputDigest},context=await captureResearchEvidence({intake:f.intake,material,contract:f.contract,requirements:f.requirements,limits}),draft=await validateResearchProposal({intake:f.intake,context,output:proposal(context)});
 assert.equal(draft.acquisition.disposition,'cancelled');assert.equal(draft.acquisition.completeness,'partial');assert.equal(draft.citations.length,0);assert.equal(draft.coverage.length,5);assert.equal(draft.proposal.questions[0]!.status,'gap');assert.equal(draft.status,'proposed');assert.equal(draft.authority,'untrusted-draft-only');
});

test('P8-RBIND-I07 actual refresh changed and unknown preserve immutable historical research evidence without granting revalidation',async t=>{
 const f=await fixture(t),p=proposal(f.context),originalDraft=await validateResearchProposal({intake:f.intake,context:f.context,output:p});
 const current=await observeResearchMaterials({intake:f.intake,context:f.context,currentInputs:f.inputs});assert.equal(current.state,'current');assert.equal(current.authority,'observation-only');
 await writeFile(f.source,'Changed material requiring independent reverification.');const changed=await observeResearchMaterials({intake:f.intake,context:f.context,currentInputs:f.inputs});assert.equal(changed.state,'changed');assert.equal(changed.authority,'observation-only');assert.notEqual(changed.entries[0]!.oldDigest,changed.entries[0]!.newDigest);assert.deepEqual(await f.intake.inspect(f.index.directory),f.index);
 const historical=await validateResearchProposal({intake:f.intake,context:f.context,output:p});assert.deepEqual(historical,originalDraft,'Validating old literal provenance is not claiming source freshness or semantic currentness');
 await rm(f.source);const unknown=await observeResearchMaterials({intake:f.intake,context:f.context,currentInputs:f.inputs});assert.equal(unknown.state,'unknown');assert.match(unknown.entries[0]!.error!,/ENOENT/);assert.deepEqual(await f.intake.inspect(f.index.directory),f.index);assert.equal(Object.hasOwn(unknown,'approved'),false);assert.equal(Object.hasOwn(unknown,'verification'),false);
});
