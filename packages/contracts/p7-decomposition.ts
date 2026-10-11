import type {SchedulerResource} from './p7-scheduler.js';
/** Untrusted model declaration; parsing does not grant resource or P4 authority. */
/** A tree read of '.' conservatively covers all project paths; never a write scope or external permission. */
export interface LogicalPathScope {path:string;kind:'file'|'tree'}
export interface TaskDecompositionDeclaration {
 taskId:string;knowledge:'declared'|'unknown';reads:LogicalPathScope[];writes:LogicalPathScope[];
 resources:SchedulerResource[];reason:string;
}
export interface GoalDecomposition {schemaVersion:1;tasks:TaskDecompositionDeclaration[]}
export interface DecompositionStep {id:string;dependencies:string[];acceptanceIds:string[]}
/** Advisory deterministic compiler data. This is not a persisted authorization receipt. */
export interface DependencyProjection {
 schemaVersion:1;policyVersion:'conservative-scopes-v1';
 tasks:{taskId:string;dependencies:string[]}[];
 addedEdges:{from:string;to:string;reason:'unknown-scope'|'logical-path-conflict'|'resource-conflict'}[];
}
/** Proposed next persistence contract only. No implementation or completion authority. */
export interface IterationIdentity {
 schedulerId:string;loopId:string;iterationId:string;parentIterationId:string|null;
 ancestorIterationIds:string[];generation:number;originPlanRevision:number;
}
