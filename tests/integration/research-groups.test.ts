import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, realpath, rm, appendFile, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {DatabaseSync} from 'node:sqlite';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {ResearchRuntimeActivity} from '../../packages/runtime/research-activity.js';
import {canonical} from '../../packages/verification/candidate.js';
import type {ResearchGroupsRecord, ResearchGroupDeclaration} from '../../packages/contracts/p8-research-groups.js';
const criterion = 'Independently verify the candidate; completing workflow steps is not delivery acceptance';
const storeModule = fileURLToPath(new URL('../../packages/persistence/store.js', import.meta.url));
function raw(store: SupervisorStore): DatabaseSync { return (store as unknown as {db: DatabaseSync}).db; }
async function fixture(t: TestContext, options: {fault?: (point: string) => void} = {}) {
  const root = await realpath(await mkdtemp('/tmp/sv-research-groups-'));
  const data = join(root, 'data'), workspace = join(root, 'workspace');
  await mkdir(workspace);
  const inputs = [];
  for (let i = 1; i <= 5; i++) {
    const path = join(root, 'source-' + i + '.txt');
    if (i < 4) await writeFile(path, 'Original material ' + i + ': retained literal evidence.\n');
    if (i === 4) await writeFile(path, Buffer.from([255, 254, 129]));
    inputs.push({id: 'm' + i, kind: 'local' as const, path});
  }
  let store = new SupervisorStore(data, options);
  const runtime = store.runtime.submit({type: 'submit', commandId: 'native-research', workspace,
    workspaceKind: 'project', goal: 'Summarize all five original inputs without losing unsupported material coverage.',
    tokenLimit: 1000, verificationReserve: 300,
    steps: [{id: 'acquire', kind: 'materials', inputs,
      limits: {maxInputs: 5, parallel: 3, maxItemBytes: 4096, maxTotalBytes: 16384, timeoutMs: 1000, maxDurationMs: 5000, maxRedirects: 0}},
    {id: 'analyze', kind: 'codex', prompt: 'Answer the unchanged original research questions with full source coverage.',
      model: 'explicit-component-fixture-no-provider', effort: 'low', reservation: 300, timeoutMs: 60000,
      research: {schemaVersion: 1, acquisitionStepId: 'acquire',
        requirements: [{criterionId: 'independent-acceptance', question: criterion,
          requiredMaterialIds: inputs.map(input => input.id), cutoff: null, maxSourceAgeMs: 60000}],
        limits: {maxContextChars: 100000, maxClaims: 8, maxCitations: 16, maxQuoteChars: 12000}, reportDirectory: 'research-report'}}]});
  const groups: ResearchGroupDeclaration[] = [
    {id: 'first', purpose: 'Extract the first two documents; include their individual limitations.',
      materialIds: ['m1', 'm2'], criterionIds: ['independent-acceptance'], reservation: 100},
    {id: 'second', purpose: 'Compare the first document with the remaining sources and record unavailable inputs.',
      materialIds: ['m1', 'm3', 'm4', 'm5'], criterionIds: ['independent-acceptance'], reservation: 100},
  ];
  const register = () => store.researchGroups.register({commandId: 'register-groups', runtimeId: runtime.id,
    expectedRunRevision: store.runtime.inspect(runtime.id).run.revision, groups, maxActive: 2, tier: 'low'});
  const acquire = async () => {
    const op = store.runtime.claim(runtime.id, 'materials-owner'); assert.ok(op);
    await new ResearchRuntimeActivity(store, data).acquire(op, 'materials-owner');
    assert.equal(store.runtime.getOperation(op.id).state, 'confirmed'); return op;
  };
  const prepared = async () => { const record = register(); await acquire(); store.researchGroups.prepare(record.id); return record; };
  const install = (record: ResearchGroupsRecord, commandId = 'install-groups') => store.researchGroups.install({commandId,
    id: record.id, expectedRunRevision: store.runtime.inspect(runtime.id).run.revision,
    expectedResultRevision: store.taskResults.inspect({projectId: runtime.projectId, runId: runtime.runId}).revision});
  const reopen = () => { store.close(); store = new SupervisorStore(data); return store; };
  t.after(async () => { store.close(); await rm(root, {recursive: true, force: true}); });
  return {root, data, runtime, groups, register, acquire, prepared, install, reopen, get store() {return store;}};
}
async function child(script: string): Promise<{code: number | null; output: string}> {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; process.stdout.on('data', bytes => {output += String(bytes);});
  process.stderr.on('data', bytes => {output += String(bytes);});
  return new Promise((resolve, reject) => {process.on('error', reject); process.on('exit', code => resolve({code, output}));});
}

test('P8-GRP-I01 actual five-material receipt freezes full mandatory coverage and installs same-Run graph final floor and real claims', async t => {
  const f = await fixture(t), original = f.store.runtime.inspect(f.runtime.id).run;
  const record = await f.prepared(), prepared = f.store.researchGroups.get(record.id).prepared!;
  const first = f.store.researchGroups.readGroup({schemaVersion: 1, registrationId: record.id, groupId: 'first', inputDigest: prepared.inputs[0]!.digest});
  const second = f.store.researchGroups.readGroup({schemaVersion: 1, registrationId: record.id, groupId: 'second', inputDigest: prepared.inputs[1]!.digest});
  assert.equal(first.authority, 'untrusted-group-extraction-only');
  assert.equal(first.context.index.entries.length, 5); assert.equal(first.context.index.completeness, 'partial');
  assert.equal(second.sources.find(source => source.materialId === 'm4')!.status, 'unsupported');
  assert.notEqual(second.sources.find(source => source.materialId === 'm5')!.status, 'success');
  assert.equal(second.sources.find(source => source.materialId === 'm4')!.text, null);
  assert.equal(f.store.runtime.claim(f.runtime.id, 'early-analysis'), null);
  assert.equal(f.store.taskResults.inspect({projectId: f.runtime.projectId, runId: f.runtime.runId}).versions.length, 0);
  const installed = f.install(record), run = f.store.runtime.inspect(f.runtime.id).run;
  assert.deepEqual(run.contract, original.contract); assert.equal(run.budget.limit, 1000);
  assert.equal(run.budget.spent, 0); assert.equal(run.budget.verificationReserve, 300);
  assert.equal(run.budget.futureExecution!.amount, 300);
  assert.equal(run.budget.futureExecution!.attemptId, prepared.analysisAttemptId);
  assert.deepEqual(run.nodes.find(node => node.id === 'analyze')!.dependencies, ['acquire', 'research-group-first', 'research-group-second']);
  assert.equal(f.store.runtime.claim(f.runtime.id, 'still-fenced'), null);
  for (let i = 0; i < 2; i++) {
    const claim = f.store.scheduler.claim({commandId: 'claim-' + i, id: installed.scheduler.id,
      expected: f.store.scheduler.expected(installed.scheduler.id), owner: 'fixture-worker'});
    assert.equal(claim.kind, 'claimed'); if (claim.kind !== 'claimed') throw Error('claim missing');
    assert.equal(claim.claim.projectId, f.runtime.projectId); assert.equal(claim.claim.runId, f.runtime.runId);
    assert.equal(claim.claim.inputBindings.length, 0, 'materials cannot masquerade as TaskResult');
    assert.doesNotThrow(() => f.store.scheduler.eligible(claim.operation.id, 'fixture-worker'));
    assert.ok(f.store.scheduler.executionInput(claim.claim.id).prompt.includes('Return only the supplied research-group JSON schema'));
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts.find(attempt => attempt.id === claim.claim.attemptId)!.reservation, 100);
  }
  assert.equal(f.store.scheduler.claims(installed.scheduler.id).length, 2);
  assert.equal(f.store.scheduler.operations(installed.scheduler.id).length, 2);
  assert.equal(f.store.executionList().length, 0, 'no provider or free-form scheduled P2 turn');
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 0);
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.futureExecution!.amount, 300);
});

test('P8-GRP-I02 parent SQLite rollback and stale CAS pause cancel reject group authority without partial graph floor or receipts', async t => {
  const f = await fixture(t), db = raw(f.store);
  db.exec('BEGIN IMMEDIATE'); const rolled = f.register(); db.exec('ROLLBACK');
  assert.throws(() => f.store.researchGroups.get(rolled.id), /unknown registration/);
  const record = await f.prepared(), before = canonical(f.store.runtime.inspect(f.runtime.id).run);
  db.exec('BEGIN IMMEDIATE'); f.install(record); db.exec('ROLLBACK');
  assert.equal(canonical(f.store.runtime.inspect(f.runtime.id).run), before);
  assert.equal(f.store.researchGroups.get(record.id).state, 'prepared');
  assert.equal(f.store.scheduler.list().length, 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM research_group_receipts WHERE command_id=?').get('install-groups')!.n), 0);
  const revision = f.store.runtime.inspect(f.runtime.id).run.revision;
  assert.throws(() => f.store.researchGroups.install({commandId: 'stale', id: record.id, expectedRunRevision: revision - 1, expectedResultRevision: 0}), /CAS stale/);
  assert.throws(() => f.store.researchGroups.install({commandId: 'stale-result', id: record.id, expectedRunRevision: revision, expectedResultRevision: 1}), /CAS stale/);
  f.store.runtime.control({type: 'pause', runtimeId: f.runtime.id, commandId: 'pause-before-install'});
  assert.throws(() => f.install(record, 'paused'), /paused/);
  f.store.runtime.control({type: 'resume', runtimeId: f.runtime.id, commandId: 'resume-before-install'});
  const exactRequest = {commandId: 'install-groups', id: record.id,
    expectedRunRevision: f.store.runtime.inspect(f.runtime.id).run.revision, expectedResultRevision: 0};
  const installed = f.store.researchGroups.install(exactRequest);
  assert.deepEqual(f.store.researchGroups.install(exactRequest), installed, 'exact command retry returns historical committed receipt');
  assert.equal(f.store.scheduler.list().length, 1);
  f.store.runtime.control({type: 'cancel', runtimeId: f.runtime.id, commandId: 'cancel-after-install'});
  assert.throws(() => f.store.scheduler.claim({commandId: 'cancelled-claim', id: installed.scheduler.id,
    expected: f.store.scheduler.expected(installed.scheduler.id), owner: 'no-worker'}), /stopped/);
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 0);
});

test('P8-GRP-I03 unknown acquisition and unknown shared claim accounting preserve reservations effects and block new dispatch', async t => {
  const f = await fixture(t); const record = f.register();
  const op = f.store.runtime.claim(f.runtime.id, 'materials-owner')!;
  f.store.runtime.beginMaterials(op.id, 'materials-owner');
  f.store.runtime.report(op.id, 'materials-owner', {messageId: 'unknown-material', outcome: 'unknown', result: {uncertainArchive: true}});
  assert.throws(() => f.store.researchGroups.prepare(record.id), /known material receipt/);
  assert.equal(f.store.runtime.claim(f.runtime.id, 'no-analysis'), null);
  assert.equal(f.store.researchGroups.get(record.id).state, 'waiting-materials');
  const g = await fixture(t), ready = await g.prepared(), installed = g.install(ready);
  const claim = g.store.scheduler.claim({commandId: 'unknown-claim', id: installed.scheduler.id,
    expected: g.store.scheduler.expected(installed.scheduler.id), owner: 'fixture-worker'});
  assert.equal(claim.kind, 'claimed'); if (claim.kind !== 'claimed') throw Error('claim missing');
  const unknown = {...claim.operation, state: 'unknown', error: 'Explicit mechanism: unknown effect, no supplier execution'};
  raw(g.store).prepare('UPDATE scheduled_outbox SET record=? WHERE id=?').run(canonical(unknown), unknown.id);
  const blocked = g.store.scheduler.claim({commandId: 'after-unknown', id: installed.scheduler.id,
    expected: g.store.scheduler.expected(installed.scheduler.id), owner: 'other-worker'});
  assert.equal(blocked.kind, 'waiting');
  const run = g.store.runtime.inspect(g.runtime.id).run;
  assert.equal(run.attempts.find(attempt => attempt.id === claim.claim.attemptId)!.settled, false);
  assert.equal(run.attempts.find(attempt => attempt.id === claim.claim.attemptId)!.reservation, 100);
  assert.equal(run.budget.spent, 0); assert.equal(run.budget.futureExecution!.amount, 300);
  assert.ok(g.store.scheduler.leases().filter(lease => lease.claimId === claim.claim.id).every(lease => lease.state === 'held'));
});

test('P8-GRP-I04 missing coverage expanded requests tampered host plan partial input and changed archive cannot grant installation', async t => {
  const f = await fixture(t), runRevision = f.store.runtime.inspect(f.runtime.id).run.revision;
  const invalid: [string, ResearchGroupDeclaration[]][] = [
    ['omission', [f.groups[0]!]],
    ['unknown-source', [{...f.groups[0]!, materialIds: ['forged']}, f.groups[1]!]],
    ['unknown-criterion', [{...f.groups[0]!, criterionIds: ['new-unapproved-question']}, f.groups[1]!]],
    ['over-budget', f.groups.map(group => ({...group, reservation: 300}))],
  ];
  for (const [label, groups] of invalid) assert.throws(() => f.store.researchGroups.register({commandId: label, runtimeId: f.runtime.id,
    expectedRunRevision: runRevision, groups: [...groups], maxActive: 2, tier: 'unlimited'}));
  assert.equal(Number(raw(f.store).prepare('SELECT COUNT(*) AS n FROM research_group_registrations').get()!.n), 0);
  const record = await f.prepared(), prepared = f.store.researchGroups.get(record.id).prepared!;
  const original = await readFile(prepared.inputs[0]!.path);
  await writeFile(prepared.inputs[0]!.path, '{}');
  assert.throws(() => f.install(record), /input bytes/);
  assert.equal(f.store.scheduler.list().length, 0); await writeFile(prepared.inputs[0]!.path, original);
  const saved = f.store.researchGroups.get(record.id), forged = structuredClone(saved);
  forged.prepared!.plan.tasks[0]!.step.model = 'caller-selected-expensive-model';
  const {digest: _, ...body} = forged.prepared!;
  const {researchDigest} = await import('../../packages/workspace/research-materials.js');
  forged.prepared!.digest = researchDigest(body);
  raw(f.store).prepare('UPDATE research_group_registrations SET record=? WHERE id=?').run(canonical(forged), record.id);
  assert.throws(() => f.install(record), /host-derived plan/);
  raw(f.store).prepare('UPDATE research_group_registrations SET record=? WHERE id=?').run(canonical(saved), record.id);
  const inputPath = prepared.inputs[0]!.path; await rm(inputPath); await symlink(prepared.inputs[1]!.path, inputPath);
  assert.throws(() => f.install(record), /alias/); await rm(inputPath); await writeFile(inputPath, original);
  const source = f.store.researchGroups.readGroup({schemaVersion: 1, registrationId: record.id, groupId: 'first', inputDigest: prepared.inputs[0]!.digest});
  await appendFile(join(source.context.index.directory, source.context.index.entries[0]!.raw!.path), 'tamper');
  assert.throws(() => f.install(record), /bytes changed/);
  assert.equal(f.store.scheduler.list().length, 0);
  assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.futureExecution, undefined);
});

test('P8-GRP-I05 two actual Node processes use SQLite CAS for one exact same-Run claim and never double-reserve', async t => {
  const f = await fixture(t), record = await f.prepared(), installed = f.install(record);
  const expected = f.store.scheduler.expected(installed.scheduler.id);
  const script = (suffix: string) => `import {SupervisorStore} from ${JSON.stringify('file://' + storeModule)};
    const store=new SupervisorStore(${JSON.stringify(f.data)});try{
    const result=store.scheduler.claim({commandId:${JSON.stringify('race-' + suffix)},id:${JSON.stringify(installed.scheduler.id)},expected:${JSON.stringify(expected)},owner:'actual-node-process'});
    console.log(JSON.stringify(result));store.close();}catch(error){console.error(String(error));store.close();process.exit(7);}`;
  const results = await Promise.all([child(script('a')), child(script('b'))]);
  assert.deepEqual(results.map(result => result.code).sort(), [0, 7], JSON.stringify(results));
  assert.ok(results.find(result => result.code === 7)!.output.includes('CAS'));
  assert.equal(f.store.scheduler.claims(installed.scheduler.id).length, 1);
  const run = f.store.runtime.inspect(f.runtime.id).run;
  assert.equal(run.attempts.filter(attempt => !attempt.settled).length, 1);
  assert.equal(run.attempts.filter(attempt => !attempt.settled)[0]!.reservation, 100);
  assert.equal(run.budget.spent, 0); assert.equal(run.budget.futureExecution!.amount, 300);
});

test('P8-GRP-I06 actual process exit inside install transaction rolls back graph floor and scheduler and restart reuses exact owned preparation', async t => {
  const f = await fixture(t), record = await f.prepared(), before = canonical(f.store.runtime.inspect(f.runtime.id).run);
  const request = {commandId: 'crash-install', id: record.id,
    expectedRunRevision: f.store.runtime.inspect(f.runtime.id).run.revision, expectedResultRevision: 0};
  const crashed = await child(`import {SupervisorStore} from ${JSON.stringify('file://' + storeModule)};
    const store=new SupervisorStore(${JSON.stringify(f.data)},{fault:point=>{if(point==='research-groups-before-install-commit')process.exit(73);}});
    store.researchGroups.install(${JSON.stringify(request)});process.exit(2);`);
  assert.equal(crashed.code, 73, crashed.output);
  const store = f.reopen(); assert.equal(canonical(store.runtime.inspect(f.runtime.id).run), before);
  assert.equal(store.researchGroups.get(record.id).state, 'prepared'); assert.equal(store.scheduler.list().length, 0);
  const prepared = store.researchGroups.get(record.id).prepared!, bytes = await readFile(prepared.inputs[0]!.path);
  assert.deepEqual(store.researchGroups.prepare(record.id), prepared);
  assert.deepEqual(await readFile(prepared.inputs[0]!.path), bytes);
  const result = store.researchGroups.install(request); assert.equal(result.registration.state, 'installed');
  assert.deepEqual(store.researchGroups.install(request), result);
  assert.equal(store.scheduler.list().length, 1); assert.equal(store.runtime.inspect(f.runtime.id).run.nodes.length, 4);
  assert.equal(store.runtime.claim(f.runtime.id, 'after-restart'), null);
});

test('P8-GRP-I07 ordinary runtime and ordinary engineering install guards remain exact while registered native material acquisition stays runnable', async t => {
  const ordinary = await fixture(t); await ordinary.acquire();
  assert.ok(ordinary.store.runtime.claim(ordinary.runtime.id, 'original-analysis'), 'unregistered native path unchanged');
  const f = await fixture(t), record = await f.prepared(), prepared = f.store.researchGroups.get(record.id).prepared!;
  assert.throws(() => f.store.scheduler.install({commandId: 'ordinary-install', plan: prepared.plan,
    expectedRunRevision: f.store.runtime.inspect(f.runtime.id).run.revision, expectedResultRevision: 0}), /unstarted active|unique integration step/);
  assert.equal(f.store.scheduler.list().length, 0);
  const before = f.store.runtime.inspect(f.runtime.id).run;
  f.store.command({type: 'act', commandId: 'existing-final-floor', projectId: f.runtime.projectId,
    runId: f.runtime.runId, expectedRevision: before.revision, action: {type: 'setFutureExecution', allocation: {
      allocationId: 'original-protected-analysis', contractVersion: before.contract.version,
      nodeId: 'analyze', attemptId: prepared.analysisAttemptId, amount: 300}, reason: 'Existing exact final analysis protection'}});
  const installed = f.install(record);
  const head = f.store.runtime.inspect(f.runtime.id).run;
  assert.equal(head.budget.futureExecution!.allocationId, 'original-protected-analysis');
  assert.equal(head.budget.futureExecution!.amount, 300);
  assert.equal(head.nodes[0]!.id, 'acquire'); assert.equal(head.nodes[0]!.status, 'succeeded');
  assert.equal(installed.scheduler.plan.tasks.every(task => task.node.required), true);
  assert.deepEqual(head.contract, ordinary.store.runtime.inspect(ordinary.runtime.id).run.contract);
});
