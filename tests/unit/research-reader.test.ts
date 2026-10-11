import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, rename, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {researchReaderFixture} from '../helpers/research-reader-fixture.js';
import {assertResearchReader, prepareResearchReader, readResearchMaterial} from '../../packages/workspace/research-reader.js';
import {bytesDigest} from '../../packages/workspace/research-runtime-files.js';
import {researchDigest} from '../../packages/workspace/research-materials.js';
import {validateReasonerSchema, parseReasonerOutput} from '../../packages/orchestration/reasoner-schema.js';
import type {ResearchReadRequest} from '../../packages/contracts/p8-research-reader.js';

// Actual MaterialIntake/FS modules; structural provenance is not semantic verification.
test('P8-READER-U01 complete raw HTML Unicode page index and global UTF16 range preserve every original byte', async t => {
  const text = 'ab😀' + 'c'.repeat(25) + '<script>untrusted instructions</script>尾';
  const f = await researchReaderFixture(t, {text, limits: {pageChars: 3, maxRangeChars: 16384,
    maxResponseChars: 65536, maxSearchResults: 16, maxQueryChars: 256}});
  const reuse={intake:f.intake,context:f.context,materialIds:['one'],role:'current' as const,dataRoot:f.data,limits:f.reader.view.limits};
  assert.deepEqual(await prepareResearchReader(reuse),f.reader,'exact immutable view is reused without replacing bytes');
  assert.deepEqual(await prepareResearchReader(reuse),f.reader,'same descriptor remains stable for separate consumers');
  const source = f.reader.view.sources[0]!; assert.equal(source.utf16Length, text.length);
  let cursor = 0, restored = '';
  for (const page of source.pages) {
    assert.equal(page.start, cursor); assert.ok(page.end > cursor);
    const result = await readResearchMaterial(f.reader, {type: 'range', materialId: 'one', start: page.start, end: page.end});
    assert.equal(result.coordinate, 'utf16-code-units');
    assert.equal(result.ranges[0]!.digest, page.digest); assert.equal(result.rawDigest, source.rawDigest);
    restored += result.ranges[0]!.text; cursor = page.end;
  }
  assert.equal(restored, text); assert.equal(cursor, text.length); assert.equal(source.rawDigest, bytesDigest(text));
  assert.equal(await readFile(join(f.index.directory, f.index.entries[0]!.raw!.path), 'utf8'), text);
  assert.equal(f.reader.view.authority, 'material-integrity-only');
  assert.deepEqual(f.reader.view.sources.map(value => [value.materialId, value.status]),
    [['one', 'success'], ['two', 'success'], ['pdf', 'unsupported'], ['missing', 'failed']]);
  assert.deepEqual(f.reader.view.sources[2]!.pages, []); assert.equal(f.reader.view.sources[2]!.utf16Length, null);
});

test('P8-READER-U02 literal search reports total matches truncation context neighborhoods and no-match without a verdict', async t => {
  const f = await researchReaderFixture(t);
  const result = await readResearchMaterial(f.reader, {type: 'search', materialId: 'one', query: 'needle', maxResults: 1, contextChars: 3});
  assert.equal(result.matchCount, 3); assert.equal(result.truncated, true); assert.equal(result.ranges.length, 1);
  const span = result.ranges[0]!; assert.equal(span.text, f.text.slice(span.start, span.end));
  assert.equal(span.digest, bytesDigest(span.text)); assert.equal(Object.hasOwn(result, 'passed'), false);
  const noMatch = await readResearchMaterial(f.reader, {type: 'search', materialId: 'one', query: '.*', maxResults: 1, contextChars: 0});
  assert.equal(noMatch.matchCount, 0); assert.equal(noMatch.truncated, false); assert.deepEqual(noMatch.ranges, []);
  const schema = {type: 'object', additionalProperties: false, properties: {
    materialId: {type: 'string', enum: ['one']}, start: {type: 'integer', minimum: 0}, end: {type: 'integer', minimum: 1}},
    required: ['materialId', 'start', 'end']};
  assert.deepEqual(validateReasonerSchema(schema), schema);
  assert.deepEqual(parseReasonerOutput('{"materialId":"one","start":0,"end":2}', schema), {materialId: 'one', start: 0, end: 2});
});

test('P8-READER-U03 selection and strict typed bounds reject unauthorized source split-surrogate oversized and extra arguments', async t => {
  const f = await researchReaderFixture(t), emoji = f.text.indexOf('😀');
  for (const request of [
    {type: 'range', materialId: 'two', start: 0, end: 2},
    {type: 'range', materialId: 'one', start: emoji, end: emoji + 1},
    {type: 'range', materialId: 'one', start: -1, end: 2},
    {type: 'range', materialId: 'one', start: 0, end: 100000},
    {type: 'range', materialId: 'one', start: 0, end: 2, path: '/etc/passwd'},
    {type: 'search', materialId: 'one', query: '\ud800', maxResults: 1, contextChars: 0},
    {type: 'search', materialId: 'one', query: 'needle', maxResults: 33, contextChars: 0},
    {type: 'search', materialId: 'one', query: 'needle', maxResults: 1, contextChars: 1025},
  ]) await assert.rejects(readResearchMaterial(f.reader, request as ResearchReadRequest));
  const result = await readResearchMaterial(f.reader, {type: 'range', materialId: 'one', start: emoji, end: emoji + 2});
  assert.equal(result.ranges[0]!.text, '😀');
  const unavailable = await prepareResearchReader({intake: f.intake, context: f.context, materialIds: ['pdf'], role: 'historical', dataRoot: f.data});
  await assert.rejects(readResearchMaterial(unavailable, {type: 'range', materialId: 'pdf', start: 0, end: 2}), /complete supported/);
});

test('P8-READER-U04 actual archive tamper alias rehashed metadata and accessor host input cannot become readable evidence', async t => {
  const f = await researchReaderFixture(t);
  let getterRan = false;
  const input = {intake: f.intake, get context() {getterRan = true; return f.context;}, materialIds: ['one'], role: 'current' as const, dataRoot: f.data};
  await assert.rejects(prepareResearchReader(input), /accessors/); assert.equal(getterRan, false);
  const original = await readFile(f.reader.path, 'utf8');
  const changed = structuredClone(f.reader); changed.view.sources[0]!.pages[0]!.end--;
  const {digest: _vd, ...view} = changed.view; changed.view.digest = researchDigest(view);
  const {digest: _rd, ...reader} = changed; changed.digest = researchDigest(reader);
  await writeFile(f.reader.path, JSON.stringify(changed)); await assert.rejects(assertResearchReader(changed));
  await writeFile(f.reader.path, original);
  const path = join(f.index.directory, f.index.entries[0]!.text!.path), bytes = await readFile(path);
  await writeFile(path, Buffer.alloc(bytes.length, 120)); await assert.rejects(readResearchMaterial(f.reader, {type: 'range', materialId: 'one', start: 0, end: 2}), /changed/);
  await writeFile(path, bytes); await rename(path, path + '.real'); await symlink(path + '.real', path);
  await assert.rejects(assertResearchReader(f.reader), /alias|snapshot/);
});

test('P8-READER-U05 full response capacity rejects rather than silently truncating and caller mutation freezes before await', async t => {
  const f = await researchReaderFixture(t, {text: '"'.repeat(2000), limits: {pageChars: 16384, maxRangeChars: 16384,
    maxResponseChars: 1024, maxSearchResults: 16, maxQueryChars: 256}});
  await assert.rejects(readResearchMaterial(f.reader, {type: 'range', materialId: 'one', start: 0, end: 1000}), /complete response exceeds/);
  const request: ResearchReadRequest = {type: 'range', materialId: 'one', start: 0, end: 1};
  const work = readResearchMaterial(f.reader, request); request.materialId = 'two';
  const result = await work; assert.equal(result.request.materialId, 'one'); assert.equal(result.ranges[0]!.text, '"');
  assert.equal(await readFile(join(f.index.directory, f.index.entries[0]!.raw!.path), 'utf8'), f.text);
});
