// P1 shared protocol. Pure domain types: no I/O or vendor dependencies.
export interface Criterion { id: string; description: string; required: boolean }
export interface TaskContract { version: number; goal: string; criteria: Criterion[] }
export type RunStatus = 'ready' | 'running' | 'paused' | 'blocked' | 'cancelled' | 'succeeded';
export interface TaskNode { id: string; dependencies: string[]; required: boolean; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' }
export interface Attempt {
  id: string; nodeId: string; contractVersion: number; status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  reservation: number; purpose: 'execution' | 'verification'; settled: boolean; actual: number | null;
}
export interface Budget { unit: 'work-unit' | 'token'; limit: number; spent: number; verificationReserve: number }
export interface Lease { resource: string; attemptId: string; released: boolean }
export interface Operation { id: string; attemptId: string; status: 'pending' | 'confirmed' | 'unknown' }
export interface Artifact { id: string; digest: string; path: string; contractVersion: number }
export interface Evidence {
  id: string; criterionId: string; contractVersion: number; artifactDigest: string;
  verdict: 'passed' | 'failed' | 'unknown'; verifierVersion: string;
}
export interface VerificationCase {
  id: string; revision: number; criterionIds: string[]; definition: string;
  status: 'active' | 'retired'; replaces: string[]; defectRefs: string[];
}
export interface VerificationCatalog { version: number; cases: VerificationCase[]; snapshotPath: string; digest: string }
export interface EvidenceRef { runId: string; artifactId: string }
export interface VerificationChange {
  id: string; baseVersion: number; reason: string; cases: VerificationCase[];
  status: 'proposed' | 'published' | 'rejected';
  evidenceRefs?: EvidenceRef[];
}
export interface VerificationPlan {
  id: string; catalogVersion: number; contractVersion: number; artifactDigest: string;
  cases: { id: string; revision: number; parameters: Record<string, string> }[];
  evidenceRefs?: EvidenceRef[];
}
export interface Run {
  id: string; projectId: string; revision: number; contract: TaskContract; status: RunStatus;
  nodes: TaskNode[]; attempts: Attempt[]; budget: Budget; leases: Lease[]; operations: Operation[];
  artifact: Artifact | null; evidence: Evidence[];
}
export interface Project { id: string; name: string }
export interface CreateRunInput {
  id: string; projectId: string; contract: TaskContract;
  nodes: { id: string; dependencies: string[]; required: boolean }[];
  budget: { limit: number; verificationReserve: number; unit?: 'work-unit' | 'token' };
}
export type RunAction =
  | { type: 'startAttempt'; attemptId: string; nodeId: string; contractVersion: number; reservation: number; purpose: 'execution' | 'verification'; resources: string[] }
  | { type: 'finishAttempt'; attemptId: string; outcome: 'succeeded' | 'failed' | 'cancelled' }
  | { type: 'settleAttempt'; attemptId: string; actual: number }
  | { type: 'setOperation'; operationId: string; attemptId: string; status: Operation['status'] }
  | { type: 'releaseLease'; resource: string; attemptId: string }
  | { type: 'pause' | 'resume' | 'cancel' | 'complete' }
  | { type: 'replaceContract'; contract: TaskContract }
  | { type: 'recordEvidence'; evidence: Evidence }
  | { type: 'setArtifact'; artifact: Artifact };
export interface DomainEvent { type: string; runId: string; revision: number; details: Record<string, unknown> }
export interface Readiness { state: 'ready' | 'active' | 'paused' | 'cancelled' | 'blocked' | 'verification' | 'complete'; nodeIds: string[]; reasons: string[] }

export type Command = { commandId: string } & (
  | { type: 'createProject'; project: Project }
  | { type: 'createRun'; input: CreateRunInput }
  | { type: 'act'; projectId: string; runId: string; expectedRevision: number; action: RunAction }
  | { type: 'publishArtifact'; projectId: string; runId: string; expectedRevision: number; artifactId: string; content: string }
  | { type: 'proposeVerificationChange'; projectId: string; change: VerificationChange }
  | { type: 'publishVerificationChange'; projectId: string; changeId: string; baseVersion: number }
  | { type: 'freezeVerificationPlan'; projectId: string; runId: string; plan: VerificationPlan }
);
export interface StoredEvent { seq: number; commandId: string; projectId: string; runId: string | null; type: string; payload: unknown }
export interface CommandResult { commandId: string; eventSeq: number; value: unknown }
export type Query =
  | { type: 'projects' }
  | { type: 'runs'; projectId: string }
  | { type: 'run'; projectId: string; runId: string }
  | { type: 'events'; after: number; projectId: string }
  | { type: 'catalog'; projectId: string }
  | { type: 'changes'; projectId: string }
  | { type: 'plans'; projectId: string; runId: string };
export type Request = { id: string } & ({ method: 'command'; command: Command } | { method: 'query'; query: Query } | { method: 'health' } | { method: 'execution'; action: import('./p2.js').ExecutionAction });
export type Response = { id: string; ok: true; value: unknown } | { id: string; ok: false; error: string };
