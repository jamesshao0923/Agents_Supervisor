import type {Budget} from './p1.js';
import type {ScheduledRecord,ScheduledClaim,ScheduledOperation} from './p7-dispatch.js';
import type {ResultRef,ResultState} from './p7-results.js';
export interface WorkbenchRead {type:'read';projectPath:string}
export interface WorkbenchParent {
 operations?:Pick<import('./p3.js').RuntimeOperation,'id'|'contractVersion'|'stepIndex'|'attemptId'|'owner'|'executionId'|'generation'|'state'>[];
 runtimeId:string;projectId:string;runId:string;contractVersion:number;budget:Budget;
 scheduler:{record:ScheduledRecord;claims:ScheduledClaim[];operations:ScheduledOperation[]}|null;
 results:{revision:number;heads:{ref:ResultRef;state:ResultState;attemptId:string;generation:number;currentContract:boolean;publicationEligibility:'unchecked'}[]}|null;
 issues:string[];
}
export interface WorkbenchSnapshot {schemaVersion:1;project:{path:string;name:string};observedAt:string;parents:WorkbenchParent[];issues:string[]}
export function parseWorkbenchRead(value:unknown):WorkbenchRead {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='projectPath,type')throw Error('Invalid workbench read request');
 const o=value as Record<string,unknown>;if(o.type!=='read'||typeof o.projectPath!=='string'||!o.projectPath.startsWith('/')||o.projectPath.length>4096||o.projectPath.includes('\0')||!o.projectPath.trim())throw Error('Invalid workbench project path');
 return {type:'read',projectPath:o.projectPath};
}
