import type {LoopProgramNode,LoopPreparation} from './p7-loop.js';
/** Untrusted strategy from the original P5 planner; never an authorization. */
export type GoalIterationNode = Extract<LoopProgramNode,{kind:'task'}> | {kind:'sequence'|'parallel';id:string;children:string[]} | (Omit<Extract<LoopProgramNode,{kind:'loop'}>,'body'> & {body:string});
export interface GoalIterationProposal {schemaVersion:1;strategy:'bounded-data-loop-v1';tree:{rootId:string;nodes:GoalIterationNode[]}}
export interface GoalLoopHostPolicy {schemaVersion:1;maxIterations:number;maxUnchangedIterations:number}
export const DEFAULT_GOAL_LOOP_POLICY:Readonly<GoalLoopHostPolicy>=Object.freeze({schemaVersion:1,maxIterations:8,maxUnchangedIterations:2});
export interface GoalLoopAdmissionDecision {schemaVersion:1;policyVersion:'goal-loop-admission-v1';proposalDigest:string;hostPolicyDigest:string;taskTemplateDigest:string;contractDigest:string;effectiveProgramDigest:string;allowed:true;reasons:string[]}
export interface GoalLoopPreparation {decision:GoalLoopAdmissionDecision;preparation:LoopPreparation}
const obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const id={type:'string',minLength:1,maxLength:80,pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'};
const integer={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER};
/** A bounded lossless tree table avoids recursive/unsupported JSON-schema refs. */
export function goalIterationSchema():Record<string,unknown>{
 const node={anyOf:[obj({kind:{type:'string',const:'task'},id,taskId:id}),obj({kind:{type:'string',enum:['sequence','parallel']},id,children:{type:'array',minItems:1,maxItems:32,items:id}}),obj({kind:{type:'string',const:'loop'},id,body:id,until:obj({taskId:id,path:{type:'string',minLength:1,maxLength:1024},field:id,atLeast:{type:'number'}}),limits:obj({iterations:integer,tokens:integer,nodes:integer,durationMs:integer,unchangedIterations:integer})})]};
 return {anyOf:[{type:'null'},obj({schemaVersion:{type:'integer',const:1},strategy:{type:'string',const:'bounded-data-loop-v1'},tree:obj({rootId:id,nodes:{type:'array',minItems:1,maxItems:128,items:node}})})]};
}
