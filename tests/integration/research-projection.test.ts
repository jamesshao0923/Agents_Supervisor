import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {acquireMaterialEvidence,assertMaterialsCurrent,currentMaterialProjectionBinding} from '../../packages/verification/material.js';
import {bytesDigest} from '../../packages/workspace/research-runtime-files.js';
import {validateResearchProposal,researchProposalSchema} from '../../packages/orchestration/research-proposal.js';
import type {MaterialVerifierBinding,MaterialVerifier} from '../../packages/contracts/p4-material.js';
import type {ResearchExecutionPackage,ResearchCompletionReceipt} from '../../packages/contracts/p8-research-runtime.js';
import {captureCandidate} from '../../packages/verification/candidate.js';
import {captureDefinition} from '../../packages/verification/definition.js';
import {executeInstances,type EngineContext} from '../../packages/verification/engine.js';
import {selectInstances} from '../../packages/verification/rules.js';
import type {VerificationSpec} from '../../packages/contracts/p4.js';
import type {VerificationJob} from '../../packages/verification/records.js';
import {inspectProcess} from '../../packages/process-control/index.js';
import {MaterialIntake} from '../../packages/workspace/material-intake.js';
import {captureResearchEvidence, researchDigest} from '../../packages/workspace/research-materials.js';
import {parseResearchProposal} from '../../packages/orchestration/research-proposal.js';
import {projectCurrentResearchReport, validateCurrentResearchProjection} from '../../packages/verification/research-projection.js';
import type {ResearchEvidenceContext, ResearchProposal} from '../../packages/contracts/p8-research.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp('/tmp/sv-research-projection-'));
  const data = join(root, 'data'), source = join(root, 'source.md');
  await mkdir(data);
  const quote = 'The tool is read-only and bounded.';
  await writeFile(source, quote + '\n');
  const intake = new MaterialIntake(data);
  const inputs = [{id: 'source', kind: 'local' as const, path: source}];
  const limits = {maxContextChars: 100000, maxClaims: 8, maxCitations: 8, maxQuoteChars: 12000};
  const first = {version: 1, goal: 'Trace complete original material meaning.', criteria: [
    {id: 'original', description: 'Preserve the original read-only meaning.', required: true}
  ]};
  const second = {...first, version: 2, criteria: [...first.criteria,
    {id: 'added', description: 'Explain the bounded nature.', required: true}
  ]};
  const context = async (commandId: string, contract: typeof first) => {
    const index = await intake.acquire({commandId, inputs});
    return captureResearchEvidence({intake,
      material: {directory: index.directory, generation: index.generation, indexDigest: index.indexDigest, inputDigest: index.inputDigest},
      contract, requirements: contract.criteria.map(criterion => ({criterionId: criterion.id,
        question: criterion.description, requiredMaterialIds: ['source'], cutoff: null, maxSourceAgeMs: 86400000})), limits});
  };
  const previous = await context('actual-old-acquisition', first);
  const current = await context('actual-new-acquisition', second);
  const report: ResearchProposal = {
    schemaVersion: 1, contextDigest: current.digest,
    categories: [{id: 'documentation', description: 'Proposed classification, not approval.'}],
    citations: [{id: 'quote', materialId: 'source', start: 0, end: quote.length, quote}],
    claims: current.requirements.map(req => ({id: 'claim-' + req.criterionId, criterionIds: [req.criterionId],
      kind: 'fact', text: req.criterionId === 'original' ? 'The tool is read-only.' : 'The tool is bounded.',
      supportCitationIds: ['quote'], counterCitationIds: [], limitations: []})),
    questions: current.requirements.map(req => ({criterionId: req.criterionId,
      status: 'proposed-answer', claimIds: ['claim-' + req.criterionId], unresolved: []})),
    materials: [{materialId: 'source', categoryIds: ['documentation'], summary: quote,
      citationIds: ['quote'], unresolved: []}], conflicts: [], followups: []
  };
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, source, intake, previous, current, report, context, second};
}

test('P8-RV2-I01 actual immutable generations project current answers with exact original records and complete source coverage without semantic approval', async t => {
  const f = await fixture(t), input = {previous: f.previous, current: f.current, report: f.report};
  assert.notEqual(f.previous.material.generation, f.current.material.generation);
  const projection = await validateCurrentResearchProjection(f.intake, input);
  assert.equal(projection.authority, 'projection-integrity-only');
  assert.deepEqual(projection.report.questions, [f.report.questions[0]!]);
  assert.deepEqual(projection.report.claims, [f.report.claims[0]!]);
  for (const field of ['citations', 'materials', 'categories'] as const) assert.deepEqual(projection.report[field], f.report[field]);
  assert.equal(projection.report.contextDigest, f.previous.digest);
  assert.equal(projection.currentReportDigest, researchDigest(f.report));
  assert.deepEqual(parseResearchProposal(projection.report, f.previous), projection.report);
  // Explicit synthetic semantic fault: provenance and projection remain valid.
  // Actual P4 semantic evaluation must detect this false meaning later.
  const bad = structuredClone(f.report); bad.claims[0]!.text = 'The tool writes unrestricted data.';
  const projectedBad = await validateCurrentResearchProjection(f.intake, {...input, report: bad});
  assert.equal(projectedBad.report.claims[0]!.text, bad.claims[0]!.text);
  assert.equal(Object.hasOwn(projectedBad, 'approved'), false);
  assert.deepEqual(await readFile(f.source, 'utf8'), 'The tool is read-only and bounded.\n');
});

test('P8-RV2-I02 mixed labels real cross-question conflicts and followups cannot be erased or relabelled for historical compatibility', async t => {
  const f = await fixture(t), input = {previous: f.previous, current: f.current, report: f.report};
  const mixed = structuredClone(f.report); mixed.claims[0]!.criterionIds.push('added');
  assert.throws(() => projectCurrentResearchReport({...input, report: mixed}), /mixed old\/new claim/);
  const conflict = structuredClone(f.report);
  conflict.conflicts.push({claimIds: ['claim-original', 'claim-added'], citationIds: ['quote'], explanation: 'An actual cross-scope relation must not be erased.'});
  assert.throws(() => projectCurrentResearchReport({...input, report: conflict}), /cross-scope conflict/);
  const followup = structuredClone(f.report);
  followup.followups.push({criterionIds: ['original', 'added'], reason: 'Real shared uncertainty must remain.'});
  assert.throws(() => projectCurrentResearchReport({...input, report: followup}), /cross-scope followup/);
  assert.deepEqual(f.report, input.report);
});

test('P8-RV2-I03 source byte changes actual archive tampering and original question cutoff changes fail compatibility while old snapshots remain', async t => {
  const f = await fixture(t), oldBytes = await readFile(f.previous.sources[0]!.textPath);
  await writeFile(f.source, 'Changed material is a new source basis.');
  const changed = await f.context('actual-changed-acquisition', f.second);
  const changedReport = structuredClone(f.report); changedReport.contextDigest = changed.digest;
  await assert.rejects(validateCurrentResearchProjection(f.intake, {previous: f.previous, current: changed, report: changedReport}), /quote|source identity|literal/);
  const tampered = f.current.sources[0]!.textPath, saved = await readFile(tampered);
  await writeFile(tampered, 'Tampered archived source');
  await assert.rejects(validateCurrentResearchProjection(f.intake, {previous: f.previous, current: f.current, report: f.report}), /snapshot changed/);
  await writeFile(tampered, saved);
  const cutoff = structuredClone(f.current); cutoff.requirements[0]!.cutoff = '2020-01-01T00:00:00.000Z';
  const {digest: _, ...body} = cutoff; cutoff.digest = researchDigest(body);
  assert.throws(() => projectCurrentResearchReport({previous: f.previous, current: cutoff, report: {...f.report, contextDigest: cutoff.digest}}), /questions cutoff/);
  const goal=structuredClone(f.current);goal.contract.goal+='\nInvented caller addition';
  const {digest:goalDigest,...goalBody}=goal;goal.digest=researchDigest(goalBody);
  assert.throws(()=>projectCurrentResearchReport({previous:f.previous,current:goal,
    report:{...f.report,contextDigest:goal.digest}}),/actual applied append receipts/);
  // Same-Run version regressions remain forbidden without actual different-
  // Run appended-message receipts. Versions must always be positive integers.
  const prior=structuredClone(f.previous);prior.contract.version=3;
  prior.contractDigest=researchDigest(prior.contract);
  const {digest:priorDigest,...priorBody}=prior;prior.digest=researchDigest(priorBody);
  assert.throws(()=>projectCurrentResearchReport({previous:prior,current:f.current,report:f.report}),/Run-local version decreased/);
  for(const version of [0,-1,1.5]){
    const invalid=structuredClone(f.current);invalid.contract.version=version;
    invalid.contractDigest=researchDigest(invalid.contract);
    const {digest:invalidDigest,...invalidBody}=invalid;invalid.digest=researchDigest(invalidBody);
    assert.throws(()=>projectCurrentResearchReport({previous:f.previous,current:invalid,
      report:{...f.report,contextDigest:invalid.digest}}),/positive Run-local integers/);
  }
  assert.deepEqual(await readFile(f.previous.sources[0]!.textPath), oldBytes);
});

test('P8-RV2-I04 inputs freeze before real archive awaits and invented old-context metadata cannot create host evidence', async t => {
  const f = await fixture(t), input = {previous: structuredClone(f.previous), current: structuredClone(f.current), report: structuredClone(f.report)};
  const pending = validateCurrentResearchProjection(f.intake, input);
  input.report.claims[0]!.text = 'Late mutation must not be projected.';
  input.previous.requirements[0]!.question = 'Weakened old question';
  const projection = await pending;
  assert.equal(projection.report.claims[0]!.text, f.report.claims[0]!.text);
  const invented: ResearchEvidenceContext = structuredClone(f.previous);
  invented.index.entries[0]!.raw!.sha256 = '0'.repeat(64);
  const {digest: _, ...body} = invented; invented.digest = researchDigest(body);
  await assert.rejects(validateCurrentResearchProjection(f.intake, {previous: invented, current: f.current, report: f.report}), /differs from actual|snapshot/);
  let accessed = 0;
  const hostile = {...input}; Object.defineProperty(hostile, 'current', {enumerable: true, get() {accessed++; return f.current;}});
  await assert.rejects(validateCurrentResearchProjection(f.intake, hostile), /unsafe JSON/);
  assert.equal(accessed, 0);
});

// Actual archive/input/completion files; producer protocol and token values are
// explicit synthetic receipts in this isolated projection-layer fixture.
async function writeBinding(f:Awaited<ReturnType<typeof fixture>>,context:ResearchEvidenceContext,label:string,report:ResearchProposal):Promise<MaterialVerifierBinding>{
 const data=join(f.root,'data'),operationId='synthetic-operation-'+label,executionId='synthetic-execution-'+label;
 const body={schemaVersion:1 as const,operationId,acquisitionOperationId:'actual-acquisition-'+label,
  contractVersion:context.contract.version,context,outputSchema:researchProposalSchema(context),
  prompt:'Explicit component protocol fixture, no supplier authority',reportDirectory:'report'};
 const input:ResearchExecutionPackage={...body,digest:researchDigest(body)};
 const draft=await validateResearchProposal({intake:f.intake,context,output:report});
 const completionBody={schemaVersion:1 as const,executionId,operationId,inputDigest:input.digest,
  threadId:'synthetic-thread-'+label,turnId:'synthetic-turn-'+label,rawOutputDigest:bytesDigest(JSON.stringify(report)),
  completionEvents:{messageSeq:1,terminalSeq:2,evidenceDigest:researchDigest('explicit protocol fixture')},
  draft,files:{'report.json':bytesDigest(JSON.stringify(report))}};
 const completion:ResearchCompletionReceipt={...completionBody,digest:researchDigest(completionBody)};
 const inputPath=join(data,'research-inputs',bytesDigest(operationId),'input.json'),completionPath=join(data,'research-completions',bytesDigest(executionId),'receipt.json');
 for(const path of [join(data,'research-inputs',bytesDigest(operationId)),join(data,'research-completions',bytesDigest(executionId))])await mkdir(path,{recursive:true});
 await writeFile(inputPath,JSON.stringify(input));await writeFile(completionPath,JSON.stringify(completion));
 return {schemaVersion:1,operationId,executionId,inputPath,inputDigest:input.digest,completionPath,completionDigest:completion.digest,contextDigest:context.digest};
}
async function detectorFixture(t:TestContext){
 const f=await fixture(t),oldReport=projectCurrentResearchReport({previous:f.previous,current:f.current,report:f.report}).report;
 const previousBinding=await writeBinding(f,f.previous,'old',oldReport),currentBinding=await writeBinding(f,f.current,'current',f.report);
 const oldVerifier:MaterialVerifier={kind:'material',version:'old-native-v1',claimFile:'report/report.json',binding:previousBinding,timeoutMs:15000};
 const tree=join(f.root,'current-candidate');await mkdir(join(tree,'report'),{recursive:true});await writeFile(join(tree,oldVerifier.claimFile),JSON.stringify(f.report));
 return {...f,oldVerifier,currentBinding,tree,oldReport};
}

test('P8-RV2-I05 historical actual material evidence is rederived from current report bytes and both immutable archives without replacing original candidate',async t=>{
 const f=await detectorFixture(t),bytes=await readFile(join(f.tree,f.oldVerifier.claimFile));
 await assert.rejects(acquireMaterialEvidence(f.oldVerifier,f.tree,join(f.root,'no-adaptation'),new AbortController().signal),/contextDigest/);
 const evidence=await acquireMaterialEvidence(f.oldVerifier,f.tree,join(f.root,'projection-proof'),new AbortController().signal,f.currentBinding);
 assert.equal(evidence.payload.proposed.authority,'untrusted-draft-only');
 assert.deepEqual(evidence.payload.proposed.proposal,f.oldReport);
 assert.deepEqual(evidence.payload.basisProjection!.currentReport,f.report);
 assert.equal(evidence.payload.basisProjection!.currentClaimDigest,bytesDigest(bytes));
 await assertMaterialsCurrent([evidence.observation]);
 assert.deepEqual(await readFile(join(f.tree,f.oldVerifier.claimFile)),bytes);
 const payload=JSON.parse(await readFile(evidence.observation.proofPath,'utf8'));
 payload.proposed.proposal.claims[0].text='Forged replacement conclusion';
 await writeFile(evidence.observation.proofPath,JSON.stringify(payload));
 const rehashed={...evidence.observation,proofDigest:bytesDigest(await readFile(evidence.observation.proofPath))};
 await assert.rejects(assertMaterialsCurrent([rehashed]),/differs from unchanged current report/);
 payload.proposed=evidence.payload.proposed;payload.basisProjection.currentClaim+=' ';
 await writeFile(evidence.observation.proofPath,JSON.stringify(payload));
 await assert.rejects(assertMaterialsCurrent([{...evidence.observation,proofDigest:bytesDigest(await readFile(evidence.observation.proofPath))}]),/original report bytes changed/);
});

test('P8-RV2-I06 actual historical detector process receives same current full report and lossless prior scope with real stop and shared usage; synthetic judgments grant no delivery',async t=>{
 const f=await detectorFixture(t),defs=join(f.root,'defs'),badTree=join(f.root,'bad-tree');await mkdir(defs);await mkdir(join(badTree,'report'),{recursive:true});const badReport=structuredClone(f.report);badReport.claims[0]!.text='Incorrect synthetic negative writes data';await writeFile(join(badTree,'report/report.json'),JSON.stringify(badReport));
 const oldSpec:VerificationSpec={schemaVersion:1,contractVersion:1,standardsVersion:'old',
  obligations:[{id:'original-check',criterionId:'original',expectation:'Preserve original read-only meaning',required:true,applicable:true}],
  cases:[{id:'original-case',revision:1,obligationIds:['original-check'],parameters:[{}],modules:['report'],replaces:[],defectRefs:[],verifier:f.oldVerifier}],
  controls:[{id:'good',workspace:f.tree,expect:'passed',mustFail:[]},{id:'bad',workspace:badTree,expect:'failed',mustFail:['original-check']}],moduleDependencies:{}};
 const currentSpec:VerificationSpec={...structuredClone(oldSpec),contractVersion:2,standardsVersion:'current',
  cases:[{...structuredClone(oldSpec.cases[0]!),revision:2,verifier:{...f.oldVerifier,version:'current-native-v2',binding:f.currentBinding}}]};
 const path=join(defs,'spec.json');await writeFile(path,JSON.stringify(oldSpec));
 const frozen=await captureDefinition(path,join(f.root,'frozen-definition')),candidate=await captureCandidate(f.tree,join(f.root,'frozen-candidate'));
 const ctx:EngineContext={output:join(f.root,'actual-history'),signal:new AbortController().signal,
  job:{id:'actual-projection-history',runtimeId:'component',projectId:'component',runId:'component',workspace:f.tree,
   kind:'review',proposalId:'component',planId:null,request:{notProvider:true},status:'running',attemptId:'component',
   environmentDigest:'0'.repeat(64),config:{model:'explicit-projection-process-fixture',effort:'low',reservation:50,timeoutMs:15000},
   startedAt:new Date().toISOString(),finishedAt:null,intents:[],identities:[],usage:0,modelStarted:false,usageUnknown:false,
   results:[],controls:[],evaluation:null,approved:false,stopConfirmed:false,error:null,proofs:{},sources:[]},
  eligible(){if(this.signal.aborted)throw Error('Cancelled');},save(){writeFileSync(join(f.root,'actual-job.json'),JSON.stringify(this.job));}};
 const binary=join(f.root,'explicit-projection-fixture.cjs'),turns=join(f.root,'actual-turns.jsonl');
 await writeFile(binary,`#!${process.execPath}
const cp=require('node:child_process'),fs=require('node:fs'),a=process.argv.slice(2);
if(a.includes('--version')||a.includes('generate-json-schema')){process.stdout.write(cp.execFileSync('codex',a));process.exit(0)}
if(a.includes('mcp')){console.log('[]');process.exit(0)}
const send=x=>console.log(JSON.stringify(x));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize')return send({id:m.id,result:{userAgent:'synthetic',codexHome:'fixture',platformFamily:'unix',platformOs:'test'}});
if(m.method==='model/list')return send({id:m.id,result:{data:[{id:'explicit-projection-process-fixture',model:'explicit-projection-process-fixture',inputModalities:['text'],supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low',isDefault:true}],nextCursor:null}});
if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'projection-thread',turns:[]}}});
if(m.method==='turn/start'){fs.appendFileSync(${JSON.stringify(turns)},JSON.stringify(m)+'\\n');
send({id:m.id,result:{turn:{id:'projection-turn',status:'inProgress',items:[]}}});
const usage={inputTokens:5,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:5};
send({method:'thread/tokenUsage/updated',params:{threadId:'projection-thread',turnId:'projection-turn',tokenUsage:{total:usage,last:usage}}});
const text=JSON.stringify({verdict:'passed',reason:'Explicit synthetic projection protocol response; no model semantic evidence',observations:[]});
send({method:'item/completed',params:{threadId:'projection-thread',turnId:'projection-turn',item:{id:'message',type:'agentMessage',text}}});
send({method:'turn/completed',params:{threadId:'projection-thread',turn:{id:'projection-turn',status:'completed',items:[{type:'agentMessage',text}]}}});return;}
throw Error('Unexpected request '+m.method);});`,{mode:0o700});
 const old=process.env.SUPERVISOR_CODEX_PATH;process.env.SUPERVISOR_CODEX_PATH=binary;
 try{
  const results=await executeInstances(ctx,frozen.spec,frozen.bundle,candidate,selectInstances(frozen.spec,{mode:'final'}).instances,'historical-successor',{materialProjectionTarget:currentSpec});
  assert.equal(results[0]!.executionStatus,'executed',results[0]!.reason);
  assert.equal(results[0]!.checks[0]!.verdict,'passed');assert.equal(ctx.job.usage,5);assert.equal(ctx.job.usageUnknown,false);
  assert.equal(ctx.job.approved,false);assert.equal(ctx.job.evaluation,null);
  const turn=JSON.parse((await readFile(turns,'utf8')).trim());
  const text=turn.params.input.find((v:{type:string})=>v.type==='text').text;
  const payload=JSON.parse(text.slice(text.indexOf('\n')+1));
  assert.deepEqual(payload.basisProjection.currentReport,f.report);
  assert.deepEqual(payload.proposed.proposal.questions,[f.report.questions[0]!]);
  assert.equal(payload.basisProjection.projection.authority,'projection-integrity-only');
  assert.ok(results[0]!.proofFiles!.some(p=>p.endsWith('actual-materials.json')));
  await assertMaterialsCurrent(ctx.job.materials!);
  for(const identity of ctx.job.identities)assert.equal((await inspectProcess(identity)).status,'stopped');
  const instance=selectInstances(oldSpec,{mode:'final'}).instances[0]!;
  assert.deepEqual(currentMaterialProjectionBinding(f.oldVerifier,oldSpec,instance,currentSpec),f.currentBinding);
  const ambiguity=structuredClone(currentSpec);ambiguity.cases.push({...ambiguity.cases[0]!,id:'other',verifier:{...f.oldVerifier,binding:f.oldVerifier.binding}});
  assert.throws(()=>currentMaterialProjectionBinding(f.oldVerifier,oldSpec,instance,ambiguity),/one exact current/);
 }finally{if(old===undefined)delete process.env.SUPERVISOR_CODEX_PATH;else process.env.SUPERVISOR_CODEX_PATH=old;}
});
