import type {ScheduledPlan, ScheduledTask} from './p7-dispatch.js';
import type {GraphSeedSnapshot,GraphPreparationReceipt} from './p7-graph.js';
import type {ResultRef} from './p7-results.js';
/** Internal execution strategy only. Yield never establishes acceptance. */
export type LoopProgramNode =
 | {kind:'task';id:string;taskId:string}
 | {kind:'sequence'|'parallel';id:string;children:LoopProgramNode[]}
 | {kind:'loop';id:string;body:LoopProgramNode;until:{taskId:string;path:string;field:string;atLeast:number};limits:{iterations:number;tokens:number;nodes:number;durationMs:number;unchangedIterations:number}};
export interface LoopProgram {schemaVersion:1;policyVersion:'bounded-data-loop-v1';sourceDigest:string;tree:LoopProgramNode}
export interface LoopProgramSource {templatePlan:ScheduledPlan;program:LoopProgram;seed:GraphSeedSnapshot;preparationRoot:string;startedAtMs:number}
export interface LoopFrame {key:string;nodeId:string;kind:LoopProgramNode['kind'];state:'new'|'active'|'yielded'|'blocked'|'stopped';reason:string|null;taskId:string|null;ordinal:number;children:string[];inputs:string[];outputs:string[];ancestry:string[];deadlineMs:number;fingerprints:string[]}
export interface LoopState {schemaVersion:1;schedulerId:string;revision:number;lastObservedMs:number;rootKey:string;frames:LoopFrame[]}
export interface LoopOccurrence {taskId:string;templateId:string;frameKey:string;loopIds:string[];dependencies:string[]}
export interface LoopDecision {id:string;iterationId:string;loopId:string;ordinal:number;decision:'continue'|'yield'|'blocked';reason:string;resultRefs:ResultRef[];fingerprint:string;value:number|null}
export interface LoopObservation {taskId:string;state:'pending'|'submitted'|'failed';ref:ResultRef|null;fingerprint:string;json:Record<string,unknown>;reason:string|null}
export interface LoopAdvance {sourceDigest:string;beforeDigest:string;state:LoopState;occurrences:LoopOccurrence[];decisions:LoopDecision[]}
export interface LoopPreparation {source:LoopProgramSource;advance:LoopAdvance;workspaces:GraphPreparationReceipt|null}
export interface LoopTaskOrigin {schedulerId:string;taskId:string;generation:number;introducedRevision:number;templateId:string;frameKey:string;task:ScheduledTask}

export interface LoopIterationRecord {id:string;schedulerId:string;instanceId:string;ordinal:number;generation:number;bodyKey:string;parentIterationId:string|null;ancestry:string[];planRevision:number;deadlineMs:number;initialTaskIds:string[]}
export interface LoopBudgetProjection {instanceId:string;limit:number|null;spent:number;reserved:number;unknown:boolean;deadlineMs:number;generatedNodes:number;maxNodes:number;iteration:number;maxIterations:number}
