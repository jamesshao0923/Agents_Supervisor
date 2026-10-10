import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { SupervisionReasoningError, SupervisionReasoningRunner } from '../../packages/orchestration/supervision-reasoning.js';
import { ReasonerError, prepareReasonerTurn } from '../../packages/orchestration/reasoner.js';
import type { ReasonerInput, ReasonerResult, SupervisorReasoner } from '../../packages/orchestration/reasoner.js';
import { inspectProcess, spawnManagedProcess } from '../../packages/process-control/index.js';
import type { ManagedProcess } from '../../packages/process-control/index.js';

// Transport fixtures use actual managed Node processes and persisted SQLite.
// Their JSON and usage numbers are explicitly fixtures, never live model evidence.
const schema = { type: 'object', additionalProperties: false, required: ['diagnosis'], properties: { diagnosis: { type: 'string' } } };
const input = { prompt: 'Inspect the supplied frozen ledger fixture and return a diagnosis.', outputSchema: schema, context: { source: 'immutable ledger fixture', criteria: ['Retain original requirements'] } };
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
class ProcessFixtureTransport implements SupervisorReasoner {
  calls = 0;
  inputs: ReasonerInput[] = [];
  children: ManagedProcess[] = [];
  started = deferred();
  completed = deferred();
  constructor(readonly options: { hold?: boolean; liveClaim?: boolean; usage?: number | null; observed?: number; value?: unknown; noProof?: boolean; contradictoryStart?: boolean; afterProcess?: () => Promise<void> } = {}) {}
  async request(request: ReasonerInput): Promise<ReasonerResult> {
    this.calls++; this.inputs.push(request);
    const result: ReasonerResult = { value: this.options.value ?? { diagnosis: 'Explicit process fixture outcome' }, usage: this.options.usage === undefined ? 7 : this.options.usage, threadId: 'fixture-thread', turnId: 'fixture-turn', proofFiles: [], stopConfirmed: false, modelStarted: false };
    let child: ManagedProcess | undefined;
    try {
      request.assertEligible?.();
      await prepareReasonerTurn(request, result, () => request.assertEligible?.());
      const path = join(request.logDir, 'process-fixture.json');
      const code = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({kind:'managed-process-fixture',prompt:process.argv[2]})); ${this.options.hold || this.options.liveClaim ? 'setInterval(()=>{},1000);' : ''}`;
      child = await spawnManagedProcess({ operationId: request.id + '-fixture-process', command: process.execPath, args: ['-e', code, path, request.prompt], cwd: request.cwd, timeoutMs: 5000, onBeforeSpawn: intent => request.onIntent?.(intent), onIdentity: identity => request.onIdentity?.(identity) });
      this.children.push(child); this.started.resolve();
      const stop = () => { void child!.terminate('cancelled'); };
      request.signal?.addEventListener('abort', stop, { once: true });
      if (request.signal?.aborted) stop();
      try {
        await request.onUsage?.(this.options.observed ?? 7);
        if (this.options.liveClaim) {
          // The deliberately lying stop flag is checked against the actual process.
          result.stopConfirmed = true; return result;
        }
        const completion = await child.completion; result.stopConfirmed = completion.stopped;
        if (!this.options.noProof) result.proofFiles = [path];
        this.completed.resolve(); await this.options.afterProcess?.();
        if (request.signal?.aborted) { result.usage = null; throw new Error('Fixture transport cancelled before authoritative final usage'); }
        if (this.options.contradictoryStart) result.modelStarted = false;
        return result;
      } finally { request.signal?.removeEventListener('abort', stop); }
    } catch (error) {
      if (child) result.stopConfirmed = (await child.terminate('cancelled')).stopped;
      throw new ReasonerError(error instanceof Error ? error.message : String(error), result, { cause: error });
    }
  }
  async close() { await Promise.all(this.children.map(child => child.terminate('cancelled'))); }
}
function fixture(transport = new ProcessFixtureTransport()) {
  const root = mkdtempSync('/tmp/sv-reasoning-runner-'), workspace = join(root, 'workspace'), data = join(root, 'data'); mkdirSync(workspace);
  let store = new SupervisorStore(data);
  const runtime = store.runtime.submit({ type: 'submit', commandId: 'runtime', workspace, workspaceKind: 'project', goal: 'Retain original standards', tokenLimit: 100, verificationReserve: 20, steps: [{ id: 'input', kind: 'input', prompt: 'Required original input' }] });
  const loop = store.supervision.attach({ commandId: 'attach', runtimeId: runtime.id, config: { model: 'explicit-process-fixture-not-codex', effort: 'low', reservation: 30, timeoutMs: 5000 }, limits: { maxRepairs: 1, maxReasoningCalls: 4, maxDurationMs: 60000, maxContextChars: 200000 } });
  let runner = new SupervisionReasoningRunner(store, data, transport);
  return { root, data, workspace, runtime, loop, transport, get store() { return store; }, get runner() { return runner; },
    begin(context: unknown = input) { return store.supervision.beginJob({ commandId: 'job', loopId: loop.id, expectedRevision: store.supervision.get(loop.id).revision, purpose: 'diagnosis', context }); },
    pause() { const value = store.supervision.get(loop.id); store.supervision.update(value.id, value.revision, { paused: true }); },
    reopen() { store.close(); store = new SupervisorStore(data); runner = new SupervisionReasoningRunner(store, data, transport); },
    async close() { await runner.close(); await transport.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
  };
}
async function rejected(promise: Promise<unknown>) { await assert.rejects(promise, SupervisionReasoningError); }

test('P6-SRR-I01 frozen prompt schema context and one real process settle once without completing the Run', async t => {
  const f = fixture(); t.after(() => f.close()); const job = f.begin(), original = f.store.runtime.inspect(f.runtime.id).run.contract;
  const a = f.runner.run(job.id), b = f.runner.run(job.id); assert.equal(a, b);
  const done = await a; assert.equal(done.status, 'finished'); assert.equal(done.error, null); assert.equal(done.usage, 7); assert.deepEqual(done.input, input);
  assert.equal(f.transport.calls, 1); assert.equal(f.transport.inputs[0]?.prompt, input.prompt); assert.deepEqual(f.transport.inputs[0]?.outputSchema, schema);
  assert.equal(done.intents.length, 1); assert.equal(done.identities.length, 1); assert.equal((await inspectProcess(done.identities[0]!)).status, 'stopped'); assert.equal(Object.keys(done.proofs).length, 1);
  assert.deepEqual(await f.runner.run(job.id), done); assert.equal(f.transport.calls, 1);
  const run = f.store.runtime.inspect(f.runtime.id).run; assert.equal(run.budget.spent, 7); assert.equal(run.attempts.length, 1); assert.deepEqual(run.contract, original); assert.notEqual(run.status, 'succeeded');
});

test('P6-SRR-I02 tampered frozen input digest is rejected before any process with zero known cost', async t => {
  const f = fixture(); t.after(() => f.close()); const job = f.begin();
  const db = new DatabaseSync(join(f.data, 'supervisor.sqlite')); db.prepare('UPDATE supervision_jobs SET record=json_set(record,\'$.input.context.source\',\'changed\') WHERE id=?').run(job.id); db.close();
  await rejected(f.runner.run(job.id)); const done = f.store.supervision.job(job.id); assert.match(done.error!, /digest/); assert.equal(done.usage, 0); assert.equal(done.stopConfirmed, true); assert.equal(f.transport.calls, 0);
});

test('P6-SRR-I03 missing context and unsupported output schema fail before model transport', async t => {
  for (const context of [{ prompt: input.prompt, outputSchema: schema }, { ...input, outputSchema: { type: 'object', unsupportedKeyword: true } }]) {
    const f = fixture(); t.after(() => f.close()); const job = f.begin(context); await rejected(f.runner.run(job.id)); assert.equal(f.transport.calls, 0); assert.equal(f.store.supervision.job(job.id).usage, 0);
  }
});

test('P6-SRR-I04 finished result rechecks actual proof bytes across reopen without replay', async t => {
  const f = fixture(); t.after(() => f.close()); const job = f.begin(), done = await f.runner.run(job.id); f.reopen();
  assert.deepEqual(await f.runner.run(job.id), done); writeFileSync(Object.keys(done.proofs)[0]!, 'changed proof');
  await assert.rejects(f.runner.run(job.id), /proof digest changed/); assert.equal(f.transport.calls, 1); assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 7);
});

test('P6-SRR-I05 pause after actual process stop preserves cost and rejects the late result', async t => {
  const gate = deferred(), f = fixture(new ProcessFixtureTransport({ afterProcess: () => gate.promise })); t.after(() => f.close()); const job = f.begin(), pending = f.runner.run(job.id); const failure = rejected(pending);
  await f.transport.completed.promise; f.pause(); gate.resolve(); await failure;
  const done = f.store.supervision.job(job.id); assert.equal(done.result, null); assert.equal(done.usage, 7); assert.equal(done.stopConfirmed, true); assert.match(done.error!, /disabled/); assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 7);
});

test('P6-SRR-I06 cancel stops a real child and unknown authoritative usage remains reserved', async t => {
  const f = fixture(new ProcessFixtureTransport({ hold: true })); t.after(() => f.close()); const job = f.begin(), pending = f.runner.run(job.id), failure = rejected(pending);
  await f.transport.started.promise; const done = await f.runner.cancel(job.id); await failure;
  assert.equal(done.status, 'finished'); assert.equal(done.result, null); assert.equal(done.usage, null); assert.equal(done.stopConfirmed, true); assert.equal((await inspectProcess(done.identities[0]!)).status, 'stopped');
  f.reopen(); await rejected(f.runner.run(job.id)); const run = f.store.runtime.inspect(f.runtime.id).run; assert.equal(run.attempts[0]?.settled, false); assert.equal(run.attempts[0]?.reservation, 30); assert.equal(f.transport.calls, 1);
});

test('P6-SRR-I07 restart terminates persisted real orphan and never replays an interrupted turn', async t => {
  const f = fixture(); t.after(() => f.close()); const job = f.begin();
  f.store.supervision.observeJob(job.id, { modelStarted: true, observedUsage: 7 });
  const child = await spawnManagedProcess({ operationId: job.id + '-orphan', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: f.workspace, timeoutMs: 5000,
    onBeforeSpawn: intent => { f.store.supervision.observeJob(job.id, { intents: [intent] }); }, onIdentity: identity => { f.store.supervision.observeJob(job.id, { identities: [identity] }); } });
  f.transport.children.push(child); f.reopen(); await f.runner.initialize();
  const done = f.store.supervision.job(job.id); assert.equal(done.usage, null); assert.equal(done.stopConfirmed, true); assert.equal(done.result, null); assert.match(done.error!, /without replay/); assert.equal((await inspectProcess(child.identity)).status, 'stopped');
  await rejected(f.runner.run(job.id)); assert.equal(f.transport.calls, 0); assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts[0]?.settled, false);
});

test('P6-SRR-I08 restart before process intent settles zero and no transport is requested', async t => {
  const f = fixture(); t.after(() => f.close()); const job = f.begin(); f.reopen(); await f.runner.initialize(); await f.runner.initialize();
  const done = f.store.supervision.job(job.id); assert.equal(done.usage, 0); assert.equal(done.stopConfirmed, true); assert.equal(done.result, null); assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts[0]?.settled, true); await rejected(f.runner.run(job.id)); assert.equal(f.transport.calls, 0);
});

test('P6-SRR-I09 claimed stopped live process is independently rejected and terminated', async t => {
  const f = fixture(new ProcessFixtureTransport({ liveClaim: true })); t.after(() => f.close()); const job = f.begin(); await rejected(f.runner.run(job.id));
  const done = f.store.supervision.job(job.id); assert.equal(done.result, null); assert.equal(done.stopConfirmed, true); assert.equal(done.usage, 7); assert.match(done.error!, /actual stopped/); assert.equal((await inspectProcess(done.identities[0]!)).status, 'stopped');
});

test('P6-SRR-I10 malformed output or absent actual proof cannot become an applicable result', async t => {
  for (const options of [{ value: { unexpected: true } }, { noProof: true }]) {
    const f = fixture(new ProcessFixtureTransport(options)); t.after(() => f.close()); const job = f.begin(); await rejected(f.runner.run(job.id)); const done = f.store.supervision.job(job.id); assert.equal(done.result, null); assert.equal(done.usage, 7); assert.equal(done.stopConfirmed, true); assert.ok(done.error);
  }
});

test('P6-SRR-I11 underreported usage retains observed cost unresolved and overrun is charged without result', async t => {
  for (const usage of [0, 35]) {
    const f = fixture(new ProcessFixtureTransport({ usage, observed: 12 })); t.after(() => f.close()); const job = f.begin(); await rejected(f.runner.run(job.id)); const done = f.store.supervision.job(job.id), run = f.store.runtime.inspect(f.runtime.id).run;
    assert.equal(done.reportedUsage, usage); assert.equal(done.observedUsage, 12); assert.equal(done.result, null);
    if (usage === 0) { assert.equal(done.usage, null); assert.equal(run.attempts[0]?.settled, false); assert.equal(run.budget.spent, 0); }
    else { assert.equal(done.usage, 35); assert.equal(run.attempts[0]?.settled, true); assert.equal(run.budget.spent, 35); }
  }
});

test('P6-SRR-I12 exact reserved usage permits current completion and rejects another turn intent', async t => {
  const f = fixture(new ProcessFixtureTransport({ usage: 30, observed: 30 })); t.after(() => f.close()); const job = f.begin(), done = await f.runner.run(job.id);
  assert.equal(done.usage, 30); assert.equal(done.error, null); await assert.rejects(async () => { await f.transport.inputs[0]!.onTurnIntent?.(); }, /exhausted|dispatchable/); assert.equal(f.transport.calls, 1);
});

test('P6-SRR-I13 close during result await blocks publication and retains unknown final usage', async t => {
  const gate = deferred(), f = fixture(new ProcessFixtureTransport({ afterProcess: () => gate.promise })); t.after(() => f.close()); const job = f.begin(), pending = f.runner.run(job.id), failure = rejected(pending);
  await f.transport.completed.promise; const closing = f.runner.close(); gate.resolve(); await closing; await failure;
  const done = f.store.supervision.job(job.id); assert.equal(done.result, null); assert.equal(done.stopConfirmed, true); assert.equal(done.usage, null); await rejected(f.runner.run(job.id));
});

test('P6-SRR-I14 finished proof cannot bypass a newer pause or changed immutable contract', async t => {
  for (const change of ['pause', 'contract']) {
    const f = fixture(); t.after(() => f.close()); const job = f.begin(), done = await f.runner.run(job.id);
    if (change === 'pause') f.pause();
    else { const db = new DatabaseSync(join(f.data, 'supervisor.sqlite')); db.prepare('UPDATE runs SET snapshot=json_set(snapshot,\'$.contract.goal\',\'changed requirements\') WHERE project_id=? AND id=?').run(job.projectId, job.runId); db.close(); }
    await rejected(f.runner.run(job.id)); assert.deepEqual(f.store.supervision.job(job.id), done); assert.equal(f.transport.calls, 1);
  }
});


test('P6-SRR-I15 finished result mutation is rejected even when proof files remain unchanged', async t => {
  const f = fixture(); t.after(() => f.close()); const job = f.begin(); await f.runner.run(job.id);
  const db = new DatabaseSync(join(f.data, 'supervisor.sqlite')); db.prepare("UPDATE supervision_jobs SET record=json_set(record,'$.result.diagnosis','unbound changed result') WHERE id=?").run(job.id); db.close();
  await assert.rejects(f.runner.run(job.id), /completion digest changed/); assert.equal(f.transport.calls, 1); assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, 7);
});

test('P6-SRR-I16 saved process intent without matching identity keeps stop unknown across recovery', async t => {
  const f = fixture(); t.after(() => f.close()); const job = f.begin();
  f.store.supervision.observeJob(job.id, { intents: [{ operationId: job.id + '-missing', ownerToken: 'fixture-missing-owner', command: process.execPath, args: [], cwd: f.workspace, createdAt: new Date().toISOString() }] });
  f.reopen(); await f.runner.initialize(); const done = f.store.supervision.job(job.id);
  assert.equal(done.stopConfirmed, false); assert.equal(done.usage, null); assert.equal(done.result, null); assert.equal(f.transport.calls, 0);
  const run = f.store.runtime.inspect(f.runtime.id).run; assert.equal(run.attempts[0]?.settled, false); assert.equal(run.operations[0]?.status, 'unknown'); await rejected(f.runner.run(job.id));
});


test('P6-SRR-I17 close settles unclaimed prelaunch jobs without a model request', async t => {
  const f = fixture(); t.after(() => f.close()); const job = f.begin(); await f.runner.close();
  const done = f.store.supervision.job(job.id); assert.equal(done.status, 'finished'); assert.equal(done.result, null); assert.equal(done.usage, 0); assert.equal(done.stopConfirmed, true); assert.equal(f.transport.calls, 0);
  await rejected(f.runner.run(job.id));
});

test('P6-SRR-I18 contradictory transport start flag cannot turn durable turn intent into known zero cost', async t => {
  const f = fixture(new ProcessFixtureTransport({ contradictoryStart: true, observed: 0, usage: 0 })); t.after(() => f.close()); const job = f.begin(); await rejected(f.runner.run(job.id));
  const done = f.store.supervision.job(job.id); assert.equal(done.modelStarted, true); assert.equal(done.usage, null); assert.equal(done.result, null); assert.equal(done.stopConfirmed, true); assert.equal(f.store.runtime.inspect(f.runtime.id).run.attempts[0]?.settled, false);
});


test('P6-SRR-I19 runtime cancellation after stopped process retains real cost without applying late output', async t => {
  const gate = deferred(), f = fixture(new ProcessFixtureTransport({ afterProcess: () => gate.promise })); t.after(() => f.close()); const job = f.begin(), pending = f.runner.run(job.id), failure = rejected(pending);
  await f.transport.completed.promise;
  f.store.runtime.control({ type: 'cancel', commandId: 'external-cancel', runtimeId: f.runtime.id }); gate.resolve(); await failure;
  const done = f.store.supervision.job(job.id), run = f.store.runtime.inspect(f.runtime.id).run;
  assert.equal(done.result, null); assert.equal(done.usage, 7); assert.equal(done.stopConfirmed, true); assert.equal(run.status, 'cancelled'); assert.equal(run.budget.spent, 7); assert.equal(run.attempts[0]?.status, 'cancelled'); assert.equal(run.attempts[0]?.settled, true); assert.equal(run.operations[0]?.status, 'confirmed');
});
