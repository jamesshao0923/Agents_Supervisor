import type { SchedulerAdmission, SchedulerDecision, SchedulerExpansion, SchedulerExpansionDecision, SchedulerNodeDecision, SchedulerResource, SchedulerSnapshot } from '../contracts/p7-scheduler.js';
import { parseDependencyBindings, parseTaskResultManifest, safeResultJSON } from '../contracts/p7-results.js';
import { createTaskResultDomain } from './task-results.js';
const bases = ['uncertain', 'exploratory', 'supported', 'strong'];
const thresholds = { low: 3, medium: 2, high: 1, unlimited: 0 };
function ensure(ok: unknown, message: string): asserts ok { if (!ok) throw new Error('Scheduler: ' + message); }
function integer(v: number, minimum = 0): void { ensure(Number.isSafeInteger(v) && v >= minimum, 'invalid integer'); }
function text(v: string): void { ensure(typeof v === 'string' && v.trim().length > 0 && v.length <= 12000 && !v.includes('\0'), 'invalid text'); }
function unique(values: string[], label: string): void { values.forEach(text); ensure(new Set(values).size === values.length, 'duplicate ' + label); }
function canonical(v: any): string { return Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v); }
function exact(v: object, keys: string[]): void { ensure(canonical(Object.keys(v).sort()) === canonical([...keys].sort()), 'unknown or missing fields'); }
function immutable<T>(v: T): T { if (v && typeof v === 'object') { Object.values(v).forEach(immutable); Object.freeze(v); } return v; }
function resources(values: SchedulerResource[]): void {
  const ids: string[] = [];
  for (const r of values) {
    exact(r, ['kind', 'key', 'mode']); text(r.key); ensure(['path','port','database','device','custom'].includes(r.kind) && ['read','write'].includes(r.mode), 'invalid resource');
    if (r.kind === 'path') ensure(r.key.startsWith('/') && !r.key.includes('\\') && (r.key === '/' || r.key.slice(1).split('/').every(p => p && p !== '.' && p !== '..')), 'path resource must be canonical absolute');
    ids.push(r.kind + ':' + r.key);
  }
  unique(ids, 'resource');
}
/** Host must normalize aliases, realpaths, case sensitivity and isolation first. */
export function schedulerResourcesConflict(a: SchedulerResource, b: SchedulerResource): boolean {
  resources([a]); resources([b]);
  if (a.kind !== b.kind || a.mode === 'read' && b.mode === 'read') return false;
  return a.key === b.key || a.kind === 'path' && (a.key === '/' || b.key === '/' || a.key.startsWith(b.key + '/') || b.key.startsWith(a.key + '/'));
}
function admission(a: SchedulerAdmission, required: boolean, tier: SchedulerSnapshot['tier']): string[] {
  const reasons: string[] = [];
  if (!a.authorized) reasons.push('outside authorization');
  if (!a.executable) reasons.push('not executable');
  if (!a.relevant) reasons.push('not relevant');
  if (a.duplicate && !a.independentVerificationPurpose) reasons.push('duplicate without independent verification purpose');
  if (!a.reasons.length) reasons.push('admission basis missing');
  if (required) { if (!a.requirementRefs.length) reasons.push('required task lacks requirement binding'); }
  else if (Math.min(bases.indexOf(a.quality), bases.indexOf(a.value)) < thresholds[tier]) reasons.push('below exploration tier');
  return reasons;
}
/** Predictive quality/value are qualitative host inputs, never proof or success. */
export function createTaskScheduler({ sha256, decisionId }: { sha256: (canonicalJSON: string) => string; decisionId: (snapshotDigest: string) => string }) {
  ensure(typeof sha256 === 'function' && typeof decisionId === 'function', 'trusted digest and ID functions required');
  const resultDomain = createTaskResultDomain({ sha256 });
  function validate(s: SchedulerSnapshot): void {
    safeResultJSON(s); exact(s, ['schemaVersion','revision','scope','status','tier','nodes','results','claims','loops','budget','limits']);
    ensure(s.schemaVersion === 1 && ['ready','running','paused','blocked','cancelled','succeeded'].includes(s.status) && Object.hasOwn(thresholds, s.tier), 'invalid scheduler state'); integer(s.revision);
    exact(s.scope, ['projectId','runId','contractVersion','contractDigest']); text(s.scope.projectId); text(s.scope.runId); integer(s.scope.contractVersion, 1); ensure(/^[a-f0-9]{64}$/.test(s.scope.contractDigest), 'invalid contract digest');
    exact(s.budget, ['limit','spent','verificationRemaining','futureVerificationFloor',...(Object.hasOwn(s.budget,'futureExecutionFloor')?['futureExecutionFloor']:[])]); Object.values(s.budget).forEach(v => integer(v));
    exact(s.limits, ['maxActive','maxNodes','maxDepth','nowMs','deadlineMs']); Object.values(s.limits).forEach(v => integer(v)); integer(s.limits.maxActive, 1); integer(s.limits.maxNodes, 1);
    ensure(s.nodes.length <= 4096 && s.claims.length <= 4096 && s.loops.length <= 256, 'scheduler capacity exceeded');
    unique(s.nodes.map(n => n.id), 'node'); unique(s.claims.map(c => c.id), 'claim'); unique(s.claims.map(c => c.taskId), 'claimed task'); unique(s.loops.map(l => l.id), 'loop');
    for (const l of s.loops) { exact(l, ['id','parentId','depth','iteration','maxIterations','nodeCount','maxNodes','limit','spent']); for (const k of ['depth','iteration','maxIterations','nodeCount','maxNodes','limit','spent'] as const) integer(l[k]); integer(l.depth, 1); integer(l.iteration, 1); integer(l.maxIterations, 1); integer(l.maxNodes, 1); if (l.parentId !== null) text(l.parentId); }
    function ancestors(ids: string[]): void {
      unique(ids, 'loop ancestry'); let parent: string | null = null;
      for (const id of ids) { const l = s.loops.find(l => l.id === id); ensure(l && l.parentId === parent && l.depth === ids.indexOf(id) + 1, 'invalid loop ancestry'); parent = id; }
    }
    for (const l of s.loops) {
      const parent = l.parentId === null ? null : s.loops.find(p => p.id === l.parentId); ensure(l.parentId === null ? l.depth === 1 : parent && l.depth === parent.depth + 1, 'invalid loop parent');
      ensure(l.limit <= (parent?.limit ?? s.budget.limit), 'child allocation exceeds parent');
      ensure(l.spent <= (parent?.spent ?? s.budget.spent), 'child spending exceeds parent accounting');
    }
    for (const c of s.claims) { exact(c, ['id','taskId','reservation','resources','loopIds','usage','effects']); text(c.taskId); integer(c.reservation); resources(c.resources); ancestors(c.loopIds); ensure(['known','unknown'].includes(c.usage) && ['pending','unknown'].includes(c.effects), 'invalid claim state'); }
    for (const n of s.nodes) {
      if(n.status==='running')ensure(s.claims.some(c=>c.taskId===n.id), 'running node has no held claim');
      exact(n, ['id','dependencies','required','status','inputs','admission','resources','reservation','loopIds']); unique(n.dependencies, 'dependency'); ensure(typeof n.required === 'boolean' && ['pending','running','succeeded','failed','blocked'].includes(n.status), 'invalid node'); integer(n.reservation, 1); resources(n.resources); ancestors(n.loopIds); parseDependencyBindings(n.inputs);
      ensure(n.inputs.every(i => n.dependencies.includes(i.dependencyNodeId)), 'input outside DAG dependencies');
      exact(n.admission, ['authorized','executable','relevant','duplicate','independentVerificationPurpose','requirementRefs','quality','value','reasons']);
      for (const k of ['authorized','executable','relevant','duplicate'] as const) ensure(typeof n.admission[k] === 'boolean', 'invalid admission fact');
      unique(n.admission.requirementRefs, 'requirement ref'); n.admission.reasons.forEach(text); ensure(bases.includes(n.admission.quality) && bases.includes(n.admission.value), 'invalid qualitative basis'); if (n.admission.independentVerificationPurpose !== null) text(n.admission.independentVerificationPurpose);
    }
    const visiting = new Set<string>(), seen = new Set<string>();
    function visit(id: string): void { ensure(!visiting.has(id), 'cyclic DAG'); if (seen.has(id)) return; const n = s.nodes.find(n => n.id === id); if (!n) return; visiting.add(id); n.dependencies.forEach(visit); visiting.delete(id); seen.add(id); }
    s.nodes.forEach(n => visit(n.id));
    exact(s.results, ['schemaVersion','revision','versions','heads','producers','consumers','events','receipts']);ensure(s.results.schemaVersion===1,'unknown result ledger schema');integer(s.results.revision);
    unique(s.results.heads.map(h => h.taskId), 'result head'); unique(s.results.versions.map(v => v.ref.taskId + ':' + v.ref.version), 'result version');
    for (const v of s.results.versions) { parseTaskResultManifest(v.manifest); integer(v.ref.version,1); ensure(['draft','submitted','verified','invalidated'].includes(v.state), 'unknown dependency result state'); if(v.state==='verified') ensure(v.verification && v.verification.stopConfirmed && v.verification.usageKnown && v.verification.manifestDigest===v.ref.manifestDigest && v.verification.contractVersion===v.manifest.contractVersion && v.verification.contractDigest===v.manifest.contractDigest && v.verification.candidateDigest===resultDomain.resultDigest(v.manifest.artifacts) && v.verification.checks.some(c=>c.required) && v.verification.checks.filter(c=>c.required).every(c=>c.verdict==='passed'), 'verified result proof unknown'); ensure(v.ref.taskId === v.manifest.taskId && v.ref.manifestDigest === resultDomain.resultDigest(v.manifest), 'result ref mismatch'); }
    for (const parent of [null,...s.loops.map(l=>l.id)]) ensure(s.loops.filter(l=>l.parentId===parent).reduce((sum,l)=>sum+l.spent,0)<=(parent===null?s.budget.spent:s.loops.find(l=>l.id===parent)!.spent), 'sibling spending exceeds parent accounting');
    for (const h of s.results.heads) ensure(h.taskId===h.ref.taskId && s.results.versions.some(v=>canonical(v.ref)===canonical(h.ref) && v.state!=='draft'), 'unknown result head');
    for (const l of s.loops) ensure(l.nodeCount >= s.nodes.filter(n => n.loopIds.includes(l.id)).length, 'loop node count understated');
  }
  function reserved(s: SchedulerSnapshot, loopId?: string): number { const amount = s.claims.filter(c => loopId === undefined || c.loopIds.includes(loopId)).reduce((a,c) => a + c.reservation, 0); integer(amount); return amount; }
  function available(s: SchedulerSnapshot): number { const held = s.budget.spent + reserved(s) + Math.max(s.budget.verificationRemaining, s.budget.futureVerificationFloor)+(s.budget.futureExecutionFloor??0); integer(held); return s.budget.limit - held; }
  function hardReasons(s: SchedulerSnapshot): string[] {
    const reasons: string[] = [];
    if (['paused','cancelled','succeeded','blocked'].includes(s.status)) reasons.push('run does not authorize new dispatch');
    if (s.limits.nowMs >= s.limits.deadlineMs) reasons.push('run deadline reached');
    if (s.nodes.length > s.limits.maxNodes) reasons.push('global node cap exceeded');
    if (s.claims.some(c => c.usage === 'unknown')) reasons.push('unknown shared accounting');
    if (available(s) < 0) reasons.push('global budget protection exceeded');
    return reasons;
  }
  function evaluate(s: SchedulerSnapshot): SchedulerDecision {
    validate(s); const global = hardReasons(s), nodes: SchedulerNodeDecision[] = []; let remaining = available(s), slots = s.limits.maxActive - s.claims.length, reservation = 0;
    const selected: SchedulerResource[] = [], additions = new Map<string, number>();
    for (const n of s.nodes) {
      const reasons = admission(n.admission, n.required, s.tier), admitted = reasons.length === 0;
      if (n.status !== 'pending') reasons.push('node not pending');
      if (s.claims.some(c => c.taskId === n.id)) reasons.push('task already claimed');
      for (const id of n.dependencies) { const dep = s.nodes.find(d => d.id === id); if (!dep || dep.status !== 'succeeded' || s.claims.some(c => c.taskId === id)) reasons.push('dependency unfinished or unknown: ' + id); if (!n.inputs.some(i => i.dependencyNodeId === id)) reasons.push('dependency has no frozen result: ' + id); }
      const deps = resultDomain.resolveDependencies(s.results, n.inputs, s.scope); reasons.push(...deps.reasons);
      for (const id of n.loopIds) { const l = s.loops.find(l => l.id === id)!; if (l.depth > s.limits.maxDepth || l.iteration > l.maxIterations || l.nodeCount > l.maxNodes) reasons.push('loop bound reached: ' + id); if (l.spent + reserved(s,id) + (additions.get(id) ?? 0) + n.reservation > l.limit) reasons.push('ancestor budget exhausted: ' + id); }
      const ready = reasons.length === 0;
      reasons.push(...global);
      if (ready && !global.length) {
        if (slots <= 0) reasons.push('active capacity exhausted');
        if (n.reservation > remaining) reasons.push('shared budget exhausted');
        if (n.resources.some(r => [...selected,...s.claims.flatMap(c => c.resources)].some(held => schedulerResourcesConflict(r, held)))) reasons.push('resource conflict');
      }
      const dispatch = reasons.length === 0;
      if (dispatch) { slots--; remaining -= n.reservation; reservation += n.reservation; selected.push(...n.resources); for (const id of n.loopIds) additions.set(id, (additions.get(id) ?? 0) + n.reservation); }
      nodes.push({taskId:n.id,admitted,ready,dispatch,reasons,inputs:structuredClone(n.inputs)});
    }
    const snapshotDigest = resultDomain.resultDigest({policyVersion:'p7-scheduler-v1',snapshot:s}), id = decisionId(snapshotDigest); text(id);
    const dispatchTaskIds = nodes.filter(n => n.dispatch).map(n => n.taskId), requiredGaps = s.nodes.filter(n => n.required && n.status !== 'succeeded').map(n => n.id);
    const unfinishedAdmitted=nodes.some(d=>d.admitted && s.nodes.find(n=>n.id===d.taskId)!.status!=='succeeded');
    const state = global.length ? 'stopped' : dispatchTaskIds.length ? 'dispatch' : s.claims.length ? 'active' : requiredGaps.length || unfinishedAdmitted ? 'waiting' : 'exhausted';
    return immutable({schemaVersion:1,policyVersion:'p7-scheduler-v1',id,snapshotDigest,revision:s.revision,state,nodes,dispatchTaskIds,requiredGaps,reservation,remaining,reasons:global});
  }
  function evaluateExpansion(s: SchedulerSnapshot, request: SchedulerExpansion): SchedulerExpansionDecision {
    validate(s); safeResultJSON(request); exact(request, ['parentLoopId','childDepth','additionalNodes','reservation']); integer(request.childDepth,1); integer(request.additionalNodes,1); integer(request.reservation,1);
    const reasons = hardReasons(s), parent = request.parentLoopId === null ? null : s.loops.find(l => l.id === request.parentLoopId);
    ensure(request.parentLoopId === null || parent, 'unknown expansion parent');
    if (request.childDepth !== (parent?.depth ?? 0) + 1 || request.childDepth > s.limits.maxDepth) reasons.push('expansion depth limit');
    if (s.nodes.length + request.additionalNodes > s.limits.maxNodes) reasons.push('expansion global node limit');
    if (request.reservation > available(s)) reasons.push('expansion shared budget limit');
    let loop = parent;
    while (loop) { if (loop.iteration > loop.maxIterations || loop.nodeCount + request.additionalNodes > loop.maxNodes || loop.spent + reserved(s,loop.id) + request.reservation > loop.limit) reasons.push('expansion ancestor limit: ' + loop.id); loop = loop.parentId === null ? null : s.loops.find(l => l.id === loop!.parentId)!; }
    return immutable({allowed:reasons.length === 0,reasons});
  }
  return Object.freeze({evaluate,evaluateExpansion});
}
