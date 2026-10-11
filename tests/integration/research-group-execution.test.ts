import {indexedWorkflowFixture} from '../helpers/indexed-workflow-fixture.js';
import {VerificationProofReader} from '../../packages/verification/proof-reader.js';
import {existsSync} from 'node:fs';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, realpath, rm, appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {DatabaseSync} from 'node:sqlite';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {ExecutionManager} from '../../packages/execution/manager.js';
import {ResearchRuntimeActivity} from '../../packages/runtime/research-activity.js';
import {ResearchGroupActivity} from '../../packages/runtime/research-group-activity.js';
import {ScheduledResultPublisher} from '../../packages/runtime/scheduled-publication.js';
import {LocalRuntimeWorker} from '../../packages/runtime/worker.js';
import {spawnManagedProcess, inspectProcess} from '../../packages/process-control/index.js';
import {MaterialIntake} from '../../packages/workspace/material-intake.js';
import {researchDigest} from '../../packages/workspace/research-materials.js';
import {researchGroupOutputSchema, validateResearchGroupOutput} from '../../packages/orchestration/research-group-output.js';
import {canonical} from '../../packages/verification/candidate.js';
import {captureMaterialBinding} from '../../packages/verification/material.js';
import type {ResearchGroupInput} from '../../packages/contracts/p8-research-groups.js';
import type {ResearchGroupProposal} from '../../packages/contracts/p8-research-group-output.js';
import type {ResearchEvidenceContext, ResearchProposal} from '../../packages/contracts/p8-research.js';
import type {ScheduledClaim} from '../../packages/contracts/p7-dispatch.js';
import type {ExecutionRecord, ExecutionState, ExecutorCapabilities} from '../../packages/contracts/p2.js';
const criterion = 'Independently verify the candidate; completing workflow steps is not delivery acceptance';
const owner = 'explicit-mechanism-owner';
function db(store: SupervisorStore): DatabaseSync {return (store as unknown as {db: DatabaseSync}).db;}
async function fixture(t: TestContext, partial = false) {
  const root = await realpath(await mkdtemp('/tmp/sv-group-execution-')), data = join(root, 'data'), workspace = join(root, 'workspace');
  await mkdir(workspace);
  const inputs = [];
  for (let i = 1; i <= 5; i++) {
    const path = join(root, 'source-' + i + '.txt');
    if (!partial || i < 4) await writeFile(path, 'Material ' + i + ': actual immutable literal evidence.\n');
    if (partial && i === 4) await writeFile(path, Buffer.from([255, 254, 129]));
    inputs.push({id: 'm' + i, kind: 'local' as const, path});
  }
  let store = new SupervisorStore(data);
  const runtime = store.runtime.submit({type: 'submit', commandId: 'original-native', workspace, workspaceKind: 'project',
    goal: 'Summarize the exact five documents without dropping unavailable material or independent acceptance.',
    tokenLimit: 1000, verificationReserve: 300,
    steps: [{id: 'acquire', kind: 'materials', inputs, limits: {maxInputs: 5, parallel: 3,
      maxItemBytes: 4096, maxTotalBytes: 16384, timeoutMs: 1000, maxDurationMs: 5000, maxRedirects: 0}},
    {id: 'analyze', kind: 'codex', prompt: 'Answer all original questions with all original material texts.',
      model: 'explicit-node-protocol-fixture', effort: 'low', reservation: 300, timeoutMs: 60000,
      research: {schemaVersion: 1, acquisitionStepId: 'acquire', requirements: [{criterionId: 'independent-acceptance',
        question: criterion, requiredMaterialIds: inputs.map(input => input.id), cutoff: null, maxSourceAgeMs: 60000}],
      limits: {maxContextChars: 150000, maxClaims: 16, maxCitations: 20, maxQuoteChars: 12000}, reportDirectory: 'research-report'}}]});
  const register = () => store.researchGroups.register({commandId: 'groups', runtimeId: runtime.id,
    expectedRunRevision: store.runtime.inspect(runtime.id).run.revision, maxActive: 2, tier: 'low', groups: [
      {id: 'first', purpose: 'Extract the first two materials with source limitations.', materialIds: ['m1', 'm2'], criterionIds: ['independent-acceptance'], reservation: 100},
      {id: 'second', purpose: 'Compare original materials and explicitly preserve all remaining gaps.', materialIds: ['m1', 'm3', 'm4', 'm5'], criterionIds: ['independent-acceptance'], reservation: 100},
    ]});
  const acquire = async () => {const op = store.runtime.claim(runtime.id, owner)!; assert.ok(op);
    await new ResearchRuntimeActivity(store, data).acquire(op, owner); assert.equal(store.runtime.getOperation(op.id).state, 'confirmed');};
  const install = async () => {const record = register(); await acquire(); await new ResearchGroupActivity(store, data).advance(runtime.id);
    assert.equal(store.researchGroups.get(record.id).state, 'installed'); return store.researchGroups.get(record.id);};
  const claim = (commandId: string) => {const schedulerId = store.researchGroups.byRuntime(runtime.id)!.schedulerId!;
    const result = store.scheduler.claim({commandId, id: schedulerId, expected: store.scheduler.expected(schedulerId), owner});
    assert.equal(result.kind, 'claimed'); if (result.kind !== 'claimed') throw Error('No actual claim');
    store.scheduler.prepareInputs(result.claim.id, owner); return result.claim;};
  const children: Awaited<ReturnType<typeof spawnManagedProcess>>[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {for (const cleanup of cleanups) await cleanup(); for (const child of children) {await child.terminate(); await child.completion;}
    store.close(); await rm(root, {recursive: true, force: true});});
  const reopen = () => {store.close(); store = new SupervisorStore(data); return store;};
  return {root, data, workspace, runtime, inputs, install, register, acquire, claim, reopen, children, cleanups, get store() {return store;}};
}
function output(input: ResearchGroupInput): ResearchGroupProposal {
  const citations = input.sources.filter(source => source.text !== null).map((source, i) => ({id: 'q' + i,
    materialId: source.materialId, start: 0, end: source.text!.trimEnd().length, quote: source.text!.trimEnd()}));
  return {schemaVersion: 1, inputDigest: input.digest, citations,
    materials: input.group.materialIds.map(materialId => {const citation = citations.find(c => c.materialId === materialId);
      return {materialId, summary: citation ? 'A bounded document extraction.' : null,
        citationIds: citation ? [citation.id] : [], unresolved: citation ? [] : ['Actual source is unavailable; no factual conclusion.']};}),
    extractions: citations.map((citation, i) => ({id: 'e' + i, criterionIds: input.group.criterionIds, kind: 'fact',
      text: 'The literal document provides evidence.', supportCitationIds: [citation.id], limitations: []})),
    relationships: [], gaps: input.sources.filter(source => source.text === null).flatMap(source => input.group.criterionIds.map(criterionId =>
      ({criterionId, materialIds: [source.materialId], reason: 'Unavailable material cannot support this question.'})))};
}
function fullOutput(context: ResearchEvidenceContext): ResearchProposal {
  const citations = context.index.entries.map((entry, i) => ({id: 'q' + i, materialId: entry.id,
    start: 0, end: ('Material ' + (i + 1) + ': actual immutable literal evidence.').length,
    quote: 'Material ' + (i + 1) + ': actual immutable literal evidence.'}));
  return {schemaVersion: 1, contextDigest: context.digest, categories: [{id: 'doc', description: 'Original source documents'}], citations,
    claims: [{id: 'claim', criterionIds: ['independent-acceptance'], kind: 'fact', text: 'All five documents provide literal evidence.',
      supportCitationIds: citations.map(c => c.id), counterCitationIds: [], limitations: []}],
    questions: [{criterionId: 'independent-acceptance', status: 'proposed-answer', claimIds: ['claim'], unresolved: []}],
    materials: citations.map(c => ({materialId: c.materialId, categoryIds: ['doc'], summary: 'Original document evidence.', citationIds: [c.id], unresolved: []})),
    conflicts: [], followups: []};
}
// Actual managed Node process + actual Manager finalizer/SQLite/FS. Message and
// seven token protocol/accounting are explicit synthetic fixtures, not provider
// semantic evidence or a paid model acceptance result.
async function complete(f: Awaited<ReturnType<typeof fixture>>, claim: ScheduledClaim, value: unknown,
  beforeFinalize?: (id: string) => Promise<void>) {
  const binding = f.store.scheduler.binding(claim.id, owner), input = f.store.scheduler.executionInput(claim.id);
  f.store.scheduler.markStarted(binding);
  const record = f.store.executionCreate({...input, workspace: claim.workspace, workspaceKind: claim.workspaceKind}, binding).record;
  const text = JSON.stringify(value), child = await spawnManagedProcess({operationId: record.id, command: process.execPath,
    args: ['-e', 'process.stdout.write(' + JSON.stringify(text) + ')'], cwd: record.workspace, timeoutMs: 5000,
    onBeforeSpawn: intent => {f.store.executionUpdate(record.id, {}, 'process-intent', intent);},
    onIdentity: identity => {f.store.executionUpdate(record.id, {identity, pid: identity.pid}, 'process-identity', identity);}});
  f.children.push(child); let stdout = ''; child.stdout.on('data', bytes => {stdout += String(bytes);});
  await child.completion; const stop = await child.terminate(); assert.equal(stop.stopped, true);
  assert.equal(stdout, text);
  syntheticEvents(f.store, record.id, text);
  await beforeFinalize?.(record.id);
  const manager = new ExecutionManager(f.store, f.data, 'no-provider-is-used');
  await (manager as unknown as {finalize(id: string, state: ExecutionState, stopped: boolean, evidence: unknown, launched: boolean, authoritative: boolean): Promise<void>})
    .finalize(record.id, 'completed', true, stop, true, true);
  await manager.close({cancel: false}); return f.store.executionGet(record.id);
}
function syntheticEvents(store: SupervisorStore, id: string, text: string) {
  const threadId = 'explicit-thread-' + id, turnId = 'explicit-turn-' + id;
  store.executionUpdate(id, {threadId, turnId, turnIntent: true, terminalStatus: 'completed', message: text,
    usageStatus: 'reported', usage: {inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 7}},
    'explicit-synthetic-accounting', {notProvider: true});
  store.executionUpdate(id, {}, 'codex-event', {kind: 'message', method: 'item/completed', threadId, turnId, text,
    raw: {method: 'item/completed', params: {threadId, turnId, item: {type: 'agentMessage', text}}}});
  store.executionUpdate(id, {}, 'codex-event', {kind: 'turn-status', method: 'turn/completed', terminal: true, status: 'completed', threadId, turnId,
    raw: {method: 'turn/completed', params: {threadId, turn: {id: turnId, status: 'completed', error: null}}}});
}
async function publish(f: Awaited<ReturnType<typeof fixture>>, claim: ScheduledClaim) {
  const settled = await f.store.scheduler.reconcileExecution({commandId: 'reconcile-' + claim.id, claimId: claim.id, executionId: claim.attemptId});
  assert.equal(settled.state, 'confirmed'); return new ScheduledResultPublisher(f.store).publish(claim);
}

test('P8-GROUP-EXEC-I01 actual material spans schema and complete unavailable coverage reject fabricated quotations cross-material summaries and omitted gaps', async t => {
  const f = await fixture(t, true), record = await f.install();
  const input = f.store.researchGroups.readGroup({schemaVersion: 1, registrationId: record.id, groupId: 'second', inputDigest: record.prepared!.inputs[1]!.digest});
  const good = output(input), intake = new MaterialIntake(f.data);
  const draft = await validateResearchGroupOutput({intake, input, output: good});
  assert.equal(draft.authority, 'untrusted-group-extraction-only');
  assert.deepEqual(draft.proposal.materials.map(m => m.materialId), input.group.materialIds);
  assert.equal(draft.proposal.gaps.length, 2);
  const mutations = [
    (v: ResearchGroupProposal) => {v.citations[0]!.quote = 'Invented evidence';},
    (v: ResearchGroupProposal) => {v.materials[1]!.citationIds = [v.citations[0]!.id];},
    (v: ResearchGroupProposal) => {v.gaps = [];},
    (v: ResearchGroupProposal) => {v.materials.pop();},
    (v: ResearchGroupProposal) => {v.extractions[0]!.criterionIds = ['unapproved'];},
  ];
  for (const change of mutations) {const bad = structuredClone(good); change(bad); await assert.rejects(validateResearchGroupOutput({intake, input, output: bad}));}
  const forgedInput = structuredClone(input); forgedInput.sources[0]!.text = 'Caller fabricated source text';
  const {digest: _oldInputDigest, ...inputBody} = forgedInput; forgedInput.digest = researchDigest(inputBody);
  const omitted = output(forgedInput); omitted.citations = []; omitted.extractions = [];
  omitted.materials = forgedInput.group.materialIds.map(materialId => ({materialId, summary: null, citationIds: [], unresolved: ['Omitted']}));
  omitted.gaps = forgedInput.group.materialIds.map(materialId => ({criterionId: 'independent-acceptance', materialIds: [materialId], reason: 'Omitted'}));
  await assert.rejects(validateResearchGroupOutput({intake, input: forgedInput, output: omitted}), /actual immutable material bytes/);
  const source = input.context.index.entries[0]!, textPath = join(input.context.index.directory, source.text!.path);
  const original = await readFile(textPath); await appendFile(textPath, 'changed');
  await assert.rejects(validateResearchGroupOutput({intake, input, output: good}), /changed/); await writeFile(textPath, original);
  assert.equal(f.store.taskResults.inspect({projectId: f.runtime.projectId, runId: f.runtime.runId}).versions.length, 0);
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 0);
});

test('P8-GROUP-EXEC-I02 actual stopped branches publish submitted host extractions and full original analysis freezes exact refs through native P4 binding', async t => {
  const f = await fixture(t), original = f.store.runtime.inspect(f.runtime.id).run.contract, record = await f.install();
  for (const id of ['one', 'two']) {
    const claim = f.claim(id), input = f.store.researchGroups.inputForClaim(claim)!;
    const stopped = await complete(f, claim, output(input)); assert.equal(stopped.state, 'completed', stopped.error ?? '');
    assert.equal(stopped.stopConfirmed, true); assert.equal(stopped.artifactId, null);
    assert.ok(f.store.researchGroups.assertCompletion(stopped)); await publish(f, claim);
  }
  const publisher = new ScheduledResultPublisher(f.store); assert.equal(publisher.releaseIfReady(record.schedulerId!), true);
  const aggregate = f.store.researchGroups.aggregate(f.runtime.id)!; assert.equal(aggregate.groups.length, 2);
  assert.equal(aggregate.groups[1]!.draft.proposal.materials.length, 4); assert.equal(aggregate.authority, 'untrusted-group-extraction-only');
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 14);
  assert.ok(f.store.taskResults.inspect({projectId: f.runtime.projectId, runId: f.runtime.runId}).versions.every(v => v.state === 'submitted'));
  const op = f.store.runtime.claim(f.runtime.id, owner)!; assert.ok(op);
  const activity = new ResearchRuntimeActivity(f.store, f.data); await activity.prepare(op.id, owner);
  const input = f.store.runtime.researchInput(op.id)!;
  assert.deepEqual(input.package.groups, aggregate); assert.equal(input.package.context.index.entries.length, 5);
  for (let i = 1; i <= 5; i++) assert.ok(input.package.prompt.includes('Material ' + i + ': actual immutable literal evidence.'));
  assert.equal(input.package.context.requirements[0]!.question, criterion);
  const before = f.store.runtime.inspect(f.runtime.id).run;
  const forged = structuredClone(input); forged.package.groups!.groups.pop();
  const {digest: _ignored, ...body} = forged.package; forged.package.digest = researchDigest(body); forged.digest = forged.package.digest;
  await writeFile(input.path, JSON.stringify(forged.package));
  assert.throws(() => f.store.runtime.setResearchInput(op.id, owner, forged), /group references/);
  assert.deepEqual(f.store.runtime.inspect(f.runtime.id).run, before); await writeFile(input.path, JSON.stringify(input.package));
  f.store.runtime.prepareIntegrationInputs(op.id, owner); f.store.runtime.markStarted(op.id, owner);
  const exec = f.store.executionCreate({...f.store.runtime.executionInput(op.id, owner), workspace: f.workspace, workspaceKind: 'project'}, f.store.runtime.binding(op.id, owner)).record;
  const actual = await spawnManagedProcess({operationId: exec.id, command: process.execPath, args: ['-e', 'process.stdout.write("actual full analysis process")'], cwd: f.workspace,
    onBeforeSpawn: intent => {f.store.executionUpdate(exec.id, {}, 'process-intent', intent);},
    onIdentity: identity => {f.store.executionUpdate(exec.id, {identity, pid: identity.pid}, 'process-identity', identity);}});
  f.children.push(actual); await actual.completion; const stop = await actual.terminate(); syntheticEvents(f.store, exec.id, JSON.stringify(fullOutput(input.package.context)));
  const manager = new ExecutionManager(f.store, f.data, 'no-provider-is-used');
  await (manager as unknown as {finalize(id: string, state: ExecutionState, stopped: boolean, evidence: unknown, launched: boolean, authoritative: boolean): Promise<void>})
    .finalize(exec.id, 'completed', true, stop, true, true); await manager.close({cancel: false});
  const finished = f.store.executionGet(exec.id); assert.equal(finished.state, 'completed', finished.error ?? '');
  f.store.runtime.report(op.id, owner, {messageId: 'full-analysis-report', outcome: 'confirmed', result: {executionId: exec.id}});
  assert.equal(f.store.runtime.get(f.runtime.id).phase, 'awaiting-verification');
  assert.deepEqual(f.store.researchGroups.aggregate(f.runtime.id), aggregate, 'immutable grouped input survives analysis closure');
  const native = await captureMaterialBinding(f.store, f.data, op.id);
  assert.equal(native.inputDigest, input.digest); assert.deepEqual(f.store.runtime.inspect(f.runtime.id).run.contract, original);
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 21);
  assert.notEqual(f.store.runtime.inspect(f.runtime.id).run.status, 'succeeded', 'submitted extraction never substitutes for full P4 and delivery');
});

test('P8-GROUP-EXEC-I03 actual structured refusal late pause cancel and unknown accounting retain raw output stop and original budget without TaskResult', async t => {
  for (const failure of ['quote', 'gap', 'pause', 'cancel', 'unknown', 'pause-after-receipt'] as const) {
    const f = await fixture(t, true); await f.install(); const claim = f.claim('negative-' + failure), input = f.store.researchGroups.inputForClaim(claim)!;
    const value = output(input); if (failure === 'quote') value.citations[0]!.quote = 'False literal quotation';
    if (failure === 'gap') {value.materials[0]!.summary = null; value.materials[0]!.citationIds = []; value.materials[0]!.unresolved = ['Omitted'];}
    const raw = JSON.stringify(value), result = await complete(f, claim, value, async id => {
      if (failure === 'pause' || failure === 'cancel') f.store.runtime.control({type: failure, commandId: 'late-' + failure, runtimeId: f.runtime.id});
      if (failure === 'unknown') f.store.executionUpdate(id, {usage: null, usageStatus: 'unknown'}, 'explicit-unknown-usage', {notProvider: true});
      if (failure === 'pause-after-receipt') {
        const {bytesDigest} = await import('../../packages/workspace/research-runtime-files.js');
        const receiptPath = join(f.data, 'research-group-completions', bytesDigest(id), 'receipt.json');
        const readActual = f.store.executionGet.bind(f.store); let interleaved = false;
        // Controlled real SQLite control interleaving after actual exclusive FS
        // receipt write. Every record remains a production repository read.
        f.store.executionGet = queried => {
          const actual = readActual(queried);
          if (queried === id && !interleaved && existsSync(receiptPath)) {
            interleaved = true;
            f.store.runtime.control({type: 'pause', commandId: 'pause-after-real-receipt', runtimeId: f.runtime.id});
          }
          return actual;
        };
      }
    });
    assert.equal(result.state, failure === 'cancel' ? 'cancelled' : 'failed'); assert.equal(result.stopConfirmed, true); assert.equal(result.message, raw);
    assert.ok(result.error); assert.equal(result.artifactId, null);
    const run = f.store.runtime.inspect(f.runtime.id).run, attempt = run.attempts.find(a => a.id === result.id)!;
    assert.equal(attempt.settled, failure !== 'unknown'); assert.equal(run.budget.spent, failure === 'unknown' ? 0 : 7);
    assert.equal(run.budget.futureExecution!.amount, 300);
    await f.store.scheduler.reconcileExecution({commandId: 'negative-stop-' + failure, claimId: claim.id, executionId: result.id});
    await assert.rejects(new ScheduledResultPublisher(f.store).publish(claim));
    assert.equal(f.store.taskResults.inspect({projectId: f.runtime.projectId, runId: f.runtime.runId}).versions.length, 0);
    if (failure === 'unknown') {assert.equal(f.store.scheduler.operation(claim.operationId).state, 'unknown');
      assert.ok(f.store.scheduler.leases().some(l => l.claimId === claim.id && l.state === 'held'));
      f.reopen(); const manager = new ExecutionManager(f.store, f.data, 'no-provider-is-used', {scope: 'scheduled'});
      await manager.initialize(); await manager.close({cancel: false}); assert.equal(f.store.executionGet(result.id).message, raw);
      const retry = f.store.scheduler.claim({commandId: 'after-unknown', id: claim.schedulerId, expected: f.store.scheduler.expected(claim.schedulerId), owner});
      assert.equal(retry.kind, 'waiting'); assert.equal(f.store.scheduler.claims(claim.schedulerId).length, 1);}
  }
});

test('P8-GROUP-EXEC-I04 actually running writer and rehashed host receipt cannot forge publication or free shared reservations', async t => {
  const f = await fixture(t); await f.install(); const claim = f.claim('live'), binding = f.store.scheduler.binding(claim.id, owner);
  f.store.scheduler.markStarted(binding); const record = f.store.executionCreate({...f.store.scheduler.executionInput(claim.id), workspace: claim.workspace, workspaceKind: claim.workspaceKind}, binding).record;
  const child = await spawnManagedProcess({operationId: record.id, command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: record.workspace,
    onBeforeSpawn: intent => {f.store.executionUpdate(record.id, {}, 'process-intent', intent);},
    onIdentity: identity => {f.store.executionUpdate(record.id, {identity, pid: identity.pid}, 'process-identity', identity);}}); f.children.push(child);
  const input = f.store.researchGroups.inputForClaim(claim)!; syntheticEvents(f.store, record.id, JSON.stringify(output(input)));
  f.store.executionUpdate(record.id, {stopConfirmed: true}, 'explicit-forged-stop', {notProvider: true});
  assert.equal((await inspectProcess(child.identity)).status, 'verified');
  await assert.rejects(new ResearchGroupActivity(f.store, f.data).materialize(record.id), /physical group writer/);
  const run = f.store.runtime.inspect(f.runtime.id).run; assert.equal(run.attempts.find(a => a.id === record.id)!.settled, false); assert.equal(run.budget.spent, 0);
  await child.terminate(); await child.completion;
  const g = await fixture(t); await g.install(); const other = g.claim('receipt'), valid = await complete(g, other, output(g.store.researchGroups.inputForClaim(other)!));
  const receipt = g.store.researchGroups.assertCompletion(valid)!;
  const {bytesDigest} = await import('../../packages/workspace/research-runtime-files.js');
  const path = join(g.data, 'research-group-completions', bytesDigest(valid.id), 'receipt.json'), original = await readFile(path);
  receipt.draft.proposal.materials[0]!.summary = 'Forged host summary'; const {digest: _, ...body} = receipt; receipt.digest = researchDigest(body);
  await writeFile(path, JSON.stringify(receipt)); await g.store.scheduler.reconcileExecution({commandId: 'stop-receipt', claimId: other.id, executionId: valid.id});
  await assert.rejects(new ScheduledResultPublisher(g.store).publish(other), /completion proof differs/);
  assert.equal(g.store.taskResults.inspect({projectId: g.runtime.projectId, runId: g.runtime.runId}).versions.length, 0);
  await writeFile(path, original); await new ScheduledResultPublisher(g.store).publish(other);
});

test('P8-GROUP-EXEC-I05 actual Manager JSON line transport requests read-only and exact structured schema then persists raw stopped extraction', async t => {
  const f = await fixture(t); await f.install(); const claim = f.claim('protocol'), input = f.store.researchGroups.inputForClaim(claim)!;
  const path = join(f.root, 'protocol-fixture.cjs'), log = join(f.root, 'actual-request-lines.jsonl');
  const script = `#!${process.execPath}
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n'),threadId='actual-node-thread',turnId='actual-node-turn';
rl.on('line',line=>{const x=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');if(!('id'in x))return;
if(x.method==='initialize')send({id:x.id,result:{userAgent:'explicit-node-fixture',codexHome:'explicit-no-config-home',platformFamily:'unix',platformOs:'test'}});
else if(x.method==='thread/start')send({id:x.id,result:{thread:{id:threadId,turns:[]}}});
else if(x.method==='turn/start'){send({id:x.id,result:{turn:{id:turnId,status:'inProgress',items:[]}}});setTimeout(()=>{
const usage={inputTokens:5,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:7};
send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total:usage,last:usage}}});
send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',text:${JSON.stringify(JSON.stringify(output(input)))}}}});
send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',error:null}}});},20);}
else if(x.method==='turn/interrupt')send({id:x.id,result:{}});else send({id:x.id,error:{message:'Unsupported explicit fixture request'}});});
`;
  await writeFile(path, script, {mode: 0o700});
  const manager = new ExecutionManager(f.store, f.data, path, {scope: 'scheduled'}); f.cleanups.push(() => manager.close({cancel: false}));
  // Reviewed synthetic transport fixture caches avoid touching installed Codex or
  // global configuration. Actual launch, protocol reduction, managed stop and
  // accounting use production modules. This is not advertised provider evidence.
  const caches = manager as unknown as {capabilityCache: Promise<ExecutorCapabilities>; argsCache: Promise<string[]>};
  caches.capabilityCache = Promise.resolve({version: 'explicit-fixture', schemaDigest: '0'.repeat(64), models: [{id: input.context.contract.criteria.length ? 'explicit-node-protocol-fixture' : 'unused', label: 'mechanism fixture', inputModalities: ['text'], reasoningEfforts: ['low'], defaultEffort: 'low'}], imageInput: false, checkedAt: new Date().toISOString()});
  caches.argsCache = Promise.resolve([]);
  const binding = f.store.scheduler.binding(claim.id, owner); f.store.scheduler.markStarted(binding);
  const {workspaceKind: _workspaceKind, ...start} = f.store.scheduler.executionInput(claim.id); await manager.startScheduled(start, binding);
  const deadline = Date.now() + 15000;
  while (!f.store.executionGet(claim.attemptId).stopConfirmed) {assert.ok(Date.now() < deadline, 'Actual protocol fixture completion deadline'); await delay(20);}
  const result = f.store.executionGet(claim.attemptId); assert.equal(result.state, 'completed', result.error ?? '');
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.find(line => line.method === 'thread/start').params.sandbox, 'read-only');
  assert.deepEqual(lines.find(line => line.method === 'turn/start').params.outputSchema, researchGroupOutputSchema(input));
  assert.equal(lines.find(line => line.method === 'turn/start').params.input[0].text, start.prompt);
  assert.ok(f.store.executionEvents(result.id, 0).some(event => event.kind === 'codex-raw'));
  assert.equal(f.store.researchGroups.assertCompletion(result)!.rawOutputDigest, (await import('../../packages/workspace/research-runtime-files.js')).bytesDigest(result.message));
  await publish(f, claim); assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 7);
});

test('P8-GROUP-EXEC-I06 actual worker tick automatically installs once and records immutable input failure as readable blocked state across restart', async t => {
  const f = await fixture(t); f.register(); await f.acquire();
  const worker = new LocalRuntimeWorker(f.store, f.data, owner);
  await (worker as unknown as {tick(id: string): Promise<void>}).tick(f.runtime.id);
  assert.equal(f.store.researchGroups.byRuntime(f.runtime.id)!.state, 'installed');
  await (worker as unknown as {tick(id: string): Promise<void>}).tick(f.runtime.id);
  assert.equal(f.store.scheduler.list().length, 1); assert.equal(f.store.executionList().length, 0, 'registration/install alone is not a model');
  const g = await fixture(t); const record = g.register(); await g.acquire(); const prepared = g.store.researchGroups.prepare(record.id);
  await writeFile(prepared.inputs[0]!.path, '{}');
  const blocked = new LocalRuntimeWorker(g.store, g.data, owner);
  await assert.rejects((blocked as unknown as {tick(id: string): Promise<void>}).tick(g.runtime.id), /partial or conflicting input/);
  assert.equal(g.store.researchGroups.get(record.id).state, 'blocked'); assert.match(g.store.researchGroups.get(record.id).blockedReason!, /partial or conflicting input/);
  assert.equal(g.store.runtime.get(g.runtime.id).phase, 'blocked'); assert.equal(g.store.scheduler.list().length, 0);
  g.reopen(); await new ResearchGroupActivity(g.store, g.data).advance(g.runtime.id);
  assert.equal(g.store.researchGroups.get(record.id).state, 'blocked'); assert.equal(g.store.scheduler.list().length, 0);
  assert.equal(g.store.runtime.inspect(g.runtime.id).run.budget.spent, 0);
});

test('P8-GROUP-EXEC-I07 actual process exit after exclusive host receipt recovers original evidence once without replay or duplicate fee', async t => {
  const f = await fixture(t); await f.install(); const claim = f.claim('receipt-crash'), input = f.store.researchGroups.inputForClaim(claim)!;
  const storeURL = new URL('../../packages/persistence/store.js', import.meta.url).href;
  const activityURL = new URL('../../packages/runtime/research-group-activity.js', import.meta.url).href;
  const crashCode = `import {SupervisorStore} from ${JSON.stringify(storeURL)};
import {ResearchGroupActivity} from ${JSON.stringify(activityURL)};
const store = new SupervisorStore(${JSON.stringify(f.data)});
await new ResearchGroupActivity(store,${JSON.stringify(f.data)}).materialize(${JSON.stringify(claim.attemptId)});
process.exit(73);`;
  await assert.rejects(complete(f, claim, output(input), async () => {
    const crash = await spawnManagedProcess({operationId: 'host-receipt-crash', command: process.execPath,
      args: ['--input-type=module', '-e', crashCode], cwd: f.root, timeoutMs: 10000,
      onBeforeSpawn: intent => writeFile(join(f.root, 'host-crash-intent.json'), JSON.stringify(intent), {flag: 'wx'}),
      onIdentity: identity => writeFile(join(f.root, 'host-crash-identity.json'), JSON.stringify(identity), {flag: 'wx'})}); f.children.push(crash);
    const actual = await crash.completion; assert.equal(actual.exitCode, 73);
    throw Error('Actual host process exited before finalization');
  }), /exited before finalization/);
  const before = f.store.executionGet(claim.attemptId);
  assert.equal(before.stopConfirmed, false, 'physical observation must not bypass pending finalization recovery');
  const {bytesDigest} = await import('../../packages/workspace/research-runtime-files.js');
  const receiptPath = join(f.data, 'research-group-completions', bytesDigest(claim.attemptId), 'receipt.json');
  const bytes = await readFile(receiptPath);
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts.find(a => a.id === claim.attemptId)!.settled, false);
  f.reopen(); const manager = new ExecutionManager(f.store, f.data, 'no-provider-is-used', {scope: 'scheduled'});
  f.cleanups.push(() => manager.close({cancel: false})); await manager.initialize();
  const after = f.store.executionGet(claim.attemptId); assert.equal(after.state, 'completed', after.error ?? '');
  assert.equal(after.stopConfirmed, true); assert.deepEqual(await readFile(receiptPath), bytes);
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 7);
  await publish(f, claim); const first = f.store.taskResults.inspect({projectId: f.runtime.projectId, runId: f.runtime.runId});
  await manager.initialize(); await new ScheduledResultPublisher(f.store).publish(claim);
  assert.deepEqual(f.store.taskResults.inspect({projectId: f.runtime.projectId, runId: f.runtime.runId}), first);
  assert.equal(f.store.executionList().length, 1); assert.equal(f.store.scheduler.claims(claim.schedulerId).length, 1);
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 7);
});

// Real local sources and owned Node transport; supplier judgments are synthetic.
// No public-network/provider acceptance is represented by this component case.
test('P8-GROUP-EXEC-I08 actual indexed assigned group readers summarize concurrently then full current analysis independent P4 seals all original sources',{timeout:270000},async t=>{
 const f=await indexedWorkflowFixture(t,undefined,undefined,{timestampSyntheticEvents:true,archiveRoot:join(process.env.SUPERVISOR_EVIDENCE_DIR??join(process.cwd(),'.supervisor-dev','indexed-group-evidence'),'component'),preserveOriginalRoot:true},{indexedGroups:true});
 assert.equal(f.groupExecutions.length,2);assert.equal(f.store.runtime.inspect(f.runtime.id).run.status,'succeeded');
 const aggregate=f.store.researchGroups.aggregate(f.runtime.id)!;assert.equal(aggregate.groups.length,2);assert.equal(aggregate.authority,'untrusted-group-extraction-only');
 const op=f.store.runtime.currentOperations(f.runtime.id).find(op=>op.step.kind==='codex'&&op.step.research)!;const input=f.store.runtime.researchInput(op.id)!.package;assert.equal(input.indexed!.view.allowedMaterialIds.length,5);assert.equal(input.groups!.digest,aggregate.digest);
 for(const record of f.groupExecutions){assert.equal(record.stopConfirmed,true);assert.equal((await inspectProcess(record.identity as import('../../packages/process-control/index.js').ProcessIdentity)).status,'stopped');
  const claim=f.store.scheduler.claimGet(record.scheduledBinding!.claimId),frozen=f.store.researchGroups.inputForClaim(claim)!;assert.equal(frozen.schemaVersion,2);assert.deepEqual(frozen.indexed!.view.allowedMaterialIds,frozen.group.materialIds);assert.ok(frozen.sources.every(source=>source.text===null));assert.ok(f.store.researchGroups.assertCompletion(record));}
 // Actual turn time intervals, not nominal maxActive or artificial sleep.
 const intervals=f.groupExecutions.map(record=>{const events=f.store.executionEvents(record.id,0);const started=events.find(event=>event.kind==='turn-started');const completed=events.find(event=>event.kind==='codex-event'&&(event.payload as {kind?:string;terminal?:boolean;status?:string}).kind==='turn-status'&&(event.payload as {terminal?:boolean}).terminal);assert.ok(started&&completed,'actual group turn event interval required');return{start:Date.parse(started.receivedAt),end:Date.parse(completed.receivedAt)};});
 assert.ok(Math.max(...intervals.map(i=>i.start))<Math.min(...intervals.map(i=>i.end)),'actual group summary turns overlap');
 await new VerificationProofReader(f.store).assertJob(f.final);const budget=f.store.runtime.inspect(f.runtime.id).run.budget;assert.ok(budget.spent<=budget.limit);assert.equal(f.store.verification.get('delivery',f.delivery.id).jobId,f.final.id);
 const reopened=new SupervisorStore(f.data);try{assert.equal(reopened.runtime.inspect(f.runtime.id).run.status,'succeeded');assert.equal(reopened.researchGroups.aggregate(f.runtime.id)!.digest,aggregate.digest);await new VerificationProofReader(reopened).assertJob(reopened.verification.get('job',f.final.id));}finally{reopened.close();}
});
