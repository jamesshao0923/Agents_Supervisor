/** A bounded, explicitly supported JSON Schema subset. Unsupported constraints fail
 * before a model is started, rather than silently weakening the controller's input. */
export class ReasonerSchemaError extends Error { override name = 'ReasonerSchemaError'; }
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export const SYMBOLIC_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';
export const ASSET_ID_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$';
const safePatterns = new Set([SYMBOLIC_ID_PATTERN, ASSET_ID_PATTERN]);
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'title', 'description', '$schema']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
type Schema = Record<string, unknown> | boolean;
const fail = (path: string, reason: string): never => { throw new ReasonerSchemaError(`${path}: ${reason}`); };
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'expected a plain object');
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function jsonClone(value: unknown, maxBytes: number): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  function walk(input: unknown, path: string, depth: number): unknown {
    if (++nodes > 50_000 || depth > 64) fail(path, 'JSON complexity limit exceeded');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') { if (!Number.isFinite(input)) fail(path, 'number must be finite'); return input; }
    if (typeof input !== 'object') fail(path, 'expected JSON value');
    const object = input as object;
    if (ancestors.has(object)) fail(path, 'cyclic JSON is forbidden');
    ancestors.add(object);
    try {
      if (Object.getOwnPropertySymbols(object).length) fail(path, 'symbol keys are forbidden');
      const descriptors = Object.getOwnPropertyDescriptors(object);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!Object.hasOwn(descriptor, 'value')) fail(path, 'accessors are forbidden');
        if (unsafe.has(key)) fail(path, 'unsafe object key');
      }
      if (Array.isArray(input)) {
        if (Object.keys(descriptors).some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) fail(path, 'extra array fields are forbidden');
        const output: unknown[] = [];
        for (let i = 0; i < input.length; i++) {
          if (!Object.hasOwn(descriptors, i)) fail(path, 'sparse arrays are forbidden');
          output.push(walk(descriptors[String(i)]!.value, `${path}[${i}]`, depth + 1));
        }
        return output;
      }
      record(input, path);
      const output: Record<string, unknown> = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) fail(path, 'non-enumerable JSON fields are forbidden');
        output[key] = walk(descriptor.value, `${path}.${key}`, depth + 1);
      }
      return output;
    } finally { ancestors.delete(object); }
  }
  const result = walk(value, '$', 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('$', 'JSON byte limit exceeded');
  return result;
}
function validateSchemaNode(schema: unknown, path: string): void {
  if (typeof schema === 'boolean') return;
  const node = record(schema, path);
  for (const key of Object.keys(node)) if (!keywords.has(key)) fail(path, `unsupported schema keyword ${key}`);
  if (!Object.hasOwn(node, 'type') && !['anyOf', 'oneOf', 'allOf', 'enum', 'const'].some(key => Object.hasOwn(node, key))) fail(path, 'schema must declare a type or constraint');
  if (node.type !== undefined) {
    const selected = Array.isArray(node.type) ? node.type : [node.type];
    if (!selected.length || selected.some(value => typeof value !== 'string' || !types.has(value)) || new Set(selected).size !== selected.length) fail(path, 'invalid schema type');
  }
  for (const key of ['title', 'description', '$schema']) if (node[key] !== undefined && typeof node[key] !== 'string') fail(path, `${key} must be a string`);
  if (node.properties !== undefined) for (const [key, child] of Object.entries(record(node.properties, `${path}.properties`))) validateSchemaNode(child, `${path}.properties.${key}`);
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some(key => typeof key !== 'string' || unsafe.has(key)) || new Set(node.required).size !== node.required.length) fail(path, 'invalid required property list');
    const properties = node.properties === undefined ? {} : record(node.properties, `${path}.properties`);
    if ((node.required as string[]).some(key => !Object.hasOwn(properties, key))) fail(path, 'required property lacks a schema');
  }
  if (node.additionalProperties !== undefined) validateSchemaNode(node.additionalProperties, `${path}.additionalProperties`);
  if (node.items !== undefined) validateSchemaNode(node.items, `${path}.items`);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (node[key] !== undefined) {
    const children = node[key];
    if (!Array.isArray(children) || !children.length || children.length > 32) fail(path, `${key} needs 1–32 schemas`);
    (children as unknown[]).forEach((child, i) => validateSchemaNode(child, `${path}.${key}[${i}]`));
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length || new Set(node.enum.map(canonical)).size !== node.enum.length)) fail(path, 'enum must contain unique JSON values');
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) fail(path, `${key} must be finite`);
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (node[key] !== undefined && (!Number.isSafeInteger(node[key]) || (node[key] as number) < 0)) fail(path, `${key} must be a non-negative integer`);
  // Only these fixed linear, bounded identifier expressions are supported.
  if (node.pattern !== undefined && (typeof node.pattern !== 'string' || !safePatterns.has(node.pattern))) fail(path, 'unsupported identifier pattern');
  if (node.uniqueItems !== undefined && typeof node.uniqueItems !== 'boolean') fail(path, 'uniqueItems must be boolean');
  for (const [low, high] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems']] as const) if (typeof node[low] === 'number' && typeof node[high] === 'number' && node[low] > node[high]) fail(path, `${low} exceeds ${high}`);
}
export function validateReasonerSchema(value: Record<string, unknown>): Record<string, unknown> {
  const schema = record(jsonClone(value, 256 * 1024), '$schema');
  validateSchemaNode(schema, '$schema');
  return schema;
}
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === type;
  }
}
function assertValue(value: unknown, schema: Schema, path: string): void {
  if (typeof schema === 'boolean') { if (!schema) fail(path, 'value prohibited by schema'); return; }
  if (schema.type !== undefined) {
    const selected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!selected.some(type => matchesType(value, type as string))) fail(path, 'value has wrong type');
  }
  if (Object.hasOwn(schema, 'const') && canonical(schema.const) !== canonical(value)) fail(path, 'value differs from const');
  if (Array.isArray(schema.enum) && !schema.enum.some(item => canonical(item) === canonical(value))) fail(path, 'value outside enum');
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[key])) {
    const branches = schema[key] as Schema[];
    if (key === 'allOf') { branches.forEach(child => assertValue(value, child, path)); continue; }
    let passed = 0;
    for (const child of branches) {
      try { assertValue(value, child, path); passed++; }
      catch (error) { if (!(error instanceof ReasonerSchemaError)) throw error; }
    }
    if (key === 'anyOf' ? passed === 0 : passed !== 1) fail(path, `${key} branch count mismatch`);
  }
  if (typeof value === 'number') {
    for (const [key, invalid] of [
      ['minimum', (limit: number) => value < limit], ['maximum', (limit: number) => value > limit],
      ['exclusiveMinimum', (limit: number) => value <= limit], ['exclusiveMaximum', (limit: number) => value >= limit],
    ] as const) if (typeof schema[key] === 'number' && invalid(schema[key])) fail(path, `violates ${key}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) fail(path, 'string violates identifier pattern');
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength || typeof schema.maxLength === 'number' && length > schema.maxLength) fail(path, 'string length outside schema');
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(path, 'array length outside schema');
    if (schema.uniqueItems === true && new Set(value.map(canonical)).size !== value.length) fail(path, 'array items must be unique');
    if (schema.items !== undefined) value.forEach((item, i) => assertValue(item, schema.items as Schema, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    const data = value as Record<string, unknown>, properties = schema.properties as Record<string, Schema> | undefined;
    for (const key of schema.required as string[] ?? []) if (!Object.hasOwn(data, key)) fail(path, `missing required property ${key}`);
    for (const [key, item] of Object.entries(data)) {
      if (properties && Object.hasOwn(properties, key)) assertValue(item, properties[key]!, `${path}.${key}`);
      else if (schema.additionalProperties !== undefined) assertValue(item, schema.additionalProperties as Schema, `${path}.${key}`);
    }
  }
}
/** Validates the model's final message independently of provider-side schema claims. */
export function parseReasonerOutput(text: string, outputSchema: Record<string, unknown>): unknown {
  const schema = validateReasonerSchema(outputSchema);
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 1024 * 1024) fail('$output', 'missing or oversized final JSON output');
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('$output', 'final output is not JSON'); }
  const clone = jsonClone(value, 1024 * 1024);
  assertValue(clone, schema, '$output');
  return clone;
}
