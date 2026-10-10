/** Internal mechanism types. Neither a caller receipt nor this pure result grants P4 delivery authority. */
export type ResearchHostGate = 'admitted-research-scope' | 'producer-authoritative-stop' | 'same-run-known-accounting' | 'material-current' | 'controls-qualified' | 'definition-approved' | 'full-final-qualified' | 'delivery-authorized' | 'delivery-receipted';
export type ResearchHostPhase = 'preflight' | 'review-complete' | 'final-settled' | 'delivery-inserted';
export interface OriginalResearchCheck {
    criterionId: string;
    checkIndex: number;
    text: string;
}
export interface ResearchCheckMapping extends OriginalResearchCheck {
    checkDigest: string;
    artifactObligationIds: string[];
    hostRequirements: {
        gate: ResearchHostGate;
        phase: ResearchHostPhase;
    }[];
}
export interface ResearchProofPlan {
    schemaVersion: 1;
    contractDigest: string;
    originalChecks: ResearchCheckMapping[];
    digest: string;
}
export interface ResearchWorkflowBinding {
    runtimeId: string;
    projectId: string;
    runId: string;
    proposalId: string;
    planId: string;
    jobId: string;
    candidateDigest: string;
    definitionDigest: string;
    contractDigest: string;
}
export interface ResearchHostFact {
    gate: ResearchHostGate;
    phase: ResearchHostPhase;
    status: 'satisfied' | 'refused' | 'unresolved' | 'pending-phase';
    binding: ResearchWorkflowBinding;
    recordRefs: {
        kind: string;
        id: string;
        digest: string;
    }[];
    reasons: string[];
}
export interface ResearchCombinedResult {
    complete: boolean;
    checks: {
        criterionId: string;
        checkIndex: number;
        satisfied: boolean;
        reasons: string[];
    }[];
}
export interface ResearchWorkflowDeclaration {
    schemaVersion: 1;
    mappings: {
        criterionId: string;
        checkIndex: number;
        artifactObligationIds: string[];
        hostGates: ResearchHostGate[];
    }[];
}
export interface ResearchWorkflowProposal {
    schemaVersion: 1;
    proposalId: string;
    proofPlan: ResearchProofPlan;
    authorJobId: string;
    digest: string;
}
export interface ResearchArtifactEvidence {
    schemaVersion: 1;
    binding: ResearchWorkflowBinding;
    proofPlanDigest: string;
    jobDigest: string;
    resultsDigest: string;
    boundaryDigest: string;
    boundary: unknown;
    files: Record<string, string>;
    hostFacts: ResearchHostFact[];
    capturedAt: string;
    digest: string;
}
export interface ResearchDeliverySeal {
    schemaVersion: 1;
    deliveryId: string;
    commandId: string;
    receiptCoreDigest: string;
    proofPlanDigest: string;
    artifactEvidenceDigest: string;
    binding: ResearchWorkflowBinding;
    hostFacts: ResearchHostFact[];
    combined: ResearchCombinedResult;
    digest: string;
}
