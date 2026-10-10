import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { spawnManagedProcess, inspectProcess, terminateProcess, type ManagedProcess, type ProcessIdentity } from '../../packages/process-control/index.js';

async function fixture(t: TestContext): Promise<{ root: string; managed: (source: string, extra?: Partial<Parameters<typeof spawnManagedProcess>[0]>) => Promise<ManagedProcess> }> {
  const root = await mkdtemp(join(tmpdir(), 'sv-p2-process-'));
  const identities: ProcessIdentity[] = [];
  t.after(async () => {
    for (const identity of identities) {
      const stop = await terminateProcess(identity, { graceMs: 100 });
      assert.equal(stop.stopped, true, 'fixture must leave no executing process group');
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, async managed(source, extra) {
    const handle = await spawnManagedProcess({ operationId: 'test-operation', command: process.execPath, args: ['-e', source], cwd: root,
      intentRecorded: true, ...extra, onIdentity: async identity => { identities.push(identity); await extra?.onIdentity?.(identity); } });
    return handle;
  } };
}
async function waitFile(path: string): Promise<string> {
  const deadline = performance.now() + 5000;
  for (;;) {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || performance.now() > deadline) throw error; await delay(20); }
  }
}
async function output(stream: NodeJS.ReadableStream): Promise<string> {
  let result = '';
  for await (const chunk of stream) result += String(chunk);
  return result;
}
function request(root: string, source: string): Parameters<typeof spawnManagedProcess>[0] {
  return { operationId: 'actual-operation', command: process.execPath, args: ['-e', source], cwd: root, intentRecorded: true };
}

test('managed process transports stdin stdout stderr with cwd and environment', async t => {
  const f = await fixture(t);
  const handle = await f.managed(`process.stdin.once('data', bytes => {
    console.log(JSON.stringify({ line: String(bytes), cwd: process.cwd(), env: process.env.SV_TEST_VALUE }));
    console.error('actual stderr bytes'); process.exit(7);
  });`, { env: { SV_TEST_VALUE: 'isolated-value' } });
  const stdout = output(handle.stdout), stderr = output(handle.stderr);
  assert.throws(() => handle.writeLine('bad\nline'), /newlines/);
  handle.writeLine('actual input');
  const result = await handle.completion;
  assert.deepEqual(JSON.parse(await stdout), { line: 'actual input\n', cwd: await realpath(f.root), env: 'isolated-value' });
  assert.equal(await stderr, 'actual stderr bytes\n');
  assert.equal(result.exitCode, 7);
  assert.equal(result.reason, 'completed');
  assert.equal(result.stopped, true);
  assert.equal(result.identity.pid, result.identity.pgid);
});

test('managed process commits intent and identity before releasing target', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'executed');
  const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`;
  const order: string[] = [];
  const handle = await f.managed(source, { ...request(f.root, source),
    onBeforeSpawn: async intent => { order.push('intent'); await writeFile(join(f.root, 'intent.json'), JSON.stringify(intent)); },
    onIdentity: async identity => {
      order.push('identity');
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      assert.equal((await inspectProcess(identity)).status, 'verified');
      await writeFile(join(f.root, 'identity.json'), JSON.stringify(identity));
    },
  });
  assert.equal((await handle.completion).stopped, true);
  assert.deepEqual(order, ['intent', 'identity']);
  assert.equal(await readFile(marker, 'utf8'), 'executed');
  const intent = JSON.parse(await readFile(join(f.root, 'intent.json'), 'utf8')) as { ownerToken: string };
  assert.equal(intent.ownerToken, handle.identity.ownerToken);
  await rm(marker);
  await assert.rejects(f.managed(source, { ...request(f.root, source), onIdentity: () => { throw new Error('durable identity failed'); } }), /durable identity failed/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await assert.rejects(f.managed(source, { ...request(f.root, source), onBeforeSpawn: () => { throw new Error('durable intent failed'); } }), /durable intent failed/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('managed process rejects missing intent malformed limits and failed executable', async t => {
  const f = await fixture(t);
  const { intentRecorded: _intent, ...withoutIntent } = request(f.root, 'process.exit(0)');
  await assert.rejects(spawnManagedProcess(withoutIntent), /durable execution intent/);
  for (const value of [0, -1, Number.NaN, 1.5, 2_147_483_648]) {
    await assert.rejects(spawnManagedProcess({ ...request(f.root, ''), timeoutMs: value }), /time limit/);
  }
  await assert.rejects(spawnManagedProcess({ ...request(f.root, ''), cwd: join(f.root, 'missing') }), { code: 'ENOENT' });
  await assert.rejects(f.managed('', { ...request(f.root, ''), command: join(f.root, 'missing-executable') }), /spawn failed.*ENOENT/);
});

test('managed process cancellation gracefully stops group and remains idempotent', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'ready');
  const handle = await f.managed(`process.on('SIGTERM', () => { process.exit(0); });
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
    { graceMs: 750 });
  await waitFile(marker);
  const result = await handle.terminate();
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.stopped, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stop.signals.map(value => value.signal), ['SIGTERM']);
  assert.deepEqual(await handle.terminate(), result);
  assert.equal((await inspectProcess(handle.identity)).status, 'stopped');
});

test('managed process timeout kills SIGTERM ignoring descendant and verifies whole group', async t => {
  const f = await fixture(t);
  const pidfile = join(f.root, 'descendant.pid');
  const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const source = `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
  const startedAt = performance.now();
  const handle = await f.managed(source, { ...request(f.root, source), timeoutMs: 500, graceMs: 150 });
  const descendantPid = Number(await waitFile(pidfile));
  const active = await inspectProcess(handle.identity);
  assert.equal(active.status, 'verified');
  assert.ok(active.members.some(member => member.pid === descendantPid));
  const result = await handle.completion;
  assert.equal(result.reason, 'timeout');
  assert.equal(result.stopped, true);
  assert.deepEqual(result.stop.signals.map(value => value.signal), ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(result.stop.members, []);
  assert.ok(performance.now() - startedAt < 5000, 'deadline must remain bounded');
  assert.equal((await inspectProcess(handle.identity)).status, 'stopped');
  t.diagnostic(JSON.stringify({ guardianPid: handle.identity.pid, descendantPid, stop: result.stop }));
});

test('managed process recovers persisted identity after actual supervisor exit', async t => {
  const f = await fixture(t);
  const identityPath = join(f.root, 'restart-identity.json');
  const writes = join(f.root, 'actual-writes');
  const target = `process.on('SIGTERM', () => process.exit(0)); const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(writes)}, 'start\\n'); setInterval(() => fs.appendFileSync(${JSON.stringify(writes)}, 'write\\n'), 30);`;
  const module = new URL('../../packages/process-control/index.js', import.meta.url).href;
  const source = `import { spawnManagedProcess } from ${JSON.stringify(module)};
    import { writeFile } from 'node:fs/promises';
    await spawnManagedProcess(${JSON.stringify(request(f.root, target)).replace(/}$/, '')}, onIdentity: identity => writeFile(${JSON.stringify(identityPath)}, JSON.stringify(identity)) });
    process.exit(0);`;
  const controller = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: '', NODE_OPTIONS: '' } });
  let stderr = '';
  controller.stderr!.on('data', chunk => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => { controller.once('error', reject); controller.once('exit', resolve); });
  assert.equal(code, 0, stderr);
  const identity = JSON.parse(await waitFile(identityPath)) as ProcessIdentity;
  t.after(async () => { assert.equal((await terminateProcess(identity, { graceMs: 100 })).stopped, true); });
  await waitFile(writes);
  await delay(100);
  const before = await readFile(writes, 'utf8');
  assert.ok(before.includes('write'), 'real writer survives its original supervisor');
  assert.equal((await inspectProcess(identity)).status, 'verified');
  const stop = await terminateProcess(identity, { graceMs: 750 });
  assert.equal(stop.stopped, true);
  const stoppedBytes = await readFile(writes, 'utf8');
  await delay(100);
  assert.equal(await readFile(writes, 'utf8'), stoppedBytes, 'recovery stops actual side effects without restarting');
  assert.equal((await inspectProcess(identity)).status, 'stopped');
});

test('managed process rejects reused PID identity and foreign ownership token without signal', async t => {
  const f = await fixture(t);
  const handle = await f.managed('setInterval(() => {}, 1000);');
  for (const identity of [{ ...handle.identity, startIdentity: 'different-start' }, { ...handle.identity, ownerToken: '00000000-0000-0000-0000-000000000000' }]) {
    assert.equal((await inspectProcess(identity)).status, 'unverified');
    const stop = await terminateProcess(identity, { graceMs: 100 });
    assert.equal(stop.stopped, false);
    assert.equal(stop.status, 'unverified');
    assert.deepEqual(stop.signals, []);
    assert.equal((await inspectProcess(handle.identity)).status, 'verified', 'unmatched identity must not kill the unrelated real group');
  }
  await assert.rejects(inspectProcess({ ...handle.identity, pid: 1 }), /Invalid/);
  assert.equal((await handle.terminate()).stopped, true);
});

test('managed process handles abrupt guardian death and stops surviving owned descendants', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'ready');
  const source = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const handle = await f.managed(source, { ...request(f.root, source), graceMs: 100 });
  const targetPid = Number(await waitFile(marker));
  process.kill(handle.identity.pid, 'SIGKILL');
  const result = await handle.completion;
  t.diagnostic(JSON.stringify({ killedGuardian: handle.identity.pid, targetPid, stop: result.stop }));
  assert.equal(result.reason, 'guardian-exit');
  assert.equal(result.stopped, true);
  assert.deepEqual(result.stop.signals.map(value => value.signal), ['SIGTERM', 'SIGKILL']);
  assert.equal((await inspectProcess(handle.identity)).status, 'stopped');
});

test('managed process stops detached token-owned writers after cancellation natural exit and supervisor restart', async t => {
  const f = await fixture(t);
  const foreign = await f.managed('setInterval(() => {}, 1000);');
  for (const mode of ['cancelled', 'completed', 'restart'] as const) {
    const pidfile = join(f.root, `${mode}.pid`);
    const writes = join(f.root, `${mode}.writes`);
    const escaped = `process.on('SIGTERM', () => {}); const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(pidfile)}, String(process.pid));
      fs.appendFileSync(${JSON.stringify(writes)}, 'started\\n');
      setInterval(() => fs.appendFileSync(${JSON.stringify(writes)}, 'write\\n'), 20);`;
    const source = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(escaped)}], { detached: true, stdio: 'ignore' }); child.unref();
      ${mode === 'completed' ? "process.stdin.once('data', () => process.exit(0));" : 'setInterval(() => {}, 1000);'}`;
    let identity: ProcessIdentity;
    let handle: ManagedProcess | undefined;
    if (mode === 'restart') {
      const identityPath = join(f.root, 'detached-restart.json');
      const module = new URL('../../packages/process-control/index.js', import.meta.url).href;
      const controllerSource = `import { spawnManagedProcess } from ${JSON.stringify(module)};
        import { writeFile } from 'node:fs/promises';
        await spawnManagedProcess(${JSON.stringify(request(f.root, source)).replace(/}$/, '')}, onIdentity: identity => writeFile(${JSON.stringify(identityPath)}, JSON.stringify(identity)) }); process.exit(0);`;
      const controller = spawn(process.execPath, ['--input-type=module', '-e', controllerSource], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: '', NODE_OPTIONS: '' } });
      let stderr = '';
      controller.stderr!.on('data', chunk => { stderr += String(chunk); });
      const code = await new Promise<number | null>((resolve, reject) => { controller.once('error', reject); controller.once('exit', resolve); });
      assert.equal(code, 0, stderr);
      identity = JSON.parse(await waitFile(identityPath)) as ProcessIdentity;
      t.after(async () => { assert.equal((await terminateProcess(identity, { graceMs: 100 })).stopped, true); });
    } else {
      handle = await f.managed(source, { graceMs: 100 });
      identity = handle.identity;
    }
    const detachedPid = Number(await waitFile(pidfile));
    await waitFile(writes);
    const active = await inspectProcess(identity);
    const member = active.members.find(value => value.pid === detachedPid);
    assert.equal(active.status, 'verified');
    assert.ok(member, 'ownership scan must find a writer outside the original group');
    assert.notEqual(member.pgid, identity.pgid);
    if (mode === 'restart') {
      // Remove the recorded group leader too: recovery must locate the escaped
      // writer by the persisted token even when its original ancestry is gone.
      process.kill(identity.pid, 'SIGKILL');
      await delay(50);
      assert.equal((await inspectProcess(identity)).status, 'verified');
    }
    if (mode === 'completed') handle!.writeLine('exit after detached writer identity was observed');
    const result = mode === 'completed' ? await handle!.completion
      : mode === 'cancelled' ? await handle!.terminate() : await terminateProcess(identity, { graceMs: 100 });
    assert.equal(result.stopped, true);
    assert.equal((await inspectProcess(identity)).status, 'stopped');
    const stoppedWrites = await readFile(writes, 'utf8');
    await delay(100);
    assert.equal(await readFile(writes, 'utf8'), stoppedWrites, 'detached writer must actually stop changing files');
    assert.equal((await inspectProcess(foreign.identity)).status, 'verified', 'another operation token must remain untouched');
    t.diagnostic(JSON.stringify({ mode, guardianPid: identity.pid, detachedPid, detachedPgid: member.pgid, stopped: result.stopped }));
  }
  // Successive detached parents replace themselves while ownership is being
  // inspected. The stopped result must not mistake the old parent's exit for
  // an empty scope while a newer generation is still spawning or writing.
  const chainLog = join(f.root, 'spawn-chain.log');
  const chainReady = join(f.root, 'spawn-chain.ready');
  const worker = join(f.root, 'chain-worker.cjs');
  await writeFile(worker, `const fs = require('node:fs'); const { spawn } = require('node:child_process');
    const remaining = Number(process.argv[2]);
    process.on('SIGTERM', () => {});
    if (remaining > 0) {
      const next = spawn(process.execPath, [__filename, String(remaining - 1)], { detached: true, stdio: 'ignore' }); next.unref();
      fs.appendFileSync(${JSON.stringify(chainLog)}, String(process.pid) + '\\n');
      fs.writeFileSync(${JSON.stringify(chainReady)}, 'next-generation-spawned');
      process.exit(0);
    } else {
      fs.appendFileSync(${JSON.stringify(chainLog)}, String(process.pid) + '\\n');
      setInterval(() => fs.appendFileSync(${JSON.stringify(chainLog)}, 'writer\\n'), 20);
    }`);
  const chain = await f.managed(`const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(worker)}, '12'], { detached: true, stdio: 'ignore' });
    child.unref(); process.stdin.once('data', () => process.exit(0));`, { graceMs: 100 });
  await waitFile(chainReady);
  const concurrentInspection = inspectProcess(chain.identity);
  chain.writeLine('natural root exit during detached replacement chain');
  await concurrentInspection;
  const chainResult = await chain.completion;
  assert.equal(chainResult.stopped, true);
  assert.equal((await inspectProcess(chain.identity)).status, 'stopped');
  const stoppedChain = await readFile(chainLog, 'utf8');
  assert.ok(stoppedChain.trim().length > 0, 'actual detached replacement chain must execute');
  await delay(200);
  assert.equal(await readFile(chainLog, 'utf8'), stoppedChain, 'no later token-owned generation may keep spawning or writing after stopped');
  assert.equal((await inspectProcess(foreign.identity)).status, 'verified');
  t.diagnostic(JSON.stringify({ mode: 'detached-spawn-chain', guardianPid: chain.identity.pid, generationsRecorded: stoppedChain.trim().split('\n').length, stopped: chainResult.stopped }));
  assert.equal((await foreign.terminate()).stopped, true);
});
