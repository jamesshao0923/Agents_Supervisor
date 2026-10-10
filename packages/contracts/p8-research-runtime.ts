import type {MaterialInput,MaterialLimits,MaterialIndex} from './p8-materials.js';
import type {MaterialRef,ResearchRequirement,ResearchLimits,ResearchEvidenceContext,ValidatedResearchDraft} from './p8-research.js';
export interface MaterialsRuntimeStep {id:string;kind:'materials';inputs:MaterialInput[];limits:MaterialLimits}
export interface ResearchStepBinding {schemaVersion:1;acquisitionStepId:string;requirements:ResearchRequirement[];limits:ResearchLimits;reportDirectory:string}
export interface MaterialsReceipt {schemaVersion:1;operationId:string;attemptId:string;contractVersion:number;requestDigest:string;material:MaterialRef;index:MaterialIndex;digest:string}
export interface ResearchExecutionPackage {schemaVersion:1;operationId:string;acquisitionOperationId:string;contractVersion:number;context:ResearchEvidenceContext;outputSchema:Record<string,unknown>;prompt:string;reportDirectory:string;digest:string}
export interface ResearchInputReceipt {kind:'research-input';path:string;digest:string;package:ResearchExecutionPackage}
export interface ResearchCompletionReceipt {schemaVersion:1;executionId:string;operationId:string;inputDigest:string;threadId:string;turnId:string;rawOutputDigest:string;completionEvents:{messageSeq:number;terminalSeq:number;evidenceDigest:string};draft:ValidatedResearchDraft;files:Record<string,string>;digest:string}

export interface GoalResearchConfiguration {schemaVersion:1;inputs:MaterialInput[];materialLimits:MaterialLimits;researchLimits:ResearchLimits;reportDirectory:string;cutoff:string|null;maxSourceAgeMs:number}
