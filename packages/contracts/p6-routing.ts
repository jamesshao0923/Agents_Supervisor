import type { ExecutorCapabilities } from './p2.js';
import type { ReasonerConfig } from './p5.js';
import type { NoProgressDecision, ProgressObservation, ReasoningEffort, ModelRouteDecision } from '../orchestration/loop-policy.js';
import type { ProcessIdentity } from '../process-control/index.js';

/** Explicit Supervisor preference, NOT measured vendor quality or token capacity. */
export interface SupervisionRoutingPolicy {
  schemaVersion: 1; version: string; preference: 'quality-first';
  models: { id: string; qualityRank: number }[];
  firstFailureEffort: ReasoningEffort; repeatedFailureEffort: ReasoningEffort;
  diagnoseAfter: number; blockAfter: number; capabilityMaxAgeMs: number;
}
export const SUPERVISOR_ROUTING_POLICY_V1: SupervisionRoutingPolicy = {
  schemaVersion: 1, version: 'supervisor-quality-preference-v1', preference: 'quality-first',
  models: [{ id: 'gpt-5.6-luna', qualityRank: 10 }, { id: 'gpt-5.6-terra', qualityRank: 15 }, { id: 'gpt-5.6-sol', qualityRank: 20 }, { id: 'gpt-6-luna', qualityRank: 25 }, { id: 'gpt-6-sol', qualityRank: 30 }, { id: 'gpt-6.1-sol', qualityRank: 40 }, { id: 'gpt-6-astra', qualityRank: 50 }],
  firstFailureEffort: 'high', repeatedFailureEffort: 'xhigh', diagnoseAfter: 2, blockAfter: 4, capabilityMaxAgeMs: 300000,
};
export interface RoutingCapabilities {
  id: string; capabilities: ExecutorCapabilities; proofPath: string; proofDigest: string;
  identity: ProcessIdentity; snapshotPath: string; snapshotDigest: string;
}
export interface SupervisionProgressRound {
  id: string; loopId: string; contractDigest: string; verificationJobId: string;
  jobDigest: string; planDigest: string; candidateDigest: string; observation: ProgressObservation;
  policyDigest: string; decision: NoProgressDecision; recordedAt: string;
}
export interface SupervisionRouteReceipt {
  id: string; commandId: string; loopId: string; contractDigest: string; failureJobId: string; progressRoundId: string;
  policy: SupervisionRoutingPolicy; policyDigest: string; capabilityId: string; capabilityDigest: string;
  inputDigest: string; baseline: ReasonerConfig; selected: ReasonerConfig; decision: ModelRouteDecision;
  reason: 'supervisor-quality-policy-after-product-failure'; reasoningJobId: string; createdAt: string;
}
