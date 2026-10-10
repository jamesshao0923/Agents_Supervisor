import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { captureProcessMember, inspectManagedMember, inspectProcess, terminateProcess, type ProcessIdentity, type ProcessIntent, type ProcessMember } from '../process-control/index.js';

export interface WorkerOwnership {
  owner: string;
  launcher: ProcessMember;
  intent: ProcessIntent | null;
  identity: ProcessIdentity | null;
  worker: ProcessMember | null;
  ready: boolean;
  createdAt: string;
  error?: string;
}
export const workerLockPath = (dataDir: string): string => join(dataDir, 'runtime-worker.lock');

/** Atomically publish complete identity receipts; half JSON is never a readiness signal. */
export async function writeOwnership(dataDir: string, value: WorkerOwnership): Promise<void> {
  await publishReceipt(workerLockPath(dataDir), value, value.owner);
}

async function publishReceipt(directory: string, value: WorkerOwnership, expectedOwner?: string): Promise<void> {
  const original = await lstat(directory);
  if (!original.isDirectory() || original.isSymbolicLink()) throw new Error('Runtime worker ownership directory is unsafe');
  const assertCurrent = async () => {
    const current = await lstat(directory);
    if (current.ino !== original.ino || current.dev !== original.dev) throw new Error('Runtime worker ownership directory was replaced');
    if (expectedOwner !== undefined) {
      const receipt = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8')) as WorkerOwnership;
      if (receipt.owner !== expectedOwner) throw new Error('Stale runtime worker cannot replace a newer ownership receipt');
    }
  };
  await assertCurrent();
  const temporary = join(directory, '.receipt-' + randomUUID());
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await assertCurrent();
    // Retirement moves this unique temporary together with its original
    // directory; a concurrent stale rename cannot find it in a newer directory.
    await rename(temporary, join(directory, 'identity.json'));
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export async function readOwnership(dataDir: string): Promise<WorkerOwnership | null> {
  try { return JSON.parse(await readFile(join(workerLockPath(dataDir), 'identity.json'), 'utf8')) as WorkerOwnership; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function launcherAlive(ownership: WorkerOwnership): Promise<boolean> {
  const current = await captureProcessMember(ownership.launcher.pid);
  return current !== null && current.startIdentity === ownership.launcher.startIdentity && current.pgid === ownership.launcher.pgid;
}

export async function workerAlive(ownership: WorkerOwnership): Promise<boolean> {
  return ownership.identity !== null && ownership.worker !== null && await inspectManagedMember(ownership.identity, ownership.worker);
}

export async function createOwnership(dataDir: string): Promise<WorkerOwnership | null> {
  const directory = workerLockPath(dataDir);
  const launcher = await captureProcessMember(process.pid);
  if (!launcher) throw new Error('Cannot establish runtime launcher process identity');
  const value: WorkerOwnership = { owner: randomUUID(), launcher, intent: null, identity: null, worker: null, ready: false, createdAt: new Date().toISOString() };
  const preparing = directory + '.preparing-' + value.owner;
  await mkdir(preparing, { mode: 0o700 });
  try {
    await publishReceipt(preparing, value);
    // Never overwrite an old incomplete lock: its missing identity cannot prove
    // that the launcher is dead. New launches publish only complete directories.
    try { await lstat(directory); return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(preparing, directory); }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
    const parent = await open(dataDir, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return value;
  } finally { await rm(preparing, { recursive: true, force: true }); }
}

/** Only an absent old worker authorizes takeover; surviving writers are reconciled by its successor. */
export async function retireOwnership(dataDir: string, expected: WorkerOwnership): Promise<void> {
  if (await workerAlive(expected)) throw new Error('Existing runtime worker remains active');
  if (!expected.ready && await launcherAlive(expected)) throw new Error('Runtime worker launcher is still preparing its process');
  if (expected.identity && !expected.worker) {
    // A released target can run before it writes its member receipt. The
    // launcher's death never proves that target stopped; inspect the full scope.
    const inspection = await inspectProcess(expected.identity);
    if (inspection.status === 'unverified') throw new Error('Released runtime worker startup scope cannot be verified');
    if (inspection.status === 'verified') {
      const stopped = await terminateProcess(expected.identity);
      if (!stopped.stopped) throw new Error('Released runtime worker startup scope could not be stopped');
    }
  }
  const directory = workerLockPath(dataDir);
  const before = await stat(directory);
  const current = await readOwnership(dataDir);
  const after = await stat(directory);
  if (!current || current.owner !== expected.owner || before.ino !== after.ino || before.dev !== after.dev) throw new Error('Runtime worker ownership changed during takeover');
  const retired = directory + '.retired-' + expected.owner;
  await rename(directory, retired);
  await rm(retired, { recursive: true, force: true });
}
