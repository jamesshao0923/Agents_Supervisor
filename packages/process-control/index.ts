import { spawn, execFile } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { guardianSource } from './guardian.js';

const execute = promisify(execFile);
const ownershipKey = 'SUPERVISOR_PROCESS_OWNER';

export interface ProcessIntent {
  operationId: string;
  ownerToken: string;
  command: string;
  args: string[];
  cwd: string;
  createdAt: string;
}
export interface ProcessIdentity {
  version: 1;
  operationId: string;
  pid: number;
  pgid: number;
  startIdentity: string;
  ownerToken: string;
  startedAt: string;
}
export interface ProcessMember { pid: number; pgid: number; state: string; startIdentity: string }
export interface ProcessInspection {
  status: 'verified' | 'stopped' | 'unverified';
  checkedAt: string;
  members: ProcessMember[];
  detail: string;
}
export interface StopEvidence extends ProcessInspection {
  stopped: boolean;
  signals: { signal: 'SIGTERM' | 'SIGKILL'; sentAt: string; pids?: number[] }[];
}
export interface ProcessResult {
  identity: ProcessIdentity;
  exitCode: number | null;
  signal: string | null;
  reason: 'completed' | 'cancelled' | 'timeout' | 'guardian-exit';
  stopped: boolean;
  stop: StopEvidence;
}
export interface SpawnManagedOptions {
  operationId: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  graceMs?: number;
  /** Caller has already durably committed an execution intent. */
  intentRecorded?: true;
  /** Runs before even the waiting guardian is spawned. */
  onBeforeSpawn?: (intent: ProcessIntent) => void | Promise<void>;
  /** Target cannot start until this durable identity callback succeeds. */
  onIdentity?: (identity: ProcessIdentity) => void | Promise<void>;
}
export interface ManagedProcess {
  identity: ProcessIdentity;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  completion: Promise<ProcessResult>;
  writeLine(line: string): void;
  terminate(reason?: 'cancelled' | 'timeout'): Promise<ProcessResult>;
}

function validateIdentity(identity: ProcessIdentity): void {
  if (identity.version !== 1 || !Number.isSafeInteger(identity.pid) || identity.pid <= 1 || identity.pgid !== identity.pid
      || !identity.startIdentity || !identity.operationId || !/^[a-f0-9-]{36}$/.test(identity.ownerToken)) {
    throw new Error('Invalid managed process identity');
  }
}
function milliseconds(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) throw new Error('Invalid process time limit');
  return result;
}
async function table(): Promise<ProcessMember[]> {
  const { stdout } = await execute('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart='], { maxBuffer: 4 * 1024 * 1024 });
  const rows: ProcessMember[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), pgid: Number(match[2]), state: match[3]!, startIdentity: match[4]! });
  }
  return rows;
}
async function startIdentity(member: ProcessMember): Promise<string> {
  if (process.platform !== 'linux') return member.startIdentity;
  // /proc start ticks refine ps's seconds on Linux; the random ownership token
  // independently prevents a same-second PID reuse match on either platform.
  const value = await readFile(`/proc/${member.pid}/stat`, 'utf8');
  return `${member.startIdentity}:${value.slice(value.lastIndexOf(')') + 2).split(' ')[19]}`;
}
async function owned(pid: number, token: string): Promise<boolean> {
  try {
    if (process.platform === 'linux') {
      const env = await readFile(`/proc/${pid}/environ`, 'utf8');
      return env.split('\0').includes(`${ownershipKey}=${token}`);
    }
    // Inspect locally without exposing command/environment bytes in evidence.
    const { stdout } = await execute('/bin/ps', ['-E', '-p', String(pid), '-o', 'command='], { maxBuffer: 4 * 1024 * 1024 });
    return new RegExp(`(?:^|\\s)${ownershipKey}=${token}(?:\\s|$)`).test(stdout);
  } catch { return false; }
}

async function ownershipSnapshot(token: string): Promise<{ all: ProcessMember[]; tokenPids: Set<number> }> {
  if (process.platform === 'linux') {
    const all = await table();
    // Enumerate independently of the earlier metadata table: a child born
    // between observations must trigger the missing-PID coherence guard.
    const pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(Number);
    const matches = await Promise.all(pids.map(async pid => await owned(pid, token) ? pid : undefined));
    return { all, tokenPids: new Set(matches.filter((pid): pid is number => pid !== undefined)) };
  }
  try {
    // Environment bytes are used only inside this private ownership lookup.
    // Never return, log, or persist the captured ps command/environment text.
    // Read metadata and token bytes from each single ps row, avoiding a
    // metadata-before-ownership gap when a detached child replaces its parent.
    const { stdout } = await execute('/bin/ps', ['-axE', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command='],
      { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
    const expression = new RegExp(`(?:^|\\s)${ownershipKey}=${token}(?:\\s|$)`);
    const matches = new Set<number>();
    const all: ProcessMember[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/.exec(line);
      if (!row) throw new Error('Unparseable process metadata');
      const pid = Number(row[1]);
      all.push({ pid, pgid: Number(row[2]), state: row[3]!, startIdentity: row[4]! });
      if (expression.test(row[5]!)) matches.add(pid);
    }
    return { all, tokenPids: matches };
  } catch { throw new Error('Managed process ownership scan failed'); }
}

/** Read-only recovery inspection: never starts or replays an operation.
 * Descendants must retain the inherited ownership token. Deliberately erased
 * tokens or separately launched external jobs are outside this ownership scope.
 */
export async function inspectProcess(identity: ProcessIdentity): Promise<ProcessInspection> {
  return inspectAttempt(identity, 2);
}
async function inspectAttempt(identity: ProcessIdentity, retries: number, emptySince?: number): Promise<ProcessInspection> {
  validateIdentity(identity);
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Managed process groups require macOS or Linux');
  const { all, tokenPids } = await ownershipSnapshot(identity.ownerToken);
  const live = all.filter(member => !member.state.startsWith('Z'));
  const members = live.filter(member => member.pgid === identity.pgid || tokenPids.has(member.pid));
  const leader = all.find(member => member.pid === identity.pid && !member.state.startsWith('Z'));
  const checkedAt = new Date().toISOString();
  const unresolved = [...tokenPids].filter(pid => !all.some(member => member.pid === pid));
  if (unresolved.length) {
    if (retries > 0) { await delay(15); return inspectAttempt(identity, retries - 1); }
    return { status: 'unverified', checkedAt, members, detail: `Ownership snapshot lacks metadata for PIDs ${unresolved.join(',')}` };
  }
  if (leader) {
    let matches = false;
    try { matches = leader.pgid === identity.pgid && await startIdentity(leader) === identity.startIdentity && await owned(leader.pid, identity.ownerToken); }
    catch { /* Exit during inspection is rechecked below. */ }
    if (matches && members.every(member => tokenPids.has(member.pid))) {
      for (const member of members) { try { member.startIdentity = await startIdentity(member); } catch { /* Fence will refuse vanished members. */ } }
      return { status: 'verified', checkedAt, members, detail: 'Leader identity and all token-owned members match, including other groups' };
    }
    const current = (await table()).find(member => member.pid === identity.pid && !member.state.startsWith('Z'));
    if (!current || retries > 0) {
      if (retries > 0) { await delay(15); return inspectAttempt(identity, retries - 1); }
      if (!current) return inspectAttempt(identity, 0);
    }
    // A reused PID must never authorize a signal, even if its group is empty.
    return { status: 'unverified', checkedAt, members, detail: 'Leader identity or ownership mismatch' };
  }
  if (!members.length) {
    // A newly exec'ing detached child can briefly lack ps environment bytes.
    // Require a stable quiet window, rather than letting two adjacent empty
    // samples mistake that handoff for a fully stopped ownership scope.
    const quietSince = emptySince ?? performance.now();
    if (performance.now() - quietSince < 250) { await delay(25); return inspectAttempt(identity, retries, quietSince); }
    return { status: 'stopped', checkedAt, members, detail: 'Repeated snapshots remained empty for 250ms across the original group and recorded ownership token' };
  }
  const verified = members.every(member => tokenPids.has(member.pid));
  if (!verified && retries > 0) { await delay(15); return inspectAttempt(identity, retries - 1); }
  if (verified) for (const member of members) { try { member.startIdentity = await startIdentity(member); } catch { /* Rechecked before signal. */ } }
  return { status: verified ? 'verified' : 'unverified', checkedAt, members,
    detail: verified ? 'Orphan members across groups retain the recorded ownership token' : 'Member ownership cannot be established; deliberate token erasure is unsupported' };
}

/** TERM, bounded grace, KILL, then actual group inspection. Fails closed on PID reuse. */
export async function terminateProcess(identity: ProcessIdentity, options: { graceMs?: number; killWaitMs?: number } = {}): Promise<StopEvidence> {
  const graceMs = milliseconds(options.graceMs, 250);
  const killWaitMs = milliseconds(options.killWaitMs, 3000);
  const signals: StopEvidence['signals'] = [];
  let inspection = await inspectProcess(identity);
  const evidence = (): StopEvidence => ({ ...inspection, stopped: inspection.status === 'stopped', signals });
  async function signal(value: 'SIGTERM' | 'SIGKILL'): Promise<boolean> {
    // Recheck immediately before each signal; never trust a prior PID lookup.
    inspection = await inspectProcess(identity);
    if (inspection.status !== 'verified') return false;
    const sent: number[] = [];
    // Signal individual verified members, never an escaped member's whole PGID:
    // that group can also contain unrelated processes with no ownership token.
    // Leader is last so it remains available for the other members' fencing.
    const targets = [...inspection.members].sort((a, b) => Number(a.pid === identity.pid) - Number(b.pid === identity.pid));
    for (const member of targets) {
      const current = (await table()).find(row => row.pid === member.pid && !row.state.startsWith('Z'));
      if (!current) continue;
      let matched = false;
      try { matched = current.pgid === member.pgid && await startIdentity(current) === member.startIdentity && await owned(current.pid, identity.ownerToken); }
      catch { /* A vanished member must not authorize a signal. */ }
      if (!matched) {
        const remaining = (await table()).find(row => row.pid === member.pid && !row.state.startsWith('Z'));
        if (!remaining) continue;
        inspection = { status: 'unverified', checkedAt: new Date().toISOString(), members: inspection.members, detail: `Member ${member.pid} identity changed before signal` };
        if (sent.length) signals.push({ signal: value, sentAt: new Date().toISOString(), pids: sent });
        return false;
      }
      try { process.kill(member.pid, value); sent.push(member.pid); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
        const remaining = (await table()).find(row => row.pid === member.pid && !row.state.startsWith('Z'));
        if (code === 'EPERM' && remaining) throw error;
      }
    }
    if (sent.length) signals.push({ signal: value, sentAt: new Date().toISOString(), pids: sent });
    inspection = await inspectProcess(identity);
    return sent.length > 0;
  }
  if (inspection.status !== 'verified' || !await signal('SIGTERM')) return evidence();
  const graceDeadline = performance.now() + graceMs;
  while (performance.now() < graceDeadline) {
    inspection = await inspectProcess(identity);
    if (inspection.status !== 'verified') return evidence();
    await delay(Math.min(25, Math.max(1, graceDeadline - performance.now())));
  }
  if (!await signal('SIGKILL')) return evidence();
  const killDeadline = performance.now() + killWaitMs;
  do {
    inspection = await inspectProcess(identity);
    if (inspection.status !== 'verified') return evidence();
    // Cover children born during the prior sweep; each new PID is fenced again.
    if (!await signal('SIGKILL')) return evidence();
    await delay(25);
  } while (performance.now() < killDeadline);
  return evidence();
}

export async function spawnManagedProcess(options: SpawnManagedOptions): Promise<ManagedProcess> {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Managed process groups require macOS or Linux');
  if (!options.operationId?.trim() || !options.command?.trim() || !options.cwd || options.args?.some(arg => typeof arg !== 'string')) throw new Error('Invalid managed process request');
  if (!options.intentRecorded && !options.onBeforeSpawn) throw new Error('A durable execution intent is required before spawn');
  const graceMs = milliseconds(options.graceMs, 250);
  if (options.timeoutMs !== undefined) milliseconds(options.timeoutMs, 1);
  if (!(await stat(options.cwd)).isDirectory()) throw new Error('Process cwd must be a directory');
  const ownerToken = randomUUID();
  const intent: ProcessIntent = { operationId: options.operationId, ownerToken, command: options.command, args: [...options.args ?? []], cwd: options.cwd, createdAt: new Date().toISOString() };
  await options.onBeforeSpawn?.(intent);
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, [ownershipKey]: ownerToken };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ['-e', guardianSource, '--', `--supervisor-owner=${ownerToken}`], { detached: true, shell: false, cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let resultCode: number | null = null, resultSignal: string | null = null;
  let reason: ProcessResult['reason'] = 'completed';
  let resultReceived = false;
  let identity!: ProcessIdentity;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stopPromise: Promise<StopEvidence> | undefined;
  let settle!: (result: ProcessResult) => void;
  const completion = new Promise<ProcessResult>(resolve => { settle = resolve; });
  let closed = false;
  async function finish(): Promise<void> {
    if (timeout) clearTimeout(timeout);
    if (!identity) return;
    if (!resultReceived && reason === 'completed') reason = 'guardian-exit';
    const stop = await (stopPromise ?? terminateProcess(identity, { graceMs }));
    settle({ identity, exitCode: resultCode, signal: resultSignal, reason, stopped: stop.stopped, stop });
  }
  // Exit, rather than pipe close, also detects an abruptly killed guardian
  // whose surviving descendants still hold stdout/stderr descriptors open.
  child.once('exit', () => { closed = true; void finish().catch(() => {
    settle({ identity, exitCode: resultCode, signal: resultSignal, reason, stopped: false,
      stop: { status: 'unverified', checkedAt: new Date().toISOString(), members: [], detail: 'Stop inspection failed', stopped: false, signals: [] } });
  }); });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Managed guardian startup timed out')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Managed guardian exited during startup')); });
    child.on('message', message => {
      const value = message as { type?: string; exitCode?: number | null; signal?: string | null };
      if (value.type === 'ready') { clearTimeout(timer); resolve(); }
      if (value.type === 'result') { resultReceived = true; resultCode = value.exitCode ?? null; resultSignal = value.signal ?? null;
        stopPromise ??= terminateProcess(identity, { graceMs }); void stopPromise.catch(() => {}); }
    });
  });
  try {
    await ready;
    const member = (await table()).find(row => row.pid === child.pid);
    if (!member || member.pgid !== child.pid) throw new Error('Managed guardian has no isolated process group');
    identity = { version: 1, operationId: options.operationId, pid: member.pid, pgid: member.pgid, startIdentity: await startIdentity(member), ownerToken, startedAt: new Date().toISOString() };
    if ((await inspectProcess(identity)).status !== 'verified') throw new Error('Managed guardian ownership is not verifiable');
    await options.onIdentity?.(identity);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Managed target startup timed out')), 5000);
      const listener = (message: unknown): void => {
        const value = message as { type?: string; message?: string };
        if (value.type === 'started' || value.type === 'spawnError') {
          clearTimeout(timer); child.off('message', listener);
          if (value.type === 'started') resolve(); else reject(new Error(`Managed target spawn failed: ${value.message}`));
        }
      };
      child.on('message', listener);
      child.send({ type: 'start', command: options.command, args: options.args ?? [], cwd: options.cwd, env });
    });
  } catch (error) {
    if (identity) await terminateProcess(identity, { graceMs });
    else if (child.connected) child.disconnect(); // A guardian with no released target exits on disconnect.
    throw error;
  }
  const terminate = async (requested: 'cancelled' | 'timeout' = 'cancelled'): Promise<ProcessResult> => {
    if (!closed && !stopPromise) { reason = requested; stopPromise = terminateProcess(identity, { graceMs }); }
    if (stopPromise) {
      const stop = await stopPromise;
      if (!stop.stopped) {
        if (timeout) clearTimeout(timeout);
        settle({ identity, exitCode: resultCode, signal: resultSignal, reason, stopped: false, stop });
      }
    }
    return completion;
  };
  if (options.timeoutMs !== undefined && !closed) timeout = setTimeout(() => { void terminate('timeout').catch(() => {}); }, options.timeoutMs);
  return { identity, stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, completion,
    writeLine(line) { if (line.includes('\n') || line.includes('\r')) throw new Error('Transport line must not contain newlines'); child.stdin!.write(`${line}\n`); }, terminate };
}
