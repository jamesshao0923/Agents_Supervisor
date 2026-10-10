import type { ProposalBase } from './p4-lineage.js';
import type { VerificationInstance, VerificationResult } from './p4.js';
import type { Candidate } from '../verification/candidate.js';
export interface RegressionSource {
    defectRef: string;
    failureJobId: string;
    repairEventSeq: number;
    candidate: Candidate;
    instance: VerificationInstance;
    result: VerificationResult;
    obligationIds: string[];
}
export interface MaintenanceBasis {
    schemaVersion: 1;
    policy: 'same-contract-regression-v1';
    loopId: string;
    projectId: string;
    runId: string;
    runtimeId: string;
    contractVersion: number;
    contractDigest: string;
    base: ProposalBase;
    baselinePassJobId: string;
    baselinePassPlanId: string;
    passingCandidate: Candidate;
    environmentDigest: string;
    sources: RegressionSource[];
    necessity: 'required-regression' | 'optional-deduplication';
}
export interface MaintenanceMapping {
    defectRef: string;
    caseId: string;
    revision: number;
    parameters: Record<string, string>;
}
export interface MaintenancePlan {
    regressions: MaintenanceMapping[];
    reason: string;
}
export interface RegressionContext {
    sources: RegressionSource[];
    passingCandidate: Candidate;
    sourceText: Record<string, Record<string, {
        content: string;
        executable: number;
    }>>;
}
export interface MaintenanceContext {
    basis: MaintenanceBasis;
    /** Full immutable bad source text and executable modes; capacity failure never truncates it. */
    sourceText: Record<string, Record<string, {
        content: string;
        executable: number;
    }>>;
}
export interface MaintenanceRecord {
    id: string;
    basis: MaintenanceBasis;
    basisDigest: string;
    authorJobId: string;
    status: 'authoring' | 'proposed' | 'reviewed' | 'complete' | 'failed';
    proposalId: string | null;
    reviewId: string | null;
    finalJobId: string | null;
    reason: string | null;
}
export interface MaintenanceReplay {
    id: string;
    defectRef: string;
    source: RegressionSource;
    instance: VerificationInstance;
    passingCandidate: Candidate;
    bad: VerificationResult[];
    good: VerificationResult[];
}
export interface MaintenanceReplayStage {
    schemaVersion: 1;
    proposalId: string;
    reviewId: string;
    replays: MaintenanceReplay[];
    /** Exact original bad/good process artifacts, immutable with the sidecar. */
    executionProofs: Record<string, string>;
    digest: string;
}
export interface MaintenanceReviewPayload {
    passingSourceText: Record<string, { content: string; executable: number }>;
    context: MaintenanceContext | RegressionContext;
    plan: MaintenancePlan;
    replay: MaintenanceReplayStage;
}
