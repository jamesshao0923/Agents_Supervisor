import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {mkdtemp, mkdir, realpath, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {MaterialIntake} from '../../packages/workspace/material-intake.js';
import {captureResearchEvidence} from '../../packages/workspace/research-materials.js';
import {prepareResearchReader} from '../../packages/workspace/research-reader.js';
import type {ResearchReaderLimits} from '../../packages/contracts/p8-research-reader.js';

export async function researchReaderFixture(t: TestContext, input: {text?: string; limits?: ResearchReaderLimits} = {}) {
  const root = await realpath(await mkdtemp('/tmp/sv-indexed-reader-'));
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, {recursive: true, force: true});});
  const data = join(root, 'data'); await mkdir(data);
  const text = input.text ?? '<html>原文 α😀 needle. needle. needle.</html>\n';
  const path = join(root, 'original.txt'), second = join(root, 'second.md'), pdf = join(root, 'unsupported.pdf');
  await writeFile(path, text); await writeFile(second, 'Other exact original material.');
  await writeFile(pdf, '%PDF actual unsupported original bytes');
  const intake = new MaterialIntake(data);
  const index = await intake.acquire({commandId: 'actual-indexed-material', inputs: [
    {id: 'one', kind: 'local', path}, {id: 'two', kind: 'local', path: second},
    {id: 'pdf', kind: 'local', path: pdf}, {id: 'missing', kind: 'local', path: join(root, 'missing.txt')},
  ]});
  assert.deepEqual(index.entries.map(entry => entry.status), ['success', 'success', 'unsupported', 'failed']);
  const contract = {version: 1, goal: 'Read all original sources without changing the question.',
    criteria: [{id: 'research', description: 'Trace interpretations to complete original source spans.', required: true}]};
  const context = await captureResearchEvidence({intake,
    material: {directory: index.directory, generation: index.generation, indexDigest: index.indexDigest, inputDigest: index.inputDigest},
    contract, requirements: [{criterionId: 'research', question: contract.criteria[0]!.description,
      requiredMaterialIds: index.entries.map(entry => entry.id), cutoff: null, maxSourceAgeMs: 86400000}],
    limits: {maxContextChars: 200000, maxClaims: 16, maxCitations: 32, maxQuoteChars: 12000}});
  const reader = await prepareResearchReader({intake, context, materialIds: ['one'], role: 'current',
    dataRoot: data, ...(input.limits ? {limits: input.limits} : {})});
  return {root, data, intake, index, context, reader, text, addCleanup(cleanup: () => Promise<void>) {cleanups.push(cleanup);}};
}
