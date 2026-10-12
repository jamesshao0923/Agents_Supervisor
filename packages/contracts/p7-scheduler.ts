import type { TaskNode, RunStatus } from './p1.js';
import type { DependencyBinding, ResultLedger, ResultProducer } from './p7-results.js';
/** Host-derived frozen facts, never model supplied permissions or calibrated probabilities. */
export type ExplorationTier = 'low' | 'medium' | 'high' | 'unlimited';
export type AdmissionBasis = 'strong' | 'supported' | 'exploratory' | 'uncertain';
export interface SchedulerAdmission {
  authorized: boolean; executable: boolean; relevant: boolean; duplicate: boolean;
  independentVerificationPurpose: string | null;
  requirementRefs: string[]; quality: AdmissionBasis; value: AdmissionBasis; reasons: string[];
}
export interface SchedulerResource { kind: 'path' | 'port' | 'database' | 'device' | 'custom'; key: string; mode: 'read' | 'write' }
export interface SchedulerNode extends TaskNode {
  inputs: DependencyBinding[]; admission: SchedulerAdmission; resources: SchedulerResource[];
  reservation: number; loopIds: string[];
}
export interface SchedulerClaim {
  id: string; taskId: string; reservation: number; resources: SchedulerResource[]; loopIds: string[];
  usage: 'known' | 'unknown'; effects: 'pending' | 'unknown';
}
/** Child token estimates constrain finite Runs; null root limit disables token ceilings.
 * They are not extra global reservations. Iteration/depth/node bounds always apply. */
export interface SchedulerLoop {
  id: string; parentId: string | null; depth: number; iteration: number; maxIterations: number;
  nodeCount: number; maxNodes: number; limit: number; spent: number;
}
export interface SchedulerSnapshot {
  schemaVersion: 1; revision: number; scope: Pick<ResultProducer, 'projectId' | 'runId' | 'contractVersion' | 'contractDigest'>;
  status: RunStatus; tier: ExplorationTier; nodes: SchedulerNode[]; results: ResultLedger;
  claims: SchedulerClaim[]; loops: SchedulerLoop[];
  /** Host projects every actual current-generation claim, including settled ones. */
  attemptedTaskIds?: string[];
  budget: { limit: number | null; spent: number; verificationRemaining: number; futureVerificationFloor: number; futureExecutionFloor?:number };
  limits: { maxActive: number; maxNodes: number; maxDepth: number; nowMs: number; deadlineMs: number };
}
export interface SchedulerNodeDecision {
  taskId: string; admitted: boolean; ready: boolean; dispatch: boolean; reasons: string[];
  inputs: DependencyBinding[];
}
/** exhausted means no unfinished necessary or admitted graph work; it never means verified delivery. */
export interface SchedulerDecision {
  schemaVersion: 1; policyVersion: 'p7-scheduler-v1'; id: string; snapshotDigest: string; revision: number;
  state: 'dispatch' | 'active' | 'waiting' | 'exhausted' | 'stopped';
  nodes: SchedulerNodeDecision[]; dispatchTaskIds: string[]; requiredGaps: string[];
  reservation: number; remaining: number | null; reasons: string[];
}
export interface SchedulerExpansion {
  parentLoopId: string | null; childDepth: number; additionalNodes: number; reservation: number;
}
export interface SchedulerExpansionDecision { allowed: boolean; reasons: string[] }
