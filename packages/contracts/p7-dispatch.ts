import type {Run,DomainEvent} from './p1.js';
import type {RuntimeStep} from './p3.js';
import type {DependencyBinding,ResultLedger} from './p7-results.js';
import type {SchedulerNode,SchedulerLoop,SchedulerResource,ExplorationTier,SchedulerDecision} from './p7-scheduler.js';
export interface ScheduledTask {
 researchGroup?: import('./p8-research-groups.js').ResearchGroupTaskBinding;
 /** Compiler-bound original baseline and declaration. Absence preserves legacy plans. */
 scopeBinding?:{schemaVersion:1;sourceDigest:string;seed:import('./p7-graph.js').GraphSeedSnapshot;declaration:import('./p7-decomposition.js').TaskDecompositionDeclaration};
 node:Omit<SchedulerNode,'status'|'inputs'>;
 inputRequirements:{dependencyNodeId:string;minimumState:'submitted'|'verified'}[];
 step:Extract<RuntimeStep,{kind:'codex'}>;
 workspace:string;workspaceKind:'project'|'managed';generation:number;
}
/** Host publication derives authorization from the current admitted Run graph.
 * This descriptor does not authorize new nodes or weaken the contract. */
export interface ScheduledPlan {
 schemaVersion:1;engine:'scheduled-v1';workflowVersion:2;id:string;runtimeId:string;
 projectId:string;runId:string;revision:number;contractVersion:number;contractDigest:string;
 integrationNodeId:string;tasks:ScheduledTask[];tier:ExplorationTier;
 loops:Omit<SchedulerLoop,'spent'>[];
 limits:{maxActive:number;maxNodes:number;maxDepth:number;deadlineMs:number};
}
export interface ScheduledRecord {id:string;plan:ScheduledPlan;planDigest:string;revision:number;state:'active'|'paused'|'cancelled'|'drained'|'blocked';fence:'held'|'released'}
export interface ScheduledClaim {
 schemaVersion:1;id:string;schedulerId:string;runtimeId:string;projectId:string;runId:string;
 taskId:string;attemptId:string;operationId:string;planRevision:number;planDigest:string;generation:number;
 contractVersion:number;contractDigest:string;owner:string;workspace:string;workspaceKind:'project'|'managed';
 inputBindings:DependencyBinding[];resources:SchedulerResource[];reservation:number;loopIds:string[];
}
export interface ScheduledBinding {schedulerId:string;claimId:string;operationId:string;owner:string;projectId:string;runId:string;attemptId:string;planRevision:number;generation:number}
export interface ScheduledOperation {id:string;claimId:string;state:'claimed'|'started'|'confirmed'|'failed'|'cancelled'|'unknown';executionId:string|null;result:unknown;error:string|null}
export interface ScheduledLease {id:string;claimId:string;resource:SchedulerResource;state:'held'|'released'}
export interface ScheduledExpected {schedulerRevision:number;runRevision:number;resultRevision:number;leaseRevision:number}
export type ScheduledClaimResult={kind:'claimed';claim:ScheduledClaim;operation:ScheduledOperation;decision:SchedulerDecision}|{kind:'waiting';decision:SchedulerDecision};
export interface ScheduledDomainInput {effectiveTier?:ExplorationTier;run:Run;plan:ScheduledPlan;ledger:ResultLedger;claims:ScheduledClaim[];operations:ScheduledOperation[];leases:ScheduledLease[];nowMs:number;blockedTaskIds?:string[];taskId:string;attemptId:string;claimId:string;operationId:string;owner:string}
export interface ScheduledDomainResult {run:Run;events:DomainEvent[];claim:ScheduledClaim;operation:ScheduledOperation;decision:SchedulerDecision}
