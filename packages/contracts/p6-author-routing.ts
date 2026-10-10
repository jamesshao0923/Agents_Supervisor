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
export interface AuthorRouteReceipt {
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
