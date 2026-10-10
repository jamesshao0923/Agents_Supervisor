import type { AcceptanceItem } from '../contracts/p5.js';
import type { TaskContract } from '../contracts/p1.js';
import type { VerificationSpec } from '../contracts/p4.js';
import type { ResearchWorkflowDeclaration } from '../contracts/p4-research-workflow.js';
import { ASSET_ID_PATTERN } from '../orchestration/reasoner-schema.js';
import { safeControlJSON } from '../contracts/p4-controls.js';
import { canonical, digest } from './candidate.js';
import type { OriginalResearchCheck, ResearchProofPlan, ResearchWorkflowBinding, ResearchHostFact, ResearchHostGate, ResearchHostPhase, ResearchCombinedResult } from '../contracts/p4-research-workflow.js';
const phases: ResearchHostPhase[] = ['preflight', 'review-complete', 'final-settled', 'delivery-inserted'];
export const requiredPhase: Record<ResearchHostGate, ResearchHostPhase> = {
    'admitted-research-scope': 'preflight',
    'producer-authoritative-stop': 'preflight',
    'same-run-known-accounting': 'final-settled',
    'material-current': 'final-settled',
    'controls-qualified': 'review-complete',
    'definition-approved': 'review-complete',
    'full-final-qualified': 'final-settled',
    'delivery-authorized': 'delivery-inserted',
    'delivery-receipted': 'delivery-inserted'
};
function ensure(v: unknown, m: string): asserts v {
    if (!v)
        throw Error('Research workflow: ' + m);
}
export const researchCheckDigest = (check: OriginalResearchCheck) => digest(canonical(check));
export function validateResearchProofPlan(plan: ResearchProofPlan, original: OriginalResearchCheck[], contractDigest: string, artifactObligationIds: readonly string[]): void {
    ensure(plan.schemaVersion === 1
        && plan.contractDigest === contractDigest, 'contract/version differs');
    const { digest: own, ...body } = plan;
    ensure(own === digest(canonical(body)), 'proof plan digest differs');
    ensure(plan.originalChecks.length === original.length
        && original.length > 0, 'missing original checks');
    const known = new Set(artifactObligationIds);
    ensure(known.size === artifactObligationIds.length, 'duplicate frozen artifact obligation');
    plan.originalChecks.forEach((mapped, index) => {
        const check = original[index]!;
        ensure(canonical({
            criterionId: mapped.criterionId,
            checkIndex: mapped.checkIndex,
            text: mapped.text
        }) === canonical(check)
            && mapped.checkDigest === researchCheckDigest(check), 'ordered original check changed');
        ensure(mapped.artifactObligationIds.length > 0
            && new Set(mapped.artifactObligationIds).size === mapped.artifactObligationIds.length
            && mapped.artifactObligationIds.every(id => known.has(id)), 'missing or unknown artifact mapping; host facts cannot replace artifact requirements');
        const gates = new Set<string>();
        for (const requirement of mapped.hostRequirements) {
            ensure(Object.hasOwn(requiredPhase, requirement.gate)
                && requirement.phase === requiredPhase[requirement.gate], 'unsupported gate/phase');
            ensure(!gates.has(requirement.gate), 'duplicate host gate');
            gates.add(requirement.gate);
        }
    });
    ensure(artifactObligationIds.every(id => plan.originalChecks.some(check => check.artifactObligationIds.includes(id))), 'frozen artifact obligation omitted');
}
/** Internal pure conjunction only. Mapping fidelity still needs independent P4 review;
 * this output is not a VerificationResult or a generic delivery permission. */
export function evaluateResearchWorkflow(input: {
    plan: ResearchProofPlan;
    original: OriginalResearchCheck[];
    binding: ResearchWorkflowBinding;
    phase: ResearchHostPhase;
    artifactResults: {
        obligationId: string;
        verdict: 'passed' | 'failed' | 'unknown';
    }[];
    hostFacts: ResearchHostFact[];
}): ResearchCombinedResult {
    validateResearchProofPlan(input.plan, input.original, input.binding.contractDigest, input.artifactResults.map(r => r.obligationId));
    ensure(phases.includes(input.phase), 'unsupported current phase');
    const gates = new Set<string>();
    for (const fact of input.hostFacts) {
        ensure(!gates.has(fact.gate), 'duplicate host fact');
        gates.add(fact.gate);
        ensure(canonical(fact.binding) === canonical(input.binding), 'host fact belongs to another frozen scope');
        ensure(Object.hasOwn(requiredPhase, fact.gate)
            && fact.phase === requiredPhase[fact.gate], 'host fact phase differs');
        ensure(['satisfied', 'refused', 'unresolved', 'pending-phase'].includes(fact.status), 'unsupported host state');
        if (fact.status === 'satisfied')
            ensure(fact.recordRefs.length > 0
                && fact.recordRefs.every(r => r.kind
                && r.id
                && /^[a-f0-9]{64}$/.test(r.digest)), 'satisfied host fact lacks actual record references');
    }
    const checks = input.plan.originalChecks.map(check => {
        const reasons: string[] = [];
        for (const id of check.artifactObligationIds)
            if (input.artifactResults.find(r => r.obligationId === id)?.verdict !== 'passed')
                reasons.push('Artifact evidence not passed: ' + id);
        for (const requirement of check.hostRequirements) {
            const fact = input.hostFacts.find(f => f.gate === requirement.gate);
            if (phases.indexOf(input.phase) < phases.indexOf(requirement.phase))
                reasons.push('Required later phase: ' + requirement.gate);
            else if (!fact
                || fact.status !== 'satisfied')
                reasons.push('Host evidence unresolved/refused: ' + requirement.gate);
        }
        return {
            criterionId: check.criterionId,
            checkIndex: check.checkIndex,
            satisfied: reasons.length === 0,
            reasons
        };
    });
    return {
        complete: checks.every(c => c.satisfied),
        checks
    };
}
export const RESEARCH_HOST_GATES = Object.keys(requiredPhase) as ResearchHostGate[];
export function originalResearchChecks(criteria: AcceptanceItem[], contract: TaskContract): OriginalResearchCheck[] {
    safeControlJSON(criteria);
    ensure(criteria.length === contract.criteria.length
        && contract.criteria.every(c => {
        const item = criteria.find(i => i.id === c.id);
        return c.required
            && item
            && c.description === [item.description, `Acceptance kind: ${item.kind}; target: ${item.target}`, ...item.checks].join('\n');
    }), 'actual admitted structured criteria differ');
    return criteria.flatMap(c => c.checks.map((text, checkIndex) => ({
        criterionId: c.id,
        checkIndex,
        text
    })));
}
export function researchDeclarationSchema(criteria: AcceptanceItem[]): Record<string, unknown> {
    const obj = (properties: Record<string, unknown>) => ({
        type: 'object',
        additionalProperties: false,
        required: Object.keys(properties),
        properties
    });
    return obj({
        schemaVersion: {
            type: 'integer',
            const: 1
        },
        mappings: {
            type: 'array',
            minItems: criteria.reduce((n, c) => n + c.checks.length, 0),
            maxItems: criteria.reduce((n, c) => n + c.checks.length, 0),
            items: {
                anyOf: criteria.map(c => obj({
                    criterionId: {
                        type: 'string',
                        const: c.id
                    },
                    checkIndex: {
                        type: 'integer',
                        enum: c.checks.map((_, i) => i)
                    },
                    artifactObligationIds: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 64,
                        items: {
                            type: 'string',
                            pattern: ASSET_ID_PATTERN
                        }
                    },
                    hostGates: {
                        type: 'array',
                        maxItems: 9,
                        items: {
                            type: 'string',
                            enum: RESEARCH_HOST_GATES
                        }
                    }
                }))
            }
        }
    });
}
export function prepareResearchProofPlan(criteria: AcceptanceItem[], contract: TaskContract, spec: VerificationSpec, declaration: ResearchWorkflowDeclaration): ResearchProofPlan {
    safeControlJSON(declaration);
    const original = originalResearchChecks(criteria, contract);
    ensure(declaration.schemaVersion === 1 && declaration.mappings.length === original.length, 'incomplete native declaration');
    const mappings = original.map((c, i) => {
        const m = declaration.mappings[i]!;
        ensure(m.criterionId === c.criterionId && m.checkIndex === c.checkIndex, 'declaration order differs');
        ensure(m.artifactObligationIds.every(id => spec.obligations.some(o => o.id === id && o.criterionId === c.criterionId && o.required && o.applicable)), 'artifact obligation not owned by original criterion');
        return {
            ...c,
            checkDigest: researchCheckDigest(c),
            artifactObligationIds: [...m.artifactObligationIds],
            hostRequirements: m.hostGates.map(gate => ({
                gate,
                phase: requiredPhase[gate]
            }))
        };
    });
    const body = {
        schemaVersion: 1 as const,
        contractDigest: digest(canonical(contract)),
        originalChecks: mappings
    };
    const plan = {
        ...body,
        digest: digest(canonical(body))
    };
    validateResearchProofPlan(plan, original, body.contractDigest, spec.obligations.filter(o => o.required && o.applicable).map(o => o.id));
    return plan;
}
