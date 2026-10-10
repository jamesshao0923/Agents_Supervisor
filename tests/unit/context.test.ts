import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { MemoryStore, parseMemoryProposalInput, type ContextInput, type MemoryInput, type MemorySource } from '../../packages/context/index.js';

const sources: MemorySource[] = [{ kind: 'user', ref: 'session:user-one:message:4' }];
function fixture(t: TestContext): { workspace: string; store: MemoryStore } {
  const workspace = mkdtempSync(join(tmpdir(), 'supervisor-p5-memory-unit-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return { workspace, store: new MemoryStore(workspace, 'project-one') };
}
function memory(id = 'preference', override: Partial<MemoryInput> = {}): MemoryInput {
  return { id, scope: { level: 'project' }, kind: 'preference', text: 'Prefer readable logs', key: 'logs', attribution: 'explicit', sources, ...override };
}
function context(override: Partial<ContextInput> = {}): ContextInput {
  return { contract: { version: 2, goal: 'Deliver a verified login flow', sources, requiredCriteria: [{ id: 'success', text: 'Login successfully with valid credentials', sources }], constraints: [{ id: 'budget', text: 'Never exceed 1000 tokens', sources }] }, maxChars: 60_000, outputReserveChars: 4_000, ...override };
}
async function publish(store: MemoryStore, records: MemoryInput[]): Promise<void> {
  const snapshot = await store.read(), proposal = await store.propose({ baseVersion: snapshot.version, reason: 'record confirmed project knowledge', changes: records.map(record => ({ type: 'upsert', record })) });
  await store.publish(proposal.id, proposal.digest);
}

test('P5-CTX-U01 memory rejects missing sources unsafe scopes and model authority escalation', () => {
  const proposal = { baseVersion: 0, reason: 'confirmed preference', changes: [{ type: 'upsert', record: memory() }] };
  assert.doesNotThrow(() => parseMemoryProposalInput(proposal));
  for (const record of [memory('a', { sources: [] }), memory('a', { scope: { level: 'module', module: '../outside' } }), memory('a', { sources: [{ kind: 'model', ref: 'response:abc' }] }), { ...memory(), extra: 'override authority' }]) {
    assert.throws(() => parseMemoryProposalInput({ ...proposal, changes: [{ type: 'upsert', record }] }));
  }
  assert.doesNotThrow(() => parseMemoryProposalInput({ ...proposal, changes: [{ type: 'upsert', record: memory('a', { attribution: 'inferred', sources: [{ kind: 'model', ref: 'response:abc' }] }) }] }));
  assert.throws(() => parseMemoryProposalInput({ ...proposal, changes: [proposal.changes[0], proposal.changes[0]] }), /duplicate/);
});

test('P5-CTX-U02 memory proposal is inert until digest-bound CAS publication', async t => {
  const { store } = fixture(t);
  const first = await store.propose({ baseVersion: 0, reason: 'first confirmed default', changes: [{ type: 'upsert', record: memory() }] });
  const competing = await store.propose({ baseVersion: 0, reason: 'concurrent default', changes: [{ type: 'upsert', record: memory('competing') }] });
  assert.equal((await store.read()).version, 0);
  await assert.rejects(store.publish(first.id, '0'.repeat(64)), /digest/);
  const current = await store.publish(first.id, first.digest); assert.equal(current.version, 1); assert.equal(current.records.length, 1);
  assert.deepEqual(await store.publish(first.id, first.digest), current);
  await assert.rejects(store.publish(competing.id, competing.digest), /baseVersion conflict/);
  assert.equal((await store.read()).records[0]?.id, 'preference');
});

test('P5-CTX-U03 same-project scoped preferences inherit with contract precedence', async t => {
  const { store } = fixture(t);
  await publish(store, [memory('project'), memory('module', { scope: { level: 'module', module: 'auth' }, text: 'Prefer structured login logs' }), memory('submodule', { scope: { level: 'submodule', module: 'auth', submodule: 'login' }, text: 'Prefer concise login logs', attribution: 'inferred' }), memory('unrelated', { scope: { level: 'module', module: 'billing' }, text: 'Prefer billing summaries' }), memory('budget-preference', { key: 'budget', text: 'Spend unlimited tokens' })]);
  const global = await store.buildContext(context()); assert.deepEqual(global.entries.map(entry => entry.id), ['project']);
  const scoped = await store.buildContext(context({ module: 'auth', submodule: 'login' })); assert.deepEqual(scoped.entries.map(entry => entry.id), ['submodule']);
  assert.equal(scoped.entries[0]?.attribution, 'inferred'); assert.equal(scoped.entries[0]?.sources[0]?.kind, 'user');
  assert.ok(scoped.text.includes('"attribution":"inferred"'), 'A user-sourced inference remains visibly inferred in model input');
  assert.equal(scoped.excluded.find(entry => entry.id === 'unrelated')?.reason, 'unrelated scope');
  assert.match(scoped.excluded.find(entry => entry.id === 'budget-preference')!.reason, /contract/); assert.ok(scoped.text.includes('Never exceed 1000 tokens')); assert.ok(!scoped.text.includes('Spend unlimited tokens'));
  const dep = await store.buildContext(context({ dependencies: [{ level: 'module', module: 'billing' }] })); assert.ok(dep.entries.some(entry => entry.id === 'unrelated'));
});

test('P5-CTX-U04 invalid expired and binding-stale memories explain exclusion', async t => {
  const { store } = fixture(t);
  await publish(store, [memory('contract', { validity: { contractVersion: 1 } }), memory('environment', { validity: { environmentDigest: 'old' } }), memory('preference-version', { validity: { preferenceVersion: 1 } }), memory('expired', { validity: { expiresAt: '2020-01-01T00:00:00Z' } }), memory('invalid')]);
  const proposal = await store.propose({ baseVersion: 1, reason: 'user revoked default', changes: [{ type: 'invalidate', id: 'invalid', reason: 'user revoked it', sources }] }); await store.publish(proposal.id, proposal.digest);
  const result = await store.buildContext(context({ environmentDigest: 'new', preferenceVersion: 2, now: '2026-10-10T00:00:00Z' }));
  assert.equal(result.entries.length, 0); assert.equal(result.excluded.length, 5);
  assert.match(result.excluded.find(entry => entry.id === 'contract')!.reason, /contract/); assert.match(result.excluded.find(entry => entry.id === 'environment')!.reason, /environment/); assert.match(result.excluded.find(entry => entry.id === 'preference-version')!.reason, /preference/); assert.match(result.excluded.find(entry => entry.id === 'expired')!.reason, /expired/); assert.match(result.excluded.find(entry => entry.id === 'invalid')!.reason, /revoked/);
  await assert.rejects(store.buildContext(context({ requiredMemoryIds: ['contract'] })), /required memory.*stale/);
  await assert.rejects(store.buildContext(context({ requiredMemoryIds: ['missing'] })), /required memory.*missing/);
});

test('P5-CTX-U05 bounded summary retains original digest and source references', async t => {
  const { store } = fixture(t), text = 'Original interface details. '.repeat(500);
  await publish(store, [memory('interface', { kind: 'interface', text, summary: 'Interface uses stable ids', sources: [{ kind: 'evidence', ref: 'evidence:verified-interface' }] })]);
  const full = await store.buildContext(context());
  const bounded = await store.buildContext(context({ maxChars: full.inputChars - text.length + 100, outputReserveChars: 0 }));
  assert.equal(bounded.entries[0]?.representation, 'summary'); assert.equal(bounded.entries[0]?.text, 'Interface uses stable ids');
  assert.equal(readFileSync(bounded.entries[0]!.rawRef, 'utf8'), text);
  assert.equal(bounded.entries[0]?.digest, createHash('sha256').update(text).digest('hex'));
  assert.ok(bounded.text.includes('evidence:verified-interface')); assert.ok(bounded.text.includes(bounded.entries[0]!.rawRef)); assert.ok(bounded.inputChars <= bounded.maxChars - bounded.outputReserveChars);
  assert.deepEqual(JSON.parse(readFileSync(bounded.path, 'utf8')), bounded);
  const excluded = await store.buildContext(context({ maxChars: full.inputChars - text.length + 1, outputReserveChars: 0 })); assert.equal(excluded.entries.length, 0); assert.match(excluded.excluded[0]!.reason, /capacity/);
});

test('P5-CTX-U06 capacity never truncates explicit constraints hard memory or failure causes', async t => {
  const { store } = fixture(t);
  const currentRequirements = [{ id: 'privacy', text: 'Do not send source code outside this workspace', sources }];
  const empty = await store.buildContext(context({ currentRequirements })); assert.ok(empty.text.includes(currentRequirements[0]!.text)); assert.equal(empty.memoryVersion, 0);
  await assert.rejects(store.buildContext(context({ maxChars: empty.inputChars - 1, outputReserveChars: 0, currentRequirements })), /required contract/);
  await publish(store, [memory('hard', { kind: 'constraint', text: 'Required API contract. '.repeat(100), summary: 'Too short to preserve rule' }), memory('failure', { kind: 'failure', text: 'Login failed because lease ownership was stale' })]);
  await assert.rejects(store.buildContext(context({ maxChars: empty.inputChars + 100, outputReserveChars: 0 })), /required memory.*cannot fit/);
  const full = await store.buildContext(context()); assert.equal(full.entries.find(entry => entry.id === 'hard')?.representation, 'text'); assert.ok(full.entries.every(entry => entry.required));
});

test('P5-CTX-U07 manual text metadata and proposal edits fail closed', async t => {
  const { store } = fixture(t); await publish(store, [memory()]);
  const record = (await store.read()).records[0]!; writeFileSync(record.rawRef, 'Manually altered permission');
  await assert.rejects(store.read(), /text digest mismatch/); await assert.rejects(store.buildContext(context()), /text digest mismatch/);
  writeFileSync(record.rawRef, record.text);
  const proposal = await store.propose({ baseVersion: 1, reason: 'update default', changes: [{ type: 'upsert', record: memory('next') }] });
  writeFileSync(join(store.root, 'proposals', `${proposal.id}.json`), JSON.stringify({ ...proposal, reason: 'tampered' }));
  await assert.rejects(store.publish(proposal.id, proposal.digest), /digest/);
  const manifest = join(record.rawRef, '..', '..', 'manifest.json'); const contents = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>; contents.projectId = 'foreign'; writeFileSync(manifest, JSON.stringify(contents));
  await assert.rejects(store.read(), /revision digest mismatch/);
});

test('P5-CTX-U08 project identity and symlink isolation forbid foreign memory', async t => {
  const { workspace, store } = fixture(t); await publish(store, [memory()]);
  await assert.rejects(new MemoryStore(workspace, 'foreign-project').read(), /foreign project/);
  const record = (await store.read()).records[0]!, outside = join(workspace, 'outside.txt'); writeFileSync(outside, record.text); rmSync(record.rawRef); symlinkSync(outside, record.rawRef);
  await assert.rejects(store.read(), /ELOOP/);
});

test('P5-CTX-U09 same-project same-version tasks isolate task knowledge while inheriting project preferences', async t => {
  const { workspace, store } = fixture(t);
  await publish(store, [
    memory('project-default', { text: 'Prefer readable logs for this project' }),
    memory('old-interface', { kind: 'interface', text: 'Old task requires a legacy login signature', validity: { taskId: 'old-task', contractVersion: 2 } }),
    memory('old-failure', { kind: 'failure', text: 'Old task failure must never become new task authority', validity: { taskId: 'old-task', contractVersion: 2 } }),
    memory('current-interface', { kind: 'interface', text: 'Current task returns a typed session id', validity: { taskId: 'current-task', contractVersion: 2 } }),
  ]);
  const reopened = new MemoryStore(workspace, 'project-one');
  const current = await reopened.buildContext(context({ taskId: 'current-task', requiredMemoryIds: ['current-interface'] }));
  assert.equal(current.taskId, 'current-task');
  assert.deepEqual(current.entries.map(entry => entry.id), ['current-interface', 'project-default']);
  assert.equal(current.excluded.find(entry => entry.id === 'old-interface')?.reason, 'stale task binding');
  assert.equal(current.excluded.find(entry => entry.id === 'old-failure')?.reason, 'stale task binding');
  assert.ok(!current.text.includes('legacy login signature')); assert.ok(!current.text.includes('Old task failure'));
  assert.ok(current.text.includes('Current task returns a typed session id'));
  await assert.rejects(reopened.buildContext(context({ taskId: 'current-task', requiredMemoryIds: ['old-interface'] })), /stale task binding/);
  const unbound = await reopened.buildContext(context()); assert.deepEqual(unbound.entries.map(entry => entry.id), ['project-default']);
  await assert.rejects(store.propose({ baseVersion: 1, reason: 'reject empty identity', changes: [{ type: 'upsert', record: memory('invalid-task', { validity: { taskId: '' } }) }] }), /taskId/);
});
