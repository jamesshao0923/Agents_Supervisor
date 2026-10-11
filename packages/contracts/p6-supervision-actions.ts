import type { SupervisionProgressRound, SupervisionRouteReceipt } from './p6-routing.js';
import type { ConcernState, ConcernDiscard } from './p6-concerns.js';
import type { ReasonerConfig } from './p5.js';
import type { SupervisionLimits,SupervisionRecord,SupervisionJob } from './p6-supervision.js';
import type { Run } from './p1.js';
import type { RuntimeRecord,RuntimeOperation,RuntimeCheckpoint } from './p3.js';
import type { Proposal,FrozenPlan,VerificationJob,Delivery } from '../verification/records.js';
import type { MonitorEnvelopeV1,MonitorEvent } from './p6-monitor.js';

export interface SupervisionInspection {
  controlMaintenance?:import('./p6-control-maintenance.js').MaintenanceRecord|null;
  loop:SupervisionRecord; jobs:SupervisionJob[];
  runtime:{runtime:RuntimeRecord;run:Run;operations:RuntimeOperation[];checkpoints:{checkpoint:RuntimeCheckpoint;digest:string;valid:boolean}[]};
  verification:{proposals:Proposal[];plans:FrozenPlan[];jobs:VerificationJob[];deliveries:Delivery[]};
  monitor?:{envelope:MonitorEnvelopeV1|null;events:MonitorEvent[];jobs:SupervisionJob[];diagnosisRequests:{jobId:string;summary:string}[];concerns?:ConcernState[];concernDiscards?:ConcernDiscard[]};
  routing?:{rounds:SupervisionProgressRound[];routes:SupervisionRouteReceipt[]};
  capabilities:{scanIntervalMs:2000;healthIntervalMs:10000;modelMonitoring:boolean;automaticControlEvolution:false};
}
export type SupervisionAction=
  | {type:'list'}
  | {type:'attach';commandId:string;runtimeId:string;config:ReasonerConfig;limits:SupervisionLimits;authoringProtocol?:'acceptance-stages-v1'}
  | {type:'inspect'|'pause'|'resume'|'stop';loopId:string};

export function parseSupervisionAction(value:unknown):SupervisionAction {
  const plain=(input:unknown):Record<string,unknown>=>{if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('Invalid supervision object');for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(input)))if(!('value'in descriptor)||!descriptor.enumerable||['__proto__','constructor','prototype'].includes(key))throw new Error('Unsafe supervision field');if(Object.getOwnPropertySymbols(input).length)throw new Error('Unsafe supervision field');return input as Record<string,unknown>;};
  const fields=(input:Record<string,unknown>,keys:string[])=>{if(Object.keys(input).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(input,key)))throw new Error('Unknown or missing supervision field');};
  const text=(input:unknown)=>{if(typeof input!=='string'||!input.trim()||input.includes('\0')||input.length>4096)throw new Error('Invalid supervision identifier');};
  const integer=(input:unknown,min:number,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(input)||Number(input)<min||Number(input)>max)throw new Error('Invalid supervision integer');};
  const input=plain(value);
  if(input.type==='list')fields(input,['type']);
  else if(input.type==='attach'){
    fields(input,['type','commandId','runtimeId','config','limits',...(Object.hasOwn(input,'authoringProtocol')?['authoringProtocol']:[])]);if(Object.hasOwn(input,'authoringProtocol')&&input.authoringProtocol!=='acceptance-stages-v1')throw new Error('Unknown authoring protocol');text(input.commandId);text(input.runtimeId);
    const config=plain(input.config),limits=plain(input.limits);fields(config,['model','effort','reservation','timeoutMs']);text(config.model);text(config.effort);integer(config.reservation,1);integer(config.timeoutMs,1000,3600000);
    fields(limits,['maxRepairs','maxReasoningCalls','maxDurationMs','maxContextChars']);integer(limits.maxRepairs,0,100);integer(limits.maxReasoningCalls,1,1000);integer(limits.maxDurationMs,1000,30*24*3600000);integer(limits.maxContextChars,8000,200000);
  }else if(['inspect','pause','resume','stop'].includes(String(input.type))){fields(input,['type','loopId']);text(input.loopId);}
  else throw new Error('Unknown supervision action');
  return structuredClone(input) as unknown as SupervisionAction;
}
