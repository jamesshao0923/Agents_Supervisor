import { createHash } from 'node:crypto';
import type { TaskContract } from '../contracts/p1.js';
import type { AcceptanceItem } from '../contracts/p5.js';
import type { AuthorizedCriterionChange, AppliedContractTransition } from '../contracts/p4-lineage.js';
import type { FollowupProposal, ConversationMessage } from '../contracts/p6.js';
import { verificationCanonical } from '../verification/rules.js';
import { followupProposalSchema, validateFollowupProposal, type FollowupValidationContext } from './followup-proposal.js';
import { parseReasonerOutput, validateReasonerSchema } from './reasoner-schema.js';

const hash = (value: unknown): string => createHash('sha256').update(verificationCanonical(value)).digest('hex');
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const text = { type: 'string', minLength: 1, maxLength: 12000 };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
type ChangeRequest = Pick<AuthorizedCriterionChange, 'kind' | 'criterionId' | 'sources'>;
export type EvolutionReview = Omit<AppliedContractTransition['review'], 'approved' | 'changes'> & {
  approved: boolean; changes: { criterionId: string; kind: AuthorizedCriterionChange['kind']; authorized: boolean; reasons: string[] }[];
};

/** This exact representation is also used when the execution contract is admitted. */
export function acceptanceCriterion(item: AcceptanceItem): TaskContract['criteria'][number] {
  return { id: item.id, required: true, description: [item.description, `Acceptance kind: ${item.kind}; target: ${item.target}`, ...item.checks].join('\n') };
}
/** The model selects sources; trusted code computes digests from actual criteria. */
export function followupEvolutionSchema(sourceIds: string[]): Record<string, unknown> {
  const legacy = followupProposalSchema(sourceIds);
  return validateReasonerSchema(object({ ...(legacy.properties as Record<string, unknown>), criterionChanges: {
    type: 'array', maxItems: 128, items: object({
      kind: { type: 'string', enum: ['add', 'modify', 'retire'] }, criterionId: text,
      sources: { type: 'array', minItems: 1, maxItems: 64, items: object({ messageId: { ...text, enum: sourceIds }, quote: { ...text, maxLength: 40000 } }) },
    }),
  } }));
}
export function processingSources(context: FollowupValidationContext, relatedMessageIds: string[]): ConversationMessage[] {
  const ids = [...relatedMessageIds, context.newMessageId];
  ensure(new Set(ids).size === ids.length, 'Duplicate processing source identity');
  const messages = context.frozenMessages.filter(message => ids.includes(message.id));
  ensure(messages.length === ids.length && messages.every(message => message.source === 'user' && message.kind !== 'question'), 'Change sources must belong to the frozen user change processing group');
  return messages.sort((a, b) => a.sequence - b.sequence);
}
function expectedChanges(result: FollowupProposal, context: FollowupValidationContext): Omit<AuthorizedCriterionChange, 'sources'>[] {
  if (result.decision !== 'revise') return [];
  const before = new Map(context.originalContract.criteria.map(criterion => [criterion.id, criterion]));
  const after = new Map(result.proposal!.criteria.map(item => { const criterion = acceptanceCriterion(item); return [criterion.id, criterion] as const; }));
  const changes: Omit<AuthorizedCriterionChange, 'sources'>[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id), b = after.get(id), beforeDigest = a ? hash(a) : null, afterDigest = b ? hash(b) : null;
    if (beforeDigest === afterDigest) continue;
    changes.push({ kind: !a ? 'add' : !b ? 'retire' : 'modify', criterionId: id, beforeDigest, afterDigest });
  }
  return changes;
}
function bindChanges(result: FollowupProposal, requested: ChangeRequest[], context: FollowupValidationContext, relatedMessageIds: string[]): AuthorizedCriterionChange[] {
  const expected = expectedChanges(result, context);
  ensure(requested.length === expected.length && new Set(requested.map(change => change.criterionId)).size === requested.length, 'Every actual acceptance change requires exactly one source mapping');
  if (result.decision !== 'revise') { ensure(requested.length === 0, 'Answer or clarification cannot authorize contract evolution'); return []; }
  const sources = processingSources(context, relatedMessageIds);
  return expected.map(change => {
    const item = requested.find(value => value.criterionId === change.criterionId);
    ensure(item && item.kind === change.kind, 'Change source kind does not match actual acceptance difference');
    ensure(item.sources.length > 0 && new Set(item.sources.map(source => verificationCanonical(source))).size === item.sources.length, 'Missing or duplicate criterion change source');
    for (const source of item.sources) {
      const message = sources.find(message => message.id === source.messageId);
      ensure(message && source.quote.trim() && !source.quote.includes('\0') && message.text.includes(source.quote), 'Criterion change needs an exact quote from its frozen processing group');
    }
    return { ...change, sources: structuredClone(item.sources) };
  });
}
export function parseFollowupEvolution(value: unknown, context: FollowupValidationContext, relatedMessageIds: string[]): FollowupProposal {
  const sourceIds = [...new Set([...context.session.messages.map(message => message.id), ...context.frozenMessages.map(message => message.id)])];
  const parsed = parseReasonerOutput(JSON.stringify(value), followupEvolutionSchema(sourceIds)) as Omit<FollowupProposal, 'criterionChanges'> & { criterionChanges: ChangeRequest[] };
  const { criterionChanges, ...legacy } = parsed;
  const result = validateFollowupProposal(legacy, context);
  return { ...result, criterionChanges: bindChanges(result, criterionChanges, context, relatedMessageIds) };
}
/** Revalidate a saved enriched result. Never recompute altered digests in place. */
export function validateFollowupEvolution(value: FollowupProposal, context: FollowupValidationContext, relatedMessageIds: string[]): FollowupProposal {
  ensure(Array.isArray(value.criterionChanges), 'Missing versioned acceptance change mappings');
  const { criterionChanges, ...legacy } = value;
  const sourceRequests = criterionChanges.map(({ kind, criterionId, sources }) => ({ kind, criterionId, sources }));
  const validated = parseFollowupEvolution({ ...legacy, criterionChanges: sourceRequests }, context, relatedMessageIds);
  ensure(verificationCanonical(validated.criterionChanges) === verificationCanonical(criterionChanges), 'Saved acceptance change digests or fields changed');
  return validated;
}
export function followupEvolutionReviewSchema(result: FollowupProposal, context: FollowupValidationContext, relatedMessageIds: string[]): Record<string, unknown> {
  const checked = validateFollowupEvolution(result, context, relatedMessageIds);
  ensure(checked.decision === 'revise', 'Only an executable revision has an authorization review');
  const sourceDigest = hash(processingSources(context, relatedMessageIds).map(({ id, text, sequence }) => ({ id, text, sequence })));
  return validateReasonerSchema(object({
    approved: { type: 'boolean' }, proposalDigest: { const: hash(checked.proposal) }, sourceDigest: { const: sourceDigest },
    changes: { type: 'array', minItems: checked.criterionChanges!.length, maxItems: checked.criterionChanges!.length, items: object({
      criterionId: text, kind: { type: 'string', enum: ['add', 'modify', 'retire'] }, authorized: { type: 'boolean' },
      reasons: { type: 'array', minItems: 1, maxItems: 64, items: text },
    }) },
  }));
}
export function validateEvolutionReview(value: unknown, result: FollowupProposal, context: FollowupValidationContext, relatedMessageIds: string[]): EvolutionReview {
  const reviewed = parseReasonerOutput(JSON.stringify(value), followupEvolutionReviewSchema(result, context, relatedMessageIds)) as EvolutionReview;
  ensure(new Set(reviewed.changes.map(change => change.criterionId)).size === reviewed.changes.length, 'Duplicate authorization review criterion');
  ensure(result.criterionChanges!.every(change => reviewed.changes.some(item => item.criterionId === change.criterionId && item.kind === change.kind && item.reasons.every(reason => reason.trim()))), 'Authorization review omitted or changed an acceptance delta');
  ensure(!reviewed.approved || reviewed.changes.every(change => change.authorized), 'Overall approval cannot override a rejected criterion change');
  return reviewed;
}
