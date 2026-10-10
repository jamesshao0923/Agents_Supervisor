import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { UiStep, UiVerifier, VerificationExecutionStatus } from '../contracts/p4.js';
import { spawnManagedProcess, terminateProcess, type ProcessIdentity, type ProcessIntent } from '../process-control/index.js';

export interface UiVerificationInput {
  id: string; candidateTree: string; verifier: UiVerifier; output: string; signal?: AbortSignal;
  onIntent?: (value: ProcessIntent) => void | Promise<void>;
  onIdentity?: (value: ProcessIdentity) => void | Promise<void>;
}
export interface UiStepResult { index: number; step: UiStep; verdict: 'passed' | 'failed' | 'unknown'; reason: string; screenshot?: string; observed?: Record<string, unknown> }
export interface UiVerificationResult {
  executionStatus: VerificationExecutionStatus; steps: UiStepResult[]; reason: string;
  screenshots: string[]; proofFiles: string[]; stopped: boolean;
}
const require = createRequire(import.meta.url);
const within = (tree: string, path: string): boolean => { const name = relative(tree, path); return name !== '..' && !name.startsWith('../') && !isAbsolute(name); };
async function durable(path: string, content: string | Buffer): Promise<void> { const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); } }

/** Performs real local-page interactions. Visual expectations are reviewed separately. */
export async function runUiVerification(input: UiVerificationInput): Promise<UiVerificationResult> {
  const result: UiVerificationResult = { executionStatus: 'verifier-error', steps: [], reason: '', screenshots: [], proofFiles: [], stopped: true };
  if (!isAbsolute(input.output)) { result.reason = 'UI evidence output must be absolute'; return result; }
  await mkdir(input.output, { recursive: true, mode: 0o700 });
  let identity: ProcessIdentity | undefined;
  let stdout = '', stderr = '', released = false;
  const abort = (): void => { void child?.terminate().catch(() => {}); };
  let child: Awaited<ReturnType<typeof spawnManagedProcess>> | undefined;
  try {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(input.id) || !isAbsolute(input.output) || !isAbsolute(input.candidateTree) || input.verifier.kind !== 'ui'
      || !Number.isSafeInteger(input.verifier.timeoutMs) || input.verifier.timeoutMs < 1 || input.verifier.timeoutMs > 3_600_000) throw new Error('Invalid UI verification input');
    const candidateTree = await realpath(input.candidateTree);
    if (!['darwin', 'linux'].includes(process.platform) || process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      result.executionStatus = 'environment-blocked'; throw new Error('UI verification requires an available macOS or Linux desktop display');
    }
    if (!(await stat(candidateTree)).isDirectory()) throw new Error('UI candidate tree is not a directory');
    const name = input.verifier.entry;
    if (isAbsolute(name) || name.includes('\\') || /[?#]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') || !name.endsWith('.html')) throw new Error('UI entry must be a normalized relative HTML path');
    const entry = await realpath(join(candidateTree, name));
    if (!within(candidateTree, entry) || !(await stat(entry)).isFile()) throw new Error('UI entry escapes candidate tree');
    await mkdir(input.output, { recursive: true, mode: 0o700 });
    const output = await realpath(input.output);
    if (within(candidateTree, output)) throw new Error('UI evidence must be outside candidate tree');
    const request = join(output, 'request.json');
    await durable(request, JSON.stringify({ schemaVersion: 1, id: input.id, candidateTree, verifier: input.verifier, output }, null, 2)); result.proofFiles.push(request);
    if (input.signal?.aborted) throw new Error('UI verification cancelled before dispatch');
    const electron: unknown = require('electron');
    if (typeof electron !== 'string') throw new Error('Installed Electron executable is unavailable');
    const driver = fileURLToPath(new URL('../../apps/verification-ui/main.cjs', import.meta.url));
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_NO_SANDBOX: undefined };
    child = await spawnManagedProcess({ operationId: input.id, command: electron, args: [driver, '--request', request], cwd: candidateTree, env, timeoutMs: input.verifier.timeoutMs,
      onBeforeSpawn: async value => { result.stopped = false; const path = join(output, 'intent.json'); await durable(path, JSON.stringify(value)); result.proofFiles.push(path); await input.onIntent?.(value); if (input.signal?.aborted) throw new Error('UI verification cancelled before spawn'); },
      onIdentity: async value => { identity = value; const path = join(output, 'identity.json'); await durable(path, JSON.stringify(value)); result.proofFiles.push(path); await input.onIdentity?.(value); if (input.signal?.aborted) throw new Error('UI verification cancelled before target release'); },
    });
    released = true;
    let oversized = false;
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); if (stdout.length > 4 * 1024 * 1024) { oversized = true; abort(); } });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); if (stderr.length > 4 * 1024 * 1024) { oversized = true; abort(); } });
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const stop = await child.completion; result.stopped = stop.stopped;
    const processPath = join(output, 'process.json'); await durable(processPath, JSON.stringify(stop, null, 2)); result.proofFiles.push(processPath);
    if (!stop.stopped || stop.reason !== 'completed' || oversized || input.signal?.aborted) throw new Error('UI driver timed out, was cancelled, exceeded log bound or lacks verified stop');
    const tracePath = join(output, 'trace.json'); const bytes = await readFile(tracePath);
    if (bytes.length > 4 * 1024 * 1024) throw new Error('UI trace exceeds bound');
    const trace = JSON.parse(bytes.toString()) as { schemaVersion: number; id: string; executionStatus: VerificationExecutionStatus; reason: string; steps: UiStepResult[]; screenshots: string[]; finalScreenshot?: string };
    result.proofFiles.push(tracePath);
    if (trace.schemaVersion !== 1 || trace.id !== input.id || !['executed', 'verifier-error', 'environment-blocked'].includes(trace.executionStatus) || typeof trace.reason !== 'string'
      || !Array.isArray(trace.steps) || !Array.isArray(trace.screenshots)) throw new Error('UI trace does not match the request');
    if (trace.executionStatus === 'executed' && trace.steps.length !== input.verifier.steps.length) throw new Error('UI trace omits declared steps');
    for (const [index, step] of trace.steps.entries()) {
      if (step.index !== index || JSON.stringify(step.step) !== JSON.stringify(input.verifier.steps[index]) || !['passed', 'failed', 'unknown'].includes(step.verdict) || typeof step.reason !== 'string') throw new Error('UI trace step differs from frozen declaration');
    }
    for (const screenshot of trace.screenshots) {
      if (!/^(?:initial|final|step-\d{3,4})\.png$/.test(screenshot) || result.screenshots.includes(join(output, screenshot))) throw new Error('Invalid or duplicate UI screenshot path');
      const path = await realpath(join(output, screenshot));
      const metadata = await stat(path);
      if (!within(output, path) || !metadata.isFile() || metadata.size < 8 || metadata.size > 30 * 1024 * 1024) throw new Error('Missing or invalid actual UI screenshot');
      const image = await readFile(path); if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('UI screenshot is not PNG');
      result.screenshots.push(path); result.proofFiles.push(path);
    }
    if (trace.executionStatus === 'executed' && (!trace.finalScreenshot || !trace.screenshots.includes(trace.finalScreenshot) || trace.steps.some(step => step.verdict !== 'unknown' && (!step.screenshot || !trace.screenshots.includes(step.screenshot))))) throw new Error('Executed UI trace lacks step/final screenshots');
    const expectedExit = trace.executionStatus !== 'executed' ? 2 : trace.steps.some(step => step.verdict !== 'passed') ? 1 : 0;
    if (stop.exitCode !== expectedExit) throw new Error('UI driver exit conflicts with trace');
    result.executionStatus = trace.executionStatus; result.steps = trace.steps; result.reason = trace.reason;
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    if (!released && ['ENOENT', 'MODULE_NOT_FOUND'].includes((error as NodeJS.ErrnoException).code ?? '')) result.executionStatus = 'environment-blocked';
    if (identity && !result.stopped) {
      try { const stopped = await terminateProcess(identity); result.stopped = stopped.stopped; const path = join(input.output, 'recovery-stop.json'); await durable(path, JSON.stringify(stopped, null, 2)); result.proofFiles.push(path); }
      catch (stopError) { result.reason += `; stop inspection: ${String(stopError)}`; }
    }
  } finally { input.signal?.removeEventListener('abort', abort); }
  // Even failed or environment-blocked executions retain real diagnostic bytes.
  for (const [name, content] of [['stdout.log', stdout], ['stderr.log', stderr]] as const) { const path = join(input.output, name); await durable(path, content); result.proofFiles.push(path); }
  const path = join(input.output, 'result.json'); result.proofFiles.push(path); await durable(path, JSON.stringify(result, null, 2));
  return result;
}

export const runUiVerifier = runUiVerification;
