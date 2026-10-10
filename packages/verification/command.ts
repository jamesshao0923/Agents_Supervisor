import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnManagedProcess, terminateProcess, type ProcessIdentity, type ProcessIntent } from '../process-control/index.js';
import { relativeFile } from './candidate.js';
export interface Check { obligationId: string; verdict: 'passed' | 'failed' | 'unknown' | 'not-applicable'; reason: string }
export interface CommandResult { executionStatus: 'executed' | 'environment-blocked' | 'verifier-error'; checks: Check[]; reason: string; proofFiles: string[]; stopped: boolean }
export interface CommandInput {
  id: string; bundle: string; entry: string; cwd: string; parameters: Record<string, string>; obligationIds: string[]; timeoutMs: number; output: string;
  signal?: AbortSignal; onIntent?: (value: ProcessIntent) => void | Promise<void>; onIdentity?: (value: ProcessIdentity) => void | Promise<void>;
}
export async function runCommandVerifier(input: CommandInput): Promise<CommandResult> {
  await mkdir(input.output, { recursive: true });
  const result: CommandResult = { executionStatus: 'verifier-error', checks: [], reason: '', proofFiles: [], stopped: true };
  let report = join(input.output, 'report.json'), stdout = '', stderr = '', launched = false, spawnAuthorized = false;
  let identity: ProcessIdentity | undefined;
  try {
    // Node permissions do not traverse an unauthorized symlink ancestor. Keep
    // every granted root and every path supplied to the target in one realpath
    // namespace rather than granting broad parents such as macOS /var.
    input = { ...input, bundle: await realpath(input.bundle), cwd: await realpath(input.cwd), output: await realpath(input.output) };
    report = join(input.output, 'report.json');
    const entry = await relativeFile(input.bundle, input.entry);
    if (input.signal?.aborted) throw new Error('Verification cancelled before dispatch');
    // Explicit undefined values survive the process manager's environment merge
    // and remove inherited loader configuration from the spawned child.
    const env = { ...process.env, SUPERVISOR_VERIFY_REPORT: report, NODE_OPTIONS: undefined, NODE_PATH: undefined };
    const guard=await realpath(fileURLToPath(new URL('./command-guard.js',import.meta.url)));
    const child = await spawnManagedProcess({ operationId: input.id, command: process.execPath, args: ['--permission','--allow-fs-read='+input.bundle,'--allow-fs-read='+input.cwd,'--allow-fs-read='+guard,'--allow-fs-write='+input.output,'--import',guard,entry, input.cwd, JSON.stringify(input.parameters)], cwd: input.cwd,
      env, timeoutMs: input.timeoutMs,
      onBeforeSpawn: async intent => { result.proofFiles.push(join(input.output, 'intent.json')); await writeFile(join(input.output, 'intent.json'), JSON.stringify(intent)); await input.onIntent?.(intent); if (input.signal?.aborted) throw new Error('Verification cancelled before spawn'); spawnAuthorized = true; result.stopped = false; },
      onIdentity: async value => { identity = value; launched = true; result.proofFiles.push(join(input.output, 'identity.json')); await writeFile(join(input.output, 'identity.json'), JSON.stringify(value)); await input.onIdentity?.(value); if (input.signal?.aborted) throw new Error('Verification cancelled before target release'); },
    });
    let oversized = false;
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); if (stdout.length > 2 * 1024 * 1024) { oversized = true; void child.terminate(); } });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); if (stderr.length > 2 * 1024 * 1024) { oversized = true; void child.terminate(); } });
    const abort = () => { void child.terminate(); }; input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const outcome = await child.completion; input.signal?.removeEventListener('abort', abort);
    result.proofFiles.push(join(input.output, 'process.json')); await writeFile(join(input.output, 'process.json'), JSON.stringify(outcome)); result.stopped = outcome.stopped;
    if (!outcome.stopped || outcome.reason !== 'completed' || oversized || input.signal?.aborted) throw new Error('Verifier process failed, timed out, was cancelled, exceeded output bound or has an unverified stop');
    const bytes = await readFile(report); if (bytes.length > 1024 * 1024) throw new Error('Verifier report too large');
    const value = JSON.parse(bytes.toString()) as { schemaVersion: number; checks: Check[] };
    if (value.schemaVersion !== 1 || !Array.isArray(value.checks) || value.checks.length !== input.obligationIds.length) throw new Error('Missing or malformed fixed verifier report');
    const seen = new Set<string>();
    for (const check of value.checks) {
      if (!check || !input.obligationIds.includes(check.obligationId) || seen.has(check.obligationId) || !['passed', 'failed', 'unknown', 'not-applicable'].includes(check.verdict) || typeof check.reason !== 'string' || !check.reason.trim()) throw new Error('Report does not match the frozen obligations');
      seen.add(check.obligationId);
    }
    const failed = value.checks.some(c => c.verdict !== 'passed' && c.verdict !== 'not-applicable');
    if (outcome.exitCode !== (failed ? 1 : 0)) throw new Error('Verifier exit code conflicts with its fixed report');
    result.executionStatus = 'executed'; result.checks = value.checks; result.reason = 'Actual independent Node verifier completed';
    result.proofFiles.push(report);
  } catch (error) {
    result.reason = String(error); if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !launched) result.executionStatus = 'environment-blocked';
    if (identity && !result.stopped) try { const stop = await terminateProcess(identity); result.stopped = stop.stopped; const path = join(input.output, 'recovery-stop.json'); await writeFile(path, JSON.stringify(stop)); result.proofFiles.push(path); } catch (stopError) { result.reason += '; stop inspection: ' + String(stopError); }
    if (!spawnAuthorized) { const path = join(input.output, 'not-started.json'); await writeFile(path, JSON.stringify({ operationId: input.id, targetStarted: false, reason: result.reason })); result.proofFiles.push(path); }
  }
  for (const [name, body] of [['stdout.log', stdout], ['stderr.log', stderr]] as const) { const path = join(input.output, name); await writeFile(path, body); result.proofFiles.push(path); }
  const path = join(input.output, 'result.json'); await writeFile(path, JSON.stringify(result, null, 2)); result.proofFiles.push(path);
  return result;
}
