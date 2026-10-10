import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { request } from '../../apps/cli/client.js';
import type { Command, CommandResult, Query, Run, StoredEvent } from '../../packages/contracts/p1.js';

const cli = fileURLToPath(new URL('../../apps/cli/main.js', import.meta.url));
const children = new Set<ChildProcess>();
interface Fixture { data: string; process: ChildProcess }

async function launch(data: string): Promise<ChildProcess> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, [cli, 'serve', '--data', data], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Service start timeout: ${stderr}`)); }, 5000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited ${code}: ${stderr}`)); });
    child.stdout!.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.includes('"event":"listening"')) { clearTimeout(timer); resolve(); }
    });
  });
  return child;
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill(signal);
    const fallback = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(fallback); }
  }
  children.delete(child);
}

async function fixture(t: TestContext): Promise<Fixture> {
  // Keep the Unix socket below the platform pathname limit.
  const data = await mkdtemp(join(tmpdir(), 'sv-p1-'));
  t.after(async () => {
    for (const child of [...children]) await stop(child);
    await rm(data, { recursive: true, force: true });
  });
  return { data, process: await launch(data) };
}

async function command<T>(data: string, value: Command): Promise<T> {
  const response = await request(data, { id: randomUUID(), method: 'command', command: value });
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response.value as CommandResult).value as T;
}

async function query<T>(data: string, value: Query): Promise<T> {
  const response = await request(data, { id: randomUUID(), method: 'query', query: value });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.value as T;
}

async function seed(data: string): Promise<Run> {
  await command(data, { commandId: 'project-command', type: 'createProject', project: { id: 'project', name: 'P1 real IPC' } });
  return command(data, {
    commandId: 'run-command', type: 'createRun', input: {
      id: 'run', projectId: 'project', contract: { version: 1, goal: 'Persist an actual artifact', criteria: [{ id: 'content', description: 'The artifact contains expected bytes', required: true }] },
      nodes: [{ id: 'write', dependencies: [], required: true }], budget: { limit: 100, verificationReserve: 20 },
    },
  });
}

test('service IPC persists commands budget events and actual artifact across restart', async t => {
  const f = await fixture(t);
  let run = await seed(f.data);
  run = await command(f.data, { commandId: 'start', type: 'act', projectId: 'project', runId: 'run', expectedRevision: run.revision,
    action: { type: 'startAttempt', attemptId: 'a1', nodeId: 'write', contractVersion: 1, reservation: 40, purpose: 'execution', resources: ['workspace'] } });
  run = await command(f.data, { commandId: 'finish', type: 'act', projectId: 'project', runId: 'run', expectedRevision: run.revision, action: { type: 'finishAttempt', attemptId: 'a1', outcome: 'succeeded' } });
  run = await command(f.data, { commandId: 'settle', type: 'act', projectId: 'project', runId: 'run', expectedRevision: run.revision, action: { type: 'settleAttempt', attemptId: 'a1', actual: 27 } });
  run = await command(f.data, { commandId: 'release', type: 'act', projectId: 'project', runId: 'run', expectedRevision: run.revision, action: { type: 'releaseLease', resource: 'workspace', attemptId: 'a1' } });
  const bytes = 'Supervisor P1 actual IPC and disk roundtrip\n';
  run = await command(f.data, { commandId: 'publish', type: 'publishArtifact', projectId: 'project', runId: 'run', expectedRevision: run.revision, artifactId: 'actual-output', content: bytes });
  assert.ok(run.artifact);
  assert.equal(await readFile(run.artifact.path, 'utf8'), bytes);
  const premature = await request(f.data, { id: 'premature', method: 'command', command: {
    commandId: 'premature', type: 'act', projectId: 'project', runId: 'run', expectedRevision: run.revision, action: { type: 'complete' },
  } });
  assert.equal(premature.ok, false, 'A real artifact without required evidence is incomplete');
  run = await command(f.data, { commandId: 'actual-file-evidence', type: 'act', projectId: 'project', runId: 'run', expectedRevision: run.revision,
    action: { type: 'recordEvidence', evidence: { id: 'file-readback', criterionId: 'content', contractVersion: 1, artifactDigest: run.artifact.digest, verdict: 'passed', verifierVersion: 'p1-real-readback-v1' } } });
  run = await command(f.data, { commandId: 'complete', type: 'act', projectId: 'project', runId: 'run', expectedRevision: run.revision, action: { type: 'complete' } });
  const before = await query<StoredEvent[]>(f.data, { type: 'events', projectId: 'project', after: 0 });
  assert.ok(before.length >= 7);
  assert.equal(run.budget.spent, 27);
  assert.equal(run.status, 'succeeded');
  await stop(f.process);
  f.process = await launch(f.data);
  assert.deepEqual(await query(f.data, { type: 'run', projectId: 'project', runId: 'run' }), run);
  assert.deepEqual(await query(f.data, { type: 'events', projectId: 'project', after: 0 }), before);
  assert.deepEqual(await query(f.data, { type: 'events', projectId: 'project', after: before.at(-1)!.seq }), []);
  t.diagnostic(JSON.stringify({ actualServicePid: f.process.pid, spent: run.budget.spent, events: before.length, artifactDigest: run.artifact!.digest }));
});

test('service reconciles a committed command by commandId after abrupt process death', async t => {
  const f = await fixture(t);
  const run = await seed(f.data);
  const input: Command = { commandId: 'reservation-once', type: 'act', projectId: 'project', runId: 'run', expectedRevision: run.revision,
    action: { type: 'startAttempt', attemptId: 'a1', nodeId: 'write', contractVersion: 1, reservation: 30, purpose: 'execution', resources: [] } };
  const first = await command<Run>(f.data, input);
  await stop(f.process, 'SIGKILL');
  f.process = await launch(f.data);
  assert.deepEqual(await command(f.data, input), first);
  const events = await query<StoredEvent[]>(f.data, { type: 'events', projectId: 'project', after: 0 });
  assert.equal(events.filter(event => event.commandId === input.commandId).length, 1);
  assert.equal((await query<Run>(f.data, { type: 'run', projectId: 'project', runId: 'run' })).attempts.length, 1);
});

test('service rejects stale revisions cross project reads and forged artifact actions', async t => {
  const f = await fixture(t);
  const run = await seed(f.data);
  await command(f.data, { commandId: 'pause', type: 'act', projectId: 'project', runId: 'run', expectedRevision: run.revision, action: { type: 'pause' } });
  const stale = await request(f.data, { id: 'stale', method: 'command', command: { commandId: 'stale', type: 'act', projectId: 'project', runId: 'run', expectedRevision: run.revision, action: { type: 'cancel' } } });
  assert.equal(stale.ok, false);
  const foreign = await request(f.data, { id: 'foreign', method: 'query', query: { type: 'run', projectId: 'other-project', runId: 'run' } });
  assert.equal(foreign.ok, false);
  const current = await query<Run>(f.data, { type: 'run', projectId: 'project', runId: 'run' });
  const forged = await request(f.data, { id: 'forged', method: 'command', command: { commandId: 'forged', type: 'act', projectId: 'project', runId: 'run', expectedRevision: current.revision,
    action: { type: 'setArtifact', artifact: { id: 'bad', digest: 'f'.repeat(64), path: '/tmp/unmanaged', contractVersion: 1 } } } });
  assert.equal(forged.ok, false);
});

test('service rejects malformed IPC and continues serving actual health requests', async t => {
  const f = await fixture(t);
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(join(f.data, 'supervisor.sock'));
    let text = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.end('this is not JSON\n'));
    socket.on('data', chunk => { text += String(chunk); });
    socket.once('end', () => resolve(text));
  });
  assert.equal(JSON.parse(raw).ok, false);
  const health = await request(f.data, { id: 'health', method: 'health' });
  assert.deepEqual(health, { id: 'health', ok: true, value: {
    status: 'ready', stage: 'P3', modelExecution: true, workspaceManagement: 'path-v1', durableRuntime: 'local-v1',
    runtime: { active: false, worker: null, capabilities: {
      engine: 'local-v1', workflowVersions: [1], pause: 'dispatch-only', input: 'declared-wait', automaticCodexReplay: false,
    } },
  } });
  assert.equal((await stat(join(f.data, 'supervisor.sock'))).mode & 0o777, 0o600);
});

test('service refuses a second owner and preserves the running service', async t => {
  const f = await fixture(t);
  const duplicate = spawn(process.execPath, [cli, 'serve', '--data', f.data], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  duplicate.stderr!.on('data', chunk => { stderr += String(chunk); });
  const [code] = await once(duplicate, 'exit');
  assert.notEqual(code, 0);
  assert.match(stderr, /already owns/);
  assert.equal((await request(f.data, { id: 'still-alive', method: 'health' })).ok, true);
});

test('CLI sends real JSON requests and exits nonzero for rejected operations', async t => {
  const f = await fixture(t);
  const input = join(f.data, 'create.json');
  await writeFile(input, JSON.stringify({ method: 'command', command: { commandId: 'cli-project', type: 'createProject', project: { id: 'cli-project', name: 'CLI real project' } } }));
  async function cliCall(args: string[]): Promise<{ code: number | null; output: string }> {
    const child = spawn(process.execPath, [cli, ...args, '--data', f.data], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', chunk => { output += String(chunk); });
    child.stderr!.on('data', chunk => { output += String(chunk); });
    const [code] = await once(child, 'exit');
    return { code: code as number | null, output };
  }
  assert.equal((await cliCall(['send', '--file', input])).code, 0);
  const list = await cliCall(['projects']);
  assert.equal(list.code, 0);
  assert.match(list.output, /CLI real project/);
  const absent = await cliCall(['show', '--project', 'cli-project', '--run', 'missing']);
  assert.equal(absent.code, 1);
  assert.ok((await readdir(f.data)).some(name => name.includes('sqlite') || name.includes('.db')));
});
