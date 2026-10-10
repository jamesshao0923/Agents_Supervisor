import {parseMobileVerifier,type MobileVerifier} from './p4-mobile.js';
import {parseFullstackVerifier, type FullstackVerifier} from './p4-fullstack.js';
import {parseMaterialVerifier,type MaterialVerifier,type MaterialVerifierBinding} from './p4-material.js';
import type { TaskContract } from './p1.js';

export type VerificationVerdict = 'passed' | 'failed' | 'unknown' | 'not-applicable';
export type VerificationExecutionStatus = 'executed' | 'environment-blocked' | 'verifier-error' | 'not-run';
export interface VerificationObligation {
  id: string; criterionId: string; expectation: string; required: boolean; applicable: boolean; notApplicableReason?: string;
}
export interface TypeScriptBuild { kind: 'typescript'; sources: string[]; rootDir: string; outputDir: string; timeoutMs: number }
export interface CommandVerifier { kind: 'command'; version: string; entry: string; files: string[]; timeoutMs: number; build?: TypeScriptBuild; candidateEntries?: string[] }
export type UiStep = { kind: 'click'; selector: string } | { kind: 'fill'; selector: string; value: string }
  | { kind: 'assertText'; selector: string; text: string } | { kind: 'assertVisible'; selector: string };
export interface UiVerifier { kind: 'ui'; version: string; entry: string; steps: UiStep[]; expectations: string[]; timeoutMs: number }
export interface SourceVerifier { binding?:MaterialVerifierBinding; kind: 'source'; version: string; claimFile: string; sources: { id: string; url: string; excerpt: string; maxAgeMs: number }[]; timeoutMs: number }
export type Verifier = CommandVerifier | UiVerifier | SourceVerifier | MobileVerifier | FullstackVerifier | MaterialVerifier;
export interface VerificationSpecCase {
  id: string; revision: number; obligationIds: string[]; parameters: Record<string, string>[]; modules: string[];
  replaces: string[]; defectRefs: string[]; status?: 'active' | 'retired'; verifier: Verifier;
}
export interface VerificationControl { id: string; workspace: string; expect: 'passed' | 'failed'; mustFail: string[] }
export interface VerificationSpec {
  schemaVersion: 1; contractVersion: number; standardsVersion: string; obligations: VerificationObligation[];
  cases: VerificationSpecCase[]; controls: VerificationControl[]; moduleDependencies: Record<string, string[]>;
}
export interface VerificationInstance { id: string; caseId: string; revision: number; parameters: Record<string, string>; obligationIds: string[]; required: boolean }
export interface VerificationSelection { mode: 'final' | 'impact'; instances: VerificationInstance[]; completeScope: boolean; excludedCaseIds: string[] }
export interface VerificationCheck { obligationId: string; verdict: VerificationVerdict; reason: string }
export interface VerificationResult { instanceId: string; executionStatus: VerificationExecutionStatus; checks: VerificationCheck[]; reason: string; proofFiles?: string[] }
export interface VerificationEvaluation { passed: boolean; complete: boolean; reasons: string[]; obligations: { id: string; satisfied: boolean; reasons: string[] }[] }
export type VerificationContract = Pick<TaskContract, 'version' | 'criteria'>;

type Shape = Record<string, unknown>;
function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
function object(value: unknown, path: string, keys?: string[], optional: string[] = []): Shape {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be a plain object');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !('value' in descriptor) || !descriptor.enumerable) fail(path, 'accessors symbols and hidden fields are forbidden');
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(path, 'unsafe object key');
    if (keys && !keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
  }
  if (keys) for (const key of keys) if (!optional.includes(key) && !Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required field');
  return value as Shape;
}
function string(value: unknown, path: string, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') || value.length > 200_000) fail(path, 'invalid string');
}
function integer(value: unknown, path: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(path, 'invalid integer');
}
function array(value: unknown, path: string, check: (v: unknown, p: string) => void, minimum = 0): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 10_000) fail(path, 'invalid array');
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || !('value' in d) || !d.enumerable) fail(path, 'nonplain array fields');
  }
  for (let i = 0; i < value.length; i++) { if (!Object.hasOwn(value, i)) fail(path, 'sparse array'); check(value[i], `${path}[${i}]`); }
}
function strings(value: unknown, path: string, minimum = 0) {
  array(value, path, string, minimum); if (new Set(value).size !== value.length) fail(path, 'duplicate value');
}
function choice(value: unknown, path: string, choices: string[]) { if (typeof value !== 'string' || !choices.includes(value)) fail(path, 'invalid choice'); }
function relative(value: unknown, path: string) {
  string(value, path); if (value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..') || /[?#]/.test(value)) fail(path, 'must be a normalized relative path');
}
function parameters(value: unknown, path: string) { const o = object(value, path); for (const [key, v] of Object.entries(o)) { string(key, path); string(v, `${path}.${key}`, true); } }
function verifier(value: unknown, path: string) {
  const kind = object(value, path).kind;
  if (kind === 'command') {
    const o = object(value, path, ['kind', 'version', 'entry', 'files', 'timeoutMs', 'build', 'candidateEntries'], ['build', 'candidateEntries']); relative(o.entry, `${path}.entry`); array(o.files, `${path}.files`, relative, 1);
    if (new Set(o.files as string[]).size !== (o.files as string[]).length || !(o.files as string[]).includes(o.entry as string)) fail(path, 'command files must contain the entry exactly once');
    string(o.version, `${path}.version`); integer(o.timeoutMs, `${path}.timeoutMs`, 1, 3_600_000);
    if (Object.hasOwn(o, 'candidateEntries')) {
      array(o.candidateEntries, `${path}.candidateEntries`, (entry, p) => { relative(entry, p); if (!/\.(js|mjs|cjs)$/.test(entry as string) || (entry as string).length > 1024) fail(p, 'candidate entry must be a bounded Node JavaScript file'); }, 1);
      if ((o.candidateEntries as string[]).length > 8 || new Set(o.candidateEntries as string[]).size !== (o.candidateEntries as string[]).length) fail(`${path}.candidateEntries`, 'candidate entries need at most eight distinct files');
    }
    if (Object.hasOwn(o, 'build')) {
      const build = object(o.build, `${path}.build`, ['kind', 'sources', 'rootDir', 'outputDir', 'timeoutMs']);
      choice(build.kind, `${path}.build.kind`, ['typescript']);
      array(build.sources, `${path}.build.sources`, relative, 1);
      if (new Set(build.sources as string[]).size !== (build.sources as string[]).length) fail(`${path}.build.sources`, 'duplicate source');
      string(build.rootDir, `${path}.build.rootDir`); if (build.rootDir !== '.') relative(build.rootDir, `${path}.build.rootDir`);
      relative(build.outputDir, `${path}.build.outputDir`); integer(build.timeoutMs, `${path}.build.timeoutMs`, 1, 3_600_000);
    }
  } else if (kind === 'ui') {
    const o = object(value, path, ['kind', 'version', 'entry', 'steps', 'expectations', 'timeoutMs']); relative(o.entry, `${path}.entry`); string(o.version, `${path}.version`); integer(o.timeoutMs, `${path}.timeoutMs`, 1, 3_600_000); strings(o.expectations, `${path}.expectations`, 1);
    array(o.steps, `${path}.steps`, (v, p) => {
      const kind = object(v, p).kind; choice(kind, `${p}.kind`, ['click', 'fill', 'assertText', 'assertVisible']);
      const keys = kind === 'fill' ? ['kind', 'selector', 'value'] : kind === 'assertText' ? ['kind', 'selector', 'text'] : ['kind', 'selector'];
      const step = object(v, p, keys); string(step.selector, `${p}.selector`); if (kind === 'fill') string(step.value, `${p}.value`, true); if (kind === 'assertText') string(step.text, `${p}.text`);
    }, 1);
  } else if (kind === 'mobile') {
    parseMobileVerifier(value);
  } else if (kind === 'fullstack') {
    parseFullstackVerifier(value, input => { verifier(input, path + '.ui'); if ((input as UiVerifier).kind !== 'ui') fail(path, 'nested UI verifier required'); return input as UiVerifier; });
  } else if (kind === 'material') { parseMaterialVerifier(value);
  } else if (kind === 'source') {
    const o = object(value, path, ['kind', 'version', 'claimFile', 'sources', 'timeoutMs','binding'],['binding']);if(Object.hasOwn(o,'binding'))parseMaterialVerifier({kind:'material',version:o.version,claimFile:o.claimFile,binding:o.binding,timeoutMs:o.timeoutMs}); relative(o.claimFile, `${path}.claimFile`); string(o.version, `${path}.version`); integer(o.timeoutMs, `${path}.timeoutMs`, 1, 3_600_000);
    array(o.sources, `${path}.sources`, (v, p) => {
      const source = object(v, p, ['id', 'url', 'excerpt', 'maxAgeMs']); string(source.id, `${p}.id`); string(source.url, `${p}.url`); string(source.excerpt, `${p}.excerpt`); integer(source.maxAgeMs, `${p}.maxAgeMs`);
      let url: URL; try { url = new URL(source.url); } catch { fail(p, 'invalid source URL'); }
      if (url!.protocol !== 'https:' || url!.username || url!.password || url!.hash) fail(p, 'source needs HTTPS without credentials or fragment');
    }, 1);
    const ids = (o.sources as { id: string }[]).map(s => s.id); if (new Set(ids).size !== ids.length) fail(path, 'duplicate source id');
  } else fail(path, 'unknown verifier kind');
}
export function parseVerificationSpec(value: unknown): VerificationSpec {
  const o = object(value, 'spec', ['schemaVersion', 'contractVersion', 'standardsVersion', 'obligations', 'cases', 'controls', 'moduleDependencies']);
  if (o.schemaVersion !== 1) fail('spec.schemaVersion', 'unsupported version'); integer(o.contractVersion, 'spec.contractVersion'); string(o.standardsVersion, 'spec.standardsVersion');
  array(o.obligations, 'spec.obligations', (v, p) => {
    const item = object(v, p, ['id', 'criterionId', 'expectation', 'required', 'applicable', 'notApplicableReason'], ['notApplicableReason']);
    for (const key of ['id', 'criterionId', 'expectation']) string(item[key], `${p}.${key}`);
    for (const key of ['required', 'applicable']) if (typeof item[key] !== 'boolean') fail(`${p}.${key}`, 'must be boolean');
    if (Object.hasOwn(item, 'notApplicableReason')) string(item.notApplicableReason, `${p}.notApplicableReason`);
    if (item.applicable === false && !Object.hasOwn(item, 'notApplicableReason')) fail(p, 'not applicable requires a frozen reason');
    if (item.applicable === true && Object.hasOwn(item, 'notApplicableReason')) fail(p, 'applicable obligation cannot carry a not-applicable reason');
  }, 1);
  const obligationIds = new Set((o.obligations as VerificationObligation[]).map(v => v.id)); if (obligationIds.size !== (o.obligations as unknown[]).length) fail('spec.obligations', 'duplicate id');
  array(o.cases, 'spec.cases', (v, p) => {
    const c = object(v, p, ['id', 'revision', 'obligationIds', 'parameters', 'modules', 'replaces', 'defectRefs', 'status', 'verifier'], ['status']); string(c.id, `${p}.id`); integer(c.revision, `${p}.revision`);
    strings(c.obligationIds, `${p}.obligationIds`, 1); if((c.verifier as {kind?:unknown})?.kind==='material'&&(c.obligationIds as unknown[]).length!==1)fail(p,'Native material cases require exactly one obligation for independently attributable semantic controls'); for (const id of c.obligationIds as string[]) if (!obligationIds.has(id)) fail(p, 'unknown obligation');
    array(c.parameters, `${p}.parameters`, parameters, 1); for (const key of ['modules', 'replaces', 'defectRefs']) strings(c[key], `${p}.${key}`);
    if (Object.hasOwn(c, 'status')) choice(c.status, `${p}.status`, ['active', 'retired']); if ((c.replaces as string[]).includes(c.id as string)) fail(p, 'case cannot replace itself'); verifier(c.verifier, `${p}.verifier`);if((c.verifier as Verifier).kind==='mobile'&&(c.obligationIds as string[]).length!==1)fail(p,'mobile case requires exactly one obligation for sound failure attribution');if((c.verifier as Verifier).kind==='fullstack'&&(c.obligationIds as string[]).length!==1)fail(p,'fullstack case requires exactly one obligation for sound failure attribution');
  }, 1);
  const revisions = (o.cases as VerificationSpecCase[]).map(c => `${c.id}:${c.revision}`); if (new Set(revisions).size !== revisions.length) fail('spec.cases', 'duplicate case revision');
  array(o.controls, 'spec.controls', (v, p) => {
    const c = object(v, p, ['id', 'workspace', 'expect', 'mustFail']); string(c.id, `${p}.id`); string(c.workspace, `${p}.workspace`); if (!(c.workspace as string).startsWith('/') || (c.workspace as string).split('/').some(p => p === '..' || p === '.')) fail(p, 'control workspace must be absolute and normalized');
    choice(c.expect, `${p}.expect`, ['passed', 'failed']); strings(c.mustFail, `${p}.mustFail`); for (const id of c.mustFail as string[]) if (!obligationIds.has(id)) fail(p, 'unknown control obligation');
    if (c.expect === 'passed' && (c.mustFail as unknown[]).length) fail(p, 'passing control cannot require failures'); if (c.expect === 'failed' && !(c.mustFail as unknown[]).length) fail(p, 'failing control needs an explicit obligation');
  }, 2);
  const controls = o.controls as VerificationControl[]; if (new Set(controls.map(c => c.id)).size !== controls.length) fail('spec.controls', 'duplicate control id'); if (!controls.some(c => c.expect === 'passed') || !controls.some(c => c.expect === 'failed')) fail('spec.controls', 'both good and bad controls are required');
  const graph = object(o.moduleDependencies, 'spec.moduleDependencies'); for (const [key, deps] of Object.entries(graph)) { string(key, 'module key'); strings(deps, `spec.moduleDependencies.${key}`); if ((deps as string[]).includes(key)) fail('spec.moduleDependencies', 'self dependency'); }
  const modules = new Set([...(o.cases as VerificationSpecCase[]).flatMap(c => c.modules), ...Object.keys(graph)]); for (const deps of Object.values(graph) as string[][]) for (const dep of deps) if (!modules.has(dep)) fail('spec.moduleDependencies', 'unknown dependency');
  return structuredClone(value) as VerificationSpec;
}
