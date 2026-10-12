import test from 'node:test';
import assert from 'node:assert/strict';
import {goalProposalSchema,type GoalProposal,type GoalSession} from '../../packages/contracts/p5.js';
import {followupEvolutionSchema} from '../../packages/orchestration/followup-evolution.js';
import {planningOutputSchema,planningCapabilityInstructions} from '../../packages/orchestration/planning-capabilities.js';
import {parseReasonerOutput,providerReasonerSchemaRecord} from '../../packages/orchestration/reasoner-schema.js';
import {validateProposal,admittedPlan} from '../../packages/orchestration/admission.js';
import {createDraftRun} from '../../packages/domain/index.js';

function proposal():GoalProposal{return {decision:'ready',summary:'Research official public evidence',questions:[],facts:[{text:'Research public evidence',origin:'explicit',sourceId:'user'}],constraints:[],style:[],criteria:[{id:'claim',kind:'source',target:'https://www.iana.org/domains/reserved',description:'Explain reserved example domains from public evidence',checks:['Report substantive claims agree with the official source and include exact supporting excerpts']},{id:'files',kind:'command',target:'report.test.mjs',description:'Keep the report and citation inventory',checks:['Actual report and source register contain title URL retrieval time and claim attribution']}],steps:[{id:'research',description:'Search official public sources and write a report, source register and Node structure checks',dependencies:[],acceptanceIds:['claim','files']}]};}

test('native planning schema excludes unavailable material without changing archived schemas or configured material support',()=>{
 const legacy=goalProposalSchema(['user']),before=JSON.stringify(legacy),native=planningOutputSchema(legacy,false);
 const p=proposal();assert.doesNotThrow(()=>parseReasonerOutput(JSON.stringify(p),native));
 p.criteria[0]!.kind='material';p.criteria[0]!.target='report.json';
 assert.throws(()=>parseReasonerOutput(JSON.stringify(p),native),/enum/);
 assert.doesNotThrow(()=>parseReasonerOutput(JSON.stringify(p),legacy));
 assert.doesNotThrow(()=>parseReasonerOutput(JSON.stringify(p),planningOutputSchema(legacy,true)));
 assert.equal(JSON.stringify(legacy),before);assert.doesNotThrow(()=>providerReasonerSchemaRecord(native));
});

test('native followup dispatch constrains nested proposals without removing user provenance or acceptance evolution fields',()=>{
 const original=followupEvolutionSchema(['user']),native=planningOutputSchema(original,false),p=proposal();
 const result={decision:'revise',response:'A research plan',proposal:p,retiredCriterionIds:[],retirementSources:[],criterionChanges:[]};
 assert.doesNotThrow(()=>parseReasonerOutput(JSON.stringify(result),native));
 p.criteria[0]!.kind='material';assert.throws(()=>parseReasonerOutput(JSON.stringify(result),native),/anyOf/);
 p.criteria[0]!.kind='source';p.facts[0]!.sourceId='model-observation';assert.throws(()=>parseReasonerOutput(JSON.stringify(result),native),/anyOf/);
 assert.deepEqual(native.required,original.required);assert.doesNotThrow(()=>providerReasonerSchemaRecord(native));
});

test('ordinary public research admits source evidence plus executable report checks without material configuration',()=>{
 const p=proposal(),s:GoalSession={id:'research',projectId:'project',workspace:'/tmp/project',workspaceKind:'project',revision:0,goal:'Research public evidence',phase:'ready',messages:[{id:'user',role:'user',text:'Research public evidence',createdAt:'now'}],jobs:[],proposal:p,runtimeId:null,error:null,createdAt:'now',updatedAt:'now',config:{model:'not-used-in-unit',effort:'low',reservation:10,timeoutMs:1000},maxContextChars:60000};
 const run=createDraftRun({id:s.id,projectId:s.projectId,goal:s.goal,budget:{unit:'token',limit:100,verificationReserve:20}});
 validateProposal(p,s);const plan=admittedPlan(s,run);assert.equal(plan.steps.length,1);assert.equal(plan.steps[0]!.kind,'codex');assert.equal(plan.contract.criteria.length,2);
 assert.ok(plan.contract.criteria[0]!.description.includes('exact supporting excerpts'));assert.equal(run.admission,'draft');assert.equal(run.evidence.length,0);
 p.criteria[0]!.kind='material';p.criteria[0]!.target='report.json';assert.throws(()=>validateProposal(p,s),/Run-owned acquisition/);
});

test('planning capability text distinguishes source discovery from frozen material acquisition and independent verification',()=>{
 const native=planningCapabilityInstructions(false),bounded=planningCapabilityInstructions(true);
 assert.match(native,/live web search is available/);assert.match(native,/File existence checks alone never validate research conclusions/);
 assert.match(native,/not a user restriction/);assert.match(native,/Do not contact people/);
 assert.match(bounded,/native web discovery is disabled/);assert.match(bounded,/Preserve its source identities/);
});

test('planner discovery evidence carries actual completed calls and rejects changed or foreign-context journals',async()=>{
 const {mkdtemp,writeFile,rm,truncate}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createHash}=await import('node:crypto');
 const {planningWebEvidence}=await import('../../packages/orchestration/planning-web-evidence.js');
 const dir=await mkdtemp(join(tmpdir(),'sv-web-proof-')),path=join(dir,'events.jsonl');
 try{
  const item={type:'webSearch',id:'web-1',action:{type:'openPage',url:'https://nodejs.org/api/fs.html'},results:[{url:'https://nodejs.org/api/fs.html',snippet:'Untrusted content; not authorization'}]};
  const event={kind:'codex-event',value:{method:'item/completed',threadId:'planner',turnId:'turn',raw:{method:'item/completed',params:{threadId:'planner',turnId:'turn',item}}}};
  const bytes=JSON.stringify(event)+'\n'+JSON.stringify({kind:'codex-event',value:{raw:{...event.value.raw,method:'item/started'}}})+'\n';await writeFile(path,bytes);
  const receipt={threadId:'planner',proofs:{[path]:createHash('sha256').update(bytes).digest('hex')}};
  const evidence=await planningWebEvidence(path,receipt) as any;assert.equal(evidence.observations.length,1);assert.deepEqual(evidence.observations[0].item,item);assert.equal(evidence.journal.sha256,receipt.proofs[path]);
  await assert.rejects(planningWebEvidence(path,{...receipt,threadId:'another-thread'}),/context mismatch/);
  const mismatch=JSON.stringify({...event,value:{...event.value,turnId:'foreign-turn'}});await writeFile(path,mismatch);
  await assert.rejects(planningWebEvidence(path,{threadId:'planner',proofs:{[path]:createHash('sha256').update(mismatch).digest('hex')}}),/context mismatch/);
  await writeFile(path,bytes+' ');await assert.rejects(planningWebEvidence(path,receipt),/changed/);
  assert.equal(await planningWebEvidence(path,{threadId:'legacy',proofs:{}}),null);
  await truncate(path,32*1024*1024+1);await assert.rejects(planningWebEvidence(path,receipt),/capacity/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
