import { validateTaskAttachments, type TaskAttachment } from './task-attachments.js';
import {goalResearchGroupsSchema,type GoalResearchGroups,type GoalResearchGroupingDecision} from './p8-research-group-planning.js';
import {explorationSchema,type ExplorationCandidate} from './p7-exploration.js';
import {goalIterationSchema,type GoalIterationProposal} from './p7-goal-loop.js';
import {parseRuntimeAction} from './p3.js';
import type {GoalResearchConfiguration} from './p8-research-runtime.js';
import type {GoalDecomposition} from './p7-decomposition.js';
import type { Run, TaskContract } from './p1.js';
import type { RuntimeStep } from './p3.js';
import type { FollowupProposal } from './p6.js';
import type { ProcessIdentity, ProcessIntent } from '../process-control/index.js';
export interface ReasonerConfig {model:string;effort:string;reservation:number;timeoutMs:number}
export interface RequirementMessage {id:string;role:'user';text:string;createdAt:string;attachments?:TaskAttachment[]}
export interface RequirementFact {text:string;sourceId:string;origin:'explicit'|'inferred'}
export interface AcceptanceItem {id:string;description:string;kind:'command'|'ui'|'source'|'mobile'|'fullstack'|'material';target:string;checks:string[]}
export interface GoalProposal {
  /** Configured initial research only; old records may omit it. */
  researchGroups?:GoalResearchGroups|null;
  /** Legacy records omit this; optional analyses never replace required steps. */
  exploration?:ExplorationCandidate[];
  /** Legacy records omit it; latest schema requires null or a bounded strategy. */
  iteration?:GoalIterationProposal|null;
  /** Optional only for legacy records; current graph-v1 model schema requires null or declarations. */
  decomposition?:GoalDecomposition|null;
  decision:'clarify'|'ready';summary:string;questions:string[];facts:RequirementFact[];
  constraints:string[];style:string[];criteria:AcceptanceItem[];
  steps:{id:string;description:string;dependencies:string[];acceptanceIds:string[]}[];
}
export interface ReasoningJob {
  id:string;purpose:'requirements'|'restore'|'followup';status:'running'|'finished';attemptId:string;config:ReasonerConfig;
  intents:ProcessIntent[];identities:ProcessIdentity[];startedAt:string;finishedAt:string|null;
  modelStarted:boolean;usage:number|null;observedUsage?:number;stopConfirmed:boolean;error:string|null;proofs:Record<string,string>;
  context:unknown;proposal:GoalProposal|null;threadId:string|null;
  /** The controller builds context from this immutable input snapshot, never newer messages. */
  followup?:{conversationId:string;messageId:string;messageSequence:number;processingAttempt:number;baseContractVersion:number;relatedMessageIds:string[];messages:RequirementMessage[];appliedContractVersion:number|null};
  followupResult?:FollowupProposal;
}
export interface GoalSession {
  id:string;projectId:string;workspace:string;workspaceKind:'project'|'managed';revision:number;
  goal:string;phase:'thinking'|'clarifying'|'ready'|'admitted'|'blocked'|'cancelled';
  messages:RequirementMessage[];jobs:ReasoningJob[];proposal:GoalProposal|null;
  runtimeId:string|null;error:string|null;createdAt:string;updatedAt:string;
  config:ReasonerConfig;maxContextChars:number;
  research?:GoalResearchConfiguration;
  researchGrouping?:GoalResearchGroupingDecision;
  graphAdmission?:import('./p7-graph.js').GoalGraphAdmissionReceipt;
  continuation?:{conversationId:string;predecessorSessionId:string;predecessorRunId:string;predecessorDeliveryId:string;proposalJobId:string|null};
}
export interface GoalInspection {session:GoalSession;run:Run}
export type OrchestrationAction =
  | ({type:'start';commandId:string;goal:string;workspace?:string;tokenLimit:number;verificationReserve:number;maxContextChars?:number;research?:GoalResearchConfiguration}&ReasonerConfig)
  | ({type:'answer';commandId:string;sessionId:string;expectedRevision:number;text:string;attachments?:TaskAttachment[]})
  | {type:'admit';commandId:string;sessionId:string;expectedRevision:number;explorationTier?:import('./p7-scheduler.js').ExplorationTier}
  | {type:'restore';commandId:string;sessionId:string;expectedRevision:number}
  | {type:'cancel';commandId:string;sessionId:string}
  | {type:'list'} | {type:'inspect';sessionId:string};
export interface AdmittedPlan {contract:TaskContract;steps:RuntimeStep[]}
const str={type:'string',minLength:1,maxLength:12000};const strings={type:'array',maxItems:64,items:str};
const obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
function proposalSchema(sourceIds?:string[],graph=false):Record<string,unknown>{const schema=obj({
  decision:{type:'string',enum:['clarify','ready']},summary:str,questions:strings,
  facts:{type:'array',maxItems:128,items:obj({text:str,sourceId:sourceIds?{...str,enum:[...sourceIds]}:str,origin:{type:'string',enum:['explicit','inferred']}})},
  constraints:strings,style:strings,
  criteria:{type:'array',maxItems:64,items:obj({id:str,description:str,kind:{type:'string',enum:['command','ui','source','mobile','fullstack','material']},target:str,checks:{...strings,minItems:1}})},
  steps:{type:'array',maxItems:32,items:obj({id:str,description:str,dependencies:strings,acceptanceIds:{...strings,minItems:1}})}
});if(graph){const properties=schema.properties as Record<string,unknown>;const scope=obj({path:str,kind:{type:'string',enum:['file','tree']}});properties.decomposition={anyOf:[{type:'null'},obj({schemaVersion:{type:'integer',const:1},tasks:{type:'array',maxItems:32,items:obj({taskId:str,knowledge:{type:'string',enum:['declared','unknown']},reads:{type:'array',maxItems:128,items:scope},writes:{type:'array',maxItems:128,items:scope},resources:{type:'array',maxItems:128,description:'External/shared resources only; project-relative files belong in reads/writes. Path keys must be canonical absolute host paths; leave resources empty when none are known.',items:{anyOf:[obj({kind:{type:'string',const:'path'},key:{...str,pattern:'^/[^\\\\]*$'},mode:{type:'string',enum:['read','write']}}),obj({kind:{type:'string',enum:['port','database','device','custom']},key:str,mode:{type:'string',enum:['read','write']}})]}},reason:str})}})]};schema.required.push('decomposition');}return schema;}
export const GOAL_PROPOSAL_SCHEMA=proposalSchema();
export function goalProposalSchema(sourceIds:string[],version:'legacy'|'graph-v1'|'graph-loop-v1'|'graph-exploration-v1'='legacy',research?:GoalResearchConfiguration):Record<string,unknown>{
  if(!sourceIds.length||sourceIds.some(id=>!id.trim())||new Set(sourceIds).size!==sourceIds.length)throw new Error('Invalid requirement source IDs');
  const schema=proposalSchema(sourceIds,version!=='legacy');if(version==='graph-loop-v1'||version==='graph-exploration-v1'){(schema.properties as Record<string,unknown>).iteration=goalIterationSchema();(schema.required as string[]).push('iteration');}if(version==='graph-exploration-v1'){(schema.properties as Record<string,unknown>).exploration=explorationSchema(sourceIds);(schema.required as string[]).push('exploration');}if(research){validateGoalResearchConfiguration(research);(schema.properties as Record<string,unknown>).researchGroups=goalResearchGroupsSchema(research.inputs.map(input=>input.id));(schema.required as string[]).push('researchGroups');}return schema;
}
export function parseOrchestrationAction(v:unknown):OrchestrationAction {
  if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid orchestration action');
  const o=v as Record<string,unknown>, fields:Record<string,string[]>={start:['commandId','goal','workspace','tokenLimit','verificationReserve','model','effort','reservation','timeoutMs','maxContextChars','research'],answer:['commandId','sessionId','expectedRevision','text','attachments'],admit:['commandId','sessionId','expectedRevision','explorationTier'],restore:['commandId','sessionId','expectedRevision'],cancel:['commandId','sessionId'],list:[],inspect:['sessionId']};
  if(typeof o.type!=='string'||!Object.hasOwn(fields,o.type))throw new Error('Unknown orchestration action');
  for(const k of Object.keys(o))if(k!=='type'&&!fields[o.type]!.includes(k))throw new Error(`Unknown orchestration field ${k}`);
  const optional=['workspace','maxContextChars','explorationTier','research'];const numbers=['expectedRevision','tokenLimit','verificationReserve','reservation','timeoutMs','maxContextChars'];
  for(const k of fields[o.type]!) {if(k==='attachments'){if(o.attachments!==undefined)validateTaskAttachments(o.attachments);continue;}if(k==='research'){if(o.research!==undefined)validateGoalResearchConfiguration(o.research);continue;}if(o[k]===undefined&&optional.includes(k))continue;if(numbers.includes(k)){if(!Number.isSafeInteger(o[k])||(o[k] as number)<(k==='expectedRevision'?0:1))throw new Error(`Invalid ${k}`);}else if(typeof o[k]!=='string'||!(o[k] as string).trim()||(o[k] as string).includes('\0')||(o[k] as string).length>(['goal','text'].includes(k)?40000:4096))throw new Error(`Invalid ${k}`);}
  if(o.type==='admit'&&o.explorationTier!==undefined&&!['low','medium','high','unlimited'].includes(String(o.explorationTier)))throw new Error('Invalid exploration tier');
  if(o.type==='start'){if((o.reservation as number)+(o.verificationReserve as number)>(o.tokenLimit as number))throw new Error('Insufficient reasoning budget');if((o.timeoutMs as number)<1000||(o.timeoutMs as number)>3600000)throw new Error('Invalid reasoning deadline');if(o.maxContextChars!==undefined&&((o.maxContextChars as number)<8000||(o.maxContextChars as number)>200000))throw new Error('Invalid context capacity');}
  return structuredClone(o) as unknown as OrchestrationAction;
}

export function validateGoalResearchConfiguration(value:unknown):asserts value is GoalResearchConfiguration {const v=value as GoalResearchConfiguration;const keys=['schemaVersion','inputs','materialLimits','researchLimits','reportDirectory','cutoff','maxSourceAgeMs'];if(!v||typeof v!=='object'||Reflect.ownKeys(v).length!==keys.length+(Object.hasOwn(v,'representation')?1:0)||Reflect.ownKeys(v).some(k=>!keys.includes(String(k))&&k!=='representation')||v.representation!==undefined&&v.representation!=='indexed-material-v1'||keys.some(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !d||!Object.hasOwn(d,'value')||!d.enumerable;}))throw Error('Invalid goal research fields');if(v.schemaVersion!==1||!Number.isSafeInteger(v.maxSourceAgeMs)||v.maxSourceAgeMs<1||v.cutoff!==null&&(typeof v.cutoff!=='string'||!Number.isFinite(Date.parse(v.cutoff))))throw Error('Invalid research freshness');parseRuntimeAction({type:'submit',commandId:'validate-research',goal:'Validate fixed research configuration',tokenLimit:2,verificationReserve:1,steps:[{kind:'materials',id:'materials',inputs:v.inputs,limits:v.materialLimits},{kind:'codex',id:'research',prompt:'Return a structured research proposal',model:'validation',effort:'low',reservation:1,timeoutMs:1000,research:{...(v.representation?{representation:v.representation}:{}),schemaVersion:1,acquisitionStepId:'materials',requirements:[{criterionId:'validation',question:'Validation',requiredMaterialIds:v.inputs.map(x=>x.id),cutoff:v.cutoff,maxSourceAgeMs:v.maxSourceAgeMs}],limits:v.researchLimits,reportDirectory:v.reportDirectory}}]});}
