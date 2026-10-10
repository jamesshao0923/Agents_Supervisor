import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBoundaries } from '../../tools/p0/boundaries.js';

test('boundaries allow pure domain and contract imports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages/domain'), { recursive: true });
  await writeFile(join(root, 'packages/domain/a.ts'), "import './b.js'; import type { Contract } from '../contracts/index.js';");
  assert.deepEqual(await checkBoundaries(root), []);
});

test('boundaries reject product and external effects inside domain', async t => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages/domain'), { recursive: true });
  await writeFile(join(root, 'packages/domain/a.ts'), "import fs from 'node:fs'; export {x} from '../runtime/index.js'; import('electron'); require(variable);");
  assert.equal((await checkBoundaries(root)).length, 4);
});

test('boundaries keep development verifier independent from product', async t => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tools/p0'), { recursive: true });
  await writeFile(join(root, 'tools/p0/a.ts'), "import '../../apps/supervisor/a.js';");
  assert.equal((await checkBoundaries(root)).length, 1);
});

test('boundaries reject import equals and import types across TypeScript extensions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages/domain'), { recursive: true });
  for (const ext of ['ts', 'tsx', 'mts', 'cts']) {
    await writeFile(join(root, `packages/domain/a.${ext}`), "import Electron = require('electron'); type X = import('node:fs').PathLike;");
  }
  assert.equal((await checkBoundaries(root)).length, 8);
});
