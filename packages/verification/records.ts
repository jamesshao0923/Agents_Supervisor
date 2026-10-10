import type {VerificationEnvironmentScope} from '../contracts/p4-environment.js';
import type {MobileEvidence,MobileArtifact} from './mobile-evidence.js';
import type {MaterialObservation} from '../contracts/p4-material.js';
import type { VerificationEvaluation, VerificationResult, VerificationSelection, VerificationSpec } from '../contracts/p4.js';
import type { ProcessIdentity, ProcessIntent, ProcessResult } from '../process-control/index.js';
import type { Candidate } from './candidate.js';
export interface ModelConfig { model: string; effort: string; reservation: number; timeoutMs: number }
export interface DefinitionBundle {
  root: string; directory: string; specPath: string; specDigest: string; files: Record<string, string>; digest: string;
  controls: { id: string; candidate: Candidate }[];
}
export interface Proposal {
  environmentScope?:VerificationEnvironmentScope;
  id: string; runtimeId: string; projectId: string; runId: string; baseVersion: number; version: number | null;
  spec: VerificationSpec; bundle: DefinitionBundle; candidate: Candidate; contractDigest: string;
  status: 'proposed' | 'published'; createdAt: string; reviewId?: string; reviewEnvironmentDigest?: string;
  /** Frozen before binding; qualified evidence is appended separately after review. */
  controlDraftDigest?: string;
  maintenanceId?:string; maintenanceDigest?:string; regressionDigest?:string;
  researchProofPlanDigest?:string;
}
export interface FrozenPlan {
  environmentScope?:VerificationEnvironmentScope;
  id: string; runtimeId: string; projectId: string; runId: string; proposalId: string; catalogVersion: number;
  candidate: Candidate; contractDigest: string; definitionDigest: string; environmentDigest: string;
  selection: VerificationSelection; createdAt: string;
}
export interface SourceObservation { id: string; url: string; digest: string; acquiredAt: string; maxAgeMs: number; path: string }
export interface VerificationJob {
  environmentScope?:VerificationEnvironmentScope;
  researchProofPlanDigest?:string;
  approvalScope?:'research-artifact';
  fullstackEvidence?:import('./fullstack-verifier.js').FullstackEvidence[];
  fullstackProcessResults?:import('../process-control/index.js').ProcessResult[];
  id: string; runtimeId: string; projectId: string; runId: string; workspace: string; kind: 'review' | 'verification';
  proposalId: string; planId: string | null; request: unknown; status: 'running' | 'finished';
  attemptId: string; environmentDigest: string; config: ModelConfig; startedAt: string; finishedAt: string | null;
  intents: ProcessIntent[]; identities: ProcessIdentity[]; usage: number; modelStarted: boolean; usageUnknown: boolean;
  results: VerificationResult[]; controls: { id: string; passed: boolean; results: VerificationResult[] }[];
  evaluation: VerificationEvaluation | null; approved: boolean; stopConfirmed: boolean; error: string | null;
  proofs: Record<string, string>; sources: SourceObservation[]; mobileEvidence?:MobileEvidence[]; mobileProcessResults?:Array<ProcessResult|null>; materials?:MaterialObservation[];
}
export interface Delivery {
  id: string; jobId: string; planId: string; runtimeId: string; projectId: string; runId: string;
  candidateDigest: string; definitionDigest: string; createdAt: string; path: string; researchProofPlanDigest?:string; mobilePackage?:{path:string;files:Record<string,string>;artifacts:MobileArtifact[]};
}
export type VerificationAction =
  | import('./delivery-open.js').DeliveryOpenRequest
  | {type:'close-open';sessionId:string}
  | {type:'open-session';sessionId:string}
  | { type: 'propose'; commandId: string; runtimeId: string; specPath: string; controlDeclarationPath?: string; controlAuthorJobId?: string; researchAuthorJobId?:string }
  | ({ type: 'review'; commandId: string; proposalId: string } & ModelConfig)
  | { type: 'publish'; commandId: string; proposalId: string; reviewId: string }
  | { type: 'freeze'; commandId: string; runtimeId: string; mode: 'final' | 'impact'; changedModules?: string[] }
  | ({ type: 'run'; commandId: string; planId: string; futureVerificationAllocationId?:string } & ModelConfig)
  | { type: 'deliver'; commandId: string; jobId: string }
  | { type: 'cancel'; jobId: string }
  | { type: 'job'; jobId: string }
  | { type: 'status'; runtimeId: string };
