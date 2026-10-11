import {constants} from 'node:fs';
import {open, lstat, realpath} from 'node:fs/promises';
import {dirname, join, resolve, parse} from 'node:path';
import {MaterialIntake} from './material-intake.js';
import {assertResearchEvidenceSnapshot, researchDigest} from './research-materials.js';
import {readBounded, bytesDigest, privateDirectory, exclusiveJSON} from './research-runtime-files.js';
import {safeResultJSON} from '../contracts/p7-results.js';
import type {ResearchEvidenceContext} from '../contracts/p8-research.js';
import type {IndexedResearchView, PreparedResearchReader, ResearchReaderLimits,
  ResearchReadRequest, ResearchReadResult} from '../contracts/p8-research-reader.js';

export const DEFAULT_RESEARCH_READER_LIMITS: Readonly<ResearchReaderLimits> = Object.freeze({
  pageChars: 16384, maxRangeChars: 16384, maxResponseChars: 65536,
  maxSearchResults: 16, maxQueryChars: 256,
});
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw Error('Research reader: ' + message);
}
function integer(value: number, min: number, max: number): void {
  ensure(Number.isSafeInteger(value) && value >= min && value <= max, 'bounded integer required');
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  safeResultJSON(value);
  ensure(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    'unknown/missing fields');
}
function ownRequest(input: object, required: string[], optional: string[] = []): void {
  ensure(input && [Object.prototype, null].includes(Object.getPrototypeOf(input)), 'plain host request required');
  const fields = Object.getOwnPropertyDescriptors(input);
  ensure(required.every(key => Object.hasOwn(fields, key)) && Reflect.ownKeys(input).every(key =>
    typeof key === 'string' && [...required, ...optional].includes(key) && fields[key]!.enumerable &&
    Object.hasOwn(fields[key]!, 'value')), 'exact host data fields required; accessors forbidden');
}
function selection(context: ResearchEvidenceContext, ids: string[], role: IndexedResearchView['role']): void {
  ensure(['current', 'historical'].includes(role) && Array.isArray(ids) && ids.length > 0 &&
    new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' &&
      context.index.entries.some(entry => entry.id === id)), 'invalid source selection/role');
}
function validLimits(limits: ResearchReaderLimits): void {
  exact(limits, ['pageChars', 'maxRangeChars', 'maxResponseChars', 'maxSearchResults', 'maxQueryChars']);
  integer(limits.pageChars, 2, 16384); integer(limits.maxRangeChars, 2, 16384);
  integer(limits.maxResponseChars, 1024, 200000); integer(limits.maxSearchResults, 1, 32);
  integer(limits.maxQueryChars, 1, 256);
}
function boundary(text: string, at: number): boolean {
  return at === 0 || at === text.length || !(text.charCodeAt(at - 1) >= 0xd800 &&
    text.charCodeAt(at - 1) <= 0xdbff && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff);
}
async function ownedPath(path: string): Promise<void> {
  ensure(path === resolve(path), 'path must be canonical absolute');
  let current = path;
  for (;;) {
    ensure(!(await lstat(current)).isSymbolicLink() && await realpath(current) === current,
      'archive or ancestor alias');
    if (current === parse(current).root) break;
    current = dirname(current);
  }
}
async function textBytes(context: ResearchEvidenceContext, id: string): Promise<string> {
  const entry = context.index.entries.find(value => value.id === id);
  ensure(entry?.status === 'success' && entry.raw?.complete && entry.text?.complete,
    'complete supported material required');
  const path = join(context.material.directory, entry.text.path);
  await ownedPath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    ensure(before.isFile() && before.size === entry.text.size && before.size <= context.index.limits.maxItemBytes,
      'actual text size changed');
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    ensure(offset === before.size && before.size === after.size && before.ino === after.ino &&
      before.mtimeMs === after.mtimeMs && bytesDigest(bytes.subarray(0, offset)) === entry.text.sha256,
      'actual text bytes changed');
    // Raw and text are independently bound even when an HTML UTF8 representation is identical.
    await ownedPath(join(context.material.directory, entry.raw.path));
    ensure(bytesDigest(readBounded(join(context.material.directory, entry.raw.path),
      context.index.limits.maxItemBytes)) === entry.raw.sha256, 'actual raw bytes changed');
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, offset));
  } finally {await handle.close();}
}
async function rebuild(context: ResearchEvidenceContext, ids: string[], role: IndexedResearchView['role'],
  limits: ResearchReaderLimits): Promise<IndexedResearchView> {
  const sources: IndexedResearchView['sources'] = [];
  for (const entry of context.index.entries) {
    const usable = entry.status === 'success' && entry.raw?.complete && entry.text?.complete;
    const text = usable ? await textBytes(context, entry.id) : null;
    const pages: IndexedResearchView['sources'][number]['pages'] = [];
    if (text !== null) for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + limits.pageChars);
      if (!boundary(text, end)) end--;
      ensure(end > start, 'page segmentation stalled');
      pages.push({id: entry.id + ':' + pages.length, start, end, digest: bytesDigest(text.slice(start, end))});
      start = end;
    }
    sources.push({materialId: entry.id, status: entry.status, representation: entry.representation,
      rawDigest: entry.raw?.sha256 ?? null, textDigest: entry.text?.sha256 ?? null,
      utf16Length: text?.length ?? null, pages});
  }
  const body = {schemaVersion: 1 as const, protocol: 'indexed-material-v1' as const,
    authority: 'material-integrity-only' as const, material: context.material,
    contextDigest: context.digest, contractDigest: context.contractDigest, role,
    allowedMaterialIds: ids, limits, sources};
  return {...body, digest: researchDigest(body)};
}
/** Derivation checks actual immutable archive bytes. Assignment/role are still
 * only integrity metadata: real consumers must establish their own authority. */
export async function prepareResearchReader(input: {intake: MaterialIntake; context: ResearchEvidenceContext;
  materialIds: string[]; role: IndexedResearchView['role']; dataRoot: string;
  limits?: ResearchReaderLimits}): Promise<PreparedResearchReader> {
  ownRequest(input, ['intake', 'context', 'materialIds', 'role', 'dataRoot'], ['limits']);
  safeResultJSON({context: input.context, materialIds: input.materialIds, role: input.role,
    dataRoot: input.dataRoot, limits: input.limits ?? DEFAULT_RESEARCH_READER_LIMITS});
  const frozen = structuredClone({context: input.context, ids: input.materialIds, role: input.role,
    limits: input.limits ?? DEFAULT_RESEARCH_READER_LIMITS, dataRoot: input.dataRoot});
  validLimits(frozen.limits);
  selection(frozen.context, frozen.ids, frozen.role);
  ensure(frozen.context.material.directory.startsWith(join(await realpath(frozen.dataRoot), 'material-intake') + '/'),
    'actual material data root differs');
  await assertResearchEvidenceSnapshot(input.intake, frozen.context);
  const view = await rebuild(frozen.context, frozen.ids, frozen.role, frozen.limits);
  const directory = await privateDirectory(frozen.dataRoot, 'indexed-material-views', view.digest);
  const path = join(directory, 'view.json');
  const body = {schemaVersion: 1 as const, protocol: 'indexed-material-v1' as const,
    path, view, context: frozen.context};
  const result = {...body, digest: researchDigest(body)};
  await exclusiveJSON(path, result);
  await assertResearchReader(result);
  return result;
}
export async function assertResearchReader(reader: PreparedResearchReader): Promise<void> {
  safeResultJSON(reader); const frozen = structuredClone(reader);
  exact(frozen, ['schemaVersion', 'protocol', 'path', 'view', 'context', 'digest']);
  const {digest, ...body} = frozen;
  ensure(frozen.schemaVersion === 1 && frozen.protocol === 'indexed-material-v1' && researchDigest(body) === digest,
    'reader version/digest changed');
  validLimits(frozen.view.limits);
  selection(frozen.context, frozen.view.allowedMaterialIds, frozen.view.role);
  await ownedPath(frozen.path);
  const root = dirname(dirname(frozen.context.material.directory));
  ensure(frozen.path === join(root, 'indexed-material-views', bytesDigest(frozen.view.digest), 'view.json'),
    'reader archive path differs');
  await assertResearchEvidenceSnapshot(new MaterialIntake(root), frozen.context);
  ensure(researchDigest(JSON.parse(readBounded(frozen.path).toString('utf8'))) === researchDigest(frozen),
    'actual reader file changed');
  ensure(researchDigest(await rebuild(frozen.context, frozen.view.allowedMaterialIds,
    frozen.view.role, frozen.view.limits)) === researchDigest(frozen.view), 'actual complete source index changed');
}
export async function readResearchMaterial(source: PreparedResearchReader,
  sourceRequest: ResearchReadRequest): Promise<ResearchReadResult> {
  safeResultJSON(source); safeResultJSON(sourceRequest);
  const reader = structuredClone(source), request = structuredClone(sourceRequest);
  await assertResearchReader(reader);
  ensure(reader.view.allowedMaterialIds.includes(request.materialId), 'material outside frozen reader selection');
  const text = await textBytes(reader.context, request.materialId), limits = reader.view.limits;
  const ranges: ResearchReadResult['ranges'] = []; let matchCount: number | null = null, truncated = false;
  const range = (start: number, end: number) => {
    ensure(boundary(text, start) && boundary(text, end), 'range splits UTF16 surrogate');
    const value = text.slice(start, end);
    return {start, end, text: value, digest: bytesDigest(value)};
  };
  if (request.type === 'range') {
    exact(request, ['type', 'materialId', 'start', 'end']);
    integer(request.start, 0, text.length); integer(request.end, request.start + 1, text.length);
    ensure(request.end - request.start <= limits.maxRangeChars, 'range exceeds bound');
    ranges.push(range(request.start, request.end));
  } else {
    exact(request, ['type', 'materialId', 'query', 'maxResults', 'contextChars']);
    ensure(request.type === 'search' && typeof request.query === 'string' && request.query.length > 0 &&
      request.query.length <= limits.maxQueryChars && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(request.query),
      'bounded literal query required');
    integer(request.maxResults, 1, limits.maxSearchResults); integer(request.contextChars, 0, 1024);
    matchCount = 0;
    for (let start = text.indexOf(request.query); start !== -1;
      start = text.indexOf(request.query, start + request.query.length)) {
      matchCount++;
      if (ranges.length >= request.maxResults) {truncated = true; continue;}
      let lo = Math.max(0, start - request.contextChars), hi = Math.min(text.length, start + request.query.length + request.contextChars);
      if (!boundary(text, lo)) lo--; if (!boundary(text, hi)) hi++;
      ranges.push(range(lo, hi));
    }
  }
  const entry = reader.view.sources.find(value => value.materialId === request.materialId)!;
  const body = {schemaVersion: 1 as const, authority: 'material-integrity-only' as const,
    viewDigest: reader.view.digest, request, rawDigest: entry.rawDigest!, textDigest: entry.textDigest!,
    coordinate: 'utf16-code-units' as const, sourceLength: text.length, ranges, matchCount, truncated};
  const result = {...body, digest: researchDigest(body)};
  ensure(JSON.stringify(result).length <= limits.maxResponseChars, 'complete response exceeds bound; no silent slicing');
  await assertResearchReader(reader);
  return result;
}
