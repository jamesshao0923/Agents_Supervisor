import type { ReasonerConfig } from './p5.js';
import type { RoutingCapabilities, SupervisionRoutingPolicy } from './p6-routing.js';
export interface AuthorSchemaRejection { schemaVersion:1;kind:'schema';rawOutputDigest:string;message:string }
/** The raw value is rejected evidence and has no AcceptanceBundle authority. */
export interface AuthorRejection {
 schemaVersion:1;kind:'schema'|'semantic'|'review';previousJobId:string;jobDigest:string;
 inputDigest:string;schemaDigest:string;rawOutputPath:string;rawOutputDigest:string;
 message:string;raw:unknown;proofsDigest:string;workspaceBoundaryDigest:string;
 review?:AuthorReviewRejectionEvidence;
}
export interface AuthorRouteReceiptV1 {
 schemaVersion:1;id:string;commandId:string;loopId:string;contractDigest:string;
 rejection:AuthorRejection;policy:SupervisionRoutingPolicy;policyDigest:string;
 capabilities:RoutingCapabilities;baseline:ReasonerConfig;selected:ReasonerConfig;
 nextInputDigest:string;nextJobId:string;createdAt:string;
}

export interface AuthorReviewRejectionEvidence {
 schemaVersion:1;classification:'control-rejected'|'definition-rejected';
 proposalId:string;proposalDigest:string;baseDigest:string;candidateDigest:string;definitionDigest:string;
 review:import('../verification/records.js').VerificationJob;
 diagnostics:{path:string;digest:string;text:string}[];
 independentReview?:import('../verification/model.js').ModelReviewResult;
}

/** Host preference only, never a measured vendor quality/latency claim. */
export interface AuthorRoutingPolicyV2 {
 schemaVersion:2; version:'acceptance-author-quality-depth-v2';
 preference:'quality-first'; models:{id:string;qualityRank:number}[];
 minimumEffort:'medium'; capabilityMaxAgeMs:number;
}
/** Derived from actual immutable completed stage/patch jobs in one original author session. */
export interface AuthorSessionBudget {
 schemaVersion:1; sessionId:string; rootJobId:string; ceiling:number; spent:number; remaining:number;
 jobs:{jobId:string;inputDigest:string;completionDigest:string;proofsDigest:string;usage:number}[];
}
export interface AuthorRouteAuthorizationV2 {
 authorSession?:AuthorSessionBudget;
 observedAt:string; loopCreatedAt:string; absoluteDeadlineMs:number;
 loopRevision:number; runRevision:number; originalTimeoutMs:number;
 budget:{limit:number;spent:number;reserved:number;protected:number};
 maxContextChars:number; storedChars:number; wireChars:number;
 inputDigest:string; wireDigest:string;
}
export interface AuthorRouteReceiptV2 extends Omit<AuthorRouteReceiptV1,'schemaVersion'|'policy'> {
 schemaVersion:2; policy:AuthorRoutingPolicyV2;
 authorization:AuthorRouteAuthorizationV2;
}
export type AuthorRouteReceipt=AuthorRouteReceiptV1|AuthorRouteReceiptV2;
