import { spawn } from 'node:child_process';
import { constants, closeSync, mkdirSync, openSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--data' || !args[1] || args[1].startsWith('--'))) {
  console.error('Usage: pnpm desktop [--data PATH]');
  process.exit(1);
}
if (process.versions.node !== '24.20.0') {
  console.error('Supervisor desktop requires the pinned Node 24.20.0 runtime. Select .nvmrc before launch.');
  process.exit(1);
}
const dataDir = args[1] ? resolve(args[1]) : join(root, '.supervisor/local');
const socketPath = join(dataDir, 'supervisor.sock');
if (Buffer.byteLength(socketPath) > 100) {
  console.error('Data path is too long for a macOS Unix socket; choose a shorter --data directory.');
  process.exit(1);
}

/** A health probe cannot execute a model or alter global configuration. */
function health() {
  return new Promise((resolvePromise, reject) => {
    const id = randomUUID();
    const socket = createConnection(socketPath);
    let buffer = '', settled = false;
    const fail = error => { if (!settled) { settled = true; socket.destroy(); reject(error); } };
    socket.setTimeout(1500, () => fail(new Error('Backend health timed out')));
    socket.once('error', fail);
    socket.once('connect', () => socket.end(JSON.stringify({ id, method: 'health' }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 32768) fail(new Error('Backend health response exceeded limit'));
    });
    socket.once('end', () => {
      if (settled) return;
      try {
        const response = JSON.parse(buffer);
        if (response.id !== id || !response.ok || response.value?.status !== 'ready') throw new Error('Backend health response invalid');
        settled = true; resolvePromise(response.value);
      } catch (error) { fail(error); }
    });
    socket.once('close', () => { if (!settled) fail(new Error('Backend disconnected during health probe')); });
  });
}
function requireCompatible(value) {
  if (value.stage !== 'P5' || value.requirementsReasoner !== 'codex-v1' || value.conversationProtocol !== 'v1' || value.taskAttachments !== 'v1' || value.publicWebResearch !== 'native-public-web-v1' || value.tokenPolicy !== 'nullable-limit-v1' || value.supervisionProtocol !== 'v1' || value.durableRuntime !== 'local-v1' || value.modelExecution !== true || value.workspaceManagement !== 'path-v1') throw new Error('Existing backend does not support this desktop workspace protocol; stop it explicitly before launching this version.');
}
async function ensureBackend() {
  try { const value = await health(); requireCompatible(value); console.log(`Reusing independent backend: ${dataDir}`); return; }
  catch (error) {
    // Start only when no listener exists. A hung or incompatible service must not
    // be replaced behind the user's back, and a failed probe never proves death.
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logPath = join(dataDir, 'backend.log');
  const log = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  let backend;
  try {
    backend = spawn(process.execPath, [join(root, 'dist/apps/cli/main.js'), 'serve', '--data', dataDir], {
      cwd: root, detached: true, stdio: ['ignore', log, log], shell: false,
    });
  } finally { closeSync(log); }
  let spawnError;
  backend.once('error', error => { spawnError = error; });
  backend.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try { const value = await health(); requireCompatible(value); console.log(`Independent backend ready (Node ${process.execPath}); log: ${logPath}`); return; }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    }
    if (backend.exitCode !== null || backend.signalCode !== null) throw new Error(`Backend exited before readiness; inspect ${logPath}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Backend did not become ready; inspect ${logPath}. It was not forcibly stopped.`);
}

try {
  await ensureBackend();
  const require = createRequire(import.meta.url);
  const electronPath = require('electron');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const desktop = spawn(electronPath, [join(root, 'dist/apps/desktop/main.cjs'), '--data', dataDir], {
    cwd: root, stdio: 'inherit', shell: false, env: environment,
  });
  desktop.once('error', error => { console.error(`Desktop failed to start: ${error.message}. Backend remains running.`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => desktop.kill(signal));
  desktop.once('exit', (code, signal) => {
    console.log('Desktop closed. Independent backend remains running.');
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
