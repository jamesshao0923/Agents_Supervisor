import type { ContextInput, MemoryProposalInput, MemorySource } from './types.js';

type Shape = Record<string, unknown>;
function fail(path: string, reason: string): never { throw new Error(`${path}: ${reason}`); }
function object(value: unknown, path: string, keys: string[], optional: string[] = []): Shape {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be a plain object');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) || !keys.includes(key)) fail(path, 'unknown or nonplain field');
  }
  for (const key of keys) if (!optional.includes(key) && !Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required');
  return value as Shape;
}
function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 1_000_000) fail(path, 'must be a nonempty string without NUL');
}
function integer(value: unknown, path: string, minimum = 0): void { if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(path, 'invalid integer'); }
function list(value: unknown, path: string, check: (value: unknown, path: string) => void, minimum = 0): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 10_000) fail(path, 'invalid array');
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || !('value' in d) || !d.enumerable) fail(path, 'nonplain array');
  }
  for (let i = 0; i < value.length; i++) { if (!Object.hasOwn(value, i)) fail(path, 'sparse array'); check(value[i], `${path}[${i}]`); }
}
function choice(value: unknown, path: string, values: string[]): void { if (!values.includes(value as string)) fail(path, 'invalid choice'); }
export function validateSources(value: unknown, path: string): asserts value is MemorySource[] {
  list(value, path, (v, p) => { const o = object(v, p, ['kind', 'ref']); choice(o.kind, `${p}.kind`, ['user', 'model', 'evidence']); string(o.ref, `${p}.ref`); }, 1);
  if (new Set(value.map(v => `${(v as MemorySource).kind}\0${(v as MemorySource).ref}`)).size !== value.length) fail(path, 'duplicate source reference');
}
function segment(value: unknown, path: string): void { string(value, path); if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) fail(path, 'invalid scope segment'); }
function scope(value: unknown, path: string): void {
  const level = value && typeof value === 'object' ? (value as Shape).level : undefined;
  choice(level, `${path}.level`, ['project', 'module', 'submodule']);
  const o = object(value, path, level === 'project' ? ['level'] : level === 'module' ? ['level', 'module'] : ['level', 'module', 'submodule']);
  if (level !== 'project') segment(o.module, `${path}.module`); if (level === 'submodule') segment(o.submodule, `${path}.submodule`);
}
function iso(value: unknown, path: string): void { string(value, path); if (!Number.isFinite(Date.parse(value))) fail(path, 'invalid timestamp'); }
function validity(value: unknown, path: string): void {
  const o = object(value, path, ['taskId', 'contractVersion', 'environmentDigest', 'preferenceVersion', 'expiresAt'], ['taskId', 'contractVersion', 'environmentDigest', 'preferenceVersion', 'expiresAt']);
  if (o.taskId !== undefined) string(o.taskId, `${path}.taskId`);
  if (o.contractVersion !== undefined) integer(o.contractVersion, `${path}.contractVersion`, 1);
  if (o.preferenceVersion !== undefined) integer(o.preferenceVersion, `${path}.preferenceVersion`);
  if (o.environmentDigest !== undefined) string(o.environmentDigest, `${path}.environmentDigest`);
  if (o.expiresAt !== undefined) iso(o.expiresAt, `${path}.expiresAt`);
}
function memory(value: unknown, path: string): void {
  const o = object(value, path, ['id', 'scope', 'kind', 'text', 'summary', 'key', 'attribution', 'sources', 'validity'], ['summary', 'key', 'validity']);
  string(o.id, `${path}.id`); scope(o.scope, `${path}.scope`); choice(o.kind, `${path}.kind`, ['fact', 'preference', 'interface', 'constraint', 'failure']); string(o.text, `${path}.text`);
  for (const key of ['summary', 'key']) if (o[key] !== undefined) string(o[key], `${path}.${key}`);
  choice(o.attribution, `${path}.attribution`, ['explicit', 'inferred']); validateSources(o.sources, `${path}.sources`);
  if (o.attribution === 'explicit' && !o.sources.some(source => source.kind !== 'model')) fail(path, 'model-only sources cannot claim explicit authority');
  if (o.validity !== undefined) validity(o.validity, `${path}.validity`);
}
export function parseMemoryProposalInput(value: unknown): MemoryProposalInput {
  const o = object(value, 'memoryProposal', ['baseVersion', 'reason', 'changes']); integer(o.baseVersion, 'baseVersion'); string(o.reason, 'reason');
  const ids = new Set<string>();
  list(o.changes, 'changes', (v, p) => {
    const type = v && typeof v === 'object' ? (v as Shape).type : undefined;
    choice(type, `${p}.type`, ['upsert', 'invalidate']);
    const c = object(v, p, type === 'upsert' ? ['type', 'record'] : ['type', 'id', 'reason', 'sources']);
    let id: string;
    if (type === 'upsert') { memory(c.record, `${p}.record`); id = (c.record as Shape).id as string; }
    else { string(c.id, `${p}.id`); string(c.reason, `${p}.reason`); validateSources(c.sources, `${p}.sources`); id = c.id; }
    if (ids.has(id)) fail(p, 'duplicate memory change'); ids.add(id);
  }, 1);
  return structuredClone(value) as MemoryProposalInput;
}
function requirement(value: unknown, path: string): void {
  const o = object(value, path, ['id', 'text', 'sources']); string(o.id, `${path}.id`); string(o.text, `${path}.text`); validateSources(o.sources, `${path}.sources`);
}
export function parseContextInput(value: unknown): ContextInput {
  const o = object(value, 'context', ['contract', 'taskId', 'currentRequirements', 'module', 'submodule', 'dependencies', 'requiredMemoryIds', 'environmentDigest', 'preferenceVersion', 'maxChars', 'outputReserveChars', 'now'], ['taskId', 'currentRequirements', 'module', 'submodule', 'dependencies', 'requiredMemoryIds', 'environmentDigest', 'preferenceVersion', 'outputReserveChars', 'now']);
  if (o.taskId !== undefined) string(o.taskId, 'taskId');
  const c = object(o.contract, 'contract', ['version', 'goal', 'sources', 'requiredCriteria', 'constraints']); integer(c.version, 'contract.version', 1); string(c.goal, 'contract.goal'); validateSources(c.sources, 'contract.sources');
  for (const key of ['requiredCriteria', 'constraints']) list(c[key], `contract.${key}`, requirement);
  const ids = [...c.requiredCriteria as Shape[], ...c.constraints as Shape[]].map(r => r.id); if (new Set(ids).size !== ids.length) fail('contract', 'duplicate required item id');
  if (o.currentRequirements !== undefined) list(o.currentRequirements, 'currentRequirements', requirement);
  if (o.module !== undefined) segment(o.module, 'module'); if (o.submodule !== undefined) { segment(o.submodule, 'submodule'); if (!o.module) fail('submodule', 'requires module'); }
  if (o.dependencies !== undefined) list(o.dependencies, 'dependencies', scope);
  if (o.requiredMemoryIds !== undefined) list(o.requiredMemoryIds, 'requiredMemoryIds', string);
  if (o.environmentDigest !== undefined) string(o.environmentDigest, 'environmentDigest'); if (o.preferenceVersion !== undefined) integer(o.preferenceVersion, 'preferenceVersion');
  integer(o.maxChars, 'maxChars', 1); if (o.outputReserveChars !== undefined) integer(o.outputReserveChars, 'outputReserveChars');
  if ((o.outputReserveChars as number | undefined ?? 0) >= (o.maxChars as number)) fail('context', 'output reserve consumes capacity');
  if (o.now !== undefined) iso(o.now, 'now');
  return structuredClone(value) as ContextInput;
}
