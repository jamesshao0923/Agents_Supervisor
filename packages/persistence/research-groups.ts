import {createHash} from 'node:crypto';
import {mkdirSync, realpathSync, lstatSync, writeFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {Run, TaskContract} from '../contracts/p1.js';
import type {RuntimeRecord, RuntimeOperation} from '../contracts/p3.js';
import type {MaterialsReceipt} from '../contracts/p8-research-runtime.js';
import type {ResearchGroupsRequest, ResearchGroupsRecord, ResearchGroupsPrepared,
  ResearchGroupInput, ResearchGroupTaskBinding, ResearchGroupsInstalled} from '../contracts/p8-research-groups.js';
import type {ScheduledRecord, ScheduledClaim} from '../contracts/p7-dispatch.js';
import type {ExecutionRecord} from '../contracts/p2.js';
import type {ResearchGroupCompletion, ResearchGroupsAggregate} from '../contracts/p8-research-group-output.js';
import {reconstructResearchGroup, researchGroupPrompt} from '../orchestration/research-group-output.js';
import {researchCompletionEvents} from '../workspace/research-runtime-files.js';
import {safeResultJSON} from '../contracts/p7-results.js';
import {futureVerificationFloor} from '../domain/index.js';
import {installResearchGroupGraph} from '../domain/research-groups.js';
import {projectResearchEvidence, researchDigest} from '../workspace/research-materials.js';
import {assertMaterialsReceipt, assertMaterialsStepReceipt, bytesDigest, readBounded} from '../workspace/research-runtime-files.js';
import {TaskResultRepository} from './task-results.js';
import {ConversationRepository} from './conversations.js';
import {canonical} from '../verification/candidate.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw Error('Research groups: ' + message);
}
function integer(value: number, min: number, max = Number.MAX_SAFE_INTEGER): void {
  ensure(Number.isSafeInteger(value) && value >= min && value <= max, 'invalid bounded integer');
}
function text(value: string, max = 200): void {
  ensure(typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0'), 'invalid text');
}
function exact(value: object, keys: string[]): void {
  ensure(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'unknown or missing fields');
}
function configuration(record: ResearchGroupsRecord) {
  const {state: _state, prepared: _prepared, schedulerId: _schedulerId, configurationDigest: _digest, blockedReason: _blockedReason, retirement: _retirement, ...body} = record;
  return body;
}
function tables(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_group_registrations'").get();
}
/** Retirement is usable only after the original runtime revision receipt exists.
 * A mutable state flag alone cannot remove a current analysis fence. */
function assertRetired(db: DatabaseSync, record: ResearchGroupsRecord): void {
  const retired = record.retirement;
  ensure(record.state === 'retired' && retired, 'retirement receipt missing');
  const row = db.prepare('SELECT request FROM runtime_receipts WHERE command_id=?').get(retired.commandId);
  ensure(row, 'retirement is not committed by an actual runtime revision');
  const request = JSON.parse(String(row.request)) as {runtimeId: string; expectedContractVersion: number; contract: TaskContract};
  ensure(request.runtimeId === record.runtimeId && request.expectedContractVersion === record.contractVersion &&
    retired.previousContractVersion === record.contractVersion && retired.previousContractDigest === record.contractDigest &&
    retired.contractVersion > record.contractVersion && researchDigest(request.contract) === retired.contractDigest &&
    request.contract.version === retired.contractVersion && Number.isSafeInteger(retired.runRevision) && retired.runRevision > 0,
    'retirement differs from the actual revision receipt');
  const events = db.prepare("SELECT record FROM research_group_events WHERE registration_id=? AND kind='contract-revision-retired'").all(record.id);
  ensure(events.length === 1 && canonical(JSON.parse(String(events[0]!.record))) === canonical(retired), 'retirement audit changed');
}
/** Called only inside the existing host runtime.revise transaction, after its
 * domain action and existing physical/usage/lease scheduler retirement checks. */
export function retireResearchGroupsForRevision(db: DatabaseSync, runtime: RuntimeRecord,
  previous: Run, next: Run, commandId: string): void {
  ensure(db.isTransaction, 'group retirement must join the actual runtime revision');
  if (!tables(db)) return;
  const row = db.prepare('SELECT record FROM research_group_registrations WHERE runtime_id=?').get(runtime.id);
  if (!row) return;
  const record = JSON.parse(String(row.record)) as ResearchGroupsRecord;
  ensure(researchDigest(configuration(record)) === record.configurationDigest, 'immutable configuration changed');
  if (record.state === 'retired') {assertRetired(db, record); return;}
  ensure(record.projectId === runtime.projectId && record.runId === runtime.runId &&
    previous.id === runtime.runId && previous.projectId === runtime.projectId &&
    record.contractVersion === previous.contract.version && record.contractDigest === researchDigest(previous.contract) &&
    record.definitionDigest === researchDigest(runtime.definition), 'old group revision boundary changed');
  const actualRow = db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(runtime.projectId, runtime.runId);
  ensure(actualRow && canonical(JSON.parse(String(actualRow.snapshot))) === canonical(next) &&
    next.contract.version > previous.contract.version && next.budget.spent === previous.budget.spent &&
    previous.attempts.every(attempt => attempt.settled && attempt.status !== 'running') &&
    previous.operations.every(operation => operation.status === 'confirmed') && previous.leases.every(lease => lease.released),
    'actual quiet Run revision required; unknown accounting cannot be retired');
  if (record.schedulerId) {
    const schedulerRow = db.prepare('SELECT record FROM scheduled_records WHERE id=?').get(record.schedulerId);
    ensure(schedulerRow, 'old group scheduler missing');
    const scheduler = JSON.parse(String(schedulerRow.record)) as ScheduledRecord;
    ensure(scheduler.state === 'cancelled' && scheduler.fence === 'released' &&
      scheduler.plan.contractVersion === previous.contract.version && scheduler.plan.contractDigest === record.contractDigest,
      'existing runtime scheduler retirement has not completed');
  }
  const retirement = {commandId, previousContractVersion: previous.contract.version,
    previousContractDigest: record.contractDigest, contractVersion: next.contract.version,
    contractDigest: researchDigest(next.contract), runRevision: next.revision};
  record.state = 'retired'; record.retirement = retirement;
  db.prepare('UPDATE research_group_registrations SET record=? WHERE id=?').run(canonical(record), record.id);
  db.prepare('INSERT INTO research_group_events(registration_id,kind,record) VALUES(?,?,?)')
    .run(record.id, 'contract-revision-retired', canonical(retirement));
}
/** Separate pre-install fence blocks only the existing native analysis step.
 * With no registration ordinary runtimes retain their original behavior. */
export function researchGroupsAnalysisFenced(db: DatabaseSync, runtime: RuntimeRecord, stepId: string): boolean {
  if (!tables(db)) return false;
  const row = db.prepare('SELECT record FROM research_group_registrations WHERE runtime_id=?').get(runtime.id);
  if (!row) return false;
  const record = JSON.parse(String(row.record)) as ResearchGroupsRecord;
  ensure(record.runtimeId === runtime.id && record.projectId === runtime.projectId &&
    record.runId === runtime.runId && researchDigest(configuration(record)) === record.configurationDigest,
    'registration scope or configuration changed');
  if (record.state === 'retired') {assertRetired(db, record); return false;}
  if (stepId !== record.analysisStepId) return false;
  const runRow = db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(runtime.projectId, runtime.runId);
  ensure(runRow, 'original Run missing');
  const run = JSON.parse(String(runRow.snapshot)) as Run;
  ensure(run.contract.version === record.contractVersion && researchDigest(run.contract) === record.contractDigest &&
    researchDigest(runtime.definition) === record.definitionDigest, 'analysis fence contract changed');
  return record.state !== 'installed';
}
/** Installed input changes block the associated branch, without stopping an
 * unrelated feasible group. Unknown inputs never become dispatch permission. */
export function unavailableResearchGroups(db: DatabaseSync, dataRoot: string, schedulerId: string): string[] {
  if (!tables(db)) return [];
  const row = db.prepare("SELECT record FROM research_group_registrations WHERE json_extract(record,'$.schedulerId')=?").get(schedulerId);
  if (!row) return [];
  const record = JSON.parse(String(row.record)) as ResearchGroupsRecord;
  const repo = new ResearchGroupsRepository(db, dataRoot);
  return record.groups.flatMap(group => {
    try {
      const input = record.prepared?.inputs.find(item => item.groupId === group.id);
      ensure(input, 'prepared group input missing');
      repo.readGroup({schemaVersion: 1, registrationId: record.id, groupId: group.id, inputDigest: input.digest});
      return [];
    } catch { return ['research-group-' + group.id]; }
  });
}
/** Uses the same SQLite connection and joins parent transactions. Acquisition
 * receipts are host inputs, never fabricated TaskResult publications. */
export class ResearchGroupsRepository {
  constructor(private readonly db: DatabaseSync, private readonly dataRoot: string,
    private readonly now: () => number = Date.now,
    private readonly fault: ((point: string) => void) | undefined = undefined) {}
  private tx<T>(work: () => T): T {
    const own = !this.db.isTransaction;
    this.db.exec(own ? 'BEGIN IMMEDIATE' : 'SAVEPOINT research_groups_call');
    try {
      const result = work();
      ensure(!result || typeof (result as {then?: unknown}).then !== 'function', 'async transaction forbidden');
      this.db.exec(own ? 'COMMIT' : 'RELEASE research_groups_call');
      return result;
    } catch (error) {
      this.db.exec(own ? 'ROLLBACK' : 'ROLLBACK TO research_groups_call');
      if (!own) this.db.exec('RELEASE research_groups_call');
      throw error;
    }
  }
  private prior<T>(commandId: string, request: unknown): T | undefined {
    text(commandId); safeResultJSON(request);
    const row = this.db.prepare('SELECT request,result FROM research_group_receipts WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    ensure(row.request === canonical(request), 'command conflict');
    return JSON.parse(String(row.result)) as T;
  }
  private remember(commandId: string, request: unknown, result: unknown): void {
    this.db.prepare('INSERT INTO research_group_receipts VALUES(?,?,?)').run(commandId, canonical(request), canonical(result));
  }
  get(id: string): ResearchGroupsRecord {
    const row = this.db.prepare('SELECT record FROM research_group_registrations WHERE id=?').get(id);
    ensure(row, 'unknown registration');
    const record = JSON.parse(String(row.record)) as ResearchGroupsRecord;
    ensure(record.id === id && researchDigest(configuration(record)) === record.configurationDigest, 'immutable configuration changed');
    if (record.state === 'retired') assertRetired(this.db, record);
    return record;
  }
  byRuntime(runtimeId: string): ResearchGroupsRecord | null {
    const row = this.db.prepare('SELECT id FROM research_group_registrations WHERE runtime_id=?').get(runtimeId);
    const record = row ? this.get(String(row.id)) : null;
    return record?.state === 'retired' ? null : record;
  }
  block(id: string, reason: string): void {
    text(reason, 12000);
    this.tx(() => {
      const record = this.get(id);
      ensure(record.state !== 'installed' && record.state !== 'retired', 'installed or retired scheduler cannot change installation state');
      if (record.state === 'blocked' && record.blockedReason === reason) return;
      record.state = 'blocked'; record.blockedReason = reason;
      this.db.prepare('UPDATE research_group_registrations SET record=? WHERE id=?').run(canonical(record), id);
      this.event(id, 'blocked', {reason});
    });
  }
  private actual(record: ResearchGroupsRecord) {
    ensure(record.state !== 'retired', 'old retired group input cannot authorize new work');
    const row = this.db.prepare('SELECT record FROM runtime_runs WHERE id=?').get(record.runtimeId);
    ensure(row, 'native runtime missing');
    const runtime = JSON.parse(String(row.record)) as RuntimeRecord;
    const runRow = this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(record.projectId, record.runId);
    ensure(runRow, 'native Run missing');
    const run = JSON.parse(String(runRow.snapshot)) as Run;
    ensure(runtime.engine === 'local-v1' && runtime.workflowVersion === 1 && runtime.projectId === run.projectId &&
      runtime.runId === run.id && record.projectId === run.projectId && record.runId === run.id &&
      run.contract.version === record.contractVersion && researchDigest(run.contract) === record.contractDigest &&
      researchDigest(runtime.definition) === record.definitionDigest, 'native scope, definition or contract changed');
    const [materials, analysis] = runtime.definition.steps;
    ensure(runtime.definition.steps.length === 2 && materials?.kind === 'materials' && analysis?.kind === 'codex' &&
      analysis.research && analysis.research.acquisitionStepId === materials.id &&
      record.acquisitionStepId === materials.id && record.analysisStepId === analysis.id, 'initial native material/analysis pair required');
    const operations = this.db.prepare('SELECT record FROM runtime_outbox WHERE runtime_id=? ORDER BY rowid').all(runtime.id)
      .map(item => JSON.parse(String(item.record)) as RuntimeOperation);
    return {runtime, run, materials, analysis, operations};
  }
  private active(record: ResearchGroupsRecord): ReturnType<ResearchGroupsRepository['actual']> {
    const actual = this.actual(record);
    ensure(!actual.runtime.paused && !actual.runtime.cancelled && ['ready', 'running'].includes(actual.run.status) &&
      actual.run.admission !== 'draft', 'native work paused, cancelled or terminal');
    ensure(!new ConversationRepository(this.db).hasPendingForRun(record.projectId, record.runId), 'pending follow-up blocks group installation');
    return actual;
  }
  private capacity(record: ResearchGroupsRecord, run: Run, reservation: number): void {
    const protectedReserve = Math.max(0, run.budget.verificationReserve - run.attempts
      .filter(attempt => attempt.purpose === 'verification' && attempt.contractVersion === run.contract.version)
      .reduce((sum, attempt) => sum + (attempt.settled ? attempt.actual! : attempt.reservation), 0));
    const groups = record.groups.reduce((sum, group) => sum + group.reservation, 0);
    ensure(Number.isSafeInteger(groups) && Number.isSafeInteger(run.budget.spent + groups + reservation +
      Math.max(protectedReserve, futureVerificationFloor(run))) && run.budget.spent + groups + reservation +
      Math.max(protectedReserve, futureVerificationFloor(run)) <= run.budget.limit,
      'unchanged Run cannot fund all mandatory groups plus original final analysis and P4');
  }
  register(input: ResearchGroupsRequest): ResearchGroupsRecord {
    safeResultJSON(input); exact(input, ['commandId', 'runtimeId', 'expectedRunRevision', 'groups', 'maxActive', 'tier']);
    const request = structuredClone(input);
    return this.tx(() => {
      const prior = this.prior<ResearchGroupsRecord>(request.commandId, request);
      if (prior) return prior;
      text(request.runtimeId); integer(request.expectedRunRevision, 0); integer(request.maxActive, 1, 5);
      ensure(['low', 'medium', 'high', 'unlimited'].includes(request.tier) && Array.isArray(request.groups) &&
        request.groups.length > 0 && request.groups.length <= 32, 'bounded group plan required');
      const row = this.db.prepare('SELECT record FROM runtime_runs WHERE id=?').get(request.runtimeId);
      ensure(row, 'native runtime missing');
      const runtime = JSON.parse(String(row.record)) as RuntimeRecord;
      const runRow = this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(runtime.projectId, runtime.runId);
      ensure(runRow, 'native Run missing');
      const run = JSON.parse(String(runRow.snapshot)) as Run;
      const [materials, analysis] = runtime.definition.steps;
      ensure(materials?.kind === 'materials' && analysis?.kind === 'codex' && analysis.research &&
        runtime.definition.steps.length === 2 && analysis.research.acquisitionStepId === materials.id, 'native research pair required');
      const now = this.now(); integer(now, 0);
      const body = {schemaVersion: 1 as const, id: 'research-groups-' + hash(request.commandId + ':' + runtime.id),
        runtimeId: runtime.id, projectId: runtime.projectId, runId: runtime.runId,
        contractVersion: run.contract.version, contractDigest: researchDigest(run.contract),
        definitionDigest: researchDigest(runtime.definition), acquisitionStepId: materials.id, analysisStepId: analysis.id,
        groups: request.groups, maxActive: request.maxActive, tier: request.tier,
        registeredAtMs: now, deadlineMs: now + analysis.timeoutMs};
      integer(body.deadlineMs, now + 1);
      const record: ResearchGroupsRecord = {...body, configurationDigest: researchDigest(body),
        state: 'waiting-materials', prepared: null, schedulerId: null};
      const actual = this.active(record);
      ensure(run.revision === request.expectedRunRevision && runtime.cursor === 0 && run.nodes.length === 2 &&
        run.nodes[0]!.id === materials.id && run.nodes[0]!.dependencies.length === 0 &&
        run.nodes[1]!.id === analysis.id && run.nodes[1]!.required &&
        run.nodes[1]!.dependencies.length === 1 && run.nodes[1]!.dependencies[0] === materials.id &&
        run.nodes.every(node => node.status === 'pending') && !run.artifact && run.evidence.length === 0 &&
        run.attempts.every(attempt => attempt.purpose === 'reasoning' && attempt.settled && attempt.status !== 'running') &&
        run.operations.every(operation => operation.status === 'confirmed') && run.leases.every(lease => lease.released) &&
        actual.operations.length === 1 && actual.operations[0]!.state === 'queued' &&
        actual.operations[0]!.step.id === materials.id &&
        !this.db.prepare('SELECT 1 FROM scheduled_records WHERE runtime_id=?').get(runtime.id), 'initial quiet native graph CAS required');
      const ids = new Set<string>(); const purposes = new Set<string>();
      for (const group of record.groups) {
        exact(group, ['id', 'purpose', 'materialIds', 'criterionIds', 'reservation']);
        text(group.id, 80); ensure(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(group.id) && !ids.has(group.id), 'unique safe group id required');
        ids.add(group.id); text(group.purpose, 2000); integer(group.reservation, 1, analysis.reservation);
        ensure(Array.isArray(group.materialIds) && group.materialIds.length > 0 && group.materialIds.length <= materials.inputs.length &&
          new Set(group.materialIds).size === group.materialIds.length &&
          group.materialIds.every(id => materials.inputs.some(source => source.id === id)), 'unknown or duplicate material reference');
        ensure(Array.isArray(group.criterionIds) && group.criterionIds.length > 0 &&
          new Set(group.criterionIds).size === group.criterionIds.length && group.criterionIds.every(id =>
            run.contract.criteria.some(criterion => criterion.id === id && criterion.required) &&
            analysis.research!.requirements.some(requirement => requirement.criterionId === id)), 'original required criterion references only');
        const key = researchDigest({purpose: group.purpose, materials: [...group.materialIds].sort(), criteria: [...group.criterionIds].sort()});
        ensure(!purposes.has(key), 'duplicate extraction scope is not an independent purpose'); purposes.add(key);
      }
      ensure(materials.inputs.every(source => record.groups.some(group => group.materialIds.includes(source.id))),
        'every declared material including unsupported or failed inputs must be assigned');
      for (const requirement of analysis.research.requirements) {
        if (run.contract.criteria.some(criterion => criterion.id === requirement.criterionId && criterion.required)) {
          ensure(requirement.requiredMaterialIds.every(id => record.groups.some(group =>
            group.criterionIds.includes(requirement.criterionId) && group.materialIds.includes(id))), 'mandatory question/material coverage omitted');
        }
      }
      this.capacity(record, run, analysis.reservation);
      const results = new TaskResultRepository(this.db, this.dataRoot);
      const scope = {projectId: run.projectId, runId: run.id};
      if (!this.db.prepare('SELECT 1 FROM task_result_ledgers WHERE project_id=? AND run_id=?').get(run.projectId, run.id)) {
        results.initializeScope({...scope, commandId: request.commandId + ':result-scope'});
      }
      const ledger = results.inspect(scope);
      ensure(ledger.versions.length === 0 && ledger.consumers.length === 0, 'initial group graph cannot reuse old result inputs');
      this.db.prepare('INSERT INTO research_group_registrations VALUES(?,?,?)').run(record.id, runtime.id, canonical(record));
      this.event(record.id, 'analysis-fenced', {configurationDigest: record.configurationDigest, runRevision: run.revision});
      this.remember(request.commandId, request, record);
      return record;
    });
  }
  private event(id: string, kind: string, value: unknown): void {
    this.db.prepare('INSERT INTO research_group_events(registration_id,kind,record) VALUES(?,?,?)').run(id, kind, canonical(value));
  }
  private acquired(record: ResearchGroupsRecord, quiet = true) {
    const actual = quiet ? this.active(record) : this.actual(record);
    const material = actual.operations.find(operation => operation.step.id === record.acquisitionStepId);
    const analysis = actual.operations.find(operation => operation.step.id === record.analysisStepId);
    ensure(actual.operations.length === 2 && material?.state === 'confirmed' &&
      material.step.kind === 'materials' && analysis && analysis.step.kind === 'codex' && analysis.step.research &&
      material.contractVersion === record.contractVersion && analysis.contractVersion === record.contractVersion &&
      researchDigest(material.step) === researchDigest(actual.materials) && researchDigest(analysis.step) === researchDigest(actual.analysis),
      'actual known material receipt and unclaimed analysis required');
    if (quiet) ensure(actual.runtime.cursor === 1 && analysis.state === 'queued' && analysis.owner === null &&
      analysis.result === null && actual.run.attempts.every(attempt => attempt.settled && attempt.status !== 'running') &&
      actual.run.operations.every(operation => operation.status === 'confirmed') && actual.run.leases.every(lease => lease.released),
      'unknown accounting, effects or writer blocks installation');
    const receipt = (material.result as {kind?: string; receipt?: MaterialsReceipt} | null)?.receipt;
    ensure(receipt && (material.result as {kind?: string}).kind === 'materials' && receipt.index.disposition === 'completed',
      'actual completed acquisition receipt required');
    assertMaterialsReceipt(receipt, material.id, material.attemptId, material.contractVersion, this.dataRoot);
    assertMaterialsStepReceipt(receipt, material);
    const path = join(this.dataRoot, 'materials-receipts', bytesDigest(material.id), 'receipt.json');
    ensure(researchDigest(JSON.parse(readBounded(path).toString('utf8'))) === researchDigest(receipt), 'actual archived receipt changed');
    ensure(actual.run.attempts.some(attempt => attempt.id === material.attemptId && attempt.nodeId === material.step.id &&
      attempt.purpose === 'execution' && attempt.status === 'succeeded' && attempt.settled && attempt.actual === 0) &&
      actual.run.operations.some(operation => operation.id === material.id && operation.attemptId === material.attemptId &&
        operation.status === 'confirmed'), 'actual settled materials ledger missing');
    if (quiet) this.capacity(record, actual.run, actual.analysis.reservation);
    return {...actual, materialOperation: material, analysisOperation: analysis, receipt};
  }
  private directory(...parts: string[]): string {
    let path = realpathSync(this.dataRoot);
    ensure(path === resolve(this.dataRoot), 'data root alias');
    for (const part of parts) {
      ensure(/^[a-zA-Z0-9_-]+$/.test(part), 'unsafe private directory'); path = join(path, part);
      mkdirSync(path, {recursive: true, mode: 0o700});
      ensure(realpathSync(path) === path && !lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory(), 'managed directory alias');
    }
    return path;
  }
  private input(record: ResearchGroupsRecord, groupId: string): ResearchGroupInput {
    const actual = this.acquired(record, false), group = record.groups.find(item => item.id === groupId);
    ensure(group, 'unknown group');
    const context = projectResearchEvidence(actual.run.contract, actual.analysis.research!.requirements,
      actual.analysis.research!.limits, actual.receipt.index);
    const sources = group.materialIds.map(id => {
      const entry = context.index.entries.find(item => item.id === id)!;
      let text: string | null = null;
      if (entry.status === 'success' && entry.text?.complete) {
        const buffer = readBounded(join(context.index.directory, entry.text.path), context.index.limits.maxItemBytes);
        ensure(buffer.length === entry.text.size && bytesDigest(buffer) === entry.text.sha256,
          'source buffer changed after archive inspection');
        text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buffer);
      }
      return {materialId: id, text, status: entry.status};
    });
    const body = {schemaVersion: 1 as const, authority: 'untrusted-group-extraction-only' as const,
      registrationId: record.id, group: structuredClone(group), materialReceiptDigest: actual.receipt.digest, context, sources};
    ensure(canonical(body).length <= actual.analysis.research!.limits.maxContextChars,
      'full bound group context capacity exceeded; no source or failed coverage is silently removed');
    return {...body, digest: researchDigest(body)};
  }
  private derivePrepared(record: ResearchGroupsRecord): ResearchGroupsPrepared {
    const actual = this.acquired(record, false);
    const inputs = record.groups.map(group => {
      const input = this.input(record, group.id);
      const path = join(realpathSync(this.dataRoot), 'research-group-inputs', hash(record.id), group.id, 'input.json');
      const workspace = join(realpathSync(this.dataRoot), 'research-group-workspaces', hash(record.id), group.id);
      return {groupId: group.id, path, digest: input.digest, workspace};
    });
    const plan = {schemaVersion: 1 as const, engine: 'scheduled-v1' as const, workflowVersion: 2 as const,
      id: 'research-scheduler-' + hash(record.id), runtimeId: record.runtimeId,
      projectId: record.projectId, runId: record.runId, revision: 1,
      contractVersion: record.contractVersion, contractDigest: record.contractDigest,
      integrationNodeId: record.analysisStepId, tier: record.tier, loops: [],
      limits: {maxActive: record.maxActive, maxNodes: record.groups.length, maxDepth: 1, deadlineMs: record.deadlineMs},
      tasks: record.groups.map(group => {
        const input = inputs.find(item => item.groupId === group.id)!;
        const nodeId = 'research-group-' + group.id;
        return {researchGroup: {schemaVersion: 1 as const, registrationId: record.id, groupId: group.id, inputDigest: input.digest},
          node: {id: nodeId, dependencies: [], required: true, reservation: group.reservation, loopIds: [],
            resources: [{kind: 'path' as const, key: input.workspace, mode: 'write' as const}],
            admission: {authorized: true, executable: true, relevant: true, duplicate: false,
              independentVerificationPurpose: null, requirementRefs: [...group.criterionIds], quality: 'supported' as const,
              value: 'supported' as const, reasons: ['Host-bound original questions and frozen material receipt; submitted extraction only']}},
          inputRequirements: [], workspace: input.workspace, workspaceKind: 'managed' as const, generation: 1,
          step: {id: nodeId, kind: 'codex' as const, prompt: researchGroupPrompt(this.input(record, group.id)),
            model: actual.analysis.model, effort: actual.analysis.effort,
            reservation: group.reservation, timeoutMs: actual.analysis.timeoutMs}};
      })};
    const body = {schemaVersion: 1 as const, registrationId: record.id, materialOperationId: actual.materialOperation.id,
      materialReceiptDigest: actual.receipt.digest, analysisOperationId: actual.analysisOperation.id,
      analysisAttemptId: actual.analysisOperation.attemptId, inputs, plan};
    return {...body, digest: researchDigest(body)};
  }
  prepare(id: string): ResearchGroupsPrepared {
    ensure(!this.db.isTransaction, 'filesystem preparation must be outside transaction');
    const record = this.get(id), actual = this.acquired(record);
    ensure(this.now() < record.deadlineMs && ['waiting-materials', 'prepared'].includes(record.state), 'preparation closed');
    const prepared = this.derivePrepared(record);
    for (const item of prepared.inputs) {
      const input = this.input(record, item.groupId);
      this.directory('research-group-inputs', hash(record.id), item.groupId);
      try { writeFileSync(item.path, canonical(input), {flag: 'wx', mode: 0o600}); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        ensure(readBounded(item.path).toString('utf8') === canonical(input), 'partial or conflicting input retained');
      }
      const workspace = this.directory('research-group-workspaces', hash(record.id), item.groupId);
      ensure(workspace === item.workspace && readdirSync(workspace).length === 0, 'unstarted managed workspace contains unowned bytes');
    }
    this.tx(() => {
      const latest = this.get(id); this.acquired(latest);
      ensure(researchDigest(configuration(latest)) === researchDigest(configuration(record)) &&
        latest.state !== 'installed' && this.now() < record.deadlineMs, 'preparation boundary changed');
      if (latest.prepared) {
        ensure(researchDigest(latest.prepared) === researchDigest(prepared), 'preparation conflict');
        return;
      }
      latest.prepared = prepared; latest.state = 'prepared';
      this.db.prepare('UPDATE research_group_registrations SET record=? WHERE id=?').run(canonical(latest), id);
      this.event(id, 'prepared', {digest: prepared.digest, materialReceiptDigest: actual.receipt.digest});
    });
    return prepared;
  }
  readGroup(binding: ResearchGroupTaskBinding): ResearchGroupInput {
    safeResultJSON(binding); exact(binding, ['schemaVersion', 'registrationId', 'groupId', 'inputDigest']);
    ensure(binding.schemaVersion === 1, 'unsupported binding');
    const record = this.get(binding.registrationId), saved = record.prepared?.inputs.find(item => item.groupId === binding.groupId);
    ensure(saved && saved.digest === binding.inputDigest, 'frozen input binding changed');
    ensure(saved.path === join(realpathSync(this.dataRoot), 'research-group-inputs', hash(record.id), binding.groupId, 'input.json'),
      'group input is outside its exact host-owned path');
    const actual = this.input(record, binding.groupId);
    ensure(actual.digest === binding.inputDigest && researchDigest(JSON.parse(readBounded(saved.path).toString('utf8'))) ===
      researchDigest(actual), 'actual input bytes or material receipt changed');
    return actual;
  }
  install(input: {commandId: string; id: string; expectedRunRevision: number; expectedResultRevision: number}): ResearchGroupsInstalled {
    safeResultJSON(input); exact(input, ['commandId', 'id', 'expectedRunRevision', 'expectedResultRevision']);
    const request = structuredClone(input);
    return this.tx(() => {
      const prior = this.prior<ResearchGroupsInstalled>(request.commandId, request);
      if (prior) return prior;
      const record = this.get(request.id), actual = this.acquired(record), prepared = record.prepared;
      ensure(record.state === 'prepared' && prepared && this.now() < record.deadlineMs,
        'actual persisted preparation is not ready');
      const {digest: _digest, ...body} = prepared;
      ensure(researchDigest(body) === prepared.digest && prepared.registrationId === record.id &&
        prepared.materialOperationId === actual.materialOperation.id && prepared.materialReceiptDigest === actual.receipt.digest &&
        prepared.analysisOperationId === actual.analysisOperation.id && prepared.analysisAttemptId === actual.analysisOperation.attemptId,
        'persisted preparation boundary changed');
      ensure(researchDigest(prepared) === researchDigest(this.derivePrepared(record)), 'host-derived plan or input paths changed');
      ensure(actual.run.revision === request.expectedRunRevision &&
        new TaskResultRepository(this.db, this.dataRoot).inspect({projectId: actual.run.projectId, runId: actual.run.id}).revision === request.expectedResultRevision,
        'installation CAS stale');
      ensure(!this.db.prepare('SELECT 1 FROM scheduled_records WHERE runtime_id=?').get(record.runtimeId), 'scheduler already installed');
      for (const item of prepared.inputs) {
        this.readGroup({schemaVersion: 1, registrationId: record.id, groupId: item.groupId, inputDigest: item.digest});
        ensure(item.workspace === join(realpathSync(this.dataRoot), 'research-group-workspaces', hash(record.id), item.groupId) &&
          realpathSync(item.workspace) === item.workspace && !lstatSync(item.workspace).isSymbolicLink() &&
          readdirSync(item.workspace).length === 0, 'managed group workspace changed');
      }
      const next = installResearchGroupGraph({run: actual.run, plan: prepared.plan,
        acquisitionNodeId: record.acquisitionStepId, acquisitionAttemptId: actual.materialOperation.attemptId,
        acquisitionOperationId: actual.materialOperation.id, analysisAttemptId: actual.analysisOperation.attemptId,
        analysisReservation: actual.analysis.reservation, sha256: hash});
      const scheduler: ScheduledRecord = {id: prepared.plan.id, plan: structuredClone(prepared.plan),
        planDigest: researchDigest(prepared.plan), revision: 0, state: 'active', fence: 'held'};
      const changed = this.db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=? AND revision=?')
        .run(canonical(next.run), next.run.revision, record.projectId, record.runId, actual.run.revision);
      ensure(changed.changes === 1, 'Run CAS failed');
      for (const event of next.events) this.db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES(?,?,?,?,?)')
        .run(request.commandId, record.projectId, record.runId, event.type, canonical(event));
      this.db.prepare('INSERT INTO scheduled_plans VALUES(?,?,?)').run(scheduler.id, scheduler.planDigest, canonical(scheduler.plan));
      this.db.prepare('INSERT INTO scheduled_records VALUES(?,?,?,?,?)').run(scheduler.id, record.runtimeId, record.projectId, record.runId, canonical(scheduler));
      this.db.prepare('INSERT INTO scheduled_events(scheduler_id,kind,record) VALUES(?,?,?)').run(scheduler.id, 'research-groups-installed',
        canonical({registrationId: record.id, preparedDigest: prepared.digest, materialReceiptDigest: actual.receipt.digest}));
      record.state = 'installed'; record.schedulerId = scheduler.id;
      this.db.prepare('UPDATE research_group_registrations SET record=? WHERE id=?').run(canonical(record), record.id);
      this.event(record.id, 'installed', {schedulerId: scheduler.id, planDigest: scheduler.planDigest});
      const result = {registration: record, scheduler};
      this.remember(request.commandId, request, result);
      this.fault?.('research-groups-before-install-commit');
      return result;
    });
  }
  inputForClaim(claim: ScheduledClaim): ResearchGroupInput | null {
    const row = this.db.prepare('SELECT record FROM scheduled_records WHERE id=?').get(claim.schedulerId);
    ensure(row, 'scheduler missing');
    const scheduler = JSON.parse(String(row.record)) as ScheduledRecord;
    const task = scheduler.plan.tasks.find(task => task.node.id === claim.taskId && task.generation === claim.generation);
    ensure(task, 'claim task no longer current');
    if (!task.researchGroup) return null;
    const actualClaim = this.db.prepare('SELECT record FROM scheduled_claims WHERE id=?').get(claim.id);
    ensure(actualClaim && canonical(JSON.parse(String(actualClaim.record))) === canonical(claim), 'actual claim changed');
    const record = this.get(task.researchGroup.registrationId);
    ensure(record.state === 'installed' && record.schedulerId === scheduler.id && record.prepared &&
      researchDigest(record.prepared.plan) === scheduler.planDigest && researchDigest(scheduler.plan) === scheduler.planDigest &&
      claim.planDigest === scheduler.planDigest && claim.planRevision === scheduler.plan.revision &&
      task.researchGroup.groupId === record.groups.find(group => 'research-group-' + group.id === claim.taskId)?.id,
      'actual installed group plan/generation changed');
    return this.readGroup(task.researchGroup);
  }
  assertDispatch(claim: ScheduledClaim): ResearchGroupInput | null {
    const input = this.inputForClaim(claim);
    if (!input) return null;
    const record = this.get(input.registrationId), actual = this.active(record);
    ensure(this.now() < record.deadlineMs && actual.runtime.cursor === 1 &&
      actual.operations.find(operation => operation.step.id === record.analysisStepId)?.state === 'queued',
      'original analysis or group dispatch boundary closed');
    return input;
  }
  /** Pure reconstruction plus actual same-turn DB and owned FS evidence. Existing
   * TaskResult publication still independently proves physical stop/accounting. */
  assertCompletion(execution: ExecutionRecord): ResearchGroupCompletion | null {
    if (!execution.scheduledBinding) return null;
    const row = this.db.prepare('SELECT record FROM scheduled_claims WHERE id=?').get(execution.scheduledBinding.claimId);
    ensure(row, 'completion claim missing');
    const claim = JSON.parse(String(row.record)) as ScheduledClaim, input = this.inputForClaim(claim);
    if (!input) return null;
    const actualRow = this.db.prepare('SELECT record FROM executions WHERE id=?').get(execution.id);
    ensure(actualRow && canonical(JSON.parse(String(actualRow.record))) === canonical(execution), 'completion execution changed');
    ensure(execution.id === claim.attemptId && execution.scheduledBinding.operationId === claim.operationId &&
      execution.state === 'completed' && execution.stopConfirmed && !execution.cancelRequested && !execution.error &&
      execution.usageStatus === 'reported' && execution.usage && execution.usage.totalTokens <= claim.reservation,
      'completion is not actual known successful stopped claim');
    const readEvents = (after: number) => this.db.prepare('SELECT * FROM execution_events WHERE execution_id=? AND seq>? ORDER BY seq LIMIT 500')
      .all(execution.id, after).map(row => ({seq: Number(row.seq), executionId: String(row.execution_id),
        receivedAt: String(row.received_at), kind: String(row.kind), payload: JSON.parse(String(row.payload))}));
    researchCompletionEvents(execution, readEvents);
    const path = join(realpathSync(this.dataRoot), 'research-group-completions', hash(execution.id), 'receipt.json');
    const receipt = JSON.parse(readBounded(path).toString('utf8')) as ResearchGroupCompletion;
    ensure(Number.isSafeInteger(receipt.eventPrefixSeq) && receipt.eventPrefixSeq <= execution.lastEventSeq, 'invalid actual completion prefix');
    const events = researchCompletionEvents({...execution, lastEventSeq: receipt.eventPrefixSeq}, readEvents);
    const {digest: _digest, ...body} = receipt;
    const draft = reconstructResearchGroup(input, execution.message);
    const contents = canonical(draft), files = {'extraction.json': bytesDigest(contents)};
    ensure(receipt.schemaVersion === 1 && receipt.executionId === execution.id && receipt.claimId === claim.id &&
      receipt.inputDigest === input.digest && receipt.threadId === execution.threadId && receipt.turnId === execution.turnId &&
      receipt.rawOutputDigest === bytesDigest(execution.message) && researchDigest(body) === receipt.digest &&
      canonical(receipt.draft) === canonical(draft) && canonical(receipt.files) === canonical(files) &&
      canonical(receipt.completionEvents) === canonical(events), 'actual group completion proof differs');
    return receipt;
  }
  aggregate(runtimeId: string): ResearchGroupsAggregate | null {
    const record = this.byRuntime(runtimeId);
    if (!record) return null;
    ensure(record.state === 'installed' && record.prepared && record.schedulerId, 'group extraction installation incomplete');
    const schedulerRow = this.db.prepare('SELECT record FROM scheduled_records WHERE id=?').get(record.schedulerId);
    ensure(schedulerRow, 'installed scheduler missing');
    const scheduler = JSON.parse(String(schedulerRow.record)) as ScheduledRecord;
    ensure(scheduler.fence === 'released' && scheduler.state === 'drained' &&
      researchDigest(scheduler.plan) === researchDigest(record.prepared.plan), 'full actual submitted groups have not drained');
    const scope = {projectId: record.projectId, runId: record.runId}, results = new TaskResultRepository(this.db, this.dataRoot), ledger = results.inspect(scope);
    const groups = record.groups.map(group => {
      const taskId = 'research-group-' + group.id, head = ledger.heads.find(head => head.taskId === taskId);
      ensure(head, 'mandatory group result missing');
      const version = ledger.versions.find(version => researchDigest(version.ref) === researchDigest(head.ref));
      ensure(version?.state === 'submitted' && version.manifest.generation === 1, 'group output is not current untrusted submitted generation');
      const pack = results.readPublished({...scope, ref: head.ref, minimumState: 'submitted'});
      ensure(pack.files.length === 1 && pack.files[0]!.relativePath === 'extraction.json', 'complete exact group artifact required');
      const executionRow = this.db.prepare('SELECT record FROM executions WHERE id=?').get(version.manifest.attemptId);
      ensure(executionRow, 'group actual producer missing');
      const execution = JSON.parse(String(executionRow.record)) as ExecutionRecord, completion = this.assertCompletion(execution);
      ensure(completion, 'group completion missing');
      const file = join(pack.directory, 'files', 'extraction.json');
      ensure(bytesDigest(readBounded(file)) === completion.files['extraction.json'] &&
        canonical(JSON.parse(readBounded(file).toString('utf8'))) === canonical(completion.draft), 'group published extraction bytes changed');
      return {groupId: group.id, inputDigest: completion.inputDigest, ref: head.ref,
        completionDigest: completion.digest, draft: completion.draft};
    });
    const body = {schemaVersion: 1 as const, registrationId: record.id, schedulerId: scheduler.id,
      contractDigest: record.contractDigest, materialReceiptDigest: record.prepared.materialReceiptDigest,
      groups, authority: 'untrusted-group-extraction-only' as const};
    return {...body, digest: researchDigest(body)};
  }

}
