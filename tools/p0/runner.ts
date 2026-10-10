import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { join, relative, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, evaluateSuite } from './contracts.js';
import type { StageManifest, SuiteSpec, TestResult, TestLayer } from './contracts.js';
import { loadSelection, loadLegacyManifest, type SelectionSnapshot } from './catalog.js';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const reporter = fileURLToPath(new URL('./reporter.js', import.meta.url));

export interface EvidenceFile { path: string; digest: string | null }
export interface Execution {
  suiteId: string; runId: string; command: string[]; cwd: string; pid: number | null;
  startedAt: string; finishedAt: string; exitCode: number | null; signal: string | null; timedOut: boolean;
  report: EvidenceFile; stdout: EvidenceFile; stderr: EvidenceFile;
}
export interface RunManifest {
  schemaVersion: 1; runId: string; scope: 'stage' | TestLayer | 'partial'; reason: string;
  selection?: SelectionSnapshot;
  startedAt: string; finishedAt: string; manifest: StageManifest; manifestDigest: string;
  candidateDigest: string; candidateFiles: Record<string, string>;
  environment: { node: string; executable: string; platform: string; arch: string };
  executions: Execution[];
}
export interface GateResult {
  runId: string; scope: string; passed: boolean; stagePassed: boolean; issues: string[];
  selection?: SelectionSnapshot;
  counts: { required: number; executed: number; passed: number; failed: number; skipped: number; todo: number; notRun: number };
  suites: { id: string; passed: boolean; issues: string[]; tests: TestResult[] }[];
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

export async function candidateSnapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Candidate symlink is not supported: ${path}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (stat.isFile()) {
      files[relative(root, path).replaceAll('\\', '/')] = sha256(await readFile(path));
    }
  }
  for (const name of ['tools', 'tests', 'packages', 'apps', 'dist', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', '.npmrc', '.nvmrc', '.node-version', '.gitignore']) {
    const path = join(root, name);
    if (await exists(path)) await visit(path);
  }
  return files;
}

export async function safeFile(base: string, name: string): Promise<string> {
  if (!name || isAbsolute(name) || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.')) throw new Error(`Unsafe evidence path: ${name}`);
  const path = await realpath(resolve(base, name));
  const rel = relative(await realpath(base), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes root: ${name}`);
  if (!(await lstat(path)).isFile()) throw new Error(`Not a regular file: ${name}`);
  return path;
}

async function fileEvidence(base: string, name: string): Promise<EvidenceFile> {
  try { return { path: name, digest: sha256(await readFile(await safeFile(base, name))) }; }
  catch { return { path: name, digest: null }; }
}

async function execute(root: string, dir: string, runId: string, suite: SuiteSpec): Promise<Execution> {
  const file = await safeFile(root, suite.file);
  const report = `artifacts/${suite.id}.json`;
  const stdout = `logs/${suite.id}.stdout.log`;
  const stderr = `logs/${suite.id}.stderr.log`;
  const args = ['--test', '--test-concurrency=1', `--test-reporter=${reporter}`, `--test-reporter-destination=${join(dir, report)}`, '--test-reporter=tap', '--test-reporter-destination=stdout', file];
  const out = createWriteStream(join(dir, stdout), { flags: 'wx' });
  const err = createWriteStream(join(dir, stderr), { flags: 'wx' });
  const startedAt = new Date().toISOString();
  const env: NodeJS.ProcessEnv = { ...process.env, SUPERVISOR_VERIFY_RUN_ID: runId, SUPERVISOR_VERIFY_SUITE_ID: suite.id, SUPERVISOR_EVIDENCE_DIR: dir };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, {
    cwd: root, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  child.stdout.pipe(out); child.stderr.pipe(err);
  let timedOut = false;
  let cleanup: Promise<void> | undefined;
  const stop = (signal: NodeJS.Signals): void => {
    try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop('SIGTERM');
    cleanup = new Promise(done => setTimeout(() => { stop('SIGKILL'); done(); }, 300));
  }, suite.timeoutMs);
  const outcome = await new Promise<{ exitCode: number | null; signal: string | null }>((done) => {
    child.once('error', error => { err.write(error.message + '\n'); });
    child.once('close', (code, signal) => done({ exitCode: code, signal }));
  });
  clearTimeout(timer);
  // The process group can outlive its leader. Do not cancel cleanup on leader exit.
  if (cleanup) await cleanup;
  await Promise.all([finished(out), finished(err)]);
  return {
    suiteId: suite.id, runId, command: [process.execPath, ...args], cwd: root, pid: child.pid ?? null,
    startedAt, finishedAt: new Date().toISOString(), ...outcome, timedOut,
    report: await fileEvidence(dir, report), stdout: await fileEvidence(dir, stdout), stderr: await fileEvidence(dir, stderr),
  };
}

export async function checkRun(root: string, dir: string, expected?: StageManifest): Promise<GateResult> {
  const result: GateResult = { runId: 'unknown', scope: 'unknown', passed: false, stagePassed: false, issues: [], suites: [], counts: { required: 0, executed: 0, passed: 0, failed: 0, skipped: 0, todo: 0, notRun: 0 } };
  let required: SuiteSpec[] = [];
  try {
    const record: RunManifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    const frozen: RunManifest = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8'));
    if (record.schemaVersion !== 1 || typeof record.runId !== 'string' || !record.runId || !['stage', 'unit', 'integration', 'live', 'partial'].includes(record.scope)) throw new Error('Invalid run manifest');
    result.runId = record.runId; result.scope = record.scope;
    for (const key of ['schemaVersion', 'runId', 'scope', 'reason', 'startedAt', 'manifest', 'manifestDigest', 'candidateDigest', 'candidateFiles', 'environment', 'selection'] as const) {
      if (json(frozen[key]) !== json(record[key])) result.issues.push(`Run differs from frozen input: ${key}`);
    }
    if (frozen.finishedAt !== '' || !Array.isArray(frozen.executions) || frozen.executions.length) result.issues.push('Invalid frozen input lifecycle');
    const manifest = parseManifest(record.manifest);
    if (frozen.selection !== undefined) {
      const selected = frozen.selection;
      if (selected.schemaVersion !== 1 || selected.stage !== manifest.stage || !selected.requested || !Array.isArray(selected.requested.modules)
        || (selected.requested.layer !== null && selected.requested.layer !== 'unit' && selected.requested.layer !== 'integration' && selected.requested.layer !== 'live')) throw new Error('Invalid frozen selection request');
      const current = await loadSelection(root, selected.stage, { ...(selected.requested.layer ? { layer: selected.requested.layer } : {}),
        ...(selected.requested.modules.length ? { modules: selected.requested.modules } : {}) });
      if (json(selected) !== json(current.selection)) result.issues.push('Frozen selection does not match current catalog/profile');
      expected = current.manifest;
      result.selection = current.selection;
      const scope = current.selection.mode === 'stage' ? 'stage' : current.selection.requested.layer ?? 'partial';
      if (record.scope !== scope) result.issues.push('Partial selection cannot be presented as a stage run');
    } else {
      if (record.scope === 'partial') result.issues.push('Partial run lacks a frozen selection');
      const legacy = await loadLegacyManifest(root, manifest.stage, manifest.revision);
      if(expected && json(expected)!==json(legacy)) result.issues.push('Supplied manifest differs from preserved legacy standard');
      expected = legacy;
    }
    if (record.manifestDigest !== sha256(json(manifest)) || record.manifestDigest !== sha256(json(parseManifest(expected)))) result.issues.push('Frozen manifest does not match current required manifest');
    if (record.candidateDigest !== sha256(json(record.candidateFiles)) || record.candidateDigest !== sha256(json(await candidateSnapshot(root)))) result.issues.push('Candidate changed or candidate digest is invalid');
    if (record.environment.node !== process.versions.node || record.environment.platform !== process.platform || record.environment.arch !== process.arch) result.issues.push('Runtime differs from recorded environment');
    const start = Date.parse(record.startedAt), end = Date.parse(record.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) result.issues.push('Invalid or incomplete run timestamps');
    if (!Array.isArray(record.executions)) throw new Error('Missing executions');
    required = expected.suites.filter(s => !!record.selection || record.scope === 'stage' || s.layer === record.scope);
    if (!required.length) result.issues.push('Zero required suites');
    if (record.executions.length !== required.length) result.issues.push('Execution count does not match required suites');
    if (new Set(record.executions.map(e => e.suiteId)).size !== record.executions.length) result.issues.push('Duplicate suite execution');
    for (const spec of required) {
      const execution = record.executions.find(e => e.suiteId === spec.id);
      const issues: string[] = [];
      let report: unknown;
      if (!execution) { result.suites.push({ id: spec.id, passed: false, issues: ['Suite not executed'], tests: [] }); continue; }
      if (execution.runId !== record.runId) issues.push('Execution belongs to a different run');
      const executionStart = Date.parse(execution.startedAt), executionEnd = Date.parse(execution.finishedAt);
      if (!Number.isFinite(executionStart) || !Number.isFinite(executionEnd) || executionStart < start || executionEnd < executionStart || executionEnd > end) issues.push('Invalid execution timestamps');
      for (const [kind, filename] of [['report', `artifacts/${spec.id}.json`], ['stdout', `logs/${spec.id}.stdout.log`], ['stderr', `logs/${spec.id}.stderr.log`]] as const) {
        try {
          const evidence = execution[kind];
          if (!evidence || evidence.path !== filename || !/^[a-f0-9]{64}$/.test(evidence.digest ?? '')) throw new Error(`Missing or invalid ${kind} evidence`);
          const content = await readFile(await safeFile(dir, evidence.path));
          if (sha256(content) !== evidence.digest) throw new Error(`${kind} digest mismatch`);
          if (kind === 'report') report = JSON.parse(content.toString('utf8'));
        } catch (e) { issues.push((e as Error).message); }
      }
      const verdict = evaluateSuite(spec, report, { runId: record.runId, exitCode: execution.exitCode, signal: execution.signal, timedOut: execution.timedOut });
      result.suites.push({ id: spec.id, passed: verdict.passed && !issues.length, issues: [...issues, ...verdict.issues], tests: verdict.tests });
    }
    result.passed = !result.issues.length && result.suites.length > 0 && result.suites.every(s => s.passed);
    result.stagePassed = result.passed && record.scope === 'stage';
  } catch (e) { result.issues.push((e as Error).message); }
  result.counts.required = required.reduce((n, s) => n + s.expectedTests.length, 0);
  for (const spec of required) {
    const tests = result.suites.find(s => s.id === spec.id)?.tests ?? [];
    for (const name of spec.expectedTests) {
      const test = tests.find(t => t.name === name);
      if (!test) { result.counts.notRun++; continue; }
      result.counts.executed++;
      result.counts[test.status]++;
    }
  }
  return result;
}

const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

async function writeReports(dir: string, result: GateResult): Promise<void> {
  await writeFile(join(dir, 'results.json'), json(result), { flag: 'wx' });
  const tests = result.suites.flatMap(s => s.tests.map(t => ({ ...t, suite: s.id })));
  const rows = result.suites.map(s => `<section><h2>${escape(s.id)} — ${s.passed ? 'PASS' : 'FAIL'}</h2><p>${escape(s.issues.join('; '))}</p><p><a href="logs/${escape(s.id)}.stdout.log">stdout</a> · <a href="logs/${escape(s.id)}.stderr.log">stderr</a> · <a href="artifacts/${escape(s.id)}.json">原始测试报告</a></p><table><tr><th>测试</th><th>结果</th><th>毫秒</th></tr>${s.tests.map(t => `<tr><td>${escape(t.name)}</td><td>${escape(t.status)}</td><td>${escape(t.durationMs.toFixed(2))}</td></tr>`).join('')}</table></section>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Supervisor 验证 ${escape(result.runId)}</title><style>body{font:15px system-ui;max-width:1050px;margin:40px auto;padding:0 24px;color:#19222e}h1{font-size:26px}table{border-collapse:collapse;width:100%}td,th{padding:9px;text-align:left;border-bottom:1px solid #ddd}section{margin:32px 0}a{color:#075bb5}code{word-break:break-all}</style><h1>${escape(result.scope)} 验证：${result.passed ? 'PASS' : 'FAIL'}</h1><p><code>${escape(result.runId)}</code></p><p>套件 ${result.suites.length}；通过 ${result.suites.filter(s => s.passed).length}。</p><p>必需 ${result.counts.required}；已报告 ${result.counts.executed}；通过 ${result.counts.passed}；失败 ${result.counts.failed}；跳过 ${result.counts.skipped}；待实现 ${result.counts.todo}；未运行或无法核实 ${result.counts.notRun}。</p><p>${escape(result.issues.join('; '))}</p>${result.selection ? `<p>目录有效用例 ${result.selection.globalActiveCaseIds.length} / 覆盖 ${result.selection.globalCoveredRisks.length} 个条款或风险；本次覆盖 ${result.selection.selectedCoveredRisks.length} 个；本次选中 ${result.selection.selectedCaseIds.length}；本次未选 ${result.selection.excluded.length}（未选不表示通过）。</p><p>${escape(result.selection.reasons.join('; '))}</p><details><summary>本次未选范围</summary>${result.selection.excluded.map(c => `<p>${escape(c.id)}: ${escape(c.reason)}</p>`).join('')}</details>` : ''}<p>仅 stage 范围表示阶段自动检查。负向用例通过表示成功拦截坏候选，并非坏候选验收通过。历史报告不自动证明当前候选仍然有效。阶段放行还需独立审查；环境能力缺口详见 doctor 报告。</p><p><a href="input.json">运行前冻结记录</a> · <a href="manifest.json">最终执行凭证</a> · <a href="results.json">机器结果</a> · <a href="events.jsonl">事件</a></p>${rows}</html>`;
  await writeFile(join(dir, 'summary.html'), html, { flag: 'wx' });
  const cases = tests.map(t => `<testcase classname="${escape(t.suite)}" name="${escape(t.name)}" time="${t.durationMs / 1000}">${t.status === 'passed' ? '' : `<failure message="${escape(t.status)}">${escape(t.message ?? '')}</failure>`}</testcase>`);
  for (const issue of [...result.issues, ...result.suites.flatMap(s => s.issues.map(i => `${s.id}: ${i}`))]) cases.push(`<testcase name="gate"><failure message="${escape(issue)}"/></testcase>`);
  await writeFile(join(dir, 'junit.xml'), `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="${escape(result.scope)}" tests="${cases.length}" failures="${cases.filter(c => c.includes('<failure')).length}">${cases.join('')}</testsuite></testsuites>\n`, { flag: 'wx' });
}

export async function runStage(root: string, input: unknown, options: { layer?: TestLayer; reason: string; selection?: SelectionSnapshot } ): Promise<{ dir: string; result: GateResult }> {
  root = await realpath(root);
  const manifest = parseManifest(input);
  if(!options.selection){
    const legacy=await loadLegacyManifest(root,manifest.stage,manifest.revision);
    if(json(legacy)!==json(manifest))throw new Error('Unregistered manifest cannot replace preserved legacy standard; freeze a catalog selection');
  }
  if (options.selection) {
    const selected = options.selection;
    if (selected.stage !== manifest.stage || !selected.requested || !Array.isArray(selected.requested.modules)
      || (selected.requested.layer !== null && selected.requested.layer !== 'unit' && selected.requested.layer !== 'integration' && selected.requested.layer !== 'live')) throw new Error('Invalid selection before freeze');
    const current = await loadSelection(root, selected.stage, { ...(selected.requested.layer ? { layer: selected.requested.layer } : {}),
      ...(selected.requested.modules.length ? { modules: selected.requested.modules } : {}) });
    if (json(current.selection) !== json(selected) || json(current.manifest) !== json(manifest)) throw new Error('Selection/manifest does not match current catalog/profile before freeze');
    if (options.layer && options.layer !== selected.requested.layer) throw new Error('Selection conflicts with the requested layer before freeze');
  }
  for (const suite of manifest.suites.filter(s => !!options.selection || !options.layer || s.layer === options.layer)) await safeFile(root, suite.file);
  const runId = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID();
  const dir = join(root, '.supervisor-dev', 'verification', runId);
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir);
  await mkdir(join(dir, 'logs')); await mkdir(join(dir, 'artifacts'));
  const files = await candidateSnapshot(root);
  const record: RunManifest = {
    schemaVersion: 1, runId, scope: options.selection?.mode === 'partial' ? options.selection.requested.layer ?? 'partial' : options.layer ?? 'stage', reason: options.reason,
    ...(options.selection ? { selection: options.selection } : {}),
    startedAt: new Date().toISOString(), finishedAt: '', manifest, manifestDigest: sha256(json(manifest)),
    candidateDigest: sha256(json(files)), candidateFiles: files,
    environment: { node: process.versions.node, executable: process.execPath, platform: process.platform, arch: process.arch }, executions: [],
  };
  await writeFile(join(dir, 'input.json'), json(record), { flag: 'wx' });
  const events: object[] = [{ type: 'run-started', runId, at: record.startedAt }];
  try {
    for (const suite of manifest.suites.filter(s => !!options.selection || !options.layer || s.layer === options.layer)) {
      const execution = await execute(root, dir, runId, suite);
      record.executions.push(execution);
      events.push({ type: 'suite-finished', suiteId: suite.id, at: execution.finishedAt, exitCode: execution.exitCode, timedOut: execution.timedOut });
      await writeFile(join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    }
  } catch (e) { events.push({ type: 'runner-error', at: new Date().toISOString(), message: (e as Error).message }); }
  record.finishedAt = new Date().toISOString();
  await writeFile(join(dir, 'manifest.json'), json(record), { flag: 'wx' });
  const result = await checkRun(root, dir, manifest);
  events.push({ type: 'run-finished', at: record.finishedAt, passed: result.passed });
  await writeFile(join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeReports(dir, result);
  return { dir, result };
}
