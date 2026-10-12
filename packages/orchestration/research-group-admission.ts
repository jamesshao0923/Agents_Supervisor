import {tokenCapacity} from '../contracts/token-policy.js';
import type {GoalProposal, GoalSession} from '../contracts/p5.js';
import {goalResearchGroupsSchema, type GoalResearchGroupingDecision} from '../contracts/p8-research-group-planning.js';
import type {ResearchGroupDeclaration} from '../contracts/p8-research-groups.js';
import type {Run} from '../contracts/p1.js';
import {futureVerificationFloor} from '../domain/index.js';
import {safeResultJSON} from '../contracts/p7-results.js';
import {parseReasonerOutput} from './reasoner-schema.js';
import {DEFAULT_GRAPH_ADMISSION} from './graph-admission.js';
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw Error('Research grouping: ' + reason);
}
/** Immutable configured sources are all mandatory. Tiers cannot remove sources. */
export function validateResearchGroups(proposal: GoalProposal, session: GoalSession): void {
  const value = proposal.researchGroups;
  if (value == null) return;
  ensure(session.research, 'grouping needs configured Run-owned research');
  ensure(!session.continuation && !session.runtimeId, 'grouping is supported only at initial admission');
  ensure(proposal.decision === 'ready', 'clarification cannot request group execution');
  safeResultJSON(value);
  parseReasonerOutput(JSON.stringify(value), goalResearchGroupsSchema(session.research.inputs.map(input => input.id)));
  const ids = new Set<string>(), materials = new Set<string>();
  const criteria = proposal.criteria.map(criterion => criterion.id);
  ensure(criteria.length > 0 && new Set(criteria).size === criteria.length, 'original criteria missing or duplicate');
  for (const group of value.groups) {
    ensure(!ids.has(group.id) && group.purpose.trim(), 'group identity or purpose missing/duplicate');
    ids.add(group.id);
    ensure(new Set(group.criterionIds).size === group.criterionIds.length &&
      group.criterionIds.length === criteria.length && criteria.every(id => group.criterionIds.includes(id)),
      'every assigned material must preserve all original required criteria');
    for (const id of group.materialIds) {
      ensure(!materials.has(id), 'material assigned more than once; grouping is not independent source voting');
      materials.add(id);
    }
  }
  ensure(materials.size === session.research.inputs.length && session.research.inputs.every(input => materials.has(input.id)),
    'complete original material coverage required including failed or unsupported inputs');
}
/** Advisory decomposition is admitted using only actual cumulative Run costs.
 * A proven single path remains available when extra groups cannot be funded. */
export function assessResearchGrouping(session: GoalSession, run: Run): {
  decision: GoalResearchGroupingDecision; groups: ResearchGroupDeclaration[];
} {
  ensure(session.research && session.proposal, 'configured research proposal required');
  validateResearchGroups(session.proposal, session);
  ensure(run.attempts.every(attempt => attempt.settled && attempt.status !== 'running') &&
    run.operations.every(operation => operation.status === 'confirmed') && run.leases.every(lease => lease.released),
    'unknown accounting or effects prevent admission');
  const reserve = Math.max(0, run.budget.verificationReserve - run.attempts
    .filter(attempt => attempt.purpose === 'verification' && attempt.contractVersion === run.contract.version)
    .reduce((sum, attempt) => sum + attempt.actual!, 0));
  const verification = Math.max(reserve, futureVerificationFloor(run));
  const original = session.config.reservation + verification;
  ensure(Number.isSafeInteger(original) && Number.isSafeInteger(run.budget.spent + original) &&
    run.budget.spent + original <= tokenCapacity(run.budget.limit), 'original full analysis and verification cannot be funded');
  const proposed = session.proposal.researchGroups?.groups ?? [];
  const count = proposed.length;
  const maxActive = Math.min(DEFAULT_GRAPH_ADMISSION.maxActive, 5, count);
  const extra = count * session.config.reservation;
  ensure(Number.isSafeInteger(extra), 'group reservation capacity overflow');
  const grouped = count >= 2 && maxActive >= 2 && Number.isSafeInteger(run.budget.spent + original + extra) &&
    run.budget.spent + original + extra <= tokenCapacity(run.budget.limit);
  const reason = grouped ? 'Host admitted disjoint mandatory material groups; complete original analysis and verification remain protected. No measured efficiency improvement is claimed.' :
    !count ? 'No grouping was proposed; the original full analysis remains unchanged.' :
    count < 2 || maxActive < 2 ? 'Grouping has no structural parallel opportunity; use the original full analysis.' :
    'The unchanged Run can fund full analysis and verification but cannot fund every proposed group; use the original full analysis.';
  const groups = grouped ? proposed.map(group => ({...structuredClone(group), reservation: session.config.reservation})) : [];
  return {decision: {schemaVersion: 1, mode: grouped ? 'grouped' : 'single', reason,
    groupCount: count, maxActive: grouped ? maxActive : 1, perGroupReservation: session.config.reservation,
    groupReservation: grouped ? extra : 0, totalProtectedReservation: original + (grouped ? extra : 0), registrationId: null}, groups};
}
