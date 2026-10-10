import type { AssembledControlQualification, BootstrapEvidence, FrozenControlDraft } from './p4-control-draft.js';
import type { QualificationExecution } from '../verification/control-engine.js';
import type { ModelReviewResult } from '../verification/model.js';

export interface StoredControlDraft {
  schemaVersion: 1; proposalId: string; proposalDigest: string; draftDigest: string;
  draft: FrozenControlDraft;
}
export type ControlReviewStagePayloads = {
  bootstrap: { draftDigest: string };
  'matrix-frozen': { bootstrap: BootstrapEvidence; assembled: AssembledControlQualification };
  qualification: { execution: QualificationExecution };
  'independent-review': { review: ModelReviewResult; promptDigest: string };
};
export type ControlReviewStageName = keyof ControlReviewStagePayloads;
export interface ControlReviewStage {
  reviewJobId: string; proposalId: string; stage: ControlReviewStageName;
  sequence: number; payload: ControlReviewStagePayloads[ControlReviewStageName];
  payloadDigest: string; createdAt: string;
}
export interface ControlQualificationEvidence {
  schemaVersion: 1; id: string; proposalId: string; proposalDigest: string;
  controlDraftDigest: string; reviewJobId: string; environmentDigest: string;
  bootstrap: BootstrapEvidence; assembled: AssembledControlQualification;
  execution: QualificationExecution; independentReview: ModelReviewResult;
  reviewPromptDigest: string; proofs: Record<string, string>; digest: string;
}
