import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCatalog, parseProfile, selectCases, loadSelection, validateRegisteredSources, loadLegacyManifest, type TestCatalog, type AcceptanceProfile } from '../../tools/p0/catalog.js';
import { checkRun, runStage } from '../../tools/p0/runner.js';
import { parseManifest } from '../../tools/p0/contracts.js';

function catalog(): TestCatalog {
  return { schemaVersion: 1, revision: 'fixture-v1', modules: [{ id: 'shared', affects: ['domain'] }, { id: 'domain', affects: ['persistence'] }, { id: 'persistence', affects: [] }],
    suites: [{ id: 'unit-fixture', layer: 'unit', file: 'dist/tests/unit/fixture.test.js', timeoutMs: 10_000 }, { id: 'integration-fixture', layer: 'integration', file: 'dist/tests/integration/fixture.test.js', timeoutMs: 10_000 }],
    cases: [
      { id: 'dev.fixture.a', name: 'fixture domain invariant', suiteId: 'unit-fixture', module: 'domain', layer: 'unit', covers: ['domain-validity'], scenario: 'fixed domain input', impactTags: ['contracts'], prerequisites: 'Node runtime', assertions: 'test source', cleanup: 'no external writes', status: 'active' },
      { id: 'dev.fixture.b', name: 'fixture shared invariant', suiteId: 'unit-fixture', module: 'shared', layer: 'unit', covers: ['shared-validity'], scenario: 'shared boundary', impactTags: ['toolchain'], prerequisites: 'Node runtime', assertions: 'test source', cleanup: 'no external writes', status: 'active' },
      { id: 'dev.fixture.c', name: 'fixture persistence invariant', suiteId: 'integration-fixture', module: 'persistence', layer: 'integration', covers: ['storage-validity'], scenario: 'real filesystem input', impactTags: ['database'], prerequisites: 'writable isolated root', assertions: 'test source', cleanup: 'remove isolated root', status: 'active' },
    ] };
}
function profile(): AcceptanceProfile { return { schemaVersion: 2, stage: 'P1', revision: 'fixture-p1-v1', caseIds: catalog().cases.map(c => c.id), requiredRisks: ['domain-validity', 'shared-validity', 'storage-validity'], coreRegression: [] }; }
async function fixture(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-catalog-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['tests/unit', 'tests/integration', 'tests/catalog', 'tests/acceptance', 'dist/tests/unit', 'dist/tests/integration']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const value = catalog();
  for (const suite of value.suites) {
    const source = "import test from 'node:test';\n" + value.cases.filter(c => c.suiteId === suite.id).map(c => `test(${JSON.stringify(c.name)}, () => {});\n`).join('');
    await writeFile(join(root, suite.file), source);
    await writeFile(join(root, suite.file.replace(/^dist\//, '').replace(/\.js$/, '.ts')), source);
  }
  await writeFile(join(root, 'tests/catalog/current.json'), JSON.stringify(value));
  await writeFile(join(root, 'tests/acceptance/p1.json'), JSON.stringify(profile()));
  return root;
}

test('catalog registers stable IDs and validates execution metadata without sharing product code', () => {
  const input = catalog(), parsed = parseCatalog(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed.cases, input.cases);
  assert.notEqual(parsed.cases[0]!.covers, input.cases[0]!.covers);
  assert.equal(parseManifest({ schemaVersion: 1, stage: 'P1', revision: 'p1-v1', suites: [{ ...input.suites[0], required: true, expectedTests: ['stable'] }] }).stage, 'P1');
});

test('catalog rejects missing malformed empty and conflicting stable registrations', () => {
  for (const value of [null, {}, { ...catalog(), schemaVersion: 2 }, { ...catalog(), cases: [] }, { ...catalog(), cases: [null] }]) assert.throws(() => parseCatalog(value));
  const input = catalog(); input.cases.push({ ...input.cases[0]!, name: 'conflicting behavior' });
  assert.throws(() => parseCatalog(input), /duplicates\/conflicts.*ID/);
  for (const key of ['scenario', 'assertions', 'prerequisites', 'cleanup', 'name', 'module', 'id'] as const) assert.throws(() => parseCatalog({ ...catalog(), cases: [{ ...catalog().cases[0], [key]: '' }] }));
});

test('catalog rejects unsafe suite files duplicate files and conflicting layers or modules', () => {
  for (const file of ['dist/tests/../bad.js', '/dist/tests/bad.js', 'dist\\tests\\bad.js', 'dist/tests/%2e.js']) assert.throws(() => parseCatalog({ ...catalog(), suites: [{ ...catalog().suites[0], file }] }), /file/);
  const input = catalog(); input.suites[1]!.file = input.suites[0]!.file;
  assert.throws(() => parseCatalog(input), /suite files/);
  for (const update of [{ suiteId: 'missing' }, { layer: 'integration' }, { module: 'missing' }]) assert.throws(() => parseCatalog({ ...catalog(), cases: [{ ...catalog().cases[0], ...update }] }));
  input.modules[0]!.affects = ['missing']; assert.throws(() => parseCatalog(input), /missing impact module/);
});

test('catalog rejects duplicate active names but permits equal names in separate suites', () => {
  const input = catalog(); input.cases[1]!.name = input.cases[0]!.name;
  assert.throws(() => parseCatalog(input), /active suite test names/);
  input.cases[1]!.name = catalog().cases[1]!.name; input.cases[2]!.name = input.cases[0]!.name;
  assert.equal(parseCatalog(input).cases.length, 3);
});

test('catalog rejects retirement without reason and assertion fault coverage review', () => {
  const input = catalog(); input.cases.push({ ...input.cases[0]!, id: 'dev.fixture.old', status: 'retired' });
  assert.throws(() => parseCatalog(input), /retired without reason/);
  input.cases.at(-1)!.retirement = { reason: 'equivalent replacement', replacements: ['dev.fixture.a'], coverageReview: '' };
  assert.throws(() => parseCatalog(input), /coverage review/);
});

test('catalog resolves reviewed replacement chains and preserves every necessary risk', () => {
  const input = catalog();
  input.cases.push({ ...input.cases[0]!, id: 'dev.fixture.old', status: 'retired', retirement: { reason: 'equivalent assertions retained', replacements: ['dev.fixture.a'], coverageReview: 'Same fixed input, expected invariant and invalid-input failure retained by a' } });
  const config = profile(); config.caseIds = ['dev.fixture.old', 'dev.fixture.b', 'dev.fixture.c'];
  const selected = selectCases(input, config);
  assert.equal(selected.selection.selectedCaseIds.includes('dev.fixture.old'), false);
  assert.equal(selected.selection.selectedCaseIds.includes('dev.fixture.a'), true);
  input.cases.at(-1)!.retirement!.replacements = ['dev.fixture.b'];
  assert.throws(() => parseCatalog(input), /replacement loses/);
});

test('catalog rejects dangling replacement references and replacement cycles', () => {
  const input = catalog();
  const old = { ...input.cases[0]!, id: 'dev.fixture.old', status: 'retired' as const, retirement: { reason: 'replacement', replacements: ['missing'], coverageReview: 'Input and fault coverage reviewed' } };
  input.cases.push(old); assert.throws(() => parseCatalog(input), /unregistered case/);
  old.retirement.replacements = [old.id]; assert.throws(() => parseCatalog(input), /replacement cycle/);
  old.retirement.replacements = ['dev.fixture.older'];
  input.cases.push({ ...old, id: 'dev.fixture.older', retirement: { ...old.retirement, replacements: [old.id] } });
  assert.throws(() => parseCatalog(input), /replacement cycle/);
});

test('catalog permits explained removed scope but refuses loss of necessary profile coverage', () => {
  const input = catalog();
  input.cases.push({ ...input.cases[0]!, id: 'dev.fixture.removed', covers: ['removed-risk'], status: 'retired', retirement: { reason: 'Supported capability formally removed', replacements: [], coverageReview: 'No replacement; capability removed from applicable profile' } });
  assert.equal(parseCatalog(input).cases.length, 4);
  const config = profile(); config.caseIds.push('dev.fixture.removed'); config.requiredRisks.push('removed-risk');
  assert.throws(() => selectCases(input, config), /necessary risk removed-risk/);
});

test('profiles reject unknown stages stale references empty selection and uncovered necessary risks', () => {
  assert.throws(() => parseProfile({ ...profile(), stage: 'P9' }), /stage/);
  for (const key of ['caseIds', 'requiredRisks'] as const) assert.throws(() => parseProfile({ ...profile(), [key]: [] }));
  assert.throws(() => selectCases(catalog(), { ...profile(), caseIds: ['missing'] }), /unregistered case/);
  assert.throws(() => selectCases(catalog(), { ...profile(), requiredRisks: ['missing-risk'] }), /necessary risk/);
  assert.throws(() => selectCases(catalog(), { ...profile(), caseIds: ['dev.fixture.a', 'dev.fixture.b'], requiredRisks: ['domain-validity'] }, { layer: 'integration' }), /selection is empty/);
});

test('profiles deduplicate repeated stable IDs across stage requirements and core regressions', () => {
  const config = profile(); config.caseIds.push('dev.fixture.a'); config.coreRegression.push('dev.fixture.a', 'dev.fixture.a');
  const plan = selectCases(catalog(), config);
  assert.equal(plan.selection.selectedCaseIds.length, 3);
  assert.equal(plan.selection.profileCaseIds.length, 3);
  assert.equal(plan.manifest.suites.length, 2);
  assert.equal(plan.manifest.suites[0]!.expectedTests.length, 2);
});

test('impact selection expands transitive modules and conservatively deduplicates full suites', () => {
  const plan = selectCases(catalog(), profile(), { modules: ['shared'] });
  assert.equal(plan.selection.selectedCaseIds.length, 3);
  const narrow = selectCases(catalog(), profile(), { modules: ['contracts'], layer: 'unit' });
  assert.deepEqual(narrow.selection.selectedCaseIds, ['dev.fixture.a', 'dev.fixture.b']);
  assert.match(narrow.selection.selected.find(c => c.id === 'dev.fixture.b')!.reason, /Expanded/);
  assert.equal(narrow.manifest.suites.length, 1);
  assert.equal(narrow.selection.excluded[0]!.status, 'not-selected');
  assert.match(narrow.selection.excluded[0]!.reason, /no pass evidence/);
});

test('impact selection broadens unknown impact and retains necessary core regressions', () => {
  const unknown = selectCases(catalog(), profile(), { modules: ['uncertain-change'] });
  assert.equal(unknown.selection.selectedCaseIds.length, 3); assert.match(unknown.selection.reasons.join(' '), /Unknown impact/);
  const config = profile(); config.coreRegression = ['dev.fixture.c'];
  assert.equal(selectCases(catalog(), config, { modules: ['contracts'] }).selection.selectedCaseIds.length, 3);
});

test('layer and impact selections never claim stage completion even when all suites expand', () => {
  const plan = selectCases(catalog(), profile(), { modules: ['shared'] });
  assert.equal(plan.selection.mode, 'partial');
  assert.equal(selectCases(catalog(), profile(), { layer: 'unit' }).selection.mode, 'partial');
  assert.equal(selectCases(catalog(), profile()).selection.mode, 'stage');
  for(const stage of ['P6','P7','P8'] as const) assert.equal(selectCases(catalog(), {...profile(),stage,gateStatus:'developing'}).selection.mode,'partial');
  assert.throws(()=>parseProfile({...profile(),gateStatus:'unknown'}),/gateStatus/);
  assert.throws(() => selectCases(catalog(), profile(), { modules: [''] }), /invalid string/);
});

test('catalog validates actual registered source declarations without reconstructing expected lists', async context => {
  const root = await fixture(context), plan = await loadSelection(root, 'P1');
  assert.equal(plan.selection.selectedCaseIds.length, 3);
  await writeFile(join(root, 'tests/unit/fixture.test.ts'), "import test from 'node:test'; test('undeclared registration', () => {});\n");
  await assert.rejects(loadSelection(root, 'P1'), /registration\/declaration mismatch/);
});

test('catalog rejects missing registered sources and unregistered real suite files before freeze', async context => {
  const root = await fixture(context);
  await rm(join(root, 'tests/unit/fixture.test.ts'));
  await assert.rejects(validateRegisteredSources(root, catalog()), /ENOENT/);
  await writeFile(join(root, 'tests/unit/unregistered.test.ts'), "import test from 'node:test'; test('new behavior', () => {});\n");
  await assert.rejects(loadSelection(root, 'P1'), /lacks registration/);
});

test('catalog rejects real source symlinks and wrong profile stage bindings', async context => {
  const root = await fixture(context), source = join(root, 'tests/unit/fixture.test.ts');
  await rm(source); await symlink(join(root, 'dist/tests/unit/fixture.test.js'), source);
  await assert.rejects(loadSelection(root, 'P1'), /symlink/);
  await writeFile(join(root, 'tests/acceptance/p1.json'), JSON.stringify({ ...profile(), stage: 'P0' }));
  await assert.rejects(loadSelection(root, 'P1'), /does not match requested stage/);
});

test('catalog preserves immutable legacy manifest parsing alongside current profiles', async context => {
  const root = await fixture(context);
  const old = parseManifest({ schemaVersion: 1, stage: 'P0', revision: 'p0-v1', suites: [{ ...catalog().suites[0], required: true, expectedTests: ['old stable name'] }] });
  await writeFile(join(root, 'tests/acceptance/p0.json'), JSON.stringify({ ...profile(), stage: 'P0' }));
  await mkdir(join(root, 'tests/acceptance/history'));
  await writeFile(join(root, 'tests/acceptance/history/p0-v1.json'), JSON.stringify(old));
  assert.deepEqual(await loadLegacyManifest(root, 'P0', 'p0-v1'), old);
  await assert.rejects(loadLegacyManifest(root, 'P0', 'missing-revision'), /no matching preserved snapshot/);
});

test('catalog recheck resolves current frozen profile and rejects changed standards without overwriting evidence', async context => {
  const root = await fixture(context), plan = await loadSelection(root, 'P1', { layer: 'unit' });
  const run = await runStage(root, plan.manifest, { reason: 'catalog real freeze self-check', selection: plan.selection });
  assert.equal(run.result.passed, true, JSON.stringify(run.result)); assert.equal(run.result.stagePassed, false);
  assert.equal((await checkRun(root, run.dir)).passed, true);
  const original = await readFile(join(run.dir, 'results.json'));
  await writeFile(join(root, 'tests/acceptance/p1.json'), JSON.stringify({ ...profile(), revision: 'fixture-p1-v2' }));
  const result = await checkRun(root, run.dir);
  assert.equal(result.passed, false); assert.match(result.issues.join(' '), /current catalog\/profile|current required manifest|Candidate changed/);
  assert.deepEqual(await readFile(join(run.dir, 'results.json')), original);
});

test('catalog recheck rejects forged final stage scope and missing current registry', async context => {
  const root = await fixture(context), plan = await loadSelection(root, 'P1', { modules: ['shared'] });
  await assert.rejects(runStage(root, plan.manifest, {reason:'Missing catalog selection must not manufacture stage success'}), /legacy manifest/);
  const run = await runStage(root, plan.manifest, { reason: 'catalog partial scope self-check', selection: plan.selection });
  assert.equal(run.result.passed, true); assert.equal(run.result.scope, 'partial'); assert.equal(run.result.stagePassed, false);
  const finalPath = join(run.dir, 'manifest.json'), metadata = JSON.parse(await readFile(finalPath, 'utf8'));
  metadata.scope = 'stage'; await writeFile(finalPath, JSON.stringify(metadata));
  const changed = await checkRun(root, run.dir);
  assert.equal(changed.passed, false); assert.match(changed.issues.join(' '), /frozen input|Partial selection/);
  await rm(join(root, 'tests/catalog/current.json'));
  assert.equal((await checkRun(root, run.dir)).passed, false);
});

test('catalog freezes live layer metadata and rechecks partial scope without stage completion', async context => {
  const root = await fixture(context), value = catalog();
  value.suites.push({ id: 'live-fixture', layer: 'live', file: 'dist/tests/live/fixture.test.js', timeoutMs: 30_000 });
  value.cases.push({ ...value.cases[2]!, id: 'dev.fixture.live', name: 'actual runner live layer transport', suiteId: 'live-fixture', layer: 'live', covers: ['live-metadata'] });
  const config: AcceptanceProfile = { ...profile(), stage: 'P2', revision: 'fixture-p2-v1', caseIds: value.cases.map(c => c.id), requiredRisks: [...profile().requiredRisks, 'live-metadata'] };
  for (const path of ['tests/live', 'dist/tests/live']) await mkdir(join(root, path), { recursive: true });
  // This real Node suite verifies runner metadata only; it is not provider-live evidence.
  const source = "import test from 'node:test'; test('actual runner live layer transport', () => {});\n";
  await writeFile(join(root, 'tests/live/fixture.test.ts'), source);
  await writeFile(join(root, 'dist/tests/live/fixture.test.js'), source);
  await writeFile(join(root, 'tests/catalog/current.json'), JSON.stringify(value));
  await writeFile(join(root, 'tests/acceptance/p2.json'), JSON.stringify(config));
  const full = await loadSelection(root, 'P2');
  assert.equal(full.selection.mode, 'stage'); assert.equal(full.manifest.suites.at(-1)!.layer, 'live');
  const plan = await loadSelection(root, 'P2', { layer: 'live' });
  assert.equal(plan.selection.mode, 'partial'); assert.deepEqual(plan.selection.selectedCaseIds, ['dev.fixture.live']);
  const run = await runStage(root, plan.manifest, { reason: 'live metadata frozen runner self-check', selection: plan.selection });
  assert.equal(run.result.passed, true, JSON.stringify(run.result)); assert.equal(run.result.scope, 'live'); assert.equal(run.result.stagePassed, false);
  assert.equal((await checkRun(root, run.dir)).passed, true);
  await writeFile(join(root, 'tests/live/unregistered.test.ts'), "import test from 'node:test'; test('unregistered live metadata', () => {});\n");
  await assert.rejects(loadSelection(root, 'P2'), /lacks registration/);
  await rm(join(root, 'tests/live/unregistered.test.ts'));
  await rm(join(root, 'tests/live/fixture.test.ts'));
  await assert.rejects(loadSelection(root, 'P2'), /ENOENT/);
});
