import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { StageManifest, TestReport } from '../../tools/p0/contracts.js';
import { candidateSnapshot, checkRun, runStage, sha256, type RunManifest } from '../../tools/p0/runner.js';

const requiredName = 'required fixture behavior';
const ioPayload = 'supervisor-real-child-file-roundtrip';
const successfulSource = `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
test(${JSON.stringify(requiredName)}, () => {
  const path = join(process.cwd(), 'actual-io.txt');
  writeFileSync(path, ${JSON.stringify(ioPayload)}, 'utf8');
  assert.equal(readFileSync(path, 'utf8'), ${JSON.stringify(ioPayload)});
  console.log('real fixture child executed');
  console.error('real fixture child stderr emitted');
});
`;
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

interface Fixture {
  root: string;
  manifest: StageManifest;
  sourcePath: string;
}

async function fixture(
  context: TestContext,
  source = successfulSource,
  timeoutMs = 10_000,
): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'supervisor-p0-gate-')));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'dist', 'tests'), { recursive: true });
  await mkdir(join(root, 'tests', 'acceptance'), { recursive: true });
  await writeFile(join(root, 'package.json'), json({ name: 'supervisor-gate-fixture', private: true, type: 'module' }));
  const sourcePath = join(root, 'dist', 'tests', 'fixture.test.js');
  await writeFile(sourcePath, source);
  const manifest: StageManifest = {
    schemaVersion: 1,
    stage: 'P0',
    revision: 'gate-self-test-v1',
    suites: [{
      id: 'fixture-integration', layer: 'integration', file: 'dist/tests/fixture.test.js',
      required: true, expectedTests: [requiredName], timeoutMs,
    }],
  };
  await writeFile(join(root, 'tests', 'acceptance', 'p0.json'), json(manifest));
  return { root, manifest, sourcePath };
}

async function runFixture(context: TestContext, candidate: Fixture, label: string): Promise<Awaited<ReturnType<typeof runStage>>> {
  const run = await runStage(candidate.root, candidate.manifest, { reason: `gate-self-test ${label}` });
  // Retain pristine child evidence before fault injection, outside candidate/source directories.
  const parentEvidence = process.env.SUPERVISOR_EVIDENCE_DIR;
  if (parentEvidence) {
    const destination = join(parentEvidence, 'gate-self-tests', label, basename(candidate.root));
    await mkdir(join(parentEvidence, 'gate-self-tests', label), { recursive: true });
    await cp(run.dir, destination, { recursive: true, errorOnExist: true, force: false });
    await writeFile(join(destination, 'snapshot-phase.json'), json({
      phase: 'before-fault-injection', label, passed: run.result.passed,
      note: 'This snapshot records the original child run before later fault injection and recheck.',
    }), { flag: 'wx' });
    context.diagnostic(json({ kind: 'gate-self-test-child', phase: 'before-fault-injection', label, passed: run.result.passed, evidence: destination }).trim());
  }
  return run;
}

async function record(dir: string): Promise<RunManifest> {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as RunManifest;
}

async function retainRejection(candidate: Fixture, dir: string, verdict: unknown, originalResult: Buffer): Promise<string | undefined> {
  const parentEvidence = process.env.SUPERVISOR_EVIDENCE_DIR;
  if (!parentEvidence) return undefined;
  const destination = join(parentEvidence, 'gate-self-tests', 'rejections', basename(dir));
  await mkdir(destination, { recursive: true });
  const filenames = ['input.json', 'manifest.json', 'results.json',
    ...candidate.manifest.suites.map((suite) => `artifacts/${suite.id}.json`)];
  const files = await Promise.all(filenames.map(async (path) => {
    try {
      const stat = await lstat(join(dir, path));
      const bytes = await readFile(join(dir, path));
      return { path, present: true, symlink: stat.isSymbolicLink(), bytes: bytes.length, digest: sha256(bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { path, present: false };
    }
  }));
  const currentResult = await readFile(join(dir, 'results.json'));
  await writeFile(join(destination, 'recheck.json'), json({
    schemaVersion: 1,
    phase: 'after-fault-injection',
    note: 'Original results and the separately retained child snapshot describe the pre-injection run. This verdict describes the actual post-injection rejection.',
    verdict,
    postInjection: {
      manifest: await record(dir), files,
      missingFiles: files.filter((file) => !file.present).map((file) => file.path),
      currentCandidateDigest: sha256(json(await candidateSnapshot(candidate.root))),
    },
    originalResultsDigest: sha256(originalResult),
    currentResultsDigest: sha256(currentResult),
    originalResultsUnchanged: originalResult.equals(currentResult),
  }), { flag: 'wx' });
  console.log(`gate-self-test post-injection rejection: ${join(destination, 'recheck.json')}`);
  return destination;
}

async function assertRejectedCheck(candidate: Fixture, dir: string, pattern: RegExp): Promise<void> {
  const originalResult = await readFile(join(dir, 'results.json'));
  const verdict = await checkRun(candidate.root, dir, candidate.manifest);
  await retainRejection(candidate, dir, verdict, originalResult);
  assert.equal(verdict.passed, false);
  const issues = [...verdict.issues, ...verdict.suites.flatMap((suite) => suite.issues)];
  assert.ok(issues.some((issue) => pattern.test(issue)), issues.join('\n'));
  assert.deepEqual(await readFile(join(dir, 'results.json')), originalResult, 'checkRun must preserve the original results');
}

test('runner records passing real child execution and complete hashed evidence', async (context) => {
  // Exercise the integration observer declaration above the unchanged unit
  // ceiling with an actual short child, without sleeping through that limit.
  const candidate = await fixture(context, successfulSource, 540_000);
  const run = await runFixture(context, candidate, 'pass');
  assert.equal(run.result.passed, true, json(run.result));
  assert.equal(run.result.scope, 'stage');
  const metadata = await record(run.dir);
  assert.equal(metadata.reason, 'gate-self-test pass');
  assert.equal(metadata.executions.length, 1);
  const frozenInput = JSON.parse(await readFile(join(run.dir, 'input.json'), 'utf8')) as RunManifest;
  assert.equal(frozenInput.manifest.suites[0]!.timeoutMs, 540_000);
  assert.equal(metadata.candidateFiles['dist/tests/fixture.test.js'], sha256(successfulSource));
  assert.match(metadata.candidateDigest, /^[a-f0-9]{64}$/);
  assert.match(metadata.manifestDigest, /^[a-f0-9]{64}$/);
  const execution = metadata.executions[0]!;
  assert.ok(execution.pid !== null && execution.pid > 0 && execution.pid !== process.pid);
  assert.equal(execution.runId, metadata.runId);
  assert.equal(execution.cwd, candidate.root);
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.signal, null);
  assert.equal(execution.timedOut, false);
  assert.equal(execution.command[0], process.execPath);
  assert.ok(execution.command.includes('--test'));
  assert.ok(Date.parse(execution.finishedAt) >= Date.parse(execution.startedAt));
  for (const evidence of [execution.report, execution.stdout, execution.stderr]) {
    assert.match(evidence.digest ?? '', /^[a-f0-9]{64}$/);
    assert.equal(sha256(await readFile(join(run.dir, evidence.path))), evidence.digest);
  }
  assert.equal(await readFile(join(candidate.root, 'actual-io.txt'), 'utf8'), ioPayload);
  const combinedLogs = await readFile(join(run.dir, execution.stdout.path), 'utf8')
    + await readFile(join(run.dir, execution.stderr.path), 'utf8');
  assert.match(combinedLogs, /real fixture child executed/);
  assert.match(combinedLogs, /real fixture child stderr emitted/);
  const raw = JSON.parse(await readFile(join(run.dir, execution.report.path), 'utf8')) as TestReport;
  assert.equal(raw.complete, true);
  assert.equal(raw.runId, metadata.runId);
  assert.deepEqual(raw.tests.map((entry) => [entry.name, entry.status]), [[requiredName, 'passed']]);
  assert.match(await readFile(join(run.dir, 'summary.html'), 'utf8'), /PASS/);
  assert.match(await readFile(join(run.dir, 'junit.xml'), 'utf8'), /failures="0"/);
  assert.match(await readFile(join(run.dir, 'events.jsonl'), 'utf8'), /run-finished/);
  const before = await readFile(join(run.dir, 'results.json'));
  assert.equal((await checkRun(candidate.root, run.dir, candidate.manifest)).passed, true);
  assert.deepEqual(await readFile(join(run.dir, 'results.json')), before);
});

test('runner rejects an actual failed assertion and preserves failing child evidence', async (context) => {
  const candidate = await fixture(context, `import test from 'node:test';
import assert from 'node:assert/strict';
test(${JSON.stringify(requiredName)}, () => assert.equal('actual', 'expected'));
`);
  const run = await runFixture(context, candidate, 'assertion-failure');
  assert.equal(run.result.passed, false);
  const metadata = await record(run.dir);
  assert.notEqual(metadata.executions[0]!.exitCode, 0);
  const raw = JSON.parse(await readFile(join(run.dir, metadata.executions[0]!.report.path), 'utf8')) as TestReport;
  assert.equal(raw.tests[0]!.status, 'failed');
  assert.equal(raw.summary.failed, 1);
  await assertRejectedCheck(candidate, run.dir, /did not pass|exitCode/);
});

test('runner rejects a real fixture that declares zero tests', async (context) => {
  const candidate = await fixture(context, `console.log('zero declared tests fixture executed');\n`);
  const run = await runFixture(context, candidate, 'zero-tests');
  assert.equal(run.result.passed, false);
  assert.ok(run.result.suites[0]!.issues.some((issue) => /zero tests|missing expected test/.test(issue)));
  // Node may emit a synthetic file-level pass; it cannot replace the frozen required test.
  const metadata = await record(run.dir);
  assert.match(await readFile(join(run.dir, metadata.executions[0]!.stdout.path), 'utf8'), /zero declared tests fixture executed/);
});

test('runner rejects a genuinely skipped required Node test', async (context) => {
  const candidate = await fixture(context, `import test from 'node:test';
test(${JSON.stringify(requiredName)}, { skip: 'fault injection' }, () => {});
`);
  const run = await runFixture(context, candidate, 'skipped-test');
  assert.equal(run.result.passed, false);
  assert.equal(run.result.suites[0]!.tests[0]!.status, 'skipped');
  await assertRejectedCheck(candidate, run.dir, /skipped/);
});

test('runner rejects a missing required name even when the actual test passes', async (context) => {
  const candidate = await fixture(context, `import test from 'node:test';
test('different fixture behavior', () => {});
`);
  const run = await runFixture(context, candidate, 'missing-required-test');
  assert.equal(run.result.passed, false);
  const metadata = await record(run.dir);
  assert.equal(metadata.executions[0]!.exitCode, 0);
  await assertRejectedCheck(candidate, run.dir, /missing expected test/);
});

test('runner rejects and terminates a genuinely timed out child process', async (context) => {
  const candidate = await fixture(context, `import test from 'node:test';
test(${JSON.stringify(requiredName)}, async () => {
  console.log('timeout fixture entered required test');
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`, 500);
  const start = Date.now();
  const run = await runFixture(context, candidate, 'process-timeout');
  assert.equal(run.result.passed, false);
  assert.ok(Date.now() - start < 15_000, 'runner must terminate the long-running real child');
  const execution = (await record(run.dir)).executions[0]!;
  assert.equal(execution.timedOut, true);
  assert.ok(execution.signal !== null || execution.exitCode !== 0);
  assert.match(await readFile(join(run.dir, execution.stdout.path), 'utf8'), /timeout fixture entered required test/);
  await assertRejectedCheck(candidate, run.dir, /timed out/);
});

test('runner kills a real SIGTERM ignoring descendant after its timeout', async (context) => {
  let pidfile: string | undefined;
  let descendantPid: number | undefined;
  // Register before fixture removal so an assertion failure still permits PID recovery.
  context.after(async () => {
    if (descendantPid === undefined) {
      if (pidfile === undefined) return;
      try { descendantPid = Number(await readFile(pidfile, 'utf8')); } catch { return; }
    }
    if (Number.isInteger(descendantPid) && descendantPid > 0) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already terminated. */ }
    }
  });
  const candidate = await fixture(context, successfulSource, 500);
  pidfile = join(candidate.root, 'descendant.pid');
  const descendantSource = `const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidfile)}, String(process.pid));
setInterval(() => {}, 1000);
`;
  await writeFile(candidate.sourcePath, `import test from 'node:test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
test(${JSON.stringify(requiredName)}, async () => {
  spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });
  for (;;) {
    try { await readFile(${JSON.stringify(pidfile)}); break; } catch { await delay(10); }
  }
  console.log('SIGTERM ignoring descendant started');
  await delay(60_000);
});
`);
  const run = await runFixture(context, candidate, 'timeout-ignoring-descendant');
  assert.equal(run.result.passed, false);
  assert.equal((await record(run.dir)).executions[0]!.timedOut, true);
  descendantPid = Number(await readFile(pidfile, 'utf8'));
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  const stillExists = (): boolean => {
    try { process.kill(descendantPid!, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  for (let attempt = 0; attempt < 60 && stillExists(); attempt += 1) await delay(50);
  assert.equal(stillExists(), false, 'the timed out process group must not leave an ignoring descendant alive');
});

test('checkRun rejects a deleted child report without replacing original results', async (context) => {
  const candidate = await fixture(context);
  const run = await runFixture(context, candidate, 'deleted-report');
  assert.equal(run.result.passed, true);
  const metadata = await record(run.dir);
  await rm(join(run.dir, metadata.executions[0]!.report.path));
  await assertRejectedCheck(candidate, run.dir, /ENOENT|missing|malformed/i);
});

test('checkRun rejects changed report bytes without replacing original results', async (context) => {
  const candidate = await fixture(context);
  const run = await runFixture(context, candidate, 'changed-report-bytes');
  assert.equal(run.result.passed, true);
  const path = join(run.dir, (await record(run.dir)).executions[0]!.report.path);
  await writeFile(path, (await readFile(path, 'utf8')) + '\n');
  await assertRejectedCheck(candidate, run.dir, /report digest mismatch/);
});

test('checkRun rejects a forged report digest without replacing original results', async (context) => {
  const candidate = await fixture(context);
  const run = await runFixture(context, candidate, 'forged-report-digest');
  assert.equal(run.result.passed, true);
  const metadata = await record(run.dir);
  metadata.executions[0]!.report.digest = '0'.repeat(64);
  await writeFile(join(run.dir, 'manifest.json'), json(metadata));
  await assertRejectedCheck(candidate, run.dir, /report digest mismatch/);
});

test('checkRun rejects a foreign report runId even with a matching content digest', async (context) => {
  const candidate = await fixture(context);
  const run = await runFixture(context, candidate, 'foreign-report-run');
  assert.equal(run.result.passed, true);
  const metadata = await record(run.dir);
  const evidence = metadata.executions[0]!.report;
  const raw = JSON.parse(await readFile(join(run.dir, evidence.path), 'utf8')) as TestReport;
  raw.runId = 'foreign-run-id';
  const content = json(raw);
  await writeFile(join(run.dir, evidence.path), content);
  evidence.digest = sha256(content);
  await writeFile(join(run.dir, 'manifest.json'), json(metadata));
  await assertRejectedCheck(candidate, run.dir, /runId/);
});

test('checkRun rejects changed candidate source without replacing original results', async (context) => {
  const candidate = await fixture(context);
  const run = await runFixture(context, candidate, 'changed-candidate');
  assert.equal(run.result.passed, true);
  await writeFile(candidate.sourcePath, successfulSource + '\n// candidate changed after execution\n');
  await assertRejectedCheck(candidate, run.dir, /Candidate changed/);
});

test('checkRun rejects a deleted initial freeze record without replacing original results', async (context) => {
  const candidate = await fixture(context);
  const run = await runFixture(context, candidate, 'deleted-initial-freeze');
  assert.equal(run.result.passed, true);
  await rm(join(run.dir, 'input.json'));
  await assertRejectedCheck(candidate, run.dir, /input|ENOENT|initial|frozen/i);
});

test('checkRun rejects rewriting only final candidate digests to bless changed source', async (context) => {
  const candidate = await fixture(context);
  const run = await runFixture(context, candidate, 'rewritten-final-candidate');
  assert.equal(run.result.passed, true);
  const initialFreeze = await readFile(join(run.dir, 'input.json'));
  await writeFile(candidate.sourcePath, successfulSource + '\n// changed candidate with rewritten final metadata\n');
  const metadata = await record(run.dir);
  metadata.candidateFiles = await candidateSnapshot(candidate.root);
  metadata.candidateDigest = sha256(json(metadata.candidateFiles));
  await writeFile(join(run.dir, 'manifest.json'), json(metadata));
  await assertRejectedCheck(candidate, run.dir, /input|initial|frozen|freeze/i);
  assert.deepEqual(await readFile(join(run.dir, 'input.json')), initialFreeze);
});

test('runner rejects a suite path escaping the isolated candidate root', async (context) => {
  const candidate = await fixture(context);
  candidate.manifest.suites[0]!.file = 'dist/tests/../../outside.test.js';
  await assert.rejects(runStage(candidate.root, candidate.manifest, { reason: 'gate-self-test escaping-suite-path' }), /\.file/);
});

test('runner rejects a symlinked suite before any child can execute it', async (context) => {
  const candidate = await fixture(context);
  const outside = await mkdtemp(join(tmpdir(), 'supervisor-p0-outside-'));
  context.after(async () => { await rm(outside, { recursive: true, force: true }); });
  const marker = join(outside, 'executed-marker');
  const source = join(outside, 'outside.test.js');
  await writeFile(source, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  await rm(candidate.sourcePath);
  await symlink(source, candidate.sourcePath);
  await assert.rejects(runStage(candidate.root, candidate.manifest, { reason: 'gate-self-test symlinked-suite' }), /symlink|escapes root/i);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('checkRun rejects a report symlink escaping its evidence directory', async (context) => {
  const candidate = await fixture(context);
  const run = await runFixture(context, candidate, 'escaping-report-symlink');
  assert.equal(run.result.passed, true);
  const metadata = await record(run.dir);
  const reportPath = join(run.dir, metadata.executions[0]!.report.path);
  const outsidePath = join(candidate.root, 'outside-report.json');
  await writeFile(outsidePath, await readFile(reportPath));
  await rm(reportPath);
  await symlink(outsidePath, reportPath);
  await assertRejectedCheck(candidate, run.dir, /escapes root/);
});

test('CLI check reads the frozen fixture manifest and exits nonzero for bad evidence', async (context) => {
  const candidate = await fixture(context);
  const run = await runFixture(context, candidate, 'cli-invalid-evidence');
  assert.equal(run.result.passed, true);
  await rm(join(run.dir, (await record(run.dir)).executions[0]!.report.path));
  const originalResult = await readFile(join(run.dir, 'results.json'));
  const cli = fileURLToPath(new URL('../../tools/p0/cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'check', '--root', candidate.root, '--run', run.dir], {
    shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => { clearTimeout(timer); });
  const checkFiles = (await readdir(join(run.dir, 'checks'))).filter((name) => name.endsWith('.json'));
  assert.equal(checkFiles.length, 1, 'the actual CLI must append its check result');
  const checkResult = JSON.parse(await readFile(join(run.dir, 'checks', checkFiles[0]!), 'utf8')) as { passed: boolean };
  assert.equal(checkResult.passed, false);
  const rejection = await retainRejection(candidate, run.dir, checkResult, originalResult);
  if (rejection) {
    await cp(join(run.dir, 'checks'), join(rejection, 'checks'), { recursive: true, errorOnExist: true, force: false });
    await writeFile(join(rejection, 'cli.json'), json({
      phase: 'after-fault-injection', command: [process.execPath, cli, 'check', '--root', candidate.root, '--run', run.dir],
      pid: child.pid, exitCode: outcome.code, signal: outcome.signal, stdout, stderr,
      checks: checkFiles.map((name) => `checks/${name}`),
    }), { flag: 'wx' });
  }
  assert.equal(outcome.signal, null, stderr);
  assert.equal(outcome.code, 1, stdout + stderr);
  assert.doesNotMatch(stderr, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/, 'the CLI itself must execute');
  assert.match(stdout + stderr, /false|FAIL|missing|ENOENT|report/i);
  assert.deepEqual(await readFile(join(run.dir, 'results.json')), originalResult);
});
