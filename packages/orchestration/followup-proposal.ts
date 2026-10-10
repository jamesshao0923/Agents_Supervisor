import type { TaskContract } from '../contracts/p1.js';
import { goalProposalSchema, type AcceptanceItem, type GoalProposal, type GoalSession } from '../contracts/p5.js';
import type { ConversationMessage, FollowupProposal } from '../contracts/p6.js';
export type { CriterionRetirementSource, FollowupProposal } from '../contracts/p6.js';
import { validateProposal } from './admission.js';
import { parseReasonerOutput, validateReasonerSchema } from './reasoner-schema.js';

export interface FollowupValidationContext {
  originalContract: TaskContract;
  originalProposal: GoalProposal | null;
  frozenMessages: ConversationMessage[];
  newMessageId: string;
  session: GoalSession;
}
const str = { type: 'string', minLength: 1, maxLength: 12_000 };
const object = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }

/** Freeze the union of initial requirement IDs and selected conversation message IDs. */
export function followupProposalSchema(sourceIds: string[]): Record<string, unknown> {
  const proposal = goalProposalSchema(sourceIds);
  return validateReasonerSchema(object({
    decision: { type: 'string', enum: ['answer', 'clarify', 'revise'] }, response: str,
    proposal: { anyOf: [proposal, { type: 'null' }] },
    retiredCriterionIds: { type: 'array', maxItems: 64, items: str },
    retirementSources: { type: 'array', maxItems: 128, items: object({
      criterionId: str, messageId: { ...str, enum: [...sourceIds] }, quote: { ...str, maxLength: 40_000 },
    }) },
  }));
}

function frozenSession(context: FollowupValidationContext): { session: GoalSession; message: ConversationMessage } {
  ensure(Array.isArray(context.frozenMessages) && context.frozenMessages.length > 0, 'Frozen follow-up messages are required');
  const ids = new Set<string>(), sources = new Map(context.session.messages.map(message => [message.id, message]));
  ensure(sources.size === context.session.messages.length, 'Duplicate frozen requirement message ID');
  let sequence = 0, conversationId: string | null = null;
  for (const message of context.frozenMessages) {
    ensure(typeof message.id === 'string' && message.id.trim() && !ids.has(message.id), 'Invalid or duplicate frozen conversation message ID');
    ensure(message.source === 'user' && typeof message.text === 'string' && message.text.trim() && !message.text.includes('\0'), 'Invalid frozen user message');
    ensure(['question', 'change', 'unclassified'].includes(message.kind), 'Invalid frozen message kind');
    ensure(Number.isSafeInteger(message.sequence) && message.sequence > sequence, 'Frozen messages must preserve sequence order');
    ensure(typeof message.conversationId === 'string' && message.conversationId.trim() && (conversationId === null || conversationId === message.conversationId), 'Frozen messages must belong to one conversation');
    const old = sources.get(message.id);
    ensure(!old || old.text === message.text, 'Conflicting frozen requirement source text');
    sources.set(message.id, { id: message.id, role: 'user', text: message.text, createdAt: message.createdAt });
    ids.add(message.id); sequence = message.sequence; conversationId = message.conversationId;
  }
  const message = context.frozenMessages.find(item => item.id === context.newMessageId);
  ensure(message && message.sequence === sequence, 'New message must be the frozen processing boundary');
  return { session: { ...context.session, messages: [...sources.values()] }, message };
}

function criterionDescription(item: AcceptanceItem): string {
  return [item.description, `Acceptance kind: ${item.kind}; target: ${item.target}`, ...item.checks].join('\n');
}
function sameAcceptance(a: AcceptanceItem, b: AcceptanceItem): boolean {
  return a.description === b.description && a.kind === b.kind && a.target === b.target
    && JSON.stringify(a.checks) === JSON.stringify(b.checks);
}

/**
 * A source quote proves provenance only, not that the requested semantic change is
 * authorized. Every retirement/semantic change still needs independent review of
 * the current contract, the complete new user message and frozen acceptance.
 */
export function validateFollowupProposal(value: unknown, context: FollowupValidationContext): FollowupProposal {
  const frozen = frozenSession(context);
  // Model results arrive as JSON. Revalidate the full supported schema independently
  // of provider-side schema handling before reading proposal fields.
  const result = parseReasonerOutput(JSON.stringify(value), followupProposalSchema(frozen.session.messages.map(message => message.id))) as FollowupProposal;
  // Codex's strict response schema rejects uniqueItems. Enforce identical
  // uniqueness locally instead of dropping the acceptance constraint.
  ensure(new Set(result.retiredCriterionIds).size===result.retiredCriterionIds.length,'Duplicate retired criterion');
  ensure(new Set(result.retirementSources.map(source=>JSON.stringify([source.criterionId,source.messageId,source.quote]))).size===result.retirementSources.length,'Duplicate retirement source');
  ensure(result.response.trim(), 'Follow-up response must be nonempty');
  ensure(!(frozen.message.kind === 'question' && result.decision === 'revise'), 'An explicit question cannot revise requirements');
  ensure(!(frozen.message.kind === 'change' && result.decision === 'answer'), 'An explicit change cannot be dismissed as an answer');
  if (result.decision !== 'revise') {
    ensure(result.retiredCriterionIds.length === 0 && result.retirementSources.length === 0, 'Answer or clarification cannot retire or change acceptance');
    if (result.decision === 'answer') ensure(result.proposal === null, 'Answer cannot include a requirements proposal');
    else {
      ensure(result.proposal?.decision === 'clarify' && result.proposal.questions.length > 0 && result.proposal.questions.every(question => question.trim()), 'Clarification needs explicit nonempty questions');
      validateProposal(result.proposal, frozen.session);
    }
    return result;
  }
  ensure(result.proposal?.decision === 'ready', 'Revision needs a ready executable proposal');
  validateProposal(result.proposal, frozen.session);
  const old = context.originalContract.criteria;
  ensure(Array.isArray(old) && new Set(old.map(criterion => criterion.id)).size === old.length, 'Invalid original acceptance identities');
  const original = new Map(old.map(criterion => [criterion.id, criterion]));
  const next = new Map(result.proposal.criteria.map(criterion => [criterion.id, criterion]));
  const baseline = new Map(context.originalProposal?.decision === 'ready' ? context.originalProposal.criteria.map(criterion => [criterion.id, criterion]) : []);
  ensure(!context.originalProposal || baseline.size === (context.originalProposal.decision === 'ready' ? context.originalProposal.criteria.length : 0), 'Duplicate original proposal acceptance identities');
  const retired = new Set(result.retiredCriterionIds), changed = new Set<string>();
  for (const id of retired) {
    ensure(original.has(id) && !next.has(id), 'Retirement must identify an omitted original criterion');
    changed.add(id);
  }
  for (const criterion of old) {
    const replacement = next.get(criterion.id);
    if (!replacement) {
      ensure(!criterion.required || retired.has(criterion.id), `Necessary criterion ${criterion.id} is missing without explicit retirement`);
      continue;
    }
    const prior = baseline.get(criterion.id);
    if (prior) {
      ensure(criterion.description === prior.description || criterion.description === criterionDescription(prior), 'Original proposal does not match the authoritative contract');
      if (!sameAcceptance(prior, replacement)) changed.add(criterion.id);
    } else if (criterion.description !== criterionDescription(replacement)) {
      // A raw description alone cannot establish that checks, target and kind were
      // retained. Without the old structured proposal this is a reviewable change.
      changed.add(criterion.id);
    }
  }
  const covered = new Set<string>();
  for (const source of result.retirementSources) {
    ensure(changed.has(source.criterionId), 'Retirement source must correspond to an actual retirement or semantic change');
    ensure(source.messageId === frozen.message.id && frozen.message.kind !== 'question', 'Semantic change must cite the newly processed user message, never historical authority');
    ensure(source.quote.trim() && !source.quote.includes('\0') && frozen.message.text.includes(source.quote), 'Semantic change quote must be an exact nonempty substring of the new user message');
    covered.add(source.criterionId);
  }
  for (const id of changed) ensure(covered.has(id), `Acceptance semantic change ${id} needs current user source evidence and independent review`);
  return result;
}
