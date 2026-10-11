import type { GoalProposal, GoalSession } from '../contracts/p5.js';
import type { TaskDecompositionDeclaration } from '../contracts/p7-decomposition.js';
import { explorationSchema, type ExplorationCandidate } from '../contracts/p7-exploration.js';
import { parseReasonerOutput } from './reasoner-schema.js';
import { projectDeclaredDependencies } from './decomposition.js';
function ensure(value: unknown, reason: string): asserts value { if (!value) throw Error('Exploration: ' + reason); }
export function explorationDeclaration(candidate: ExplorationCandidate): TaskDecompositionDeclaration {
  return { taskId: candidate.id, knowledge: 'declared', reads: candidate.reads, writes: candidate.writes, resources: [], reason: 'Optional bounded project analysis: ' + candidate.qualityReason + '\n' + candidate.valueReason };
}
/** No candidate may replace a core step, acceptance item or required output.
 * An estimate is advisory; user admission authorizes only bounded project work. */
export function validateExploration(proposal: GoalProposal, session: GoalSession): void {
  const candidates = proposal.exploration ?? [];
  parseReasonerOutput(JSON.stringify(candidates), explorationSchema(session.messages.map(message => message.id)));
  if (!candidates.length) return;
  ensure(proposal.decision === 'ready', 'clarification cannot dispatch exploration');
  ensure(!proposal.iteration, 'iteration with exploration is not supported; never discard candidates');
  ensure(!session.research, 'native research exploration requires a separately frozen source admission protocol');
  const coreIds = new Set(proposal.steps.map(step => step.id));
  const ids = new Set<string>();
  for (const candidate of candidates) {
    ensure(!coreIds.has(candidate.id) && !ids.has(candidate.id), 'candidate duplicates a core or optional task');
    ids.add(candidate.id);
    ensure(candidate.dependencies.every(id => coreIds.has(id) || ids.has(id) && id !== candidate.id), 'candidate dependencies must precede it and cannot alter core dependencies');
    ensure(candidate.relatedCriterionIds.every(id => proposal.criteria.some(criterion => criterion.id === id)), 'candidate references unknown criteria');
    ensure(candidate.sources.every(source => session.messages.some(message => message.id === source.messageId && message.text.includes(source.quote))), 'candidate source is not an exact frozen user quote');
    ensure(!proposal.steps.some(step => step.description === candidate.description), 'candidate duplicates required work');
    // This slice can produce supplemental reports only. It cannot write required
    // implementation files or silently become the sole implementation of a goal.
    const prefix = 'exploration/' + candidate.id + '/';
    ensure(candidate.writes.every(scope => scope.path.startsWith(prefix)), 'optional writes must stay in their own supplemental output directory');
    ensure(proposal.criteria.every(criterion => !criterion.target.startsWith(prefix)), 'optional output cannot satisfy a required acceptance target');
    projectDeclaredDependencies([{ id: candidate.id, dependencies: [], acceptanceIds: candidate.relatedCriterionIds }], { schemaVersion: 1, tasks: [explorationDeclaration(candidate)] });
  }
  ensure(proposal.steps.every(step => step.dependencies.every(id => !ids.has(id))), 'required work cannot depend on optional candidates');
}
export const EXPLORATION_GUIDANCE = 'Keep every user-requested task and every necessary implementation step in the original required steps array with complete acceptance coverage. exploration is a SEPARATE bounded list of optional supplemental analyses, never required implementation or acceptance. Use [] when no useful optional work exists. Each candidate cites exact frozen user message quotes, relates to existing criteria and estimates quality/value with concrete reasons (strong/supported/exploratory/uncertain are predictions, never calibrated probabilities or permission). Do not duplicate core work or change user expectations. Outputs may only be supplemental files under exploration/<candidate-id>/; no required acceptance target may point there. Declare all reads and writes. Candidates may depend on original core steps or earlier candidates, never the reverse; core steps must remain independently sufficient. No external resources, deployments or new source acquisition are authorized. iteration and native research configurations require exploration:[] in this version; never silently omit required work to comply. The user chooses a threshold separately from the hard concurrency/budget limits.';
