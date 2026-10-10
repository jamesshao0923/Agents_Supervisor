import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import ts from 'typescript';
import { parseManifest, type StageManifest, type SuiteSpec, type TestLayer, type ImplementedStage } from './contracts.js';

export interface CatalogSuite { id: string; layer: TestLayer; file: string; timeoutMs: number }
export interface CatalogCase {
  id: string; name: string; suiteId: string; module: string; layer: TestLayer;
  covers: string[]; scenario: string; impactTags: string[]; prerequisites: string;
  assertions: string; cleanup: string; status: 'active' | 'retired';
  retirement?: { reason: string; replacements: string[]; coverageReview: string };
}
export interface TestCatalog {
  schemaVersion: 1; revision: string;
  modules: { id: string; affects: string[] }[];
  suites: CatalogSuite[]; cases: CatalogCase[];
}
export interface AcceptanceProfile {
  schemaVersion: 2; stage: ImplementedStage; revision: string;
  caseIds: string[]; requiredRisks: string[]; coreRegression: string[];
}
export interface SelectionOptions { layer?: TestLayer; modules?: string[] }
export interface SelectionSnapshot {
  schemaVersion: 1; stage: ImplementedStage; profileRevision: string; catalogRevision: string;
  profileDigest: string; catalogDigest: string; requested: { layer: TestLayer | null; modules: string[] };
  mode: 'stage' | 'partial'; strategy: 'conservative-complete-suite'; reasons: string[];
  globalActiveCaseIds: string[]; profileCaseIds: string[]; selectedCaseIds: string[];
  globalCoveredRisks: string[]; selectedCoveredRisks: string[];
  selected: { id: string; name: string; module: string; layer: TestLayer; covers: string[]; reason: string }[];
  excluded: { id: string; reason: string; status: 'not-selected' }[];
}
export interface ResolvedSelection { manifest: StageManifest; selection: SelectionSnapshot }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, null, 2) + '\n').digest('hex');
function fail(message: string): never { throw new Error(`Invalid test catalog/profile: ${message}`); }
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const token = (v: unknown): v is string => text(v) && /^[a-z][a-z0-9.-]*$/.test(v);
function strings(v: unknown, path: string, allowEmpty = false): string[] {
  if (!Array.isArray(v) || (!allowEmpty && !v.length)) fail(`${path} must be a ${allowEmpty ? '' : 'nonempty '}string array`);
  return Array.from(v).map((item: unknown) => { if (!text(item)) fail(`${path} contains an invalid string`); return item; });
}
function identifier(v: unknown, path: string): string { if (!token(v)) fail(`${path} is an invalid identifier`); return v; }
function revision(v: unknown): string { if (!text(v) || /\s/.test(v)) fail('revision must be nonempty without whitespace'); return v; }
function unique<T>(items: T[], key: (v: T) => string, path: string): void {
  const ids = new Set<string>();
  for (const item of items) { const id = key(item); if (ids.has(id)) fail(`${path} duplicates/conflicts with ID ${id}`); ids.add(id); }
}

export function parseCatalog(value: unknown): TestCatalog {
  if (!object(value) || value.schemaVersion !== 1) fail('catalog schemaVersion must equal 1');
  if (!Array.isArray(value.modules) || !value.modules.length) fail('modules must be nonempty');
  const modules = Array.from(value.modules).map((v: unknown) => {
    if (!object(v)) fail('module must be an object');
    return { id: identifier(v.id, 'module.id'), affects: strings(v.affects, 'module.affects', true) };
  });
  unique(modules, m => m.id, 'modules');
  const moduleIds = new Set(modules.map(m => m.id));
  for (const m of modules) for (const target of m.affects) if (!moduleIds.has(target)) fail(`module ${m.id} references missing impact module ${target}`);
  if (!Array.isArray(value.suites) || !value.suites.length) fail('suites must be nonempty');
  const suites = Array.from(value.suites).map((v: unknown) => {
    if (!object(v)) fail('suite must be an object');
    // Reuse the path, timeout, layer and ID validation of the execution contract.
    const validated = parseManifest({ schemaVersion: 1, stage: 'P0', revision: 'validation', suites: [{ ...v, required: true, expectedTests: ['validation-only'] }] }).suites[0]!;
    return { id: validated.id, layer: validated.layer, file: validated.file, timeoutMs: validated.timeoutMs };
  });
  unique(suites, s => s.id, 'suites');
  unique(suites, s => s.file, 'suite files');
  if (!Array.isArray(value.cases) || !value.cases.length) fail('cases must be nonempty');
  const cases: CatalogCase[] = Array.from(value.cases).map((v: unknown) => {
    if (!object(v)) fail('case must be an object');
    const id = identifier(v.id, 'case.id');
    if (!text(v.name)) fail(`${id}.name must be nonempty`);
    const suiteId = identifier(v.suiteId, `${id}.suiteId`);
    const module = identifier(v.module, `${id}.module`);
    if (!moduleIds.has(module)) fail(`${id} references unregistered module ${module}`);
    const suite = suites.find(s => s.id === suiteId);
    if (!suite || suite.layer !== v.layer) fail(`${id} references missing suite or conflicting layer`);
    if (v.status !== 'active' && v.status !== 'retired') fail(`${id}.status must equal active or retired`);
    for (const key of ['scenario', 'prerequisites', 'assertions', 'cleanup'] as const) if (!text(v[key])) fail(`${id}.${key} must be nonempty`);
    const item: CatalogCase = { id, name: v.name, suiteId, module, layer: suite.layer, covers: strings(v.covers, `${id}.covers`), scenario: v.scenario as string,
      prerequisites: v.prerequisites as string, assertions: v.assertions as string, cleanup: v.cleanup as string, impactTags: strings(v.impactTags, `${id}.impactTags`), status: v.status };
    if (v.status === 'retired') {
      if (!object(v.retirement) || !text(v.retirement.reason) || !text(v.retirement.coverageReview)) fail(`${id} retired without reason and assertion/fault coverage review`);
      item.retirement = { reason: v.retirement.reason, replacements: strings(v.retirement.replacements, `${id}.replacements`, true), coverageReview: v.retirement.coverageReview };
    } else if (v.retirement !== undefined) fail(`${id} active with retirement metadata`);
    return item;
  });
  unique(cases, c => c.id, 'cases');
  unique(cases.filter(c => c.status === 'active'), c => `${c.suiteId}:${c.name}`, 'active suite test names');
  const catalog: TestCatalog = { schemaVersion: 1, revision: revision(value.revision), modules, suites, cases };
  for (const c of cases) if (c.status === 'retired') {
    const replacements = resolveCase(catalog, c.id);
    if (c.retirement!.replacements.length && c.covers.some(risk => !replacements.some(replacement => replacement.covers.includes(risk)))) fail(`${c.id} replacement loses required criterion/risk coverage`);
  }
  for (const suite of suites) if (!cases.some(c => c.suiteId === suite.id && c.status === 'active')) fail(`${suite.id} has no registered active cases`);
  return catalog;
}

export function parseProfile(value: unknown): AcceptanceProfile {
  if (!object(value) || value.schemaVersion !== 2) fail('profile schemaVersion must equal 2');
  if (value.stage !== 'P0' && value.stage !== 'P1' && value.stage !== 'P2' && value.stage !== 'P3') fail('profile stage must equal P0, P1, P2 or P3');
  return { schemaVersion: 2, stage: value.stage, revision: revision(value.revision), caseIds: strings(value.caseIds, 'profile.caseIds'),
    requiredRisks: strings(value.requiredRisks, 'profile.requiredRisks'), coreRegression: strings(value.coreRegression, 'profile.coreRegression', true) };
}

function resolveCase(catalog: TestCatalog, id: string, trail: string[] = []): CatalogCase[] {
  if (trail.includes(id)) fail(`replacement cycle: ${[...trail, id].join(' -> ')}`);
  const item = catalog.cases.find(c => c.id === id);
  if (!item) fail(`reference to unregistered case ${id}`);
  if (item.status === 'active') return [item];
  return item.retirement!.replacements.flatMap(next => resolveCase(catalog, next, [...trail, id]));
}

export function selectCases(catalogInput: unknown, profileInput: unknown, options: SelectionOptions = {}): ResolvedSelection {
  const catalog = parseCatalog(catalogInput), profile = parseProfile(profileInput);
  if (options.layer !== undefined && options.layer !== 'unit' && options.layer !== 'integration' && options.layer !== 'live') fail('selection layer must equal unit, integration or live');
  const requestedModules = options.modules === undefined ? [] : strings(options.modules, 'selection.modules');
  const profileIds = new Set([...profile.caseIds, ...profile.coreRegression].flatMap(id => resolveCase(catalog, id).map(c => c.id)));
  const profileCases = catalog.cases.filter(c => profileIds.has(c.id));
  for (const risk of profile.requiredRisks) if (!profileCases.some(c => c.covers.includes(risk))) fail(`necessary risk ${risk} has no active selected profile coverage`);
  const reasons: string[] = [], impact = new Set(requestedModules);
  const known = new Set([...catalog.modules.map(m => m.id), ...catalog.cases.flatMap(c => c.impactTags)]);
  const unknown = requestedModules.some(m => !known.has(m));
  if (unknown) reasons.push('Unknown impact module/tag; expanded to the full applicable profile');
  for (const item of impact) for (const target of catalog.modules.find(m => m.id === item)?.affects ?? []) impact.add(target);
  const core = new Set(profile.coreRegression.flatMap(id => resolveCase(catalog, id).map(c => c.id)));
  const seed = profileCases.filter(c => (!options.layer || c.layer === options.layer) && (!requestedModules.length || unknown || core.has(c.id) || impact.has(c.module) || c.impactTags.some(tag => impact.has(tag))));
  if (!seed.length) fail('selection is empty; no necessary cases can be frozen');
  const suiteIds = new Set(seed.map(c => c.suiteId));
  // Node runs whole suites. All active cases in a selected suite remain required,
  // including those outside a local impact request. Never filter discovered tests.
  const chosen = catalog.cases.filter(c => c.status === 'active' && suiteIds.has(c.suiteId));
  const chosenIds = new Set(chosen.map(c => c.id)), seedIds = new Set(seed.map(c => c.id));
  reasons.push('Selected cases conservatively expanded to complete suites; stable IDs and suite files deduplicated');
  const suites: SuiteSpec[] = catalog.suites.filter(s => suiteIds.has(s.id)).map(s => ({ ...s, required: true, expectedTests: chosen.filter(c => c.suiteId === s.id).map(c => c.name) }));
  const selection: SelectionSnapshot = { schemaVersion: 1, stage: profile.stage, profileRevision: profile.revision, catalogRevision: catalog.revision,
    profileDigest: digest(profile), catalogDigest: digest(catalog), requested: { layer: options.layer ?? null, modules: requestedModules },
    mode: options.layer || requestedModules.length ? 'partial' : 'stage', strategy: 'conservative-complete-suite', reasons,
    globalActiveCaseIds: catalog.cases.filter(c => c.status === 'active').map(c => c.id), profileCaseIds: [...profileIds], selectedCaseIds: chosen.map(c => c.id),
    globalCoveredRisks: [...new Set(catalog.cases.filter(c => c.status === 'active').flatMap(c => c.covers))], selectedCoveredRisks: [...new Set(chosen.flatMap(c => c.covers))],
    selected: chosen.map(c => ({ id: c.id, name: c.name, module: c.module, layer: c.layer, covers: [...c.covers], reason: seedIds.has(c.id) ? 'Applicable profile / requested layer and impact / core regression' : 'Expanded to complete selected suite' })),
    excluded: catalog.cases.filter(c => c.status === 'active' && !chosenIds.has(c.id)).map(c => ({ id: c.id, status: 'not-selected', reason: profileIds.has(c.id) ? 'Outside requested layer or known impact scope; this run provides no pass evidence' : 'Outside this stage profile; this run provides no pass evidence' })) };
  return { manifest: parseManifest({ schemaVersion: 1, stage: profile.stage, revision: profile.revision, suites }), selection };
}

async function sourceFile(root: string, path: string): Promise<string> {
  const full = join(root, path), canonical = await realpath(full), rel = relative(await realpath(root), canonical);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || (await lstat(full)).isSymbolicLink() || !(await lstat(canonical)).isFile()) fail(`unsafe registered test source ${path}`);
  return readFile(canonical, 'utf8');
}

export async function validateRegisteredSources(root: string, catalog: TestCatalog): Promise<void> {
  const registeredFiles = new Set(catalog.suites.map(s => s.file.replace(/^dist\//, '').replace(/\.js$/, '.ts')));
  async function walk(path: string): Promise<void> {
    const entries = await readdir(join(root, path), { withFileTypes: true });
    for (const entry of entries) {
      const name = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(`test source symlink ${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && entry.name.endsWith('.test.ts') && !registeredFiles.has(name)) fail(`test suite source lacks registration: ${name}`);
    }
  }
  for (const layer of ['unit', 'integration', 'live']) {
    try { await walk(`tests/${layer}`); }
    catch (error) {
      // Historical P0/P1 fixtures may have no live directory. A registered live
      // source is still mandatory and checked individually below.
      if (layer !== 'live' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const suite of catalog.suites) {
    const path = suite.file.replace(/^dist\//, '').replace(/\.js$/, '.ts');
    const source = ts.createSourceFile(path, await sourceFile(root, path), ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    // Inspect explicit top-level declarations only, without executing test code or
    // using discovery to reconstruct the required list. Fixture strings are inert.
    for (const statement of source.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
      const call = statement.expression, target = call.expression;
      if (!(ts.isIdentifier(target) && target.text === 'test') && !(ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'test')) continue;
      const arg = call.arguments[0];
      if (!arg || (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg))) fail(`${path} requires an explicit stable test name`);
      names.push(arg.text);
    }
    const expected = catalog.cases.filter(c => c.suiteId === suite.id && c.status === 'active').map(c => c.name);
    unique(names, n => n, `${path} declarations`);
    if (names.length !== expected.length || names.some(name => !expected.includes(name)) || expected.some(name => !names.includes(name))) fail(`${path} registration/declaration mismatch (missing or stale case registration)`);
  }
}

export async function loadSelection(root: string, stage: ImplementedStage, options: SelectionOptions = {}): Promise<ResolvedSelection> {
  const values = await Promise.all([readFile(join(root, 'tests/catalog/current.json'), 'utf8'), readFile(join(root, `tests/acceptance/${stage.toLowerCase()}.json`), 'utf8')]);
  const catalog = parseCatalog(JSON.parse(values[0]!)), profile = parseProfile(JSON.parse(values[1]!));
  if (profile.stage !== stage) fail('profile file does not match requested stage');
  await validateRegisteredSources(root, catalog);
  return selectCases(catalog, profile, options);
}

export async function loadLegacyManifest(root: string, stage: ImplementedStage, revisionValue: string): Promise<StageManifest> {
  // Immutable original P0 snapshot remains format-compatible. Isolated runner
  // fixtures may still supply a schema1 profile at the original location.
  const current = JSON.parse(await readFile(join(root, `tests/acceptance/${stage.toLowerCase()}.json`), 'utf8')) as unknown;
  if (object(current) && current.schemaVersion === 1) return parseManifest(current);
  if (stage === 'P0' && revisionValue === 'p0-v1') return parseManifest(JSON.parse(await readFile(join(root, 'tests/acceptance/history/p0-v1.json'), 'utf8')));
  fail('legacy manifest has no matching preserved snapshot; use a new catalog freeze');
}
