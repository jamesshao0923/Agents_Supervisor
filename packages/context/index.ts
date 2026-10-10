import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { constructContext, digest, textDigest } from './build.js';
import { parseContextInput, parseMemoryProposalInput, validateSources } from './validation.js';
import type { ContextInput, ContextManifest, MemoryInput, MemoryProposal, MemoryProposalInput, MemoryRecord, MemorySnapshot } from './types.js';

export type * from './types.js';
export { parseContextInput, parseMemoryProposalInput } from './validation.js';

interface Head { schemaVersion: 1; workspace: string; projectId: string; version: number; directory: string | null; digest: string; proposalId: string | null; proposalDigest: string | null }
interface Revision { schemaVersion: 1; workspace: string; projectId: string; version: number; proposalId: string; proposalDigest: string; records: MemoryRecord[] }
function validString(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && !value.includes('\0'); }
function assertKeys(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`memory ${name}: malformed metadata`);
}
function jsonFile(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!lstatSync(path).isFile()) throw new Error(`memory non-file: ${path}`); return JSON.parse(readFileSync(fd, 'utf8')) as unknown; }
  finally { closeSync(fd); }
}
function rawFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!lstatSync(path).isFile()) throw new Error(`memory non-file: ${path}`); return readFileSync(fd, 'utf8'); }
  finally { closeSync(fd); }
}
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function directory(path: string): void {
  if (existsSync(path)) { if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error(`memory directory must not be a symlink: ${path}`); }
  else {
    try { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw error; }
  }
}
function fileNew(path: string, contents: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function atomic(path: string, contents: string): void {
  const temporary = join(dirname(path), `.atomic-${randomUUID()}`);
  try { fileNew(temporary, contents); renameSync(temporary, path); syncDirectory(dirname(path)); }
  finally { rmSync(temporary, { force: true }); }
}
function inputOf(record: MemoryRecord): MemoryInput {
  const { id, scope, kind, text, attribution, sources, summary, key, validity } = record;
  return { id, scope, kind, text, attribution, sources, ...(summary === undefined ? {} : { summary }), ...(key === undefined ? {} : { key }), ...(validity === undefined ? {} : { validity }) };
}
function relativeRecord(record: MemoryInput): string {
  const filename = `${textDigest(record.id)}.md`;
  if (record.scope.level === 'project') return join('project', filename);
  if (record.scope.level === 'module') return join('modules', record.scope.module, filename);
  return join('modules', record.scope.module, record.scope.submodule, filename);
}

/** Only controller-issued API calls publish memory. Generated workspace files are never imported implicitly. */
export class MemoryStore {
  readonly workspace: string;
  readonly projectId: string;
  readonly root: string;
  constructor(workspace: string, projectId: string) {
    if (!validString(projectId)) throw new Error('memory projectId must be nonempty');
    this.workspace = realpathSync(resolve(workspace)); this.projectId = projectId;
    directory(join(this.workspace, '.supervisor')); this.root = join(this.workspace, '.supervisor', 'memory'); directory(this.root);
    for (const name of ['revisions', 'proposals', 'contexts']) directory(join(this.root, name));
  }
  private async locked<T>(work: () => T): Promise<T> {
    // SQLite is only an OS-backed publication mutex. All memory state remains in plaintext files.
    // Its native file locks are released on process death, avoiding unsafe PID lock-file recovery.
    const path = join(this.root, '.publication-lock.sqlite');
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('memory publication lock must be a regular file');
    const lock = new DatabaseSync(path);
    try {
      lock.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
      this.initialize(); const result = work(); lock.exec('COMMIT;'); return result;
    } finally { lock.close(); }
  }
  private initialize(): void {
    const path = join(this.root, 'HEAD.json');
    if (!existsSync(path)) {
      if (['revisions', 'proposals', 'contexts'].some(name => readdirSync(join(this.root, name)).length > 0)) throw new Error('memory HEAD missing with persisted history; explicit recovery required');
      const head: Head = { schemaVersion: 1, workspace: this.workspace, projectId: this.projectId, version: 0, directory: null, digest: digest({ projectId: this.projectId, version: 0, records: [] }), proposalId: null, proposalDigest: null };
      atomic(path, JSON.stringify(head));
    }
    this.head();
  }
  private head(): Head {
    const value = jsonFile(join(this.root, 'HEAD.json'));
    assertKeys(value, ['schemaVersion', 'workspace', 'projectId', 'version', 'directory', 'digest', 'proposalId', 'proposalDigest'], 'HEAD');
    if (value.schemaVersion !== 1 || value.workspace !== this.workspace || value.projectId !== this.projectId) throw new Error('memory foreign project or workspace identity');
    if (!Number.isSafeInteger(value.version) || (value.version as number) < 0 || !validString(value.digest)) throw new Error('memory HEAD corrupted');
    if (value.version === 0) {
      if (value.directory !== null || value.proposalId !== null || value.proposalDigest !== null || value.digest !== digest({ projectId: this.projectId, version: 0, records: [] })) throw new Error('memory empty HEAD corrupted');
    } else if (typeof value.directory !== 'string' || !/^v[1-9]\d*-[a-f0-9-]{36}$/.test(value.directory) || !validString(value.proposalId) || !validString(value.proposalDigest)) throw new Error('memory HEAD revision corrupted');
    return value as unknown as Head;
  }
  private snapshot(head = this.head()): MemorySnapshot {
    if (head.version === 0) return { projectId: this.projectId, version: 0, digest: head.digest, records: [] };
    const path = join(this.root, 'revisions', head.directory!); directory(path);
    const value = jsonFile(join(path, 'manifest.json'));
    assertKeys(value, ['schemaVersion', 'workspace', 'projectId', 'version', 'proposalId', 'proposalDigest', 'records'], 'revision');
    if (digest(value) !== head.digest) throw new Error('memory revision digest mismatch: manual edit must be proposed and republished');
    if (value.schemaVersion !== 1 || value.workspace !== this.workspace || value.projectId !== this.projectId || value.version !== head.version || value.proposalId !== head.proposalId || value.proposalDigest !== head.proposalDigest || !Array.isArray(value.records)) throw new Error('memory revision identity mismatch');
    const ids = new Set<string>();
    for (const unknownRecord of value.records) {
      const record = unknownRecord as MemoryRecord;
      parseMemoryProposalInput({ baseVersion: 0, reason: 'validate revision', changes: [{ type: 'upsert', record: inputOf(record) }] });
      if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isFinite(Date.parse(record.updatedAt)) || !['active', 'invalid'].includes(record.status) || ids.has(record.id)) throw new Error('memory record metadata corrupted');
      ids.add(record.id);
      if (record.status === 'invalid') { if (!record.invalidation || !validString(record.invalidation.reason)) throw new Error('memory invalidation missing'); validateSources(record.invalidation.sources, 'memory.invalidation.sources'); }
      if (record.rawRef !== join(path, relativeRecord(record))) throw new Error('memory raw reference outside current revision');
      let parent = dirname(record.rawRef);
      while (parent !== path) { if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error('memory raw reference symlink'); parent = dirname(parent); }
      const text = rawFile(record.rawRef);
      if (text !== record.text || textDigest(text) !== record.digest) throw new Error('memory text digest mismatch: manual edit must be proposed and republished');
    }
    return { projectId: this.projectId, version: head.version, digest: head.digest, records: value.records as MemoryRecord[] };
  }
  async read(): Promise<MemorySnapshot> { return this.locked(() => structuredClone(this.snapshot())); }
  async propose(input: MemoryProposalInput): Promise<MemoryProposal> {
    const parsed = parseMemoryProposalInput(input);
    return this.locked(() => {
      const snapshot = this.snapshot();
      if (snapshot.version !== parsed.baseVersion) throw new Error('memory baseVersion conflict');
      for (const change of parsed.changes) if (change.type === 'invalidate' && !snapshot.records.some(record => record.id === change.id)) throw new Error(`memory invalidate unknown id ${change.id}`);
      const value = { ...parsed, id: randomUUID(), projectId: this.projectId, createdAt: new Date().toISOString() };
      const proposal: MemoryProposal = { ...value, digest: digest(value) };
      fileNew(join(this.root, 'proposals', `${proposal.id}.json`), JSON.stringify(proposal));
      return structuredClone(proposal);
    });
  }
  async publish(proposalId: string, expectedDigest: string): Promise<MemorySnapshot> {
    if (!/^[a-f0-9-]{36}$/.test(proposalId) || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('memory invalid proposal identity');
    return this.locked(() => {
      const unknownProposal = jsonFile(join(this.root, 'proposals', `${proposalId}.json`));
      assertKeys(unknownProposal, ['baseVersion', 'reason', 'changes', 'id', 'projectId', 'createdAt', 'digest'], 'proposal');
      const { digest: proof, ...value } = unknownProposal;
      if (proof !== expectedDigest || digest(value) !== expectedDigest || value.id !== proposalId || value.projectId !== this.projectId || !Number.isFinite(Date.parse(value.createdAt as string))) throw new Error('memory proposal digest or project mismatch');
      const proposal = parseMemoryProposalInput({ baseVersion: value.baseVersion, reason: value.reason, changes: value.changes });
      const head = this.head(), snapshot = this.snapshot(head);
      if (head.proposalId === proposalId && head.proposalDigest === expectedDigest) return structuredClone(snapshot);
      if (snapshot.version !== proposal.baseVersion) throw new Error('memory baseVersion conflict');
      const nextVersion = snapshot.version + 1, name = `v${nextVersion}-${proposalId}`;
      const final = join(this.root, 'revisions', name), staging = join(this.root, 'revisions', `.pending-${randomUUID()}`);
      directory(staging);
      const records = new Map(snapshot.records.map(record => [record.id, record]));
      for (const change of proposal.changes) {
        const old = records.get(change.type === 'upsert' ? change.record.id : change.id);
        if (change.type === 'upsert') records.set(change.record.id, { ...change.record, revision: (old?.revision ?? 0) + 1, updatedAt: value.createdAt as string, status: 'active', rawRef: '', digest: textDigest(change.record.text) });
        else {
          if (!old) throw new Error(`memory invalidate unknown id ${change.id}`);
          records.set(change.id, { ...old, revision: old.revision + 1, updatedAt: value.createdAt as string, status: 'invalid', invalidation: { reason: change.reason, sources: change.sources } });
        }
      }
      const nextRecords = [...records.values()].sort((a, b) => a.id.localeCompare(b.id)).map(record => ({ ...record, rawRef: join(final, relativeRecord(record)) }));
      try {
        for (const record of nextRecords) {
          const relative = relativeRecord(record), parts = dirname(relative).split('/'); let current = staging;
          for (const part of parts) { current = join(current, part); directory(current); }
          fileNew(join(staging, relative), record.text);
        }
        const revision: Revision = { schemaVersion: 1, workspace: this.workspace, projectId: this.projectId, version: nextVersion, proposalId, proposalDigest: expectedDigest, records: nextRecords };
        fileNew(join(staging, 'manifest.json'), JSON.stringify(revision)); syncDirectory(staging);
        // A crash before HEAD leaves only an unselected immutable revision; retry safely replaces that orphan.
        if (existsSync(final)) {
          if (!lstatSync(final).isDirectory() || lstatSync(final).isSymbolicLink()) throw new Error('memory orphan revision is not a directory');
          const orphan = jsonFile(join(final, 'manifest.json')); if (digest(orphan) !== digest(revision)) throw new Error('memory orphan revision conflict');
          // Only an unselected orphan can be here after the CAS check. Replace it from fully synced files.
          rmSync(final, { recursive: true });
        }
        renameSync(staging, final); syncDirectory(join(this.root, 'revisions'));
        const next: Head = { schemaVersion: 1, workspace: this.workspace, projectId: this.projectId, version: nextVersion, directory: name, digest: digest(revision), proposalId, proposalDigest: expectedDigest };
        atomic(join(this.root, 'HEAD.json'), JSON.stringify(next));
        return structuredClone(this.snapshot(next));
      } finally { rmSync(staging, { recursive: true, force: true }); }
    });
  }
  async buildContext(input: ContextInput): Promise<ContextManifest> {
    const parsed = parseContextInput(input);
    return this.locked(() => {
      const result = constructContext(this.snapshot(), parsed, this.root);
      fileNew(result.path, JSON.stringify(result)); return structuredClone(result);
    });
  }
}
