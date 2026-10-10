import type { CreateRunInput, DomainEvent, Readiness, Run, RunAction, VerificationCase, VerificationCatalog, VerificationChange, VerificationPlan } from '../contracts/p1.js';
import { parseCreateRunInput, parseRunAction, validateVerificationChangeShape, validateVerificationPlanShape } from '../contracts/validation.js';

function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function unique(values: string[], label: string): void { ensure(new Set(values).size === values.length, `duplicate ${label}`); }
function contractValid(contract: Run['contract']): void { unique(contract.criteria.map((c) => c.id), 'criterion id'); ensure(contract.criteria.length > 0, 'contract needs criteria'); }
export function createRun(input: CreateRunInput): Run {
  const value = parseCreateRunInput(input); contractValid(value.contract); unique(value.nodes.map((n) => n.id), 'node id'); ensure(value.nodes.length > 0, 'run needs nodes');
  const nodes = new Map(value.nodes.map((n) => [n.id, n])); const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(id: string): void {
    ensure(!visiting.has(id), 'cyclic node dependencies'); if (visited.has(id)) return;
    const node = nodes.get(id); ensure(node, `unknown dependency ${id}`); unique(node.dependencies, 'dependency'); visiting.add(id);
    for (const dep of node.dependencies) visit(dep); visiting.delete(id); visited.add(id);
  }
  for (const id of nodes.keys()) visit(id);
  return { id: value.id, projectId: value.projectId, revision: 0, contract: value.contract, status: 'ready', nodes: value.nodes.map((node) => ({ ...node, status: 'pending' })), attempts: [], budget: { unit: 'work-unit', ...value.budget, spent: 0 }, leases: [], operations: [], artifact: null, evidence: [] };
}
function reservations(run: Run): number { return run.attempts.filter((a) => !a.settled).reduce((sum, a) => sum + a.reservation, 0); }
function protectedReserve(run: Run): number { return Math.max(0, run.budget.verificationReserve - run.attempts.filter((a) => a.purpose === 'verification').reduce((sum, a) => sum + (a.settled ? a.actual! : a.reservation), 0)); }
function completionReasons(run: Run): string[] {
  const reasons: string[] = [];
  if (run.nodes.some((n) => n.required && n.status !== 'succeeded')) reasons.push('required nodes unfinished');
  if (run.attempts.some((a) => a.status === 'running')) reasons.push('active attempts');
  if (run.attempts.some((a) => !a.settled)) reasons.push('unsettled attempts');
  if (run.leases.some((l) => !l.released)) reasons.push('unreleased leases');
  if (run.operations.some((o) => o.status !== 'confirmed')) reasons.push('unresolved operations');
  if (!run.artifact || run.artifact.contractVersion !== run.contract.version) reasons.push('current artifact missing');
  for (const criterion of run.contract.criteria.filter((c) => c.required)) {
    const latest = run.evidence.filter((e) => e.criterionId === criterion.id && e.contractVersion === run.contract.version && e.artifactDigest === run.artifact?.digest).at(-1);
    if (latest?.verdict !== 'passed') reasons.push(`criterion ${criterion.id} lacks current passed evidence`);
  }
  return reasons;
}
export function readiness(run: Run): Readiness {
  const result = (state: Readiness['state'], nodeIds: string[] = [], reasons: string[] = []): Readiness => ({ state, nodeIds, reasons });
  if (run.status === 'cancelled') return result('cancelled');
  if (run.status === 'paused') return result('paused');
  if (run.status === 'succeeded') return result('complete');
  if (run.attempts.some((a) => a.status === 'running')) return result('active');
  const reasons = completionReasons(run);
  if (run.operations.some((o) => o.status !== 'confirmed') || run.leases.some((l) => !l.released) || run.attempts.some((a) => !a.settled)) return result('blocked', [], reasons);
  // Budget limits gate new work. They do not erase an already verified result.
  if (!reasons.length) return result('complete');
  const ready = run.nodes.filter((n) => (n.status === 'pending' || n.status === 'failed') && n.dependencies.every((id) => run.nodes.find((d) => d.id === id)?.status === 'succeeded'));
  if (run.budget.spent > run.budget.limit) return result('blocked', [], ['budget overspent']);
  if (ready.length && run.budget.limit - run.budget.spent - reservations(run) - protectedReserve(run) > 0) return result('ready', ready.map((n) => n.id));
  if (ready.length) return result('blocked', [], ['execution budget exhausted']);
  if (run.nodes.some((n) => n.required && n.status !== 'succeeded')) return result('blocked', [], reasons);
  return result('verification', [], reasons);
}
export function applyAction(input: Run, unparsed: RunAction): { run: Run; events: DomainEvent[] } {
  const action = parseRunAction(unparsed); const run = structuredClone(input);
  const noChange = (): { run: Run; events: DomainEvent[] } => ({ run, events: [] });
  const audit = (details: Record<string, unknown> = {}): { run: Run; events: DomainEvent[] } => {
    run.revision++; return { run, events: [{ type: action.type, runId: run.id, revision: run.revision, details: { ...action, ...details } }] };
  };
  // Accounting and reconciliation remain legal after termination; execution does not.
  if (run.status === 'succeeded') { ensure(action.type === 'complete', 'succeeded run is terminal'); return noChange(); }
  if (run.status === 'cancelled') ensure(['cancel', 'finishAttempt', 'settleAttempt', 'releaseLease', 'setOperation'].includes(action.type), 'cancelled run cannot execute');
  switch (action.type) {
    case 'startAttempt': {
      ensure(!['paused', 'cancelled'].includes(run.status), 'dispatch prohibited by run state'); ensure(action.contractVersion === run.contract.version, 'stale contract version');
      ensure(!run.attempts.some((a) => a.id === action.attemptId), 'attempt id already exists');
      const node = run.nodes.find((n) => n.id === action.nodeId); ensure(node, 'unknown node');
      ensure(!run.attempts.some((a) => a.nodeId === node.id && a.status === 'running'), 'node has active attempt');
      ensure(run.operations.every((o) => o.status === 'confirmed'), 'unresolved operation prevents dispatch');
      ensure(node.dependencies.every((id) => run.nodes.find((n) => n.id === id)?.status === 'succeeded'), 'dependencies unfinished');
      if (action.purpose === 'execution') ensure(node.status === 'pending' || node.status === 'failed', 'node not dispatchable');
      else ensure(run.artifact?.contractVersion === run.contract.version && run.nodes.every((n) => !n.required || n.status === 'succeeded'), 'verification needs current candidate and completed required nodes');
      unique(action.resources, 'resource'); for (const resource of action.resources) ensure(!run.leases.some((l) => l.resource === resource && !l.released), `resource ${resource} still leased`);
      const protection = action.purpose === 'execution' ? protectedReserve(run) : 0;
      ensure(run.budget.spent <= run.budget.limit && run.budget.spent + reservations(run) + action.reservation + protection <= run.budget.limit, 'insufficient budget');
      run.attempts.push({ id: action.attemptId, nodeId: node.id, contractVersion: action.contractVersion, status: 'running', reservation: action.reservation, purpose: action.purpose, settled: false, actual: null });
      for (const resource of action.resources) run.leases.push({ resource, attemptId: action.attemptId, released: false });
      if (action.purpose === 'execution') node.status = 'running'; run.status = 'running'; break;
    }
    case 'finishAttempt': {
      const attempt = run.attempts.find((a) => a.id === action.attemptId); ensure(attempt, 'unknown attempt');
      if (attempt.status === action.outcome) return noChange();
      if (attempt.status === 'cancelled' && action.outcome !== 'cancelled') return audit({ ignored: 'late result after cancellation' });
      ensure(attempt.status === 'running', 'conflicting terminal attempt result'); ensure(attempt.contractVersion === run.contract.version, 'stale contract result');
      attempt.status = action.outcome;
      if (attempt.purpose === 'execution') run.nodes.find((n) => n.id === attempt.nodeId)!.status = action.outcome === 'succeeded' ? 'succeeded' : 'failed';
      if (run.status === 'running' && !run.attempts.some((a) => a.status === 'running')) run.status = 'ready'; break;
    }
    case 'settleAttempt': {
      const attempt = run.attempts.find((a) => a.id === action.attemptId); ensure(attempt, 'unknown attempt'); ensure(attempt.status !== 'running', 'active attempt cannot settle');
      if (attempt.settled) { ensure(attempt.actual === action.actual, 'conflicting settlement'); return noChange(); }
      ensure(Number.isSafeInteger(run.budget.spent + action.actual), 'accounting sum exceeds safe integer range');
      attempt.actual = action.actual; attempt.settled = true; run.budget.spent += action.actual;
      if (run.budget.spent > run.budget.limit && !['cancelled', 'paused'].includes(run.status)) run.status = 'blocked'; break;
    }
    case 'releaseLease': {
      const lease = run.leases.find((l) => l.resource === action.resource && l.attemptId === action.attemptId); ensure(lease, 'unknown lease');
      ensure(run.attempts.find((a) => a.id === action.attemptId)?.status !== 'running', 'active owner cannot release lease');
      if (lease.released) return noChange(); lease.released = true; break;
    }
    case 'setOperation': {
      ensure(run.attempts.some((a) => a.id === action.attemptId), 'unknown operation attempt'); const op = run.operations.find((o) => o.id === action.operationId);
      if (op) { ensure(op.attemptId === action.attemptId, 'operation belongs to another attempt'); if (op.status === action.status) return noChange(); ensure(op.status !== 'confirmed', 'confirmed operation is immutable'); op.status = action.status; }
      else run.operations.push({ id: action.operationId, attemptId: action.attemptId, status: action.status }); break;
    }
    case 'pause': ensure(run.status !== 'cancelled', 'cancelled run cannot pause'); if (run.status === 'paused') return noChange(); run.status = 'paused'; break;
    case 'resume': ensure(run.status === 'paused', 'only paused run can resume'); run.status = run.attempts.some((a) => a.status === 'running') ? 'running' : 'ready'; break;
    case 'cancel': {
      if (run.status === 'cancelled') return noChange(); run.status = 'cancelled';
      for (const attempt of run.attempts.filter((a) => a.status === 'running')) { attempt.status = 'cancelled'; if (attempt.purpose === 'execution') run.nodes.find((n) => n.id === attempt.nodeId)!.status = 'failed'; }
      break;
    }
    case 'replaceContract': {
      contractValid(action.contract); ensure(action.contract.version === run.contract.version + 1, 'contract version must increment'); run.contract = action.contract;
      const invalidatedEvidence = run.evidence; run.evidence = [];
      for (const attempt of run.attempts.filter((a) => a.status === 'running')) attempt.status = 'cancelled';
      for (const node of run.nodes) node.status = 'pending'; run.artifact = null;
      if (run.status !== 'paused') run.status = 'ready'; return audit({ invalidatedEvidence });
    }
    case 'setArtifact': {
      ensure(action.artifact.contractVersion === run.contract.version, 'stale artifact contract');
      if (run.artifact && same(run.artifact, action.artifact)) return noChange();
      const invalidatedEvidence = run.artifact?.digest !== action.artifact.digest ? run.evidence : []; if (invalidatedEvidence.length) run.evidence = [];
      run.artifact = action.artifact; return audit({ invalidatedEvidence });
    }
    case 'recordEvidence': {
      const evidence = action.evidence; ensure(evidence.contractVersion === run.contract.version, 'stale evidence contract'); ensure(run.artifact?.digest === evidence.artifactDigest, 'stale evidence artifact');
      ensure(run.contract.criteria.some((c) => c.id === evidence.criterionId), 'unknown evidence criterion'); const previous = run.evidence.find((e) => e.id === evidence.id);
      if (previous) { ensure(same(previous, evidence), 'evidence id is immutable'); return noChange(); } run.evidence.push(evidence); break;
    }
    case 'complete': ensure(run.status !== 'paused', 'paused run cannot complete'); ensure(!completionReasons(run).length, `run incomplete: ${completionReasons(run).join(', ')}`); run.status = 'succeeded'; break;
  }
  return audit();
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)]));
  return value;
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function currentCases(cases: VerificationCase[]): Map<string, VerificationCase> {
  const result = new Map<string, VerificationCase>(); for (const c of cases) if (!result.has(c.id) || result.get(c.id)!.revision < c.revision) result.set(c.id, c); return result;
}
export function validateVerificationChange(previous: VerificationCatalog | null, change: VerificationChange): void {
  validateVerificationChangeShape(change); ensure(change.baseVersion === (previous?.version ?? 0), 'stale catalog base version'); ensure(change.status === 'proposed', 'only proposed change can publish');
  unique(change.cases.map((c) => `${c.id}:${c.revision}`), 'case revision');
  for (const c of change.cases) { unique(c.criterionIds, 'case criterion'); unique(c.replaces, 'replacement'); unique(c.defectRefs, 'defect reference'); ensure(c.criterionIds.length > 0, 'case needs criterion coverage'); ensure(!c.replaces.includes(c.id), 'case cannot replace itself'); }
  const old = previous?.cases ?? [];
  for (const c of old) ensure(change.cases.some((n) => n.id === c.id && n.revision === c.revision && same(n, c)), 'published case revision cannot be overwritten or removed');
  const oldCurrent = currentCases(old); const current = currentCases(change.cases);
  for (const c of change.cases.filter((c) => !old.some((o) => o.id === c.id && o.revision === c.revision))) {
    const base = oldCurrent.get(c.id); ensure(c.revision === (base?.revision ?? 0) + 1, 'case revision must increment');
    if (base) {
      for (const defect of base.defectRefs) ensure(c.defectRefs.includes(defect), 'case revision drops defect reference');
      for (const criterion of base.criterionIds) ensure(c.criterionIds.includes(criterion), 'case revision drops criterion coverage');
      for (const id of base.replaces) ensure(c.replaces.includes(id), 'case revision drops replacement lineage');
      ensure(base.status !== 'retired' || c.status === 'retired', 'retired case cannot be revived without an explicit scope transition');
    }
  }
  const active = [...current.values()].filter((c) => c.status === 'active');
  for (const c of current.values()) for (const id of c.replaces) {
    const replaced = oldCurrent.get(id); ensure(replaced, 'replacement references unknown case'); ensure(current.get(id)?.status === 'retired', 'replaced case must be retired');
    for (const defect of replaced.defectRefs) ensure(c.defectRefs.includes(defect), 'replacement drops defect reference');
  }
  const visiting = new Set<string>(); const lineage = new Map<string, Set<string>>();
  function ancestors(id: string): Set<string> {
    const existing = lineage.get(id); if (existing) return existing;
    ensure(!visiting.has(id), 'cyclic replacement lineage'); visiting.add(id);
    const inherited = new Set<string>();
    for (const replaced of current.get(id)!.replaces) { inherited.add(replaced); for (const ancestor of ancestors(replaced)) inherited.add(ancestor); }
    visiting.delete(id); lineage.set(id, inherited); return inherited;
  }
  for (const id of current.keys()) ancestors(id);
  // Audit every retired definition on every publication, including older chains.
  // P1 has no contract-authorized scope removal, so lineage cannot lose coverage.
  for (const [id, c] of current) if (c.status === 'retired') {
    const replacements = active.filter((n) => ancestors(n.id).has(id)); ensure(replacements.length > 0, 'retirement requires explicit replacement coverage');
    for (const criterion of c.criterionIds) ensure(replacements.some((n) => n.criterionIds.includes(criterion)), 'replacement drops criterion coverage');
    for (const defect of c.defectRefs) ensure(replacements.some((n) => n.defectRefs.includes(defect)), 'replacement drops defect reference');
  }
}
export function validateVerificationPlan(run: Run, catalog: VerificationCatalog, plan: VerificationPlan): void {
  validateVerificationPlanShape(plan); ensure(plan.catalogVersion === catalog.version, 'plan catalog version mismatch'); ensure(plan.contractVersion === run.contract.version, 'plan contract version mismatch');
  ensure(run.artifact?.contractVersion === run.contract.version && plan.artifactDigest === run.artifact.digest, 'plan candidate mismatch');
  const current = currentCases(catalog.cases); const instances = new Set<string>(); const covered = new Set<string>();
  for (const selected of plan.cases) {
    const c = current.get(selected.id); ensure(c?.status === 'active' && c.revision === selected.revision, 'plan needs active current case revision');
    const key = JSON.stringify([selected.id, selected.revision, Object.entries(selected.parameters).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]); ensure(!instances.has(key), 'duplicate verification instance'); instances.add(key);
    for (const criterion of c.criterionIds) { ensure(run.contract.criteria.some((required) => required.id === criterion), 'selected case references criterion outside run contract'); covered.add(criterion); }
  }
  for (const criterion of run.contract.criteria.filter((c) => c.required)) ensure(covered.has(criterion.id), `plan lacks required criterion ${criterion.id}`);
}
