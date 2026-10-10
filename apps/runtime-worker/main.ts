import { appendFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { LocalRuntimeWorker } from '../../packages/runtime/worker.js';
import { readOwnership, writeOwnership } from '../../packages/runtime/worker-ownership.js';

const args = process.argv.slice(2);
const value = (key: string): string => { const i = args.indexOf(key); const v = args[i + 1]; if (i < 0 || !v || v.startsWith('--')) throw new Error('Runtime worker requires ' + key); return v; };
const data = value('--data'), owner = value('--owner');
if (!isAbsolute(data) || !/^[a-f0-9-]{36}$/.test(owner)) throw new Error('Invalid runtime worker identity');
const dataDir = resolve(data);
const store = new SupervisorStore(dataDir);
const worker = new LocalRuntimeWorker(store, dataDir, owner);
let closing = false;
async function close() { if (closing) return; closing = true; await worker.close(); }
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
try { await worker.run(); }
catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  await appendFile(join(dataDir, 'runtime-worker.log'), JSON.stringify({ kind: 'worker-failed', owner, error: detail, time: new Date().toISOString() }) + '\n', { mode: 0o600 });
  const ownership = await readOwnership(dataDir);
  if (ownership?.owner === owner) await writeOwnership(dataDir, { ...ownership, error: detail });
  process.exitCode = 1;
} finally { await close(); store.close(); }
