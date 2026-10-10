import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { classifyCodexAuth, executableCandidates, parseVersion, runBounded } from '../../tools/p0/environment.js';

test('p0.environment.unit.version-extracts-complete-prefixed-and-multisegment-tokens', () => {
  assert.equal(parseVersion('v24.20.0\n'), '24.20.0');
  assert.equal(parseVersion('node V24.20.0'), '24.20.0');
  assert.equal(parseVersion('git version 2.50.1 (Apple Git-155)'), '2.50.1');
  assert.equal(parseVersion('Xcode 26.0'), '26.0');
  assert.equal(parseVersion('tool 1.2.3.4.5'), '1.2.3.4.5');
  assert.equal(parseVersion('temporal 1.2.3-rc.4+build.7'), '1.2.3-rc.4+build.7');
  assert.equal(parseVersion('java version "1.8.0_402"'), '1.8.0_402');
  assert.equal(parseVersion(process.version), process.version.slice(1));
});

test('p0.environment.unit.version-rejects-partial-or-unbounded-tokens-without-retaining-output', () => {
  for (const output of ['', 'version 24', 'nodev24.20.0', '1.2.3.unknown', '1.2.3.', '1.2.3_', '1.2.3+']) {
    assert.equal(parseVersion(output), undefined, output);
  }
  assert.equal(parseVersion(`version 1.${'2'.repeat(200)}`), undefined);
  assert.equal(parseVersion('codex-cli 0.100.0\nAPI key: SECRET_VERSION_FIXTURE'), '0.100.0');
});

test('p0.environment.unit.path-posix-excludes-implicit-cwd-and-deduplicates', () => {
  assert.deepEqual(executableCandidates('codex', ['', '/opt/bin', 'relative', '/opt/bin', '/usr/bin'].join(delimiter), 'darwin', undefined, ['/opt/bin/codex', '/Applications/Codex.app/codex']), [
    '/opt/bin/codex', '/usr/bin/codex', '/Applications/Codex.app/codex',
  ]);
  assert.deepEqual(executableCandidates('codex', undefined, 'linux'), []);
});

test('p0.environment.unit.path-windows-respects-pathext-and-absolute-directories', () => {
  assert.deepEqual(executableCandidates('pnpm', 'C:\\Tools;;relative;D:\\Node', 'win32', '.EXE;.CMD;.EXE'), [
    'C:\\Tools\\pnpm.exe', 'C:\\Tools\\pnpm.cmd', 'D:\\Node\\pnpm.exe', 'D:\\Node\\pnpm.cmd',
  ]);
  assert.deepEqual(executableCandidates('node.exe', 'C:\\Tools', 'win32', '.EXE;.CMD'), ['C:\\Tools\\node.exe']);
});

test('p0.environment.unit.auth-known-labels-do-not-claim-api-access-or-retain-secrets', () => {
  const authenticated = classifyCodexAuth({ exitCode: 0, output: 'Logged in using an API key: SECRET_AUTH_FIXTURE' });
  assert.equal(authenticated.status, 'available');
  assert.equal(authenticated.detail, 'authenticated; remote API not tested');
  assert.ok(!JSON.stringify(authenticated).includes('SECRET_AUTH_FIXTURE'));
  const missing = classifyCodexAuth({ exitCode: 1, output: 'Not logged in' });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.detail, 'not-authenticated; remote API not tested');
});

test('p0.environment.unit.auth-unrecognized-or-failed-status-is-unknown', () => {
  for (const result of [
    { exitCode: 0, output: '' },
    { exitCode: 0, output: 'success' },
    { exitCode: 0, output: 'Authenticated: false' },
    { exitCode: 0, output: 'error: not logged in due to command failure' },
    { exitCode: 1, output: 'Logged in using ChatGPT' },
    { exitCode: null, output: 'Logged in', failure: 'timeout' as const },
    { exitCode: 0, output: 'Logged in', failure: 'output-limit' as const },
  ]) assert.equal(classifyCodexAuth(result).status, 'unknown');
});

test('p0.environment.unit.command-real-process-captures-exit-without-shell', async () => {
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.exit(7)', 'literal $(echo injected); `echo injected`'], tmpdir());
  assert.equal(result.exitCode, 7);
  assert.equal(result.failure, undefined);
  assert.equal(result.output, 'literal $(echo injected); `echo injected`');
});

test('p0.environment.unit.command-real-process-enforces-output-limit', async () => {
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write("x".repeat(100_000)); setInterval(() => {}, 1000)'], tmpdir());
  assert.equal(result.failure, 'output-limit');
  assert.ok(Buffer.byteLength(result.output) <= 16_384);
});

test('p0.environment.unit.command-real-process-enforces-five-second-deadline', { timeout: 10_000 }, async () => {
  const start = performance.now();
  const result = await runBounded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], tmpdir());
  assert.equal(result.failure, 'timeout');
  assert.equal(result.exitCode, null);
  assert.ok(performance.now() - start < 9_000);
});

test('p0.environment.unit.command-missing-executable-is-explicit-spawn-failure', async () => {
  const result = await runBounded(join(tmpdir(), `p0-missing-executable-${process.pid}`), [], tmpdir());
  assert.equal(result.failure, 'spawn');
  assert.equal(result.exitCode, null);
});
