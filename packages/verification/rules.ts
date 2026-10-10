import { createHash } from 'node:crypto';
import { parseVerificationSpec, type VerificationContract, type VerificationEvaluation, type VerificationInstance, type VerificationResult, type VerificationSelection, type VerificationSpec, type VerificationSpecCase } from '../contracts/p4.js';

export function verificationCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(verificationCanonical).join(',') + ']';
  return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + verificationCanonical(v)).join(',') + '}';
}
const equal = (a: unknown, b: unknown) => verificationCanonical(a) === verificationCanonical(b);
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const status = (c: VerificationSpecCase) => c.status ?? 'active';
const normalizedCase = (c: VerificationSpecCase) => ({ ...c, status: status(c) });
export function currentVerificationCases(spec: VerificationSpec): VerificationSpecCase[] {
  const current = new Map<string, VerificationSpecCase>(); for (const c of spec.cases) if (!current.has(c.id) || current.get(c.id)!.revision < c.revision) current.set(c.id, c);
  return [...current.values()];
}

export function validateSpecChange(previous: VerificationSpec | null, nextInput: VerificationSpec, contract: VerificationContract): void {
  const next = parseVerificationSpec(nextInput), old = previous === null ? null : parseVerificationSpec(previous);
  ensure(next.contractVersion === contract.version, 'Verification spec contract version mismatch');
  const criteria = new Map(contract.criteria.map(c => [c.id, c]));
  for (const obligation of next.obligations) ensure(criteria.has(obligation.criterionId), 'Verification obligation references unknown contract criterion');
  for (const criterion of contract.criteria.filter(c => c.required)) ensure(next.obligations.some(o => o.criterionId === criterion.id && o.required), 'Required contract criterion lacks a necessary obligation');
  if (old) {
    ensure(next.contractVersion >= old.contractVersion, 'Verification contract version cannot go backwards');
    if (next.standardsVersion === old.standardsVersion) ensure(equal([...next.obligations].sort((a, b) => a.id.localeCompare(b.id)), [...old.obligations].sort((a, b) => a.id.localeCompare(b.id))), 'Standards version cannot be reused with changed semantics');
    if (next.contractVersion === old.contractVersion) for (const obligation of old.obligations.filter(o => o.required)) {
      ensure(equal(next.obligations.find(o => o.id === obligation.id), obligation), 'Necessary obligation semantics or applicability changed without a contract change');
    }
    for (const control of old.controls) {
      const retained = next.controls.find(c => c.id === control.id); ensure(retained, 'Published control cannot be deleted');
      ensure(retained.workspace === control.workspace && retained.expect === control.expect && control.mustFail.every(id => retained.mustFail.includes(id)), 'Control sample cannot be replaced or weakened');
    }
    for (const c of old.cases) {
      const retained = next.cases.find(n => n.id === c.id && n.revision === c.revision);
      ensure(retained && equal(normalizedCase(retained), normalizedCase(c)), 'Published case revision cannot be reused changed or removed');
    }
  }
  const current = currentVerificationCases(next), byId = new Map(current.map(c => [c.id, c]));
  for (const c of next.cases) {
    if (old?.cases.some(o => o.id === c.id && o.revision === c.revision)) continue;
    const preceding = next.cases.find(p => p.id === c.id && p.revision === c.revision - 1);
    ensure(c.revision === 1 || preceding, 'Case revision sequence has a gap');
    if (preceding) {
      ensure(preceding.defectRefs.every(id => c.defectRefs.includes(id)), 'Case revision drops a known defect reference');
      ensure(preceding.replaces.every(id => c.replaces.includes(id)), 'Case revision drops replacement ancestry');
      ensure(status(preceding) !== 'retired' || status(c) === 'retired', 'Retired case cannot be revived');
      if (status(c) === 'active' && (!old || next.contractVersion === old.contractVersion)) {
        const necessary = preceding.obligationIds.filter(id => next.obligations.some(o => o.id === id && o.required));
        ensure(necessary.every(id => c.obligationIds.includes(id)), 'Case revision drops necessary assertion coverage');
        ensure(preceding.parameters.every(p => c.parameters.some(n => equal(n, p))), 'Case revision drops a necessary parameter instance');
      }
    }
  }
  const ancestors = new Map<string, Set<string>>(), visiting = new Set<string>();
  function lineage(id: string): Set<string> {
    const prior = ancestors.get(id); if (prior) return prior;
    ensure(!visiting.has(id), 'Cyclic replacement ancestry'); const c = byId.get(id); ensure(c, 'Replacement references unknown case'); visiting.add(id);
    const result = new Set<string>();
    for (const replaced of c.replaces) {
      const target = byId.get(replaced); ensure(target && status(target) === 'retired', 'Replacement must reference a retired definition');
      result.add(replaced); for (const ancestor of lineage(replaced)) result.add(ancestor);
    }
    visiting.delete(id); ancestors.set(id, result); return result;
  }
  for (const c of current) lineage(c.id);
  const active = current.filter(c => status(c) === 'active');
  for (const retired of current.filter(c => status(c) === 'retired')) {
    const replacements = active.filter(c => lineage(c.id).has(retired.id)); ensure(replacements.length, 'Retirement needs a current replacement');
    const historical = next.cases.filter(c => c.id === retired.id);
    for (const original of historical) {
      for (const id of original.defectRefs) ensure(replacements.some(c => c.defectRefs.includes(id)), 'Replacement drops known defect coverage');
      for (const id of original.obligationIds.filter(id => next.obligations.some(o => o.id === id && o.required))) {
        for (const parameters of original.parameters) ensure(replacements.some(c => c.obligationIds.includes(id) && c.parameters.some(p => equal(p, parameters))), 'Replacement drops a necessary assertion and parameter instance');
      }
    }
  }
  for (const obligation of next.obligations.filter(o => o.required && o.applicable)) ensure(active.some(c => c.obligationIds.includes(obligation.id)), 'Necessary obligation lacks active executable coverage');
}

export function selectInstances(specInput: VerificationSpec, options: { mode: 'final' | 'impact'; changedModules?: string[] }): VerificationSelection {
  const spec = parseVerificationSpec(specInput); ensure(options.mode === 'final' || options.mode === 'impact', 'Unknown selection mode');
  const active = currentVerificationCases(spec).filter(c => status(c) === 'active'); const known = new Set([...Object.keys(spec.moduleDependencies), ...active.flatMap(c => c.modules)]);
  const changed = options.changedModules;
  const all = options.mode === 'final' || !changed?.length || changed.some(m => !known.has(m)); const impacted = new Set(changed ?? []);
  if (!all) { let expanded = true; while (expanded) { expanded = false; for (const [dependent, dependencies] of Object.entries(spec.moduleDependencies)) if (dependencies.some(d => impacted.has(d)) && !impacted.has(dependent)) { impacted.add(dependent); expanded = true; } } }
  const selected = active.filter(c => all || c.modules.some(m => impacted.has(m))); const instances = new Map<string, VerificationInstance>();
  for (const c of selected) for (const parameters of c.parameters) {
    const id = 'vi-' + createHash('sha256').update(verificationCanonical({ caseId: c.id, revision: c.revision, parameters })).digest('hex');
    instances.set(id, { id, caseId: c.id, revision: c.revision, parameters: structuredClone(parameters), obligationIds: [...c.obligationIds], required: c.obligationIds.some(id => spec.obligations.some(o => o.id === id && o.required && o.applicable)) });
  }
  return { mode: options.mode, instances: [...instances.values()], completeScope: options.mode === 'final', excludedCaseIds: active.filter(c => !selected.includes(c)).map(c => c.id) };
}

export function evaluateVerification(specInput: VerificationSpec, selection: VerificationSelection, results: VerificationResult[], context: { current?: boolean } = {}): VerificationEvaluation {
  const spec = parseVerificationSpec(specInput); const reasons: string[] = [], obligationReasons = new Map(spec.obligations.map(o => [o.id, [] as string[]]));
  const final = selectInstances(spec, { mode: 'final' }); const expected = new Map(final.instances.map(i => [i.id, i])); const selected = new Set<string>();
  const issue = (message: string) => { if (!reasons.includes(message)) reasons.push(message); };
  if (context.current === false) issue('Verification inputs or evidence are no longer current');
  if (selection.mode !== 'final' || selection.completeScope !== true) issue('Partial impact verification cannot complete delivery');
  if (!selection.instances.length) issue('No actual verification instances were selected');
  for (const instance of selection.instances) {
    if (selected.has(instance.id)) issue('Duplicate selected verification instance'); selected.add(instance.id);
    if (!equal(expected.get(instance.id), instance)) issue('Selected instance does not match the published definition');
  }
  if (selection.mode === 'final' && (final.instances.some(i => !selected.has(i.id)) || selection.excludedCaseIds.length)) issue('Final selection omits frozen executable coverage');
  const grouped = new Map<string, VerificationResult[]>();
  for (const result of results) {
    if (!selected.has(result.instanceId)) issue('Report references an unselected verification instance');
    const prior = grouped.get(result.instanceId) ?? []; prior.push(result); grouped.set(result.instanceId, prior);
  }
  for (const instance of selection.instances) {
    const reports = grouped.get(instance.id) ?? []; const definition = expected.get(instance.id); if (!definition) continue;
    if (reports.length !== 1) {
      const problem = reports.length ? 'Conflicting or duplicate reports cannot mask a failed result' : 'Necessary verification instance has no report';
      if (definition.required) issue(problem);
      for (const id of definition.obligationIds) obligationReasons.get(id)!.push(problem);
      continue;
    }
    const result = reports[0]!; const reported = new Set<string>();
    for (const check of result.checks) {
      if (!definition.obligationIds.includes(check.obligationId)) { issue('Report claims an obligation outside its frozen instance'); continue; }
      if (reported.has(check.obligationId)) issue('Duplicate obligation checks cannot mask a failed result'); reported.add(check.obligationId);
    }
    for (const id of definition.obligationIds) {
      const obligation = spec.obligations.find(o => o.id === id)!; const checks = result.checks.filter(c => c.obligationId === id); const errors = obligationReasons.get(id)!;
      if (result.executionStatus !== 'executed') errors.push(`Instance ${instance.id} was ${result.executionStatus}`);
      if (checks.length !== 1) errors.push(`Instance ${instance.id} lacks exactly one obligation check`);
      for (const check of checks) {
        const allowed = obligation.applicable ? check.verdict === 'passed' : check.verdict === 'not-applicable' && !!obligation.notApplicableReason;
        if (!allowed) errors.push(`Instance ${instance.id} verdict ${check.verdict} does not satisfy obligation ${id}`);
        if (!check.reason?.trim()) errors.push(`Instance ${instance.id} has no check explanation`);
      }
      if (obligation.required && errors.length) issue(`Necessary obligation ${id} is unsatisfied`);
    }
  }
  const obligations = spec.obligations.map(o => {
    const errors = obligationReasons.get(o.id)!;
    if (o.required && o.applicable && !final.instances.some(i => i.obligationIds.includes(o.id))) { errors.push('No active executable coverage'); issue(`Necessary obligation ${o.id} has no executable coverage`); }
    if (o.required && o.applicable && !selection.instances.some(i => i.obligationIds.includes(o.id))) errors.push('Obligation was not selected');
    return { id: o.id, satisfied: errors.length === 0 && (!o.applicable ? !!o.notApplicableReason : selection.instances.some(i => i.obligationIds.includes(o.id))), reasons: [...new Set(errors)] };
  });
  for (const o of spec.obligations.filter(o => o.required && (selection.mode === 'final' || selection.instances.some(i => i.obligationIds.includes(o.id))))) if (!obligations.find(v => v.id === o.id)!.satisfied) issue(`Necessary obligation ${o.id} is unsatisfied`);
  const passed = context.current !== false && obligations.filter(o => spec.obligations.find(v => v.id === o.id)!.required && selection.instances.some(i => i.obligationIds.includes(o.id))).every(o => o.satisfied) && !reasons.some(r => !r.startsWith('Partial impact'));
  return { passed, complete: passed && reasons.length === 0 && selection.mode === 'final' && selection.completeScope, reasons, obligations };
}
