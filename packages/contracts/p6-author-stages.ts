import type {VerificationSpec} from './p4.js';

export const AUTHOR_STAGE_PROTOCOL = 'acceptance-stages-v1' as const;
export const AUTHOR_STAGE_ORDER = ['definition', 'positive', 'negative'] as const;
export type AuthorStage = typeof AUTHOR_STAGE_ORDER[number];
/** Versioned policy only. The actual Run ledger/clock must enforce these bounds. */
export const AUTHOR_STAGE_POLICY = {
  schemaVersion: 1,
  policy: 'per-call-timeout-shared-session-tokens-v1',
  stages: AUTHOR_STAGE_ORDER,
  callsRequired: 3,
  timeout: 'min-original-per-call-and-loop-remaining',
  tokens: 'original-author-reservation-shared-by-all-stages',
} as const;
export interface AuthorStageParent {
  stage: AuthorStage;
  jobId: string;
  inputDigest: string;
  resultDigest: string;
  rawOutputDigest: string;
  proofsDigest: string;
}
/** Host-derived and later rechecked against actual jobs; never model authority. */
export interface HostAuthorStageBinding {
  protocol: typeof AUTHOR_STAGE_PROTOCOL;
  sessionId: string;
  index: 0 | 1 | 2;
  stage: AuthorStage;
  sessionTokenCeiling: number;
  perCallTimeoutMs: number;
  loopDeadlineMs: number;
  parents: AuthorStageParent[];
}
export interface AuthorStageFile {path: string; content: string}
export interface AuthorStageControl {id: string; files: AuthorStageFile[]}
export interface AuthorDefinitionStage {
  protocol: typeof AUTHOR_STAGE_PROTOCOL;
  stage: 'definition';
  contextDigest: string;
  spec: VerificationSpec;
  verifierFiles: AuthorStageFile[];
  coverageExplanation: {criterionId: string; check: string; caseIds: string[]; explanation: string}[];
  negativeBases: {controlId: string; positiveId: string}[];
}
export interface AuthorPositiveStage {
  protocol: typeof AUTHOR_STAGE_PROTOCOL;
  stage: 'positive';
  contextDigest: string;
  definitionDigest: string;
  controls: AuthorStageControl[];
}
export type AuthorControlFileChange =
  | {path: string; operation: 'replace' | 'add'; content: string}
  | {path: string; operation: 'delete'};
export interface AuthorNegativeStage {
  protocol: typeof AUTHOR_STAGE_PROTOCOL;
  stage: 'negative';
  contextDigest: string;
  definitionDigest: string;
  positiveDigest: string;
  controls: {id: string; basePositiveId: string; basePositiveDigest: string; fileChanges: AuthorControlFileChange[]}[];
}
export type AuthorStageOutput = AuthorDefinitionStage | AuthorPositiveStage | AuthorNegativeStage;

/** V2 relocates verifier content to the positive stage; V1 remains immutable. */
export const AUTHOR_STAGE_PROTOCOL_V2 = 'acceptance-stages-v2' as const;
export type AuthorStageProtocol = typeof AUTHOR_STAGE_PROTOCOL | typeof AUTHOR_STAGE_PROTOCOL_V2;
export interface HostAuthorStageBindingV2 extends Omit<HostAuthorStageBinding, 'protocol'> {
  protocol: typeof AUTHOR_STAGE_PROTOCOL_V2;
}
export interface AuthorDefinitionStageV2 extends Omit<AuthorDefinitionStage, 'protocol' | 'verifierFiles'> {
  protocol: typeof AUTHOR_STAGE_PROTOCOL_V2;
  verifierPaths: string[];
}
export interface AuthorPositiveStageV2 extends Omit<AuthorPositiveStage, 'protocol'> {
  protocol: typeof AUTHOR_STAGE_PROTOCOL_V2;
  verifierFiles: AuthorStageFile[];
}
export interface AuthorNegativeStageV2 extends Omit<AuthorNegativeStage, 'protocol'> {
  protocol: typeof AUTHOR_STAGE_PROTOCOL_V2;
}
export type AuthorStageOutputV2 = AuthorDefinitionStageV2 | AuthorPositiveStageV2 | AuthorNegativeStageV2;
export type AnyHostAuthorStageBinding = HostAuthorStageBinding | HostAuthorStageBindingV2;
