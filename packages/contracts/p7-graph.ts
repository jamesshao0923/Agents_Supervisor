import type { TaskContract } from './p1.js';
import type { RuntimeStep } from './p3.js';
import type { ScheduledPlan } from './p7-dispatch.js';
/** Graph seed only: may contain zero source files; never P4 deliverable evidence. */
export interface GraphSeedSnapshot {
 schemaVersion:1;kind:'graph-seed';root:string;tree:string;digest:string;
 files:Record<string,string>;excluded:string[];createdAt:string;
}
/** Deterministic compilation input, not an approval or independent evidence. */
export interface GoalGraphAdmission {
 schemaVersion:1; policyVersion:'goal-graph-conservative-v1'; sessionId:string; projectId:string;
 baseContractVersion:number; sourceDigest:string; contract:TaskContract;
 implementationSteps:Extract<RuntimeStep,{kind:'codex'}>[];
 integrationStep:Extract<RuntimeStep,{kind:'codex'}>;
 digest:string;
}
export interface GraphPreparationRequest {
 schemaVersion:1; commandId:string; admissionDigest:string; projectId:string; runId:string;
 taskIds:string[]; seed:GraphSeedSnapshot;
}
/** Created and re-read by the host; never accepted as a model supplied permission. */
export interface GraphPreparationReceipt {
 schemaVersion:1; state:'complete'; request:GraphPreparationRequest; hostRoot:string; directory:string;
 workspaces:{taskId:string;path:string;candidateDigest:string}[]; receiptDigest:string;
}
export interface GoalGraphHostPolicy {
 schedulerId:string; preparationRoot:string; tier:ScheduledPlan['tier']; limits:ScheduledPlan['limits'];
}

export interface GoalGraphAdmissionReceipt {
 schemaVersion:1;commandId:string;requestDigest:string;admission:GoalGraphAdmission;
 preparation:GraphPreparationReceipt;policy:GoalGraphHostPolicy;schedulerDigest:string;
 allocation:import('./p7-final-execution.js').FutureExecutionAllocation;
}
export interface GoalGraphAdmissionInput {
 action:Extract<import('./p5.js').OrchestrationAction,{type:'admit'}>;
 expectedRunRevision:number;admission:GoalGraphAdmission;
 preparation:GraphPreparationReceipt;policy:GoalGraphHostPolicy;
}
