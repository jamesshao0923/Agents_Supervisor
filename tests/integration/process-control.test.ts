import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

  // /bin/sh is a native writer: inherited Node O_NONBLOCK descriptors used to
  // produce EAGAIN under this actual burst, rather than exercising Node's own
  // retrying stdout implementation. Delay both consumers to force backpressure.
  const block = '0123456789abcdef'.repeat(512);
  const repetitions = 512, bodyBytes = block.length * repetitions;
  const burst = await f.managed('', { command: '/bin/sh', args: ['-c',
    'i=0; while [ "$i" -lt 512 ]; do printf "%s" "$SV_BURST_BLOCK"; printf "%s" "$SV_BURST_BLOCK" >&2; i=$((i+1)); done; printf "%s" stdout-tail; printf "%s" stderr-tail >&2; exit 7'],
    env: { SV_BURST_BLOCK: block }, timeoutMs: 10_000 });
  await delay(300);
  async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let bytes = 0, paused = false;
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk as Uint8Array); chunks.push(buffer); bytes += buffer.length;
      // Keep the final burst queued past the normal TERM grace. The result IPC
      // must not kill the guardian before those last bytes have drained.
      if (!paused && bytes >= bodyBytes - 128 * 1024) { paused = true; await delay(750); }
    }
    return Buffer.concat(chunks);
  }
  const burstStdout = collect(burst.stdout), burstStderr = collect(burst.stderr);
  const burstResult = await burst.completion;
  const [out, err] = await Promise.all([burstStdout, burstStderr]);
  const expectedOut = Buffer.from(block.repeat(repetitions) + 'stdout-tail');
  const expectedErr = Buffer.from(block.repeat(repetitions) + 'stderr-tail');
  assert.deepEqual(out, expectedOut, 'native stdout burst and final tail must arrive byte-for-byte');
  assert.deepEqual(err, expectedErr, 'native stderr burst and final tail must arrive byte-for-byte');
  assert.equal(burstResult.exitCode, 7);
  assert.equal(burstResult.reason, 'completed');
  assert.equal(burstResult.stopped, true);
  t.diagnostic(JSON.stringify({ nativeWriter: '/bin/sh', stdoutBytes: out.length, stderrBytes: err.length,
    stdoutSha256: createHash('sha256').update(out).digest('hex'), stderrSha256: createHash('sha256').update(err).digest('hex'),
    exitCode: burstResult.exitCode, stopped: burstResult.stopped }));
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
  const target = `process.on('SIGTERM', () => process.exit(0)); const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(writes)}, 'start\\n'); setInterval(() => {
    fs.writeSync(1, 'actual stdout after controller exit|'); fs.writeSync(2, 'actual stderr after controller exit|');
    fs.appendFileSync(${JSON.stringify(writes)}, 'write\\n');
  }, 30);`;
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
  await delay(100);
  assert.ok((await readFile(writes, 'utf8')).length > before.length, 'writer keeps producing bytes after both controller output pipes disconnect');
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
  // The target exits while a descendant retains both output pipes. Early
  // fenced cleanup must close those FDs without killing the guardian's relay.
  const inheritedReady = join(f.root, 'inherited-output.ready');
  const inheritedChild = `const fs = require('node:fs');
    process.on('SIGTERM', () => { fs.writeSync(1, 'stdout-final-tail'); fs.writeSync(2, 'stderr-final-tail'); process.exit(0); });
    fs.writeSync(1, 'stdout-before-exit|'); fs.writeSync(2, 'stderr-before-exit|');
    fs.writeFileSync(${JSON.stringify(inheritedReady)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const inherited = await f.managed(`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(inheritedChild)}], { stdio: 'inherit' });
    process.stdin.once('data', () => process.exit(0));`, { graceMs: 750, timeoutMs: 10_000 });
  const inheritedStdout = output(inherited.stdout), inheritedStderr = output(inherited.stderr);
  const inheritedPid = Number(await waitFile(inheritedReady));
  inherited.writeLine('exit with inherited output FDs still open');
  const inheritedResult = await inherited.completion;
  assert.equal(inheritedResult.reason, 'completed');
  assert.equal(inheritedResult.exitCode, 0);
  assert.equal(inheritedResult.stopped, true);
  assert.equal(await inheritedStdout, 'stdout-before-exit|stdout-final-tail');
  assert.equal(await inheritedStderr, 'stderr-before-exit|stderr-final-tail');
  assert.ok(inheritedResult.stop.signals.some(signal => signal.pids?.includes(inheritedPid)), 'descendant cleanup signals belong in final stop proof');
  t.diagnostic(JSON.stringify({ inheritedOutputPid: inheritedPid, exitCode: inheritedResult.exitCode, stopped: inheritedResult.stopped, stop: inheritedResult.stop }));
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
