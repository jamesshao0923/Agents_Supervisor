import test from 'node:test';
import assert from 'node:assert/strict';
import {researchReaderFixture} from '../helpers/research-reader-fixture.js';
import {prepareResearchReader} from '../../packages/workspace/research-reader.js';
import {prepareResearchViewSet, assertResearchViewSet, readResearchView} from '../../packages/workspace/research-reader-views.js';
import {researchDigest} from '../../packages/workspace/research-materials.js';

// Actual local MaterialIntake/FS. The epoch digest below is structural test data,
// not an approved original model epoch or a sourceRefresh qualification receipt.
test('P8-READER-VIEWS-U01 immutable current and historical view inventory preserves complete original bytes and partial entries', async t => {
  const f = await researchReaderFixture(t, {text: 'original😀 material'});
  const historical = await prepareResearchReader({intake: f.intake, context: f.context,
    materialIds: ['one'], role: 'historical', dataRoot: f.data, limits: f.reader.view.limits});
  const entries = [{viewId: 'current', reader: f.reader,
    reference: {role: 'current' as const, bindingDigest: researchDigest({test: 'structural-current'})}},
  {viewId: 'original', reader: historical,
    reference: {role: 'historical' as const, epochDigest: researchDigest({test: 'structural-epoch'})}}];
  const set = await prepareResearchViewSet(f.data, entries);
  await assertResearchViewSet(set);
  // Typed oversized input rejection, no archive mutation or external experiment.
  await assert.rejects(assertResearchViewSet({...set, path: 'x'.repeat(200001)}), /metadata exceeds original context cap/);
  assert.deepEqual(await prepareResearchViewSet(f.data, entries), set);
  assert.equal(set.authority, 'material-integrity-only');
  assert.deepEqual(set.views.map(v => v.reader.view.sources.map(s => [s.materialId, s.status])),
    [entries[0]!.reader.view.sources, entries[1]!.reader.view.sources].map(s => s.map(v => [v.materialId, v.status])));
  for (const viewId of ['current', 'original']) {
    const read = await readResearchView(set, {viewId, request: {type: 'range', materialId: 'one', start: 0, end: f.text.length}});
    assert.equal(read.result.ranges[0]!.text, f.text);
    assert.equal(read.inventoryDigest, set.digest);
    assert.equal(read.viewId, viewId);
    assert.equal(Object.hasOwn(read, 'passed'), false);
  }
});
