import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { GoalProposal, GoalSession } from '../../packages/contracts/p5.js';
import type { ConversationMessage } from '../../packages/contracts/p6.js';
import type { FollowupValidationContext } from '../../packages/orchestration/followup-proposal.js';
import { acceptanceCriterion, followupEvolutionSchema, parseFollowupEvolution, validateFollowupEvolution, followupEvolutionReviewSchema, validateEvolutionReview } from '../../packages/orchestration/followup-evolution.js';
import { verificationCanonical } from '../../packages/verification/rules.js';
import { validateReasonerSchema, parseReasonerOutput } from '../../packages/orchestration/reasoner-schema.js';
const hash = (value: unknown) => createHash('sha256').update(verificationCanonical(value)).digest('hex');
function fixture() {
  const proposal: GoalProposal = { decision: 'ready', summary: 'Sum project', facts: [{ text: 'Build sum.', sourceId: 'initial', origin: 'explicit' }], constraints: [], style: [], questions: [], criteria: [{ id: 'sum', description: 'Add inputs', kind: 'command', target: 'test.mjs', checks: ['sum(2,3)=5'] }], steps: [{ id: 'implement', description: 'Build sum', dependencies: [], acceptanceIds: ['sum'] }] };
  const session: GoalSession = { id: 'task', projectId: 'project', workspace: '/tmp/evolution-unit', workspaceKind: 'project', revision: 1, goal: 'Build sum.', phase: 'admitted', messages: [{ id: 'initial', role: 'user', text: 'Build sum.', createdAt: 'now' }], jobs: [], proposal, runtimeId: 'task', error: null, createdAt: 'now', updatedAt: 'now', config: { model: 'no-model-pure-test', effort: 'low', reservation: 10, timeoutMs: 1000 }, maxContextChars: 60000 };
  const message: ConversationMessage = { id: 'change', conversationId: 'conversation', sequence: 1, commandId: 'message', source: 'user', kind: 'change', text: 'Add divide. Replace sum with product.', receivedRunId: 'task', receivedContractVersion: 2, createdAt: 'now', state: 'processing', processing: { attempt: 1, runId: 'task', baseContractVersion: 2, throughSequence: 1, startedAt: 'now' }, processingHistory: [], response: null, appliedContractVersion: null, history: [] };
  const context: FollowupValidationContext = { originalContract: { version: 2, goal: session.goal, criteria: proposal.criteria.map(acceptanceCriterion) }, originalProposal: proposal, frozenMessages: [message], newMessageId: message.id, session };
  const next = structuredClone(proposal); next.criteria.push({ id: 'divide', description: 'Divide inputs', kind: 'command', target: 'test.mjs', checks: ['divide(6,2)=3'] }); next.steps[0]!.acceptanceIds.push('divide');
  const output = { decision: 'revise', response: 'Add requested divide and preserve sum.', proposal: next, retiredCriterionIds: [] as string[], retirementSources: [] as { criterionId: string; messageId: string; quote: string }[], criterionChanges: [{ kind: 'add', criterionId: 'divide', sources: [{ messageId: 'change', quote: 'Add divide.' }] }] };
  return { context, output, message };
}

test('P6-FE-U01 new transport schema requires complete source mappings but never asks the model to compute hashes', () => {
  const { output } = fixture(), schema = followupEvolutionSchema(['initial', 'change']);
  validateReasonerSchema(schema); assert.doesNotThrow(() => parseReasonerOutput(JSON.stringify(output), schema));
  assert.equal(JSON.stringify(schema).includes('beforeDigest'), false); assert.equal(JSON.stringify(schema).includes('uniqueItems'), false);
  const { criterionChanges, ...missing } = output; assert.throws(() => parseReasonerOutput(JSON.stringify(missing), schema));
  assert.throws(() => parseReasonerOutput(JSON.stringify({ ...output, criterionChanges: [{ ...criterionChanges[0], approved: true }] }), schema));
});
test('P6-FE-U02 additions bind exact current criterion bytes using trusted digests and leave inputs intact', () => {
  const { context, output } = fixture(), before = structuredClone({ context, output });
  const result = parseFollowupEvolution(output, context, []);
  assert.deepEqual(result.criterionChanges, [{ ...output.criterionChanges[0], beforeDigest: null, afterDigest: hash(acceptanceCriterion(output.proposal.criteria[1]!)) }]);
  assert.deepEqual({ context, output }, before); assert.deepEqual(validateFollowupEvolution(result, context, []), result);
});
test('P6-FE-U03 omissions duplicates fabricated and unchanged deltas cannot authorize a different set', () => {
  const { context, output } = fixture();
  for (const changes of [[], [...output.criterionChanges, ...output.criterionChanges], [{ ...output.criterionChanges[0], criterionId: 'sum' }], [{ ...output.criterionChanges[0], kind: 'modify' }]]) {
    assert.throws(() => parseFollowupEvolution({ ...output, criterionChanges: changes }, context, []));
  }
});
test('P6-FE-U04 changed and retired criteria bind exact prior bytes and still require legacy fresh user authority', () => {
  const { context, output } = fixture();
  output.proposal.criteria[0]!.checks = ['product(2,3)=6'];
  output.retirementSources.push({ criterionId: 'sum', messageId: 'change', quote: 'Replace sum with product.' });
  output.criterionChanges.push({ kind: 'modify', criterionId: 'sum', sources: [{ messageId: 'change', quote: 'Replace sum with product.' }] });
  const changed = parseFollowupEvolution(output, context, []);
  assert.equal(changed.criterionChanges!.find(change => change.criterionId === 'sum')!.beforeDigest, hash(context.originalContract.criteria[0]));
  output.proposal.criteria.shift(); output.proposal.steps[0]!.acceptanceIds = ['divide']; output.retiredCriterionIds = ['sum']; output.criterionChanges[1]!.kind = 'retire';
  const retired = parseFollowupEvolution(output, context, []); assert.equal(retired.criterionChanges![0]!.afterDigest, null);
  output.retirementSources = []; assert.throws(() => parseFollowupEvolution(output, context, []), /source evidence/);
});
test('P6-FE-U05 every source is exact nonempty nonduplicate and belongs to this processing group', () => {
  const { context, output } = fixture();
  for (const sources of [[{ messageId: 'initial', quote: 'Build sum.' }], [{ messageId: 'change', quote: 'invented' }], [{ messageId: 'change', quote: ' ' }], [...output.criterionChanges[0]!.sources, ...output.criterionChanges[0]!.sources]]) {
    assert.throws(() => parseFollowupEvolution({ ...output, criterionChanges: [{ ...output.criterionChanges[0], sources }] }, context, []));
  }
});
test('P6-FE-U06 a specifically bound clarification ancestor can source additions but arbitrary history cannot', () => {
  const { context, output, message } = fixture();
  context.frozenMessages = [{ ...message, id: 'ancestor', sequence: 1, text: 'Add divide.', state: 'clarifying' }, { ...message, sequence: 2, text: 'Use exact arithmetic.' }];
  output.criterionChanges[0]!.sources[0]!.messageId = 'ancestor';
  assert.throws(() => parseFollowupEvolution(output, context, []), /processing group/);
  assert.equal(parseFollowupEvolution(output, context, ['ancestor']).criterionChanges![0]!.sources[0]!.messageId, 'ancestor');
  assert.throws(() => parseFollowupEvolution(output, context, ['ancestor', 'ancestor']), /Duplicate/);
});
test('P6-FE-U07 answers and clarification cannot smuggle evolution and saved hashes cannot be rewritten', () => {
  const { context, output } = fixture(); context.frozenMessages[0]!.kind = 'question';
  const answer = { ...output, decision: 'answer', proposal: null, criterionChanges: [] };
  assert.deepEqual(parseFollowupEvolution(answer, context, []).criterionChanges, []);
  assert.throws(() => parseFollowupEvolution({ ...answer, criterionChanges: output.criterionChanges }, context, []));
  context.frozenMessages[0]!.kind = 'change';
  const saved = parseFollowupEvolution(output, context, []); saved.criterionChanges![0]!.afterDigest = 'f'.repeat(64);
  assert.throws(() => validateFollowupEvolution(saved, context, []), /digests/);
});
function reviewedFixture() {
  const { context, output } = fixture(), result = parseFollowupEvolution(output, context, []);
  const review = { approved: true, proposalDigest: hash(result.proposal), sourceDigest: hash(context.frozenMessages.map(({ id, text, sequence }) => ({ id, text, sequence }))), changes: [{ criterionId: 'divide', kind: 'add', authorized: true, reasons: ['The current user explicitly requests divide.'] }] };
  return { context, result, review };
}
test('P6-FE-U08 independent review binds proposal and exact ordered user sources', () => {
  const { context, result, review } = reviewedFixture(); validateReasonerSchema(followupEvolutionReviewSchema(result, context, []));
  assert.deepEqual(validateEvolutionReview(review, result, context, []), review);
  for (const key of ['proposalDigest', 'sourceDigest'] as const) assert.throws(() => validateEvolutionReview({ ...review, [key]: '0'.repeat(64) }, result, context, []));
});
test('P6-FE-U09 overall approval cannot override a rejected or omitted individual change', () => {
  const { context, result, review } = reviewedFixture();
  for (const changes of [[], [{ ...review.changes[0], authorized: false }], [{ ...review.changes[0], criterionId: 'sum' }], [{ ...review.changes[0], kind: 'retire' }], [{ ...review.changes[0], reasons: [' '] }]]) assert.throws(() => validateEvolutionReview({ ...review, changes }, result, context, []));
  assert.equal(validateEvolutionReview({ ...review, approved: false, changes: [{ ...review.changes[0], authorized: false }] }, result, context, []).approved, false);
});
test('P6-FE-U10 duplicate review identities cannot replace another required authorization', () => {
  const { context, output } = fixture(); output.proposal.criteria[0]!.checks = ['product(2,3)=6']; output.retirementSources = [{ criterionId: 'sum', messageId: 'change', quote: 'Replace sum with product.' }]; output.criterionChanges.push({ kind: 'modify', criterionId: 'sum', sources: [{ messageId: 'change', quote: 'Replace sum with product.' }] });
  const result = parseFollowupEvolution(output, context, []), review = { approved: true, proposalDigest: hash(result.proposal), sourceDigest: hash(context.frozenMessages.map(({ id, text, sequence }) => ({ id, text, sequence }))), changes: Array.from({ length: 2 }, () => ({ criterionId: 'divide', kind: 'add', authorized: true, reasons: ['yes'] })) };
  assert.throws(() => validateEvolutionReview(review, result, context, []), /Duplicate/);
});
