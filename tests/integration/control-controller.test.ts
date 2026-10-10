import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { VerificationController } from '../../packages/verification/controller.js';

// Actual SQLite/runtime/files. No model success, author approval, or qualified
// evidence is fabricated. These rejection paths must allocate no review work.
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sv-control-controller-')));
  const data = join(root, 'data'), workspace = join(root, 'workspace');
  await mkdir(workspace); await writeFile(join(workspace, 'result.mjs'), 'export const value=2;\n');
  const store = new SupervisorStore(data), controller = new VerificationController(store, data);
  const runtime = store.runtime.submit({ type: 'submit', commandId: 'submit', workspace, workspaceKind: 'project', goal: 'Export two', tokenLimit: 1000, verificationReserve: 100, steps: [{ id: 'input', kind: 'input', prompt: 'Confirm input' }] });
  t.after(async () => { await controller.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const action = { type: 'propose', commandId: 'control-propose', runtimeId: runtime.id, specPath: join(root, 'spec.json'), controlDeclarationPath: join(root, 'declaration.json'), controlAuthorJobId: 'absent-author' };
  function complete() {
    store.runtime.control({ type: 'input', runtimeId: runtime.id, commandId: 'input', stepId: 'input', text: 'Ready' });
    const op = store.runtime.claim(runtime.id, 'actual-input-owner'); assert.ok(op);
    store.runtime.report(op.id, 'actual-input-owner', { messageId: 'input-result', outcome: 'confirmed', result: 'Ready' });
  }
  function snapshot() { return { runtime: store.runtime.inspect(runtime.id), proposals: store.verification.list('proposal'), jobs: store.verification.list('job') }; }
  return { store, controller, runtime, action, complete, snapshot };
}

test('P6-CCTL-I01 V2 proposal rejects unpaired declaration or author before mutating the actual ledger', async t => {
  const f = await fixture(t), before = f.snapshot();
  const { controlAuthorJobId: _author, ...declarationOnly } = f.action;
  const { controlDeclarationPath: _declaration, ...authorOnly } = f.action;
  await assert.rejects(f.controller.dispatch(declarationOnly), /supplied together/);
  await assert.rejects(f.controller.dispatch(authorOnly), /supplied together/);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.store.verification.receipt(f.action.commandId, f.action), undefined);
});

test('P6-CCTL-I02 V2 proposal fences active runtime then rejects missing authoritative author after actual input completion', async t => {
  const f = await fixture(t), active = f.snapshot();
  await assert.rejects(f.controller.dispatch(f.action), /Workflow must finish/);
  assert.deepEqual(f.snapshot(), active);
  f.complete(); assert.equal(f.store.runtime.get(f.runtime.id).phase, 'awaiting-verification');
  const completed = f.snapshot();
  await assert.rejects(f.controller.dispatch(f.action), /Unknown supervision job/);
  assert.deepEqual(f.snapshot(), completed); assert.equal(f.store.verification.receipt(f.action.commandId, f.action), undefined);
  await f.controller.initialize(); assert.deepEqual(f.snapshot(), completed);
});
