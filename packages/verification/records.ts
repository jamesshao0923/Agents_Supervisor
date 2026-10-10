import type { VerificationEvaluation, VerificationResult, VerificationSelection, VerificationSpec } from '../contracts/p4.js';
import type { ProcessIdentity, ProcessIntent } from '../process-control/index.js';
import type { Candidate } from './candidate.js';
export interface ModelConfig { model: string; effort: string; reservation: number; timeoutMs: number }
export interface DefinitionBundle {
  root: string; directory: string; specPath: string; specDigest: string; files: Record<string, string>; digest: string;
  controls: { id: string; candidate: Candidate }[];
}
export interface Proposal {
  id: string; runtimeId: string; projectId: string; runId: string; baseVersion: number; version: number | null;
  spec: VerificationSpec; bundle: DefinitionBundle; candidate: Candidate; contractDigest: string;
  status: 'proposed' | 'published'; createdAt: string; reviewId?: string; reviewEnvironmentDigest?: string;
}
export interface FrozenPlan {
  id: string; runtimeId: string; projectId: string; runId: string; proposalId: string; catalogVersion: number;
  candidate: Candidate; contractDigest: string; definitionDigest: string; environmentDigest: string;
  selection: VerificationSelection; createdAt: string;
}
export interface SourceObservation { id: string; url: string; digest: string; acquiredAt: string; maxAgeMs: number; path: string }
export interface VerificationJob {
  id: string; runtimeId: string; projectId: string; runId: string; workspace: string; kind: 'review' | 'verification';
  proposalId: string; planId: string | null; request: unknown; status: 'running' | 'finished';
  attemptId: string; environmentDigest: string; config: ModelConfig; startedAt: string; finishedAt: string | null;
  intents: ProcessIntent[]; identities: ProcessIdentity[]; usage: number; modelStarted: boolean; usageUnknown: boolean;
  results: VerificationResult[]; controls: { id: string; passed: boolean; results: VerificationResult[] }[];
  evaluation: VerificationEvaluation | null; approved: boolean; stopConfirmed: boolean; error: string | null;
  proofs: Record<string, string>; sources: SourceObservation[];
}
export interface Delivery {
  id: string; jobId: string; planId: string; runtimeId: string; projectId: string; runId: string;
  candidateDigest: string; definitionDigest: string; createdAt: string; path: string;
}
export type VerificationAction =
  | { type: 'propose'; commandId: string; runtimeId: string; specPath: string }
  | ({ type: 'review'; commandId: string; proposalId: string } & ModelConfig)
  | { type: 'publish'; commandId: string; proposalId: string; reviewId: string }
  | { type: 'freeze'; commandId: string; runtimeId: string; mode: 'final' | 'impact'; changedModules?: string[] }
  | ({ type: 'run'; commandId: string; planId: string; futureVerificationAllocationId?:string } & ModelConfig)
  | { type: 'deliver'; commandId: string; jobId: string }
  | { type: 'cancel'; jobId: string }
  | { type: 'job'; jobId: string }
  | { type: 'status'; runtimeId: string };
