import test from 'node:test';
import assert from 'node:assert/strict';
import {researchPlanningInstructions} from '../../packages/orchestration/research-planning.js';
import {goalProposalSchema,type GoalSession,type GoalProposal,type RequirementMessage} from '../../packages/contracts/p5.js';
import {parseReasonerOutput} from '../../packages/orchestration/reasoner-schema.js';
import {validateProposal} from '../../packages/orchestration/admission.js';
import type {GoalResearchConfiguration} from '../../packages/contracts/p8-research-runtime.js';

// Stable development fixture derived from the observed host-attribution failure.
// Actual provider output/session IDs/local receipts stay in ignored evidence.
const messages:RequirementMessage[]=[{id:'message-1',role:'user',text:'Produce a structured source-bound research report, not software.',createdAt:'fixture'}];
const research:GoalResearchConfiguration={schemaVersion:1,inputs:[{id:'source',kind:'local',path:'/tmp/research-fixture/source.md'}],materialLimits:{maxInputs:1,parallel:1,maxItemBytes:1000,maxTotalBytes:1000,timeoutMs:1000,maxDurationMs:1000,maxRedirects:0},researchLimits:{maxContextChars:200000,maxClaims:24,maxCitations:40,maxQuoteChars:12000},reportDirectory:'research-report',cutoff:null,maxSourceAgeMs:3600000};
const observedHostFacts=['Propose exactly one structured analysis step; the host performs bounded acquisition before it.','Every criterion kind must be material and target exactly research-report/report.json.','Include complete original material coverage, exact citations, classification, dependence, limitations, contradictions and independent semantic acceptance.','Do not invent command/code tasks for this research.'];
function failedFactPattern():GoalProposal{return {decision:'ready',summary:'Propose bounded research',questions:[],facts:observedHostFacts.map(text=>({text,sourceId:'message-1',origin:'explicit'})),constraints:[],style:[],criteria:[{id:'research',description:'Source-bound research',kind:'material',target:'research-report/report.json',checks:['Complete source coverage and accurate citations']}],steps:[{id:'analysis',description:'Analyze admitted materials',dependencies:[],acceptanceIds:['research']}]};}
function session():GoalSession{return {id:'fixture',projectId:'fixture',workspace:'/tmp/fixture',workspaceKind:'project',revision:0,goal:messages[0]!.text,phase:'ready',messages:structuredClone(messages),jobs:[],proposal:null,runtimeId:null,error:null,createdAt:'fixture',updatedAt:'fixture',config:{model:'fixture',effort:'high',reservation:1,timeoutMs:1000},maxContextChars:200000,research:structuredClone(research)};}

test('P8-RPLAN-U01 host research configuration is separated from verbatim user-only fact sources',()=>{
 const before=structuredClone({messages,research});
 const prompt=researchPlanningInstructions(research,messages);
 const originals=prompt.slice(prompt.indexOf('\n')+1,prompt.indexOf('\nHOST RESEARCH CONFIGURATION'));
 assert.deepEqual(JSON.parse(originals),messages.map(({id,text})=>({id,text})));
 assert.ok(prompt.indexOf('USER MESSAGE ORIGINALS')<prompt.indexOf('HOST RESEARCH CONFIGURATION'));
 assert.ok(prompt.includes('not user messages and never facts sources'));
 assert.ok(prompt.includes('never copy them into an explicit user fact'));
 assert.ok(prompt.includes(JSON.stringify({sourceId:messages[0]!.id,origin:'explicit',text:messages[0]!.text})));
 assert.deepEqual({messages,research},before);
 const longSource={...messages[0]!,text:'  '+messages[0]!.text+' '.repeat(2)+'preserved user requirement '.repeat(1000)+'  '};
 assert.ok(longSource.text.length>12000&&longSource.text.length<=40000);
 const longPrompt=researchPlanningInstructions(research,[longSource]);
 const literal=JSON.parse(longPrompt.split('for example ')[1]!.split('. Prefer fewer')[0]!);
 assert.equal(literal.origin,'explicit');assert.equal(literal.sourceId,longSource.id);
 assert.ok(literal.text.length<=240&&longSource.text.includes(literal.text));
 assert.ok(longPrompt.includes(JSON.stringify([{id:longSource.id,text:longSource.text}])),'Full original requirement is retained while only the example is bounded');
 const p=failedFactPattern();p.facts=[literal];
 parseReasonerOutput(JSON.stringify(p),goalProposalSchema([longSource.id]));
 validateProposal(p,{...session(),goal:longSource.text,messages:[longSource]});
});

test('P8-RPLAN-U02 observed paid failure pattern preserves rejection of four host-attributed explicit facts',()=>{
 // The recorded provider output failed; this regression must not relabel it
 // successful, strip facts in production or weaken exact source validation.
 const pattern=failedFactPattern(),proposal=parseReasonerOutput(JSON.stringify(pattern),goalProposalSchema(messages.map(m=>m.id)));
 assert.equal(pattern.facts.filter(f=>f.origin==='explicit'&&!messages.some(m=>m.id===f.sourceId&&m.text.includes(f.text))).length,4);
 assert.throws(()=>validateProposal(proposal as GoalProposal,session()),/missing or misattributed/);
 const literalOnly=structuredClone(pattern);literalOnly.facts=[{text:messages[0]!.text,sourceId:messages[0]!.id,origin:'explicit'}];
 validateProposal(literalOnly,session());
 // This literal-only object is a host-built validation fixture, not a second
 // provider result or evidence that the changed prompt repairs model behavior.
 literalOnly.facts[0]!.sourceId='host-configuration';
 assert.throws(()=>parseReasonerOutput(JSON.stringify(literalOnly),goalProposalSchema(messages.map(m=>m.id))),/enum/);
 assert.throws(()=>validateProposal(literalOnly,session()),/source/);
});

test('P8-RPLAN-U03 malformed configuration or invented duplicate message identity cannot gain fact authority',()=>{
 assert.throws(()=>researchPlanningInstructions(research,[]),/messages/);
 assert.throws(()=>researchPlanningInstructions(research,[...messages,...messages]),/messages/);
 assert.throws(()=>researchPlanningInstructions({...research,reportDirectory:'../outside'},messages),/Unsafe report directory/);
 assert.throws(()=>researchPlanningInstructions(research,[{...messages[0]!,role:'host' as 'user'}]),/messages/);
 assert.throws(()=>researchPlanningInstructions(research,[{...messages[0]!,text:'\0'}]),/messages/);
});
