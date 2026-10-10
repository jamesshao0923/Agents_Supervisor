import type { MaintenanceBasis, MaintenancePlan, MaintenanceReplay, RegressionSource } from '../contracts/p6-control-maintenance.js';
import type { VerificationInstance, VerificationResult, VerificationSpec } from '../contracts/p4.js';
import { canonical, digest } from './candidate.js';
import { currentVerificationCases, selectInstances } from './rules.js';
export function maintenanceEnsure(v: unknown, m: string): asserts v {
    if (!v)
        throw Error('Control maintenance: ' + m);
}
export const maintenanceDigest = (v: unknown) => digest(canonical(v));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function regressionRef(jobId: string, instance: VerificationInstance, result: VerificationResult): string {
    return 'regression-' + maintenanceDigest({ jobId, instance, result }).slice(0, 40);
}
export function maintenanceInstance(spec: VerificationSpec, mapping: MaintenancePlan['regressions'][number], source: RegressionSource): VerificationInstance {
    const instances = selectInstances(spec, { mode: 'final' }).instances.filter(i => i.caseId === mapping.caseId
        && i.revision === mapping.revision
        && same(i.parameters, mapping.parameters));
    maintenanceEnsure(instances.length === 1, 'Regression needs one exact final instance');
    const i = instances[0]!;
    const c = spec.cases.find(c => c.id === i.caseId && c.revision === i.revision)!;
    maintenanceEnsure(c.verifier.kind === 'command' && !c.verifier.build,
        'Regression evidence supports command detectors without build only');
    maintenanceEnsure(i.required
        && c.defectRefs.includes(source.defectRef)
        && source.obligationIds.every(id => i.obligationIds.includes(id)), 'Regression cannot drop necessary fault scope or defectRef');
    return i;
}
export function assertMaintenancePlan(basis: MaintenanceBasis, old: VerificationSpec, next: VerificationSpec, plan: MaintenancePlan): void {
    maintenanceEnsure(same(old.obligations, next.obligations)
        && old.contractVersion === next.contractVersion
        && old.standardsVersion === next.standardsVersion, 'Maintenance cannot change business standards');
    maintenanceEnsure(plan && typeof plan.reason === 'string' && plan.reason.trim() && Array.isArray(plan.regressions), 'Missing concrete maintenance plan');
    const refs = basis.sources.map(s => s.defectRef).sort();
    maintenanceEnsure(same(plan.regressions.map(m => m.defectRef).sort(), refs) && new Set(refs).size === refs.length, 'Every required actual defect needs exactly one mapping');
    for (const source of basis.sources) {
        const m = plan.regressions.find(m => m.defectRef === source.defectRef)!;
        maintenanceInstance(next, m, source);
    }
    maintenanceEnsure(!same(old.cases, next.cases), 'No-op maintenance cannot claim a changed regression library');
    // A retired case needs replayable actual fault evidence for every necessary parameter.
    // Existing general lineage rules independently preserve all old revisions and replacements.
    for (const c of currentVerificationCases(old).filter(c => c.status !== 'retired')) {
        const now = currentVerificationCases(next).find(n => n.id === c.id);
        if (now?.status !== 'retired')
            continue;
        for (const parameters of c.parameters)
            for (const id of c.obligationIds.filter(id => old.obligations.some(o => o.id === id && o.required && o.applicable))) {
                const witnesses = basis.sources.filter(s => s.instance.caseId === c.id && same(s.instance.parameters, parameters) && s.obligationIds.includes(id));
                maintenanceEnsure(witnesses.length > 0, 'Optional retirement lacks actual instance-specific replacement witness');
                for (const source of witnesses) {
                    const m = plan.regressions.find(m => m.defectRef === source.defectRef)!;
                    const successor = currentVerificationCases(next).find(n => n.id === m.caseId);
                    maintenanceEnsure(successor?.replaces.includes(c.id), 'Replacement witness must belong to declared successor');
                }
            }
    }
}
export function assertMaintenanceReplay(replay: MaintenanceReplay): void {
    for (const [label, results, verdict] of [['bad', replay.bad, 'failed'], ['good', replay.good, 'passed']] as const) {
        maintenanceEnsure(results.length === 1
            && results[0]!.instanceId === replay.instance.id
            && results[0]!.executionStatus === 'executed', 'Regression ' + label + ' did not execute its exact detector');
        const checks = results[0]!.checks;
        maintenanceEnsure(new Set(checks.map(c => c.obligationId)).size === checks.length, 'Duplicate regression checks');
        for (const id of replay.source.obligationIds)
            maintenanceEnsure(checks.some(c => c.obligationId === id && c.verdict === verdict), 'Regression ' + label + ' lacks specific ' + verdict + ' business check');
        if (label === 'good')
            for (const id of replay.instance.obligationIds)
                maintenanceEnsure(checks.some(c => c.obligationId === id && c.verdict === 'passed'), 'Positive regression instance is not fully passing');
        maintenanceEnsure(results[0]!.proofFiles?.length, 'Regression execution lacks actual proofs');
    }
}
