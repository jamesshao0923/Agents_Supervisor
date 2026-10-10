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
