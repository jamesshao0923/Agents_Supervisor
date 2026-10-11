import type { ScheduledBinding } from '../contracts/p7-dispatch.js';
import type { TaskSchedulerRepository } from './task-scheduler.js';
import { VerificationRepository } from './verification.js';
import type { RuntimeBinding } from '../contracts/p3.js';
import { RuntimeRepository } from './runtime.js';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Run, RunAction } from '../contracts/p1.js';
import { parseExecutionAction, type ExecutionEvent, type ExecutionRecord, type ResolvedExecutionStart } from '../contracts/p2.js';
import { applyAction, createRun } from '../domain/index.js';

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const json = (v: unknown): string => JSON.stringify(v);
function readRecord(value: unknown): ExecutionRecord {
  const record = JSON.parse(String(value)) as ExecutionRecord;
  return { ...record, workspaceKind: record.workspaceKind ?? 'project' };
}
function canonicalRequest(input: Record<string, unknown>): string {
  // Older receipts stored explicit project paths before ownership was recorded.
  const normalized = { ...input, workspaceKind: input.workspaceKind ?? 'project', images: input.images ?? [] };
  return json(Object.fromEntries(Object.entries(normalized).sort(([a],[b])=>a.localeCompare(b))));
}
export function executionList(db: DatabaseSync): ExecutionRecord[] {
  return db.prepare('SELECT record FROM executions ORDER BY rowid DESC').all().map(r => readRecord(r.record));
}
export function executionGet(db: DatabaseSync, id: string): ExecutionRecord {
  const row = db.prepare('SELECT record FROM executions WHERE id=?').get(id);
  if (!row) throw new Error('Unknown execution');
  return readRecord(row.record);
}
export function executionEvents(db: DatabaseSync, id: string, after: number): ExecutionEvent[] {
  executionGet(db, id);
  return db.prepare('SELECT * FROM execution_events WHERE execution_id=? AND seq>? ORDER BY seq LIMIT 500').all(id, after)
    .map(r => ({ seq: Number(r.seq), executionId: id, receivedAt: String(r.received_at), kind: String(r.kind), payload: JSON.parse(String(r.payload)) }));
}
function event(db: DatabaseSync, id: string, kind: string, payload: unknown): number {
  return Number(db.prepare('INSERT INTO execution_events(execution_id,received_at,kind,payload) VALUES (?,?,?,?)').run(id, new Date().toISOString(), kind, json(payload)).lastInsertRowid);
}
function runEvents(db: DatabaseSync, run: Run, commandId: string, events: unknown[]): void {
  db.prepare('UPDATE runs SET snapshot=?,revision=? WHERE project_id=? AND id=?').run(json(run), run.revision, run.projectId, run.id);
  for (const e of events) db.prepare('INSERT INTO events(command_id,project_id,run_id,type,payload) VALUES (?,?,?,?,?)').run(commandId, run.projectId, run.id, String((e as {type:string}).type), json(e));
}
/** The intent, domain reservation, resource lease and execution receipt commit together before spawn. */
export function executionCreate(db: DatabaseSync, input: ResolvedExecutionStart, binding?: RuntimeBinding | ScheduledBinding, scheduler?:TaskSchedulerRepository,hostRuntime?:RuntimeRepository): {record: ExecutionRecord; created: boolean} {
  const scheduled=binding&&'schedulerId' in binding?binding:undefined;
  const runtimeBinding=binding&&!scheduled?binding as RuntimeBinding:undefined;
  const assertEligible=()=>{if(scheduled){if(!scheduler)throw new Error('Scheduled execution requires host repository');scheduler.eligible(scheduled.operationId,scheduled.owner);if(canonicalRequest({...scheduler.binding(scheduled.claimId,scheduled.owner)})!==canonicalRequest({...scheduled}))throw new Error('Scheduled binding mismatch');const expected=scheduler.executionInput(scheduled.claimId);if(canonicalRequest({...input,images:input.images??[]})!==canonicalRequest({...expected,images:expected.images??[]}))throw new Error('Scheduled input differs from frozen authorized task');}else if(runtimeBinding){const runtime=hostRuntime??new RuntimeRepository(db);runtime.eligible(runtimeBinding.operationId,runtimeBinding.owner);if(runtime.hasScheduledIntegration(runtimeBinding.operationId)||runtime.getOperation(runtimeBinding.operationId).step.kind==='codex'&&!!(runtime.getOperation(runtimeBinding.operationId).step as Extract<import('../contracts/p3.js').RuntimeStep,{kind:'codex'}>).research){const expected={...runtime.executionInput(runtimeBinding.operationId,runtimeBinding.owner),workspaceKind:runtime.get(runtimeBinding.runtimeId).workspaceKind};if(canonicalRequest({...input})!==canonicalRequest({...expected}))throw new Error('Integration input differs from frozen authorized request');}}};
  const { workspaceKind, ...action } = input;
  parseExecutionAction(action);
  if (!isAbsolute(input.workspace) || input.workspace === sep || !['project', 'managed'].includes(workspaceKind)) throw new Error('Execution workspace must be resolved by the controller');
  const normalized = { ...input, images: input.images ?? [], ...(binding ? { [scheduled?'scheduledBinding':'runtimeBinding']: { ...binding, owner: undefined } } : {}) };
  const request = canonicalRequest(normalized);
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT request,record FROM executions WHERE command_id=?').get(input.commandId);
    if (existing) {
      if (canonicalRequest(JSON.parse(String(existing.request)) as Record<string, unknown>) !== request) throw new Error('commandId already used with a different execution');
      const record=readRecord(existing.record);
      if(binding) { assertEligible();if(scheduled){if(record.scheduledBinding?.claimId!==scheduled.claimId)throw new Error('Scheduled receipt binding mismatch');record.scheduledBinding=scheduled;}else {if(record.runtimeBinding?.runtimeId!==runtimeBinding!.runtimeId)throw new Error('Runtime binding mismatch');record.runtimeBinding=runtimeBinding!;}db.prepare('UPDATE executions SET record=? WHERE id=?').run(json(record),record.id); }
      db.exec('COMMIT'); return { record, created: false };
    }
    new VerificationRepository(db).assertNoVerificationWriter(input.workspace);
    for (const record of executionList(db)) {
      const overlap = record.workspace === input.workspace || record.workspace.startsWith(input.workspace + sep) || input.workspace.startsWith(record.workspace + sep);
      if (overlap && !record.stopConfirmed) throw new Error('Workspace has an active or unverified writer; cancel or reconcile it before dispatch');
    }
    if(binding)assertEligible();
    else for(const runtime of new RuntimeRepository(db).list()) {
      const overlap=runtime.workspace===input.workspace||runtime.workspace.startsWith(input.workspace+sep)||input.workspace.startsWith(runtime.workspace+sep);
      if(overlap && (!['cancelled','awaiting-verification'].includes(runtime.phase)||new RuntimeRepository(db).operations(runtime.id).some(o=>!['confirmed','cancelled'].includes(o.state))))throw new Error('Workspace has unresolved runtime work');
    }
    const id = 'exec-' + (scheduled?hash(input.commandId):hash(input.commandId).slice(0,24)), projectId = binding?.projectId ?? 'workspace-' + hash(input.workspace).slice(0,24);
    if(binding && binding.attemptId!==id)throw new Error('Runtime attempt identity mismatch');
    const now = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO projects(id,name) VALUES (?,?)').run(projectId, basename(input.workspace));
    let run = binding ? JSON.parse(String(db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(binding.projectId,binding.runId)?.snapshot)) as Run : createRun({ id, projectId, contract: { version: 1, goal: input.prompt, criteria: [{ id: 'independent-acceptance', description: 'Independently validate the produced candidate; executor self-report is insufficient', required: true }] }, nodes: [{ id: 'execution', dependencies: [], required: true }], budget: { unit: 'token', limit: input.tokenLimit, verificationReserve: input.verificationReserve } });
    const events = [];
    for (const action of (binding ? [] : [
      { type: 'startAttempt', attemptId: id, nodeId: 'execution', contractVersion: 1, reservation: input.reservation, purpose: 'execution', resources: ['workspace:' + input.workspace] },
      { type: 'setOperation', operationId: id, attemptId: id, status: 'pending' },
    ] as RunAction[])) { const result = applyAction(run, action); run = result.run; events.push(...result.events); }
    if(!binding)db.prepare('INSERT INTO runs(project_id,id,revision,snapshot) VALUES (?,?,?,?)').run(projectId, id, run.revision, json(run));
    runEvents(db, run, input.commandId, events);
    const record: ExecutionRecord = { id, commandId: input.commandId, projectId, runId: binding?.runId ?? id, attemptId: id, ...(scheduled?{scheduledBinding:scheduled}:runtimeBinding?{runtimeBinding}:{} ), workspace: input.workspace, workspaceKind, prompt: input.prompt,
      model: input.model, effort: input.effort, images: normalized.images, state: 'queued', createdAt: now, updatedAt: now,
      deadline: new Date(Date.now() + input.timeoutMs).toISOString(), timeoutMs: input.timeoutMs, tokenLimit: input.tokenLimit, reservation: input.reservation, verificationReserve: input.verificationReserve,
      identity: null, pid: null, threadId: null, turnId: null, lastEventSeq: 0, message: '', diff: '', error: null, usage: null, usageStatus: 'unknown',
      stopConfirmed: false, cancelRequested: false, artifactId: null, protocolVersion: null, schemaDigest: null };
    db.prepare('INSERT INTO executions(id,command_id,project_id,run_id,request,record) VALUES (?,?,?,?,?,?)').run(id, input.commandId, projectId, record.runId, request, json(record));
    record.lastEventSeq = event(db,id,'execution-intent',{ input: normalized, budget: run.budget, reservation: input.reservation });
    db.prepare('UPDATE executions SET record=? WHERE id=?').run(json(record),id);
    db.exec('COMMIT'); return { record, created: true };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
/** Called only by the deterministic execution controller, never by renderer-supplied patches. */
export function executionUpdate(db: DatabaseSync, id: string, patch: Partial<ExecutionRecord>, kind: string, payload: unknown, actions: RunAction[] = [],expectedEventSeq?:number): ExecutionRecord {
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = executionGet(db,id);
    if(expectedEventSeq!==undefined){if(!Number.isSafeInteger(expectedEventSeq)||expectedEventSeq<0)throw new Error('Invalid execution event CAS');if(previous.lastEventSeq!==expectedEventSeq){db.exec('COMMIT');return previous;}}
    if (patch.id !== undefined && patch.id !== id) throw new Error('Execution identity immutable');
    const effectivePatch={...patch};let effectiveActions=actions;
    // Cancellation may commit through another SQLite connection after the
    // controller observed the Run. Classify the stopped receipt under this
    // same write lock so its attempt and record can never disagree.
    if(previous.scheduledBinding&&kind==='execution-stopped'&&patch.stopConfirmed){
      const current=JSON.parse(String(db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(previous.projectId,previous.runId)!.snapshot)) as Run;
      if(current.status==='cancelled'){effectivePatch.state='cancelled';effectiveActions=actions.map(action=>action.type==='finishAttempt'&&action.attemptId===previous.attemptId?{...action,outcome:'cancelled' as const}:action);}
    }
    const record = { ...previous, ...effectivePatch, updatedAt: new Date().toISOString() };
    if (previous.cancelRequested && record.state === 'completed') throw new Error('Cancelled execution cannot become completed');
    if (effectiveActions.length) {
      const row = db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(record.projectId,record.runId)!;
      let run = JSON.parse(String(row.snapshot)) as Run;
      const events = [];
      for(const action of effectiveActions) { const result=applyAction(run,action);run=result.run;events.push(...result.events); }
      runEvents(db,run,`${id}:${kind}:${Date.now()}`,events);
    }
    record.lastEventSeq = event(db,id,kind,payload);
    db.prepare('UPDATE executions SET record=? WHERE id=?').run(json(record),id);
    db.exec('COMMIT'); return record;
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
