import {dirname, join, resolve} from 'node:path';
import {lstat, realpath} from 'node:fs/promises';
import type {IndexedResearchViewEntry, PreparedResearchViewSet, ResearchViewReadRequest,
  ResearchViewReadResult} from '../contracts/p8-research-reader.js';
import {safeResultJSON} from '../contracts/p7-results.js';
import {assertResearchReader, readResearchMaterial} from './research-reader.js';
import {assertMaterialIndex} from './research-runtime-files.js';
import {researchDigest} from './research-materials.js';
import {privateDirectory, exclusiveJSON, readBounded, bytesDigest} from './research-runtime-files.js';

function ensure(v: unknown, message: string): asserts v {
  if (!v) throw Error('Research view inventory: ' + message);
}
function exact(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  safeResultJSON(v);
  ensure(v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)), 'exact fields required');
}
async function inventory(entries: IndexedResearchViewEntry[]): Promise<void> {
  ensure(Array.isArray(entries) && entries.length > 0, 'complete nonempty inventory required');
  const ids = new Set<string>(); let current = 0; let root: string | undefined;
  for (const entry of entries) {
    exact(entry, ['viewId', 'reader', 'reference']);
    ensure(typeof entry.viewId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(entry.viewId)
      && !ids.has(entry.viewId), 'unique bounded host view ID required'); ids.add(entry.viewId);
    const ref = entry.reference;
    exact(ref, ref.role === 'current' ? ['role', 'bindingDigest'] : ['role', 'epochDigest']);
    ensure(ref.role === 'current' || ref.role === 'historical', 'explicit context role required');
    const digest = ref.role === 'current' ? ref.bindingDigest : ref.epochDigest;
    ensure(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'exact context reference digest required');
    ensure(entry.reader.view.role === ref.role, 'reader and context role differ');
    if (ref.role === 'current') current++;
    await assertResearchReader(entry.reader);
    const actualRoot = dirname(dirname(entry.reader.context.material.directory));
    ensure(root === undefined || root === actualRoot, 'one owned material root required'); root = actualRoot;
  }
  ensure(current === 1, 'exactly one current basis required');
}
/** Does not issue authority or reconstruct epochs. A real consumer must compare
 * this exact inventory against its frozen job/matrix before creating sessions. */
export async function prepareResearchViewSet(dataRoot: string,
  views: IndexedResearchViewEntry[]): Promise<PreparedResearchViewSet> {
  safeResultJSON(views); const frozen = structuredClone(views); await inventory(frozen);
  ensure(frozen.every(v => dirname(dirname(v.reader.context.material.directory)) === dataRoot),
    'inventory is not within the owning material root');
  const body = {schemaVersion: 1 as const, protocol: 'indexed-material-views-v1' as const,
    authority: 'material-integrity-only' as const, views: frozen};
  const directory = await privateDirectory(dataRoot, 'indexed-material-view-sets', researchDigest(body));
  const path = join(directory, 'views.json'); const contents = {...body, path};
  const result = {...contents, digest: researchDigest(contents)};
  ensure(JSON.stringify(result).length <= 200000,
    'complete view metadata exceeds original context cap; no truncation');
  await exclusiveJSON(path, result); await assertResearchViewSet(result); return result;
}
export async function assertResearchViewSet(source: PreparedResearchViewSet): Promise<void> {
  exact(source, ['schemaVersion', 'protocol', 'authority', 'views', 'path', 'digest']);
  ensure(JSON.stringify(source).length <= 200000,
    'complete view metadata exceeds original context cap; no truncation');
  const set = structuredClone(source); const {digest, ...body} = set;
  ensure(set.schemaVersion === 1 && set.protocol === 'indexed-material-views-v1' &&
    set.authority === 'material-integrity-only' && researchDigest(body) === digest, 'version/digest changed');
  await inventory(set.views);
  const root = dirname(dirname(set.views[0]!.reader.context.material.directory));
  const descriptor = {schemaVersion: set.schemaVersion, protocol: set.protocol, authority: set.authority, views: set.views};
  ensure(set.path === join(root, 'indexed-material-view-sets', bytesDigest(researchDigest(descriptor)), 'views.json'),
    'inventory path differs from deterministic owned path');
  ensure(!(await lstat(set.path)).isSymbolicLink() && await realpath(set.path) === resolve(set.path), 'inventory alias');
  const actual = readBounded(set.path, 800000).toString('utf8');
  ensure(actual.length <= 200000, 'actual view metadata exceeds original context cap; no truncation');
  ensure(researchDigest(JSON.parse(actual)) === researchDigest(set), 'actual complete inventory differs');
}
export async function readResearchView(source: PreparedResearchViewSet,
  request: ResearchViewReadRequest): Promise<ResearchViewReadResult> {
  exact(request, ['viewId', 'request']); safeResultJSON(source);
  const set = structuredClone(source), frozenRequest = structuredClone(request);
  await assertResearchViewSet(set);
  const entry = set.views.find(v => v.viewId === frozenRequest.viewId); ensure(entry, 'view outside exact inventory');
  const result = await readResearchMaterial(entry.reader, frozenRequest.request);
  const body = {schemaVersion: 1 as const, authority: 'material-integrity-only' as const,
    inventoryDigest: set.digest, viewId: entry.viewId, result};
  await assertResearchViewSet(set); return {...body, digest: researchDigest(body)};
}

/** Synchronous reopen integrity only; consumers separately derive exact authority.
 * Uses the same actual complete index/file checks as the existing archive reader. */
export function assertResearchViewSetSync(source:PreparedResearchViewSet):void {
  exact(source,['schemaVersion','protocol','authority','views','path','digest']);
  ensure(JSON.stringify(source).length<=200000,'complete view metadata exceeds original context cap; no truncation');
  const {digest,...body}=source;
  ensure(source.schemaVersion===1&&source.protocol==='indexed-material-views-v1'&&source.authority==='material-integrity-only'&&
    researchDigest(body)===digest&&Array.isArray(source.views)&&source.views.length>0,'invalid frozen inventory');
  const ids=new Set<string>();let current=0;
  const root=dirname(dirname(source.views[0]!.reader.context.material.directory));
  for(const entry of source.views){
    exact(entry,['viewId','reader','reference']);
    ensure(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(entry.viewId)&&!ids.has(entry.viewId),'unique bounded host view ID required');ids.add(entry.viewId);
    const ref=entry.reference;exact(ref,ref.role==='current'?['role','bindingDigest']:['role','epochDigest']);
    ensure((ref.role==='current'||ref.role==='historical')&&entry.reader.view.role===ref.role,'explicit matching role required');
    ensure(/^[a-f0-9]{64}$/.test(ref.role==='current'?ref.bindingDigest:ref.epochDigest),'exact reference digest required');
    if(ref.role==='current')current++;
    ensure(dirname(dirname(entry.reader.context.material.directory))===root,'one material root required');
    const {digest:r,...reader}=entry.reader;
    ensure(researchDigest(reader)===r&&researchDigest(JSON.parse(readBounded(entry.reader.path).toString('utf8')))===researchDigest(entry.reader),
      'actual reader descriptor differs');assertMaterialIndex(entry.reader.context.index,root);
  }
  ensure(current===1,'exactly one current basis required');
  const descriptor={schemaVersion:source.schemaVersion,protocol:source.protocol,authority:source.authority,views:source.views};
  ensure(source.path===join(root,'indexed-material-view-sets',bytesDigest(researchDigest(descriptor)),'views.json'),'inventory path differs');
  const text=readBounded(source.path,800000).toString('utf8');ensure(text.length<=200000&&researchDigest(JSON.parse(text))===researchDigest(source),'actual complete inventory differs');
}
