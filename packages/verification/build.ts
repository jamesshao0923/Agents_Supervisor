import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { lstat, mkdir, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import type { TypeScriptBuild } from '../contracts/p4.js';
import { spawnManagedProcess, terminateProcess, type ProcessIdentity, type ProcessIntent } from '../process-control/index.js';
import { digest, relativeFile } from './candidate.js';

export interface CandidateBuildInput {
  id: string; candidateTree: string; build: TypeScriptBuild; output: string; signal?: AbortSignal;
  onIntent?: (value: ProcessIntent) => void | Promise<void>;
  onIdentity?: (value: ProcessIdentity) => void | Promise<void>;
}
export interface CandidateBuildResult {
  executionStatus: 'executed' | 'environment-blocked' | 'verifier-error'; passed: boolean; reason: string; proofFiles: string[]; stopped: boolean;
}
interface BuiltFile { digest: string; size: number; executable: number }
const require = createRequire(import.meta.url);
const confined = (root: string, path: string): boolean => { const name = relative(root, path); return name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name); };
const normalized = (path: unknown): path is string => typeof path === 'string' && !!path && !isAbsolute(path) && !/^[a-z]:/i.test(path) && !/[\\\0?#]/.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..');
async function durable(path: string, bytes: string | Buffer): Promise<void> { const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
/** Inventory intentionally has no source/dependency exclusions: every emitted byte must match. */
async function inventory(root: string): Promise<Record<string, BuiltFile>> {
  const files: Record<string, BuiltFile> = Object.create(null) as Record<string, BuiltFile>; let bytes = 0;
  async function walk(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const absolute = join(path, name), info = await lstat(absolute), local = relative(root, absolute).split(sep).join('/');
      if (info.isSymbolicLink()) throw new Error('Build output contains an unsupported symlink: ' + local);
      if (info.isDirectory()) await walk(absolute);
      else if (info.isFile()) {
        bytes += info.size;
        if (Object.keys(files).length >= 10000 || bytes > 256 * 1024 * 1024) throw new Error('Build output exceeds bounded comparison capacity');
        files[local] = { digest: digest(await readFile(absolute)), size: info.size, executable: info.mode & 0o111 };
      } else throw new Error('Build output contains an unsupported file type: ' + local);
    }
  }
  await walk(root); return files;
}

/** Rebuild outside the candidate, then compare the exact frozen deliverable output. */
export async function runCandidateBuild(input: CandidateBuildInput): Promise<CandidateBuildResult> {
  const result: CandidateBuildResult = { executionStatus: 'verifier-error', passed: false, reason: '', proofFiles: [], stopped: true };
  if (!isAbsolute(input.output)) { result.reason = 'Build evidence output must be absolute'; return result; }
  await mkdir(input.output, { recursive: true, mode: 0o700 });
  input = { ...input, output: await realpath(input.output) };
  let stdout = '', stderr = '', identity: ProcessIdentity | undefined, spawnAuthorized = false;
  let child: Awaited<ReturnType<typeof spawnManagedProcess>> | undefined;
  let emitted: Record<string, BuiltFile> = {}, expected: Record<string, BuiltFile> = {};
  const differences: { missing: string[]; extra: string[]; changed: string[] } = { missing: [], extra: [], changed: [] };
  const abort = (): void => { void child?.terminate().catch(() => {}); };
  async function proof(name: string, value: unknown): Promise<void> { const path = join(input.output, name); await durable(path, JSON.stringify(value, null, 2) + '\n'); result.proofFiles.push(path); }
  try {
    const build = input.build;
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(input.id) || !isAbsolute(input.candidateTree) || !build || build.kind !== 'typescript' || !normalized(build.outputDir)
      || !(build.rootDir === '.' || normalized(build.rootDir)) || !Array.isArray(build.sources) || !build.sources.length || build.sources.length > 10000
      || build.sources.some(source => !normalized(source)) || new Set(build.sources).size !== build.sources.length
      || !Number.isSafeInteger(build.timeoutMs) || build.timeoutMs < 1 || build.timeoutMs > 3_600_000) throw new Error('Invalid confined TypeScript build configuration');
    if (process.versions.node !== '24.20.0') { result.executionStatus = 'environment-blocked'; throw new Error('Candidate build requires pinned Node 24.20.0'); }
    const candidate = await realpath(input.candidateTree);
    if (!(await stat(candidate)).isDirectory() || confined(candidate, input.output)) throw new Error('Build evidence must be outside the candidate tree');
    const rootDir = await realpath(join(candidate, build.rootDir));
    if (!confined(candidate, rootDir) || !(await stat(rootDir)).isDirectory()) throw new Error('TypeScript rootDir escapes candidate tree');
    const sources: string[] = [];
    for (const source of build.sources) {
      const path = await relativeFile(candidate, source);
      if (!confined(rootDir, path)) throw new Error('TypeScript source escapes declared rootDir');
      sources.push(path);
    }
    if (new Set(sources).size !== sources.length) throw new Error('TypeScript source aliases duplicate the same file');
    let compiler: string, compilerRoot: string, typeRoots: string;
    const typeDependencies: string[] = [];
    try {
      compiler = await realpath(require.resolve('typescript/bin/tsc'));
      compilerRoot = dirname(await realpath(require.resolve('typescript/package.json')));
      const compilerPackage = JSON.parse(await readFile(join(compilerRoot, 'package.json'), 'utf8')) as { version: string };
      if (compilerPackage.version !== '6.0.3') throw new Error('Candidate build requires pinned TypeScript 6.0.3');
      const nodeTypesPackage = await realpath(require.resolve('@types/node/package.json'));
      const nodeTypes = dirname(nodeTypesPackage); typeRoots = dirname(nodeTypes);
      const nodePackage = JSON.parse(await readFile(nodeTypesPackage, 'utf8')) as { dependencies?: Record<string, string> };
      for (const name of Object.keys(nodePackage.dependencies ?? {})) typeDependencies.push(dirname(await realpath(require.resolve(name + '/package.json', { paths: [nodeTypes] }))));
    } catch (error) { result.executionStatus = 'environment-blocked'; throw error; }
    const generated = join(input.output, 'generated'); await mkdir(generated, { mode: 0o700 });
    const compilerHash = digest(await readFile(compiler));
    await proof('configuration.json', { schemaVersion: 1, id: input.id, candidate, build, compiler, compilerHash, node: process.version, typeRoots, typeDependencies, generated });
    if (input.signal?.aborted) throw new Error('Candidate build cancelled before dispatch');
    const env = { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined };
    // Config/plugin options are never inherited from the untrusted project.
    // Read grants cover only the frozen tree and pinned compiler/type libraries;
    // the sole write grant is the newly created evidence output directory.
    // Node's permission checks also apply to TypeScript's directory probes and
    // pnpm's logical dependency links. The pinned @types/node node_modules
    // directory contains those edges; resolved dependency contents stay pinned.
    const args = ['--permission', '--allow-fs-read=' + candidate, '--allow-fs-read=' + compilerRoot, '--allow-fs-read=' + dirname(typeRoots),
      ...typeDependencies.map(path => '--allow-fs-read=' + path), '--allow-fs-write=' + generated,
      compiler, '--ignoreConfig', '--target', 'es2022', '--module', 'nodenext', '--strict', '--types', 'node', '--typeRoots', typeRoots, '--rootDir', rootDir, '--outDir', generated, ...sources];
    child = await spawnManagedProcess({ operationId: input.id, command: process.execPath, args, cwd: candidate, env, timeoutMs: build.timeoutMs,
      onBeforeSpawn: async intent => { await proof('intent.json', intent); await input.onIntent?.(intent); if (input.signal?.aborted) throw new Error('Candidate build cancelled before spawn'); spawnAuthorized = true; result.stopped = false; },
      onIdentity: async value => { identity = value; await proof('identity.json', value); await input.onIdentity?.(value); if (input.signal?.aborted) throw new Error('Candidate build cancelled before target release'); },
    });
    let oversized = false;
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString(); if (stdout.length > 2 * 1024 * 1024) { oversized = true; abort(); } });
    child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString(); if (stderr.length > 2 * 1024 * 1024) { oversized = true; abort(); } });
    input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort();
    const processResult = await child.completion; result.stopped = processResult.stopped; await proof('process.json', processResult);
    if (!processResult.stopped || processResult.reason !== 'completed' || processResult.signal !== null || processResult.exitCode === null || oversized || input.signal?.aborted) throw new Error('Candidate compiler timed out, was cancelled, crashed, exceeded output bounds or lacks verified stop');
    result.executionStatus = 'executed';
    emitted = await inventory(generated);
    if (processResult.exitCode !== 0) {
      result.reason = 'Actual TypeScript compiler rejected the frozen candidate (exit ' + processResult.exitCode + ')';
    } else {
      let outputDir: string | undefined;
      try { outputDir = await realpath(join(candidate, build.outputDir)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (outputDir) {
        if (!confined(candidate, outputDir) || !(await stat(outputDir)).isDirectory()) throw new Error('Frozen deliverable outputDir escapes the candidate or is not a directory');
        expected = await inventory(outputDir);
      }
      differences.missing = Object.keys(emitted).filter(name => !Object.hasOwn(expected, name));
      differences.extra = Object.keys(expected).filter(name => !Object.hasOwn(emitted, name));
      differences.changed = Object.keys(emitted).filter(name => Object.hasOwn(expected, name) && (emitted[name]!.digest !== expected[name]!.digest || emitted[name]!.size !== expected[name]!.size || emitted[name]!.executable !== expected[name]!.executable));
      result.passed = Object.keys(emitted).length > 0 && !!outputDir && !differences.missing.length && !differences.extra.length && !differences.changed.length;
      result.reason = result.passed ? 'Actual rebuilt files, bytes and executable permissions exactly match the frozen deliverable' : 'Rebuilt output does not exactly match the frozen deliverable (missing, extra, changed or empty output)';
    }
  } catch (error) {
    result.passed = false; result.reason = error instanceof Error ? error.message : String(error);
    if (result.executionStatus !== 'environment-blocked') result.executionStatus = 'verifier-error';
    if (identity && !result.stopped) {
      try { const stop = await terminateProcess(identity); result.stopped = stop.stopped; await proof('recovery-stop.json', stop); }
      catch (stopError) { result.reason += '; stop inspection: ' + String(stopError); }
    }
    if (!spawnAuthorized) await proof('not-started.json', { operationId: input.id, targetStarted: false, reason: result.reason });
  } finally { input.signal?.removeEventListener('abort', abort); }
  await proof('manifest.json', { schemaVersion: 1, emitted, frozenDeliverable: expected, differences, passed: result.passed, reason: result.reason });
  for (const [name, bytes] of [['stdout.log', stdout], ['stderr.log', stderr]] as const) { const path = join(input.output, name); await durable(path, bytes); result.proofFiles.push(path); }
  const path = join(input.output, 'result.json'); result.proofFiles.push(path); await durable(path, JSON.stringify(result, null, 2) + '\n');
  return result;
}
