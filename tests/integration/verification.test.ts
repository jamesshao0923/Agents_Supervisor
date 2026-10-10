import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { assertCandidate, captureCandidate, type Candidate } from '../../packages/verification/candidate.js';
import { runCommandVerifier } from '../../packages/verification/command.js';
import { runCandidateBuild } from '../../packages/verification/build.js';
import { inspectProcess, type ProcessIdentity, type ProcessResult } from '../../packages/process-control/index.js';

const execute = promisify(execFile), compiler = resolve('node_modules/typescript/bin/tsc');
const correctSource = 'export function discountedPrice(amount: number, percent: number): number { if(!Number.isFinite(amount)||!Number.isFinite(percent)||amount<0||percent<0||percent>100)throw new RangeError("Invalid discount input"); return amount*(1-percent/100); }\n';
const wrongFormula = correctSource.replace('amount*(1-percent/100)', 'amount*percent');
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sv-p4-')), workspace = join(directory, 'project'), bundle = join(directory, 'verifiers'); await mkdir(workspace); await mkdir(bundle);
  await writeFile(join(workspace, 'package.json'), '{"type":"module"}\n'); await mkdir(join(workspace, 'src'));
  await copyFile(fileURLToPath(new URL('../fixtures/p4-price-verifier.js', import.meta.url)), join(bundle, 'price.mjs'));
  await copyFile(fileURLToPath(new URL('../fixtures/p4-process-verifier.js', import.meta.url)), join(bundle, 'process.mjs'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function build(source = correctSource) {
    await writeFile(join(workspace, 'src/price.ts'), source);
    await execute(process.execPath, [compiler, 'src/price.ts', '--target', 'es2022', '--module', 'nodenext', '--strict', '--outDir', 'build', '--types', 'node', '--typeRoots', resolve('node_modules/@types')], { cwd: workspace, timeout: 15_000 });
  }
  async function run(candidate: Candidate, parameters: Record<string, string>, name: string, entry = 'price.mjs', obligationIds = ['normal', 'invalid'], timeoutMs = 5000) {
    return runCommandVerifier({ id: name, bundle, entry, cwd: candidate.tree, parameters, obligationIds, timeoutMs, output: join(directory, name) });
  }
  return { directory, workspace: await realpath(workspace), bundle, build, run };
}

test('verification fixed candidate includes source build binary and lock bytes and detects live or frozen changes', async t => {
  const f = await fixture(t); await f.build(); await writeFile(join(f.workspace, 'app.bin'), Buffer.from([0, 1, 2, 255])); await chmod(join(f.workspace, 'app.bin'), 0o644); await writeFile(join(f.workspace, '__proto__'), 'actual filename, not an inherited object property\n'); await writeFile(join(f.workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'); await mkdir(join(f.workspace, 'node_modules')); await writeFile(join(f.workspace, 'node_modules/installed.txt'), 'explicit excluded dependencies');
  const candidate = await captureCandidate(f.workspace, join(f.directory, 'snapshot')); await assertCandidate(candidate);
  for (const name of ['src/price.ts', 'build/price.js', 'app.bin', '__proto__', 'pnpm-lock.yaml', 'package.json']) assert.ok(Object.hasOwn(candidate.files, name) && typeof candidate.files[name] === 'string', name); assert.equal(candidate.files['node_modules/installed.txt'], undefined); assert.ok(candidate.excluded.includes('node_modules'));
  await writeFile(join(f.workspace, '__proto__'), 'changed filename bytes\n'); await assert.rejects(assertCandidate(candidate), /workspace differs/); await writeFile(join(f.workspace, '__proto__'), 'actual filename, not an inherited object property\n');
  await chmod(join(f.workspace, 'app.bin'), 0o755); await assert.rejects(assertCandidate(candidate), /workspace differs/); await assertCandidate(candidate, false); await chmod(join(f.workspace, 'app.bin'), 0o644); await assertCandidate(candidate);
  await writeFile(join(f.workspace, 'src/price.ts'), wrongFormula); await assert.rejects(assertCandidate(candidate), /workspace differs/); await assertCandidate(candidate, false); assert.equal(await readFile(join(candidate.tree, 'src/price.ts'), 'utf8'), correctSource);
  await writeFile(join(f.workspace, 'src/price.ts'), correctSource); await writeFile(join(f.workspace, 'app.bin'), Buffer.from([0, 1, 2, 254])); await assert.rejects(assertCandidate(candidate), /workspace differs/); await assertCandidate(candidate, false);
  await writeFile(join(f.workspace, 'app.bin'), Buffer.from([0, 1, 2, 255])); await writeFile(join(f.workspace, 'build/price.js'), 'changed built program\n'); await assert.rejects(assertCandidate(candidate), /workspace differs/);
  await writeFile(join(candidate.tree, 'app.bin'), Buffer.from([99])); await assert.rejects(assertCandidate(candidate, false), /snapshot is invalid/);
});

test('verification snapshot refuses symlink deliverables and existing frozen destinations without modifying original bytes', async t => {
  const f = await fixture(t); await f.build(); const outside = join(f.directory, 'outside.txt'); await writeFile(outside, 'external bytes'); await symlink(outside, join(f.workspace, 'linked-source')); await assert.rejects(captureCandidate(f.workspace, join(f.directory, 'with-link')), /symlink/); await rm(join(f.workspace, 'linked-source'));
  const destination = join(f.directory, 'fixed'), candidate = await captureCandidate(f.workspace, destination); const original = await readFile(join(candidate.tree, 'src/price.ts'));
  await f.build(wrongFormula); await assert.rejects(captureCandidate(f.workspace, destination)); assert.deepEqual(await readFile(join(candidate.tree, 'src/price.ts')), original, 'A refused recapture must not rewrite a previously frozen candidate'); await assertCandidate(candidate, false);
  await assert.rejects(captureCandidate(f.workspace, join(f.workspace, 'nested-snapshot')), /outside the candidate/);
});

test('verification actual independent build assertions pass correct program and reject the known formula and illegal-input defects', async t => {
  const f = await fixture(t); const parameters = { amount: '200', percent: '25', expected: '150' }; await f.build(); const good = await captureCandidate(f.workspace, join(f.directory, 'good')); const passed = await f.run(good, parameters, 'good-report');
  assert.equal(passed.executionStatus, 'executed'); assert.equal(passed.stopped, true); assert.deepEqual(passed.checks.map(c => c.verdict), ['passed', 'passed']); await assertCandidate(good);
  async function verifyBuild(candidate: Candidate, name: string) {
    const output = join(f.directory, name), result = await runCandidateBuild({ id: name, candidateTree: candidate.tree, build: { kind: 'typescript', sources: ['src/price.ts'], rootDir: 'src', outputDir: 'build', timeoutMs: 15_000 }, output });
    assert.equal(result.executionStatus, 'executed', result.reason); assert.equal(result.stopped, true, result.reason); assert.ok(result.proofFiles.some(path => path.endsWith('manifest.json')));
    const process = JSON.parse(await readFile(join(output, 'process.json'), 'utf8')) as ProcessResult; assert.equal(process.reason, 'completed'); assert.equal(process.stopped, true); assert.equal((await inspectProcess(process.identity)).status, 'stopped'); await assertCandidate(candidate, false);
    return result;
  }
  const rebuiltGood = await verifyBuild(good, 'source-build-good'); assert.equal(rebuiltGood.passed, true, rebuiltGood.reason);
  // A correct old binary still passes behavioral assertions when the source
  // differs. Rebuilding must detect that mismatch instead of accepting it.
  await writeFile(join(f.workspace, 'src/price.ts'), wrongFormula); const staleBinary = await captureCandidate(f.workspace, join(f.directory, 'stale-binary'));
  const staleChecks = await f.run(staleBinary, parameters, 'stale-binary-report'); assert.equal(staleChecks.executionStatus, 'executed'); assert.ok(staleChecks.checks.every(check => check.verdict === 'passed'));
  const staleBuild = await verifyBuild(staleBinary, 'source-build-stale'); assert.equal(staleBuild.passed, false, 'Wrong source cannot be delivered with an unrelated correct old binary');
  const staleManifest = JSON.parse(await readFile(join(f.directory, 'source-build-stale/manifest.json'), 'utf8')) as { differences: { changed: string[] } }; assert.deepEqual(staleManifest.differences.changed, ['price.js']);
  await f.build(); await writeFile(join(f.workspace, 'build/price.js'), (await readFile(join(f.workspace, 'build/price.js'), 'utf8')) + '// altered deliverable bytes\n'); const changedBinary = await captureCandidate(f.workspace, join(f.directory, 'changed-binary'));
  assert.equal((await verifyBuild(changedBinary, 'source-build-changed-binary')).passed, false, 'Even a behaviorally equivalent altered binary must match the actual source build');
  await f.build(); await writeFile(join(f.workspace, 'src/price.ts'), 'export function discountedPrice(amount:number,percent:number):number{return "not a number";}\n'); const invalidSource = await captureCandidate(f.workspace, join(f.directory, 'invalid-source'));
  const rejectedSource = await verifyBuild(invalidSource, 'source-build-invalid'); assert.equal(rejectedSource.passed, false); assert.match(rejectedSource.reason, /compiler rejected/); assert.match(await readFile(join(f.directory, 'source-build-invalid/stdout.log'), 'utf8'), /TS2322/);
  await f.build(wrongFormula); const bad = await captureCandidate(f.workspace, join(f.directory, 'bad')); const failed = await f.run(bad, parameters, 'bad-report'); assert.equal(failed.executionStatus, 'executed'); assert.equal(failed.checks.find(c => c.obligationId === 'normal')?.verdict, 'failed'); assert.equal(failed.checks.find(c => c.obligationId === 'invalid')?.verdict, 'passed'); await assertCandidate(bad);
  const originalBadBuild = await readFile(join(bad.tree, 'build/price.js')), rewrite = await f.run(bad, { mode: 'rewrite-candidate' }, 'rewrite-report', 'process.mjs', ['normal']); assert.equal(rewrite.executionStatus, 'verifier-error'); assert.equal(rewrite.stopped, true); assert.deepEqual(rewrite.checks, []); assert.match(await readFile(join(f.directory, 'rewrite-report/stderr.log'), 'utf8'), /ERR_ACCESS_DENIED/); assert.deepEqual(await readFile(join(bad.tree, 'build/price.js')), originalBadBuild, 'A checker cannot repair the faulty candidate and pass its modified copy'); await assertCandidate(bad);
  await f.build('export function discountedPrice(amount:number,percent:number):number{return amount*(1-percent/100);}\n'); const illegal = await captureCandidate(f.workspace, join(f.directory, 'illegal')); const fault = await f.run(illegal, parameters, 'illegal-report'); assert.equal(fault.executionStatus, 'executed'); assert.equal(fault.checks.find(c => c.obligationId === 'normal')?.verdict, 'passed'); assert.equal(fault.checks.find(c => c.obligationId === 'invalid')?.verdict, 'failed');
  // Preserve separate counterexamples: each implementation only accepts the
  // formerly omitted -Infinity input in one argument, and rejects all others.
  for (const argument of ['amount', 'percent'] as const) {
    await f.build(correctSource.replace(' { if(', ` { if(${argument}===-Infinity)return 0; if(`));
    const negativeInfinity = await captureCandidate(f.workspace, join(f.directory, 'negative-infinity-' + argument));
    const rejected = await f.run(negativeInfinity, parameters, 'negative-infinity-' + argument + '-report');
    assert.equal(rejected.executionStatus, 'executed', argument + ': ' + rejected.reason); assert.equal(rejected.stopped, true);
    assert.equal(rejected.checks.find(c => c.obligationId === 'normal')?.verdict, 'passed');
    assert.equal(rejected.checks.find(c => c.obligationId === 'invalid')?.verdict, 'failed', 'A checker must reject accepting -Infinity in ' + argument);
    await assertCandidate(negativeInfinity);
  }
  assert.equal(await readFile(join(good.tree, 'src/price.ts'), 'utf8'), correctSource); assert.ok(passed.proofFiles.some(path => path.endsWith('report.json'))); assert.ok(failed.proofFiles.some(path => path.endsWith('stderr.log')));
});

test('verification real crash missing report conflicting exit timeout and cancellation remain verifier errors with actual stopped process evidence', async t => {
  const f = await fixture(t); await f.build(); const candidate = await captureCandidate(f.workspace, join(f.directory, 'candidate'));
  for (const mode of ['crash', 'missing', 'passed-exit-one', 'failed-exit-zero', 'hang']) {
    const result = await f.run(candidate, { mode }, 'process-' + mode, 'process.mjs', ['normal'], mode === 'hang' ? 300 : 5000); assert.equal(result.executionStatus, 'verifier-error', mode + ': ' + result.reason); assert.equal(result.stopped, true); assert.deepEqual(result.checks, []); assert.ok(result.reason);
    const identity = JSON.parse(await readFile(join(f.directory, 'process-' + mode, 'identity.json'), 'utf8')) as ProcessIdentity; assert.equal((await inspectProcess(identity)).status, 'stopped', mode); assert.ok(result.proofFiles.some(path => path.endsWith('process.json')));
  }
  const unknown = await f.run(candidate, { mode: 'unknown-exit-one' }, 'unknown-report', 'process.mjs', ['normal']); assert.equal(unknown.executionStatus, 'executed'); assert.equal(unknown.checks[0]?.verdict, 'unknown');
  const unavailable = await f.run(candidate, {}, 'missing-entry', 'not-installed.mjs', ['normal']); assert.equal(unavailable.executionStatus, 'environment-blocked'); assert.equal(unavailable.stopped, true);
  for (const point of ['before-dispatch', 'after-intent', 'after-identity'] as const) {
    const cancellation = new AbortController(); if (point === 'before-dispatch') cancellation.abort();
    const output = join(f.directory, 'cancel-' + point), result = await runCommandVerifier({ id: 'cancel-' + point, bundle: f.bundle, entry: 'process.mjs', cwd: candidate.tree, parameters: { mode: 'effect' }, obligationIds: ['normal'], timeoutMs: 5000, output, signal: cancellation.signal,
      onIntent: () => { if (point === 'after-intent') cancellation.abort(); }, onIdentity: () => { if (point === 'after-identity') cancellation.abort(); } });
    assert.equal(result.executionStatus, 'verifier-error', point + ': ' + result.reason); assert.equal(result.stopped, true, point); assert.deepEqual(result.checks, []); assert.match(result.reason, /cancelled/);
    await assert.rejects(readFile(join(output, 'forbidden-effect')), { code: 'ENOENT' });
    if (point === 'after-identity') { const identity = JSON.parse(await readFile(join(output, 'identity.json'), 'utf8')) as ProcessIdentity; assert.equal((await inspectProcess(identity)).status, 'stopped'); }
    else assert.ok(result.proofFiles.some(path => path.endsWith('not-started.json')));
  }
  const cancellation = new AbortController(), output = join(f.directory, 'cancel-started');
  const running = runCommandVerifier({ id: 'cancel-started', bundle: f.bundle, entry: 'process.mjs', cwd: candidate.tree, parameters: { mode: 'cancel-effect' }, obligationIds: ['normal'], timeoutMs: 5000, output, signal: cancellation.signal });
  const end = Date.now() + 4000; let actualStarted = false;
  while (Date.now() < end) { try { actualStarted = (await readFile(join(output, 'verifier-started'), 'utf8')).includes('Actual target started'); if (actualStarted) break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } await delay(30); }
  cancellation.abort(); const cancelled = await running; assert.equal(actualStarted, true, cancelled.reason); assert.equal(cancelled.executionStatus, 'verifier-error'); assert.equal(cancelled.stopped, true); assert.deepEqual(cancelled.checks, []); await assert.rejects(readFile(join(output, 'forbidden-effect')), { code: 'ENOENT' });
  const stopped = JSON.parse(await readFile(join(output, 'identity.json'), 'utf8')) as ProcessIdentity; assert.equal((await inspectProcess(stopped)).status, 'stopped');
});

test('verification actual parameter instances execute independently and a later pass preserves the earlier failed report', async t => {
  const f = await fixture(t); await f.build(); const candidate = await captureCandidate(f.workspace, join(f.directory, 'candidate')); const inputs = [{ amount: '200', percent: '25', expected: '149' }, { amount: '80', percent: '0', expected: '80' }];
  const first = await f.run(candidate, inputs[0]!, 'parameter-one'), second = await f.run(candidate, inputs[1]!, 'parameter-two'); assert.equal(first.executionStatus, 'executed'); assert.equal(second.executionStatus, 'executed'); assert.equal(first.checks[0]?.verdict, 'failed'); assert.equal(second.checks[0]?.verdict, 'passed');
  const reportOne = JSON.parse(await readFile(join(f.directory, 'parameter-one/report.json'), 'utf8')) as { checks: { verdict: string; reason: string }[] }; const reportTwo = JSON.parse(await readFile(join(f.directory, 'parameter-two/report.json'), 'utf8')) as { checks: { verdict: string; reason: string }[] };
  assert.equal(reportOne.checks[0]?.verdict, 'failed'); assert.match(reportTwo.checks[0]!.reason, /"amount":"80"/); assert.notEqual(await readFile(join(f.directory, 'parameter-one/identity.json'), 'utf8'), await readFile(join(f.directory, 'parameter-two/identity.json'), 'utf8')); await assertCandidate(candidate);
});
