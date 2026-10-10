import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeEnvironment, type EnvironmentReport } from '../../tools/p0/environment.js';

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    const metadata = await stat(directory);
    entries[prefix || '.'] = `directory:${metadata.mode}:${metadata.mtimeMs}`;
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else {
        const data = await readFile(absolute);
        const fileMetadata = await stat(absolute);
        entries[relative] = `file:${fileMetadata.mode}:${fileMetadata.mtimeMs}:${createHash('sha256').update(data).digest('hex')}`;
      }
    }
  }
  await visit(root, '');
  return entries;
}

function assertReport(report: EnvironmentReport): void {
  assert.equal(report.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(report.generatedAt)));
  assert.equal(report.platform, process.platform);
  assert.equal(report.arch, process.arch);
  assert.deepEqual(report.node, { version: process.version, executable: process.execPath });
  const expectedIds = ['project.directory', 'project.read', 'project.write', 'project.search', 'node', 'git', 'pnpm', 'codex', 'codex.auth', 'temporal', 'xcode.select', 'xcode.build', 'ios.simctl', 'ios.devices', 'android.java', 'android.sdk', 'android.adb', 'android.emulator', 'android.avds'];
  assert.deepEqual(report.checks.map((check) => check.id).sort(), expectedIds.sort());
  for (const check of [...report.checks, ...report.capabilities]) {
    assert.ok(['available', 'missing', 'unknown'].includes(check.status));
    assert.ok(check.detail.length > 0 && check.detail.length < 4096);
  }
  assert.equal(new Set(report.checks.map((check) => check.id)).size, report.checks.length);
  assert.deepEqual(report.capabilities.map((check) => check.id), ['codex.api', 'temporal.service', 'ios.delivery', 'android.delivery']);
  assert.ok(report.capabilities.every((check) => check.status === 'unknown' && /not tested/.test(check.detail)));
  const auth = report.checks.find((check) => check.id === 'codex.auth');
  assert.ok(auth && /remote API not tested/.test(auth.detail));
  assert.match(auth.detail, /^(?:authenticated|not-authenticated|unrecognized-login-status|login-status-(?:spawn|timeout|output-limit|signal)|Codex executable unavailable); remote API not tested$/);
}

test('p0.environment.integration.real-probe-preserves-project-and-cwd', { timeout: 50_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'p0 environment '));
  const cwdBefore = process.cwd();
  try {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'fixture.txt'), 'immutable environment fixture\n');
    await writeFile(join(root, '.hidden-fixture'), 'hidden file must survive\n');
    // Actual test-owned write demonstrates the directory permits real writes.
    const before = await snapshot(root);
    const report = await probeEnvironment(root);
    assertReport(report);
    assert.equal(report.checks.find((check) => check.id === 'project.directory')?.status, 'available');
    assert.equal(report.checks.find((check) => check.id === 'project.write')?.status, 'available');
    assert.deepEqual(await snapshot(root), before);
    assert.equal(process.cwd(), cwdBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('p0.environment.integration.missing-project-still-reports-host-capabilities', { timeout: 50_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'p0 missing environment '));
  try {
    const report = await probeEnvironment(join(root, 'absent'));
    assertReport(report);
    for (const id of ['project.directory', 'project.read', 'project.write', 'project.search']) {
      assert.equal(report.checks.find((check) => check.id === id)?.status, 'missing');
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
