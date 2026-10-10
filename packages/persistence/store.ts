import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Artifact, Command, CommandResult, DomainEvent, EvidenceRef, Query, Run, StoredEvent, VerificationCatalog, VerificationChange, VerificationPlan } from '../contracts/p1.js';
import { parseCommand, parseQuery } from '../contracts/validation.js';
import { applyAction, createRun, validateVerificationChange, validateVerificationPlan } from '../domain/index.js';
import { migrate } from './migrations.js';
import { executionCreate, executionGet, executionList, executionEvents, executionUpdate } from './executions.js';
import type { ExecutionRecord, ExecutionStart } from '../contracts/p2.js';
import type { RunAction } from '../contracts/p1.js';

/** Canonical JSON is used for receipts and immutable definitions, never caller object identity. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Single authoritative writer per transaction. BEGIN IMMEDIATE also serializes independent
 * connections/processes; revision checks and budget admission occur under the same lock.
 * Fault points: afterSnapshot = durable rename before index publication; beforeCommit =
 * all writes staged; afterCommit = durable commit, before returning its receipt.
 * Hooks are for controlled real-process fault experiments, and never alter domain outcomes.
 */
export class SupervisorStore {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly objects: string;
  private readonly fault: ((point: string) => void) | undefined;

  constructor(dataDir: string, options: { fault?: (point: string) => void } = {}) {
    const target = resolve(dataDir);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Data directory cannot be a symbolic link');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    this.root = realpathSync(target);
    this.objects = resolve(this.root, 'objects');
    this.fault = options.fault;
    if (existsSync(this.objects) && lstatSync(this.objects).isSymbolicLink()) throw new Error('Object directory cannot be a symbolic link');
    mkdirSync(this.objects, { mode: 0o700, recursive: true });
    const database = resolve(this.root, 'supervisor.sqlite');
    if (existsSync(database) && lstatSync(database).isSymbolicLink()) throw new Error('Database cannot be a symbolic link');
    this.db = new DatabaseSync(database);
    try { migrate(this.db); } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  executionCreate(input: ExecutionStart) { return executionCreate(this.db, input); }
  executionGet(id: string) { return executionGet(this.db, id); }
  executionList() { return executionList(this.db); }
  executionEvents(id: string, after: number) { return executionEvents(this.db, id, after); }
  executionUpdate(id: string, patch: Partial<ExecutionRecord>, kind: string, payload: unknown, actions: RunAction[] = []) {
    return executionUpdate(this.db, id, patch, kind, payload, actions);
  }
  isManagedRun(projectId: string, runId: string): boolean {
    return !!this.db.prepare('SELECT id FROM executions WHERE project_id=? AND run_id=?').get(projectId, runId);
  }

  command(input: Command): CommandResult {
    const command = parseCommand(input);
    const request = canonical(command);
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const receipt = this.db.prepare('SELECT request,result FROM command_receipts WHERE command_id=?').get(command.commandId);
      if (receipt) {
        if (receipt['request'] !== request) throw new Error('commandId already used with a different request');
        // An idempotent receipt is a historical commit, not a new verification of its files.
        const result = JSON.parse(String(receipt['result'])) as CommandResult;
        this.db.exec('COMMIT');
        return result;
      }
      const { projectId, runId, value, events } = this.execute(command);
      const emitted = events.length ? events : [{ type: `${command.type}Accepted`, details: { value } }];
      let eventSeq = 0;
      for (const event of emitted) {
        const inserted = this.db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES (?,?,?,?,?)')
          .run(command.commandId, projectId, runId, event.type, canonical(event));
        eventSeq = Number(inserted.lastInsertRowid);
      }
      const result: CommandResult = { commandId: command.commandId, eventSeq, value };
      this.db.prepare('INSERT INTO command_receipts(command_id,request,result,event_seq) VALUES (?,?,?,?)')
        .run(command.commandId, request, canonical(result), eventSeq);
      this.fault?.('beforeCommit');
      this.db.exec('COMMIT');
      committed = true;
      this.fault?.('afterCommit');
      return result;
    } catch (error) {
      if (!committed) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  query(input: Query): unknown {
    const query = parseQuery(input);
    switch (query.type) {
      case 'projects': return this.db.prepare('SELECT id,name FROM projects ORDER BY id').all().map(row => ({ id: String(row['id']), name: String(row['name']) }));
      case 'runs': {
        this.project(query.projectId);
        return this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? ORDER BY id').all(query.projectId)
          .map(row => this.verifyRun(JSON.parse(String(row['snapshot'])) as Run));
      }
      case 'run': return this.verifyRun(this.run(query.projectId, query.runId));
      case 'events': {
        this.project(query.projectId);
        return this.db.prepare('SELECT * FROM events WHERE project_id=? AND seq>? ORDER BY seq').all(query.projectId, query.after)
          .map(row => ({ seq: Number(row['seq']), commandId: String(row['command_id']), projectId: String(row['project_id']),
            runId: row['run_id'] === null ? null : String(row['run_id']), type: String(row['type']), payload: JSON.parse(String(row['payload'])) } satisfies StoredEvent));
      }
      case 'catalog': return this.catalog(query.projectId);
      case 'changes': {
        this.project(query.projectId);
        return this.db.prepare('SELECT definition FROM verification_changes WHERE project_id=? ORDER BY id').all(query.projectId)
          .map(row => JSON.parse(String(row['definition'])) as VerificationChange);
      }
      case 'plans': {
        this.verifyRun(this.run(query.projectId, query.runId));
        const plans = this.db.prepare('SELECT definition FROM verification_plans WHERE project_id=? AND run_id=? ORDER BY id').all(query.projectId, query.runId)
          .map(row => JSON.parse(String(row['definition'])) as VerificationPlan);
        for (const plan of plans) this.catalog(query.projectId, plan.catalogVersion);
        return plans;
      }
    }
  }

  private execute(command: Command): { projectId: string; runId: string | null; value: unknown; events: DomainEvent[] } {
    switch (command.type) {
      case 'createProject': {
        this.db.prepare('INSERT INTO projects(id,name) VALUES (?,?)').run(command.project.id, command.project.name);
        return { projectId: command.project.id, runId: null, value: command.project, events: [] };
      }
      case 'createRun': {
        this.project(command.input.projectId);
        const run = createRun(command.input);
        this.db.prepare('INSERT INTO runs(project_id,id,revision,snapshot) VALUES (?,?,?,?)')
          .run(run.projectId, run.id, run.revision, canonical(run));
        return { projectId: run.projectId, runId: run.id, value: run, events: [] };
      }
      case 'act': {
        if (command.action.type === 'setArtifact') throw new Error('Artifacts must be published through publishArtifact; caller paths are not accepted');
        const previous = this.runAtRevision(command.projectId, command.runId, command.expectedRevision);
        const needsCandidate = command.action.type === 'complete' || command.action.type === 'recordEvidence'
          || (command.action.type === 'startAttempt' && command.action.purpose === 'verification');
        let invalidArtifact: string | null = null;
        if (needsCandidate) this.verifyRun(previous);
        else {
          // A missing or edited candidate must block delivery, never prevent the
          // authoritative stop/accounting/reconciliation path from committing.
          try { this.verifyRun(previous); }
          catch (error) { invalidArtifact = error instanceof Error ? error.message : String(error); }
        }
        if (command.action.type === 'startAttempt') {
          const resources = new Set(command.action.resources);
          const snapshots = this.db.prepare('SELECT snapshot FROM runs').all();
          for (const row of snapshots) {
            const existing = JSON.parse(String(row['snapshot'])) as Run;
            if (existing.leases.some(lease => !lease.released && resources.has(lease.resource))) throw new Error('Resource key is already leased');
          }
        }
        const { run, events } = applyAction(previous, command.action);
        if (invalidArtifact) {
          const invalidatedEvidence = previous.evidence;
          run.evidence = [];
          if (invalidatedEvidence.length && run.revision === previous.revision) run.revision++;
          events.push({ type: 'artifactInvalidated', runId: run.id, revision: run.revision,
            details: { reason: invalidArtifact, artifact: previous.artifact, invalidatedEvidence, status: run.status, action: command.action.type } });
        }
        this.saveRun(run);
        return { projectId: run.projectId, runId: run.id, value: run, events };
      }
      case 'publishArtifact': {
        const previous = this.runAtRevision(command.projectId, command.runId, command.expectedRevision);
        if (this.db.prepare('SELECT id FROM artifacts WHERE project_id=? AND run_id=? AND id=?').get(command.projectId, command.runId, command.artifactId)) {
          throw new Error('Artifact id is immutable and already published');
        }
        const file = this.snapshot(command.content);
        const artifact: Artifact = { id: command.artifactId, ...file, contractVersion: previous.contract.version };
        const { run, events } = applyAction(previous, { type: 'setArtifact', artifact });
        this.db.prepare('INSERT INTO artifacts(project_id,run_id,id,digest,path,contract_version) VALUES (?,?,?,?,?,?)')
          .run(run.projectId, run.id, artifact.id, artifact.digest, artifact.path, artifact.contractVersion);
        this.saveRun(run);
        return { projectId: run.projectId, runId: run.id, value: run, events };
      }
      case 'proposeVerificationChange': {
        const current = this.catalog(command.projectId);
        if (command.change.status !== 'proposed') throw new Error('New change must have proposed status');
        validateVerificationChange(current, command.change);
        this.verifyEvidenceRefs(command.projectId, command.change.evidenceRefs);
        this.db.prepare('INSERT INTO verification_changes(project_id,id,base_version,status,definition) VALUES (?,?,?,?,?)')
          .run(command.projectId, command.change.id, command.change.baseVersion, 'proposed', canonical(command.change));
        return { projectId: command.projectId, runId: null, value: command.change, events: [] };
      }
      case 'publishVerificationChange': {
        const current = this.catalog(command.projectId);
        if (command.baseVersion !== (current?.version ?? 0)) throw new Error('Catalog base version conflict');
        const row = this.db.prepare('SELECT definition FROM verification_changes WHERE project_id=? AND id=?').get(command.projectId, command.changeId);
        if (!row) throw new Error('Verification change not found in project');
        const change = JSON.parse(String(row['definition'])) as VerificationChange;
        if (change.status !== 'proposed') throw new Error('Verification change is not proposed');
        if (change.baseVersion !== command.baseVersion) throw new Error('Catalog base version conflict');
        validateVerificationChange(current, change);
        this.verifyEvidenceRefs(command.projectId, change.evidenceRefs);
        const version = command.baseVersion + 1;
        // Snapshot binds the project too; identical catalog bodies cannot be mistaken for another project's definitions.
        const body = canonical({ projectId: command.projectId, version, cases: change.cases });
        const file = this.snapshot(body);
        const catalog: VerificationCatalog = { version, cases: change.cases, digest: file.digest, snapshotPath: file.path };
        this.db.prepare('INSERT INTO verification_catalogs(project_id,version,digest,path,definition) VALUES (?,?,?,?,?)')
          .run(command.projectId, version, catalog.digest, catalog.snapshotPath, canonical(catalog));
        for (const item of catalog.cases) {
          const old = this.db.prepare('SELECT definition FROM verification_cases WHERE project_id=? AND id=? AND revision=?')
            .get(command.projectId, item.id, item.revision);
          const definition = canonical(item);
          if (old && old['definition'] !== definition) throw new Error('Case revision is immutable');
          if (!old) this.db.prepare('INSERT INTO verification_cases(project_id,id,revision,definition) VALUES (?,?,?,?)')
            .run(command.projectId, item.id, item.revision, definition);
          this.db.prepare('INSERT INTO verification_catalog_cases(project_id,version,case_id,revision) VALUES (?,?,?,?)')
            .run(command.projectId, version, item.id, item.revision);
          for (const criterion of item.criterionIds) this.db.prepare('INSERT INTO verification_coverage(project_id,version,case_id,revision,criterion_id) VALUES (?,?,?,?,?)')
            .run(command.projectId, version, item.id, item.revision, criterion);
          for (const replaced of item.replaces) this.db.prepare('INSERT INTO verification_replacements(project_id,version,case_id,revision,replaced_id) VALUES (?,?,?,?,?)')
            .run(command.projectId, version, item.id, item.revision, replaced);
        }
        this.db.prepare('INSERT INTO verification_catalog_heads(project_id,version) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET version=excluded.version')
          .run(command.projectId, version);
        const published = { ...change, status: 'published' as const };
        this.db.prepare('UPDATE verification_changes SET status=?,definition=? WHERE project_id=? AND id=?')
          .run('published', canonical(published), command.projectId, change.id);
        return { projectId: command.projectId, runId: null, value: catalog, events: [] };
      }
      case 'freezeVerificationPlan': {
        const run = this.verifyRun(this.run(command.projectId, command.runId));
        const catalog = this.catalog(command.projectId, command.plan.catalogVersion);
        if (!catalog) throw new Error('Catalog version not found');
        // A new freeze uses the currently published library. Already frozen plans retain historical versions.
        const current = this.catalog(command.projectId);
        if (current?.version !== command.plan.catalogVersion) throw new Error('New plan must use current published catalog');
        validateVerificationPlan(run, catalog, command.plan);
        this.verifyEvidenceRefs(command.projectId, command.plan.evidenceRefs);
        this.db.prepare('INSERT INTO verification_plans(project_id,run_id,id,catalog_version,definition) VALUES (?,?,?,?,?)')
          .run(command.projectId, command.runId, command.plan.id, command.plan.catalogVersion, canonical(command.plan));
        return { projectId: command.projectId, runId: command.runId, value: command.plan, events: [] };
      }
    }
  }

  private project(id: string): void {
    if (!this.db.prepare('SELECT id FROM projects WHERE id=?').get(id)) throw new Error('Project not found');
  }

  private run(projectId: string, runId: string): Run {
    this.project(projectId);
    const row = this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(projectId, runId);
    if (!row) throw new Error('Run not found in project');
    return JSON.parse(String(row['snapshot'])) as Run;
  }

  private runAtRevision(projectId: string, runId: string, revision: number): Run {
    const run = this.run(projectId, runId);
    if (run.revision !== revision) throw new Error('Run revision conflict');
    return run;
  }

  private saveRun(run: Run): void {
    this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE project_id=? AND id=?')
      .run(run.revision, canonical(run), run.projectId, run.id);
  }

  private catalog(projectId: string, requestedVersion?: number): VerificationCatalog | null {
    this.project(projectId);
    const version = requestedVersion ?? Number(this.db.prepare('SELECT version FROM verification_catalog_heads WHERE project_id=?').get(projectId)?.['version'] ?? 0);
    if (version === 0) return null;
    const row = this.db.prepare('SELECT definition FROM verification_catalogs WHERE project_id=? AND version=?').get(projectId, version);
    if (!row) throw new Error('Catalog version not found in project');
    const catalog = JSON.parse(String(row['definition'])) as VerificationCatalog;
    this.verifyFile(catalog.snapshotPath, catalog.digest);
    const body = canonical({ projectId, version: catalog.version, cases: catalog.cases });
    if (digest(body) !== catalog.digest) throw new Error('Catalog snapshot/index mismatch');
    return catalog;
  }

  private verifyRun(run: Run): Run {
    if (run.artifact) {
      const artifact = run.artifact;
      const row = this.db.prepare('SELECT digest,path,contract_version FROM artifacts WHERE project_id=? AND run_id=? AND id=?')
        .get(run.projectId, run.id, artifact.id);
      if (!row || row['digest'] !== artifact.digest || row['path'] !== artifact.path || row['contract_version'] !== artifact.contractVersion) {
        throw new Error('Artifact snapshot/index mismatch');
      }
      this.verifyFile(artifact.path, artifact.digest);
    }
    return run;
  }

  private verifyEvidenceRefs(projectId: string, refs: EvidenceRef[] | undefined): void {
    for (const ref of refs ?? []) {
      const row = this.db.prepare('SELECT path,digest FROM artifacts WHERE project_id=? AND run_id=? AND id=?')
        .get(projectId, ref.runId, ref.artifactId);
      if (!row) throw new Error('Evidence reference artifact not found in project');
      this.verifyFile(String(row['path']), String(row['digest']));
    }
  }

  private verifyFile(path: string, hash: string): void {
    if (!/^[a-f0-9]{64}$/.test(hash) || path !== resolve(this.objects, hash)) throw new Error('Artifact path is outside managed content store');
    if (lstatSync(this.objects).isSymbolicLink() || realpathSync(this.objects) !== this.objects) throw new Error('Managed object directory changed');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Managed object is not a regular file');
    if (digest(readFileSync(path)) !== hash) throw new Error('Managed file digest mismatch; evidence invalid');
  }

  private snapshot(content: string): { digest: string; path: string } {
    if (lstatSync(this.objects).isSymbolicLink() || realpathSync(this.objects) !== this.objects) throw new Error('Managed object directory changed');
    const hash = digest(content);
    const path = resolve(this.objects, hash);
    if (existsSync(path)) {
      this.verifyFile(path, hash);
    } else {
      const temporary = resolve(this.objects, `.pending-${randomUUID()}`);
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    this.fault?.('afterSnapshot');
    return { digest: hash, path };
  }
}
