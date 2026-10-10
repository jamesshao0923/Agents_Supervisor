import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnManagedProcess, terminateProcess, type ProcessIdentity, type ProcessIntent } from '../process-control/index.js';
import { digest, relativeFile } from './candidate.js';
const commandRequire = createRequire(import.meta.url);
export interface Check { obligationId: string; verdict: 'passed' | 'failed' | 'unknown' | 'not-applicable'; reason: string }
export interface CommandResult { executionStatus: 'executed' | 'environment-blocked' | 'verifier-error'; checks: Check[]; reason: string; proofFiles: string[]; stopped: boolean }
export interface CommandInput {
  id: string; bundle: string; entry: string; cwd: string; parameters: Record<string, string>; obligationIds: string[]; timeoutMs: number; output: string;
  signal?: AbortSignal; onIntent?: (value: ProcessIntent) => void | Promise<void>; onIdentity?: (value: ProcessIdentity) => void | Promise<void>;
}
export interface CandidateEntryInput {
  id: string; cwd: string; entry: string; timeoutMs: number; output: string; signal?: AbortSignal;
  onIntent?: (value: ProcessIntent) => void | Promise<void>; onIdentity?: (value: ProcessIdentity) => void | Promise<void>;
}
export interface CandidateEntryResult {
  entry: string; executionStatus: CommandResult['executionStatus']; passed: boolean; exitCode: number | null;
  reason: string; proofFiles: string[]; stopped: boolean;
}
/** Execute a declared frozen candidate CLI; only the separate checker emits a report. */
export async function runCandidateEntry(input: CandidateEntryInput): Promise<CandidateEntryResult> {
  const result: CandidateEntryResult = { entry: input.entry, executionStatus: 'verifier-error', passed: false, exitCode: null, reason: '', proofFiles: [], stopped: true };
  let stdout = '', stderr = '', identity: ProcessIdentity | undefined, spawnAuthorized = false, toolUnavailable = false, evidenceReady = false;
  let child: Awaited<ReturnType<typeof spawnManagedProcess>> | undefined;
  const abort = (): void => { void child?.terminate().catch(() => {}); };
  async function proof(name: string, bytes: string): Promise<void> {
    if (!evidenceReady) throw new Error('Candidate entry evidence destination is not validated');
    const path = join(input.output, name), handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    result.proofFiles.push(path);
  }
  try {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(input.id) || !isAbsolute(input.cwd) || !isAbsolute(input.output)
      || !input.entry || input.entry.length > 1024 || !/\.(js|mjs|cjs)$/.test(input.entry) || /^[a-z]:/i.test(input.entry) || /[\\\0?#]/.test(input.entry)
      || input.entry.split('/').some(p => !p || p === '.' || p === '..') || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3_600_000) throw new Error('Invalid confined candidate Node entry');
    input = { ...input, cwd: await realpath(input.cwd), output: resolve(input.output) };
    const local = relative(input.cwd, input.output);
    if (!local || local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local)) throw new Error('Candidate entry evidence must be outside the candidate');
    // Resolve the nearest existing ancestor before creating anything. An
    // outside-looking symlink/new-directory path must not mkdir in the tree.
    const suffix: string[] = []; let ancestor = input.output, canonicalOutput: string;
    for (;;) {
      try { canonicalOutput = join(await realpath(ancestor), ...suffix); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
    }
    const canonicalLocal = relative(input.cwd, canonicalOutput);
    if (!canonicalLocal || canonicalLocal !== '..' && !canonicalLocal.startsWith('..' + sep) && !isAbsolute(canonicalLocal)) throw new Error('Candidate entry evidence resolves inside the candidate');
    input = { ...input, output: canonicalOutput };
    await mkdir(input.output, { recursive: true, mode: 0o700 }); input = { ...input, output: await realpath(input.output) };
    const realLocal = relative(input.cwd, input.output);
    if (!realLocal || realLocal !== '..' && !realLocal.startsWith('..' + sep) && !isAbsolute(realLocal)) throw new Error('Candidate entry evidence resolves inside the candidate');
    evidenceReady = true;
    const entry = await relativeFile(input.cwd, input.entry), entryDigest = digest(await readFile(entry));
    let guard: string;
    try { if (process.versions.node !== '24.20.0') throw new Error('Candidate entries require pinned Node 24.20.0'); guard = await realpath(fileURLToPath(new URL('./command-guard.js', import.meta.url))); }
    catch (error) { toolUnavailable = true; throw error; }
    await proof('configuration.json', JSON.stringify({ schemaVersion: 1, entry: input.entry, entryDigest, cwd: input.cwd, node: process.version, permissions: { read: [input.cwd, guard], write: [], network: false, childProcess: false } }, null, 2));
    if (input.signal?.aborted) throw new Error('Candidate entry cancelled before dispatch');
    child = await spawnManagedProcess({ operationId: input.id, command: process.execPath,
      args: ['--permission', '--allow-fs-read=' + input.cwd, '--allow-fs-read=' + guard, '--import', guard, entry], cwd: input.cwd,
      env: { ...process.env, SUPERVISOR_VERIFY_REPORT: undefined, SUPERVISOR_VERIFY_TYPESCRIPT_MODULE: undefined, NODE_OPTIONS: undefined, NODE_PATH: undefined }, timeoutMs: input.timeoutMs,
      onBeforeSpawn: async intent => { await proof('intent.json', JSON.stringify(intent)); await input.onIntent?.(intent); if (input.signal?.aborted) throw new Error('Candidate entry cancelled before spawn'); spawnAuthorized = true; result.stopped = false; },
      onIdentity: async value => { identity = value; await proof('identity.json', JSON.stringify(value)); await input.onIdentity?.(value); if (input.signal?.aborted) throw new Error('Candidate entry cancelled before target release'); },
    });
    const streamsClosed = Promise.all([child.stdout, child.stderr].map(stream => new Promise<void>(done => { stream.once('end', done); stream.once('close', done); })));
    let oversized = false;
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); if (stdout.length > 2 * 1024 * 1024) { oversized = true; stdout = stdout.slice(0, 2 * 1024 * 1024); abort(); } });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); if (stderr.length > 2 * 1024 * 1024) { oversized = true; stderr = stderr.slice(0, 2 * 1024 * 1024); abort(); } });
    input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort();
    const outcome = await child.completion; result.stopped = outcome.stopped; result.exitCode = outcome.exitCode;
    await proof('process.json', JSON.stringify(outcome));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([streamsClosed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Candidate entry output streams did not close')), 2000); })]); } finally { if (timer) clearTimeout(timer); }
    if (!outcome.stopped || outcome.reason !== 'completed' || outcome.signal !== null || outcome.exitCode === null || oversized || input.signal?.aborted) throw new Error('Candidate entry timed out, was cancelled, crashed, exceeded output bounds or lacks verified stop');
    result.executionStatus = 'executed'; result.passed = outcome.exitCode === 0;
    result.reason = `Actual candidate Node entry ${input.entry}: exit ${outcome.exitCode}, stopped ${outcome.stopped}`;
  } catch (error) {
    result.reason = `Candidate Node entry ${input.entry} did not execute successfully: ${String(error)}`;
    if (toolUnavailable) result.executionStatus = 'environment-blocked';
    if (identity && !result.stopped) try { const stop = await terminateProcess(identity); result.stopped = stop.stopped; await proof('recovery-stop.json', JSON.stringify(stop)); } catch (stopError) { result.reason += '; stop inspection: ' + String(stopError); }
    if (!spawnAuthorized && evidenceReady) try { await proof('not-started.json', JSON.stringify({ operationId: input.id, targetStarted: false, reason: result.reason })); } catch { /* Preserve the original dispatch failure. */ }
  } finally { input.signal?.removeEventListener('abort', abort); }
  if (!evidenceReady) return result;
  for (const [name, body] of [['stdout.log', stdout], ['stderr.log', stderr]] as const) try { await proof(name, body); } catch (error) { result.executionStatus = 'verifier-error'; result.passed = false; result.reason += '; evidence write: ' + String(error); }
  try { await proof('result.json', JSON.stringify(result, null, 2)); } catch (error) { result.executionStatus = 'verifier-error'; result.passed = false; result.reason += '; evidence write: ' + String(error); }
  return result;
}
export async function runCommandVerifier(input: CommandInput): Promise<CommandResult> {
  await mkdir(input.output, { recursive: true });
  const result: CommandResult = { executionStatus: 'verifier-error', checks: [], reason: '', proofFiles: [], stopped: true };
  let report = join(input.output, 'report.json'), stdout = '', stderr = '', launched = false, spawnAuthorized = false, parserUnavailable = false;
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
    let parserModule: string, parserRoot: string, parserVersion: string, parserDigest: string;
    try {
      // This is Supervisor's pinned parser, never a candidate-selected package.
      parserModule = await realpath(commandRequire.resolve('typescript/lib/typescript.js'));
      const packagePath = await realpath(commandRequire.resolve('typescript/package.json'));
      parserRoot = dirname(packagePath);
      const parserPackage = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown };
      if (parserPackage.version !== '6.0.3' || !parserModule.startsWith(parserRoot + sep)) throw new Error('Command verifier requires fixed TypeScript parser 6.0.3');
      parserVersion = parserPackage.version; parserDigest = digest(await readFile(parserModule));
    } catch (error) { parserUnavailable = true; throw error; }
    const parserProof = join(input.output, 'parser-runtime.json');
    await writeFile(parserProof, JSON.stringify({ schemaVersion: 1, version: parserVersion, module: parserModule, moduleDigest: parserDigest, packageRoot: parserRoot, grant: 'read-only', selectedBy: 'Supervisor fixed dependency' }, null, 2), { flag: 'wx', mode: 0o600 }); result.proofFiles.push(parserProof);
    const env = { ...process.env, SUPERVISOR_VERIFY_REPORT: report, SUPERVISOR_VERIFY_TYPESCRIPT_MODULE: parserModule, NODE_OPTIONS: undefined, NODE_PATH: undefined };
    const guard=await realpath(fileURLToPath(new URL('./command-guard.js',import.meta.url)));
    const child = await spawnManagedProcess({ operationId: input.id, command: process.execPath, args: ['--permission','--allow-fs-read='+input.bundle,'--allow-fs-read='+input.cwd,'--allow-fs-read='+guard,'--allow-fs-read='+parserRoot,'--allow-fs-write='+input.output,'--import',guard,entry, input.cwd, JSON.stringify(input.parameters)], cwd: input.cwd,
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
    result.reason = String(error); if (parserUnavailable || (error as NodeJS.ErrnoException).code === 'ENOENT' && !launched) result.executionStatus = 'environment-blocked';
    if (identity && !result.stopped) try { const stop = await terminateProcess(identity); result.stopped = stop.stopped; const path = join(input.output, 'recovery-stop.json'); await writeFile(path, JSON.stringify(stop)); result.proofFiles.push(path); } catch (stopError) { result.reason += '; stop inspection: ' + String(stopError); }
    if (!spawnAuthorized) { const path = join(input.output, 'not-started.json'); await writeFile(path, JSON.stringify({ operationId: input.id, targetStarted: false, reason: result.reason })); result.proofFiles.push(path); }
  }
  for (const [name, body] of [['stdout.log', stdout], ['stderr.log', stderr]] as const) { const path = join(input.output, name); await writeFile(path, body); result.proofFiles.push(path); }
  const path = join(input.output, 'result.json'); await writeFile(path, JSON.stringify(result, null, 2)); result.proofFiles.push(path);
  return result;
}
