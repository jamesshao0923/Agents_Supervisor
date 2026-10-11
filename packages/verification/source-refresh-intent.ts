import type {RuntimeOperation} from '../contracts/p3.js';
import type {SourceRefreshIntent} from '../contracts/p8-source-refresh.js';
import type {GoalResearchConfiguration} from '../contracts/p8-research-runtime.js';
import type {TaskContract} from '../contracts/p1.js';
import type {ConversationMessage} from '../contracts/p6.js';
import {canonical,digest} from './candidate.js';
function ensure(v:unknown,m:string):asserts v {if(!v)throw Error('Source refresh: '+m);}
export function sourceRefreshIntentSchema(ids:string[],messages:string[]):Record<string,unknown>{return {type:'object',additionalProperties:false,required:['materialIds','sources'],properties:{materialIds:{type:'array',minItems:1,maxItems:ids.length,items:{type:'string',enum:ids}},sources:{type:'array',minItems:1,maxItems:64,items:{type:'object',additionalProperties:false,required:['messageId','quote'],properties:{messageId:{type:'string',enum:messages},quote:{type:'string',minLength:1,maxLength:40000}}}}}};}
export function assertSourceRefreshIntent(value:unknown,configuration:GoalResearchConfiguration,messages:Pick<ConversationMessage,'id'|'text'|'source'|'kind'>[],previous:TaskContract,current:TaskContract):SourceRefreshIntent{
 const v=value as SourceRefreshIntent;ensure(v&&Object.keys(v).length===2&&Object.keys(v).every(k=>['materialIds','sources'].includes(k))&&Array.isArray(v.materialIds)&&Array.isArray(v.sources),'exact intent fields required');
 ensure(v.materialIds.length>0&&v.materialIds.length<=configuration.inputs.length&&new Set(v.materialIds).size===v.materialIds.length&&v.materialIds.every(id=>configuration.inputs.some(input=>input.id===id)),'unique existing source IDs required');
 ensure(canonical(previous.criteria)===canonical(current.criteria),'original criteria or checks changed');
 ensure(v.sources.length>0&&v.sources.length<=64&&new Set(v.sources.map(canonical)).size===v.sources.length,'exact unique user provenance required');
 for(const source of v.sources){ensure(source&&Object.keys(source).length===2&&Object.keys(source).every(k=>['messageId','quote'].includes(k)),'exact source fields required');const message=messages.find(m=>m.id===source.messageId);ensure(message?.source==='user'&&message.kind!=='question'&&typeof source.quote==='string'&&source.quote.trim()&&!source.quote.includes('\0')&&source.quote.length<=40000&&message.text.includes(source.quote),'intent needs exact fresh user change quote');}
 return structuredClone(v);
}
export const sourceRefreshDigest=(value:unknown)=>digest(canonical(value));

/** Original host-installed step configuration is a second actual authority
 * basis; mutable Goal/context metadata alone cannot change cutoff or inputs. */
export function assertSourceRefreshConfiguration(config:GoalResearchConfiguration,operations:RuntimeOperation[],version:number):void{
 const analysis=operations.filter(o=>o.contractVersion===version&&o.step.kind==='codex'&&o.step.research);
 ensure(analysis.length===1,'one actual original research analysis required');const step=analysis[0]!.step;ensure(step.kind==='codex'&&step.research,'original research step missing');
 const material=operations.filter(o=>o.contractVersion===version&&o.step.kind==='materials'&&o.step.id===step.research!.acquisitionStepId);
 ensure(material.length===1&&material[0]!.step.kind==='materials','one actual original material step required');const source=material[0]!.step;ensure(source.kind==='materials','original material step missing');
 ensure(canonical(source.inputs)===canonical(config.inputs)&&canonical(source.limits)===canonical(config.materialLimits)&&canonical(step.research.limits)===canonical(config.researchLimits)&&step.research.reportDirectory===config.reportDirectory&&step.research.requirements.every(r=>r.cutoff===config.cutoff&&r.maxSourceAgeMs===config.maxSourceAgeMs&&canonical(r.requiredMaterialIds)===canonical(config.inputs.map(i=>i.id))),'original installed inputs cutoff or capacity changed');
}
