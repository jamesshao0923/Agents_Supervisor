import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkBoundaries } from '../../tools/p0/boundaries.js';

test('repository production module boundaries pass on actual source files', async () => {
  assert.deepEqual(await checkBoundaries(process.cwd()), []);
});

test('repository ignores runtime secrets outputs and dependencies but retains sources and lockfile', async () => {
  const ignored = ['node_modules/pkg/file.js', 'dist/a.js', 'coverage/index.html', '.supervisor-dev/verification/run/manifest.json', '.supervisor/memory/project.md', 'local/supervisor.sqlite', 'local/supervisor.sqlite-wal', 'local/supervisor.sqlite-shm', 'local/supervisor.sock', 'local/service.lock', '.env', '.env.local', 'private.key', 'certificate.p12', '.DS_Store'];
  for (const path of ignored) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(result.status, 0, `${path} must be ignored: ${result.stderr}`);
  }
  for (const path of ['pnpm-lock.yaml', 'package.json', '.env.example', '.env.local.example', 'tests/acceptance/p0.json', 'tools/p0/runner.ts']) {
    assert.equal(spawnSync('git', ['check-ignore', '--no-index', '-q', path]).status, 1, `${path} must remain versionable`);
  }
});

test('repository live gate is wired and unavailable release gate fails closed', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.scripts['test:live'], 'pnpm build && node dist/tools/p0/cli.js run --layer live');
  const result = spawnSync(process.execPath, [resolve('tools/unavailable.mjs'), 'release'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /No tests executed; NOT PASSED/);
});

test('repository running compiler and runtime match pinned versions', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(process.versions.node, pkg.engines.node);
  const compiler = JSON.parse(await readFile('node_modules/typescript/package.json', 'utf8'));
  assert.equal(compiler.version, pkg.devDependencies.typescript);
  assert.equal((await readFile('.nvmrc', 'utf8')).trim(), process.versions.node);
});
