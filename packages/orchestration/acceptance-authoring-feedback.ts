/** Diagnostics only: never rewrites output, resolves an ID or grants publication. */
export interface AcceptanceReferenceDiagnostic {
  schemaVersion: 1;
  declared: { obligations: string[]; cases: string[]; controls: string[] };
  missing: { path: string; namespace: 'obligation' | 'case'; value: string }[];
}
export function acceptanceReferenceDiagnostic(value: unknown): AcceptanceReferenceDiagnostic {
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
  const root = object(value), spec = object(root.spec);
  const ids = (v: unknown) => array(v).map(item => object(item).id).filter((id): id is string => typeof id === 'string');
  const result: AcceptanceReferenceDiagnostic = { schemaVersion: 1, declared: { obligations: ids(spec.obligations), cases: ids(spec.cases), controls: ids(spec.controls) }, missing: [] };
  function references(items: unknown, key: string, path: string, namespace: 'obligation' | 'case') {
    array(items).forEach((item, i) => array(object(item)[key]).forEach((ref, j) => {
      if (typeof ref === 'string' && !(namespace === 'obligation' ? result.declared.obligations : result.declared.cases).includes(ref)) result.missing.push({ path: `${path}[${i}].${key}[${j}]`, namespace, value: ref });
    }));
  }
  references(spec.cases, 'obligationIds', 'spec.cases', 'obligation');
  references(spec.controls, 'mustFail', 'spec.controls', 'obligation');
  references(spec.cases, 'replaces', 'spec.cases', 'case');
  references(root.coverageExplanation, 'caseIds', 'coverageExplanation', 'case');
  return result;
}
