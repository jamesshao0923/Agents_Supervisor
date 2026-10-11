import type { ExecutorCapabilities } from '../contracts/p2.js';
import type { ReasonerConfig } from '../contracts/p5.js';
import { SUPERVISOR_ROUTING_POLICY_V1, type SupervisionRoutingPolicy } from '../contracts/p6-routing.js';
import { REASONING_EFFORTS } from './loop-policy.js';
/** Pure choice only. The caller MUST read capabilities through readRoutingCapabilities,
 * check actual stopped/settled author receipts and reserve atomically with the receipt.
 * This is not a product-failure round and cannot authorize implementation repair. */
export function selectAcceptanceAuthorRoute(actual: ExecutorCapabilities, baseline: ReasonerConfig, policy: SupervisionRoutingPolicy = SUPERVISOR_ROUTING_POLICY_V1): ReasonerConfig {
  const previous = policy.models.find(model => model.id === baseline.model);
  const priorEffort = REASONING_EFFORTS.indexOf(baseline.effort as typeof REASONING_EFFORTS[number]);
  const requested = REASONING_EFFORTS.indexOf(policy.firstFailureEffort);
  if (!previous || priorEffort < 0 || requested < 0) throw Error('Author model lacks an explicit host preference');
  const seen = new Set<string>();
  const choices = actual.models.flatMap(model => {
    if (seen.has(model.id)) throw Error('Ambiguous advertised model ID'); seen.add(model.id);
    const preference = policy.models.find(item => item.id === model.id);
    if (!preference || preference.qualityRank < previous.qualityRank || !model.inputModalities.includes('text')) return [];
    const effort = REASONING_EFFORTS.find((value, index) => index >= Math.max(requested, priorEffort + (preference.qualityRank === previous.qualityRank ? 1 : 0)) && model.reasoningEfforts.includes(value));
    if (!effort || preference.qualityRank === previous.qualityRank && REASONING_EFFORTS.indexOf(effort) <= priorEffort) return [];
    return [{ model: model.id, effort, rank: preference.qualityRank }];
  }).sort((a, b) => b.rank - a.rank || a.model.localeCompare(b.model));
  const selected = choices[0]; if (!selected) throw Error('No advertised quality or depth upgrade for acceptance author');
  return { ...baseline, model: selected.model, effort: selected.effort };
}


import type {AuthorRoutingPolicyV2,AuthorRouteReceipt} from '../contracts/p6-author-routing.js';
/** Independent author policy; diagnosis and V1 selection remain unchanged. */
export const ACCEPTANCE_AUTHOR_ROUTING_POLICY_V2:AuthorRoutingPolicyV2={
 schemaVersion:2,version:'acceptance-author-quality-depth-v2',preference:'quality-first',
 models:SUPERVISOR_ROUTING_POLICY_V1.models.map(model=>({...model})),
 minimumEffort:'medium',capabilityMaxAgeMs:300000,
};
function ensureRoute(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
export function selectAcceptanceAuthorRouteV2(actual:ExecutorCapabilities,baseline:ReasonerConfig,policy:AuthorRoutingPolicyV2=ACCEPTANCE_AUTHOR_ROUTING_POLICY_V2):ReasonerConfig {
 ensureRoute(policy.schemaVersion===2&&policy.version==='acceptance-author-quality-depth-v2'&&policy.preference==='quality-first'&&policy.minimumEffort==='medium','Unsupported author route policy');
 ensureRoute(policy.models.length>0&&new Set(policy.models.map(m=>m.id)).size===policy.models.length&&policy.models.every(m=>typeof m.id==='string'&&m.id.length>0&&Number.isSafeInteger(m.qualityRank)),'Invalid author model preferences');
 const previous=policy.models.find(m=>m.id===baseline.model),priorEffort=REASONING_EFFORTS.indexOf(baseline.effort as typeof REASONING_EFFORTS[number]);
 ensureRoute(previous&&priorEffort>=0,'Author model lacks an explicit host preference');
 const seen=new Set<string>();
 const choices=actual.models.flatMap(model=>{
  ensureRoute(!seen.has(model.id),'Ambiguous advertised model ID');seen.add(model.id);
  const preference=policy.models.find(m=>m.id===model.id);
  if(!preference||preference.qualityRank<previous.qualityRank||!model.inputModalities.includes('text'))return [];
  const effort=REASONING_EFFORTS.find((value,index)=>index>=REASONING_EFFORTS.indexOf('medium')
   &&(preference.qualityRank>previous.qualityRank||index>priorEffort)&&model.reasoningEfforts.includes(value));
  return effort?[{model:model.id,effort,rank:preference.qualityRank}]:[];
 }).sort((a,b)=>b.rank-a.rank||a.model.localeCompare(b.model));
 ensureRoute(choices[0],'No advertised quality or depth upgrade for acceptance author');
 return {...baseline,model:choices[0].model,effort:choices[0].effort};
}
/** Select against persisted authorization time, never today's clock on replay. */
export function expectedAuthorRouteConfig(receipt:AuthorRouteReceipt):ReasonerConfig {
 if(receipt.schemaVersion===1)return selectAcceptanceAuthorRoute(receipt.capabilities.capabilities,receipt.baseline,receipt.policy);
 ensureRoute(receipt.schemaVersion===2,'Unknown author route receipt version');
 const a=receipt.authorization,at=Date.parse(a.observedAt),created=Date.parse(a.loopCreatedAt);
 ensureRoute(Number.isFinite(at)&&Number.isFinite(created)&&at>=created&&Number.isSafeInteger(a.absoluteDeadlineMs)&&a.absoluteDeadlineMs>at,'Invalid author route time boundary');
 ensureRoute(a.originalTimeoutMs===receipt.baseline.timeoutMs,'Author original timeout changed');
 const timeoutMs=Math.min(a.originalTimeoutMs,a.absoluteDeadlineMs-at);
 ensureRoute(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1000,'Insufficient remaining author deadline');
 return {...selectAcceptanceAuthorRouteV2(receipt.capabilities.capabilities,receipt.baseline,receipt.policy),timeoutMs};
}
