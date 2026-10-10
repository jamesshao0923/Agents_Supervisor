import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalProposal, GoalSession } from '../../packages/contracts/p5.js';
import type { ConversationMessage } from '../../packages/contracts/p6.js';
import { followupProposalSchema, validateFollowupProposal, type FollowupProposal, type FollowupValidationContext } from '../../packages/orchestration/followup-proposal.js';
import { parseReasonerOutput, validateReasonerSchema } from '../../packages/orchestration/reasoner-schema.js';

function proposal(): GoalProposal {
  return { decision: 'ready', summary: 'Implement sum', questions: [], facts: [{ text: 'Write sum function', sourceId: 'initial-user', origin: 'explicit' }], constraints: ['Keep work in project'], style: [],
    criteria: [{ id: 'sum', description: 'Adds two numbers', kind: 'command', target: 'test.mjs', checks: ['sum(2,3)=5'] }],
    steps: [{ id: 'build', description: 'Implement sum and checks', dependencies: [], acceptanceIds: ['sum'] }] };
}
function message(id: string, sequence: number, kind: ConversationMessage['kind'] = 'change'): ConversationMessage {
  return { id, conversationId: 'conversation', sequence, commandId: 'command-' + id, source: 'user', kind,
    text: sequence === 1 ? 'Previously I allowed removal of the sum criterion.' : 'Add a UI check. Replace sum check with multiplication and retire subtraction criterion.',
    receivedRunId: 'goal', receivedContractVersion: 2, createdAt: '2026-10-10T00:00:00Z', state: 'received', processing: null,
    processingHistory: [], response: null, appliedContractVersion: null, history: [] };
}
function context(): FollowupValidationContext {
  const original = proposal();
  const session: GoalSession = { id: 'goal', projectId: 'project', workspace: '/tmp/project', workspaceKind: 'project', revision: 2, goal: 'Write sum function', phase: 'admitted',
    messages: [{ id: 'initial-user', role: 'user', text: 'Write sum function', createdAt: 'now' }], jobs: [], proposal: original, runtimeId: 'goal', error: null,
    createdAt: 'now', updatedAt: 'now', config: { model: 'unneeded-in-pure-unit', effort: 'low', reservation: 20, timeoutMs: 1000 }, maxContextChars: 60_000 };
  return { originalContract: { version: 2, goal: session.goal, criteria: [{ id: 'sum', description: 'Adds two numbers\nAcceptance kind: command; target: test.mjs\nsum(2,3)=5', required: true }] }, originalProposal: original,
    frozenMessages: [message('historical-user', 1), message('new-user', 2)], newMessageId: 'new-user', session };
}
function revision(): FollowupProposal { return { decision: 'revise', response: 'I will preserve sum and add the requested check.', proposal: proposal(), retiredCriterionIds: [], retirementSources: [] }; }
function answer(): FollowupProposal { return { decision: 'answer', response: 'The accepted task is waiting for independent verification.', proposal: null, retiredCriterionIds: [], retirementSources: [] }; }
function authorize(value: FollowupProposal, criterionId = 'sum'): void {
  value.retirementSources.push({ criterionId, messageId: 'new-user', quote: 'Replace sum check with multiplication' });
}

test('P6-FUP-U01 strict followup schema requires every field rejects extra authority and freezes source IDs', () => {
  const schema = followupProposalSchema(['initial-user', 'historical-user', 'new-user']);
  assert.doesNotThrow(() => validateReasonerSchema(schema));
  assert.deepEqual((schema.required as string[]).sort(), ['decision', 'proposal', 'response', 'retiredCriterionIds', 'retirementSources'].sort());
  assert.equal(schema.additionalProperties, false);
  assert.ok(!JSON.stringify(schema).includes('uniqueItems'),'Strict Codex response schemas do not accept uniqueItems');
  assert.doesNotThrow(() => parseReasonerOutput(JSON.stringify(revision()), schema));
  for (const key of Object.keys(revision())) {
    const missing = { ...revision() } as Record<string, unknown>; delete missing[key];
    assert.throws(() => parseReasonerOutput(JSON.stringify(missing), schema), /missing/);
  }
  assert.throws(() => parseReasonerOutput(JSON.stringify({ ...revision(), authority: 'waive old acceptance' }), schema));
  const fabricated = revision(); fabricated.proposal!.facts[0]!.sourceId = 'invented-user';
  assert.throws(() => parseReasonerOutput(JSON.stringify(fabricated), schema), /anyOf/);
  fabricated.proposal!.facts[0]!.sourceId = 'initial-user';
  authorize(fabricated); fabricated.retirementSources[0]!.messageId = 'future-user';
  assert.throws(() => parseReasonerOutput(JSON.stringify(fabricated), schema), /enum/);
  assert.throws(() => followupProposalSchema([])); assert.throws(() => followupProposalSchema(['same', 'same']));
  const duplicates=revision();duplicates.retiredCriterionIds=['sum','sum'];
  assert.throws(()=>validateFollowupProposal(duplicates,context()),/Duplicate retired/);
  duplicates.retiredCriterionIds=[];authorize(duplicates);authorize(duplicates);
  assert.throws(()=>validateFollowupProposal(duplicates,context()),/Duplicate retirement source/);
});

test('P6-FUP-U02 explicit question cannot revise and explicit change cannot be dismissed as answer', () => {
  const c = context(); c.frozenMessages[1]!.kind = 'question';
  assert.throws(() => validateFollowupProposal(revision(), c), /question cannot revise/);
  assert.equal(validateFollowupProposal(answer(), c).decision, 'answer');
  assert.throws(() => validateFollowupProposal(answer(), context()), /change cannot be dismissed/);
  c.frozenMessages[1]!.kind = 'unclassified';
  assert.equal(validateFollowupProposal(answer(), c).decision, 'answer');
  assert.equal(validateFollowupProposal(revision(), c).decision, 'revise');
});

test('P6-FUP-U03 answer cannot carry plans retirements or standard changes and response must be nonempty', () => {
  const c = context(); c.frozenMessages[1]!.kind = 'question';
  assert.throws(() => validateFollowupProposal({ ...answer(), proposal: proposal() }, c), /Answer cannot include/);
  assert.throws(() => validateFollowupProposal({ ...answer(), retiredCriterionIds: ['sum'] }, c), /cannot retire/);
  const sourced = answer(); authorize(sourced); assert.throws(() => validateFollowupProposal(sourced, c), /cannot retire/);
  assert.throws(() => validateFollowupProposal({ ...answer(), response: '   ' }, c), /response/);
});

test('P6-FUP-U04 clarification preserves a concrete question without a ready plan or acceptance retirement', () => {
  const value: FollowupProposal = { decision: 'clarify', response: 'Which UI state should be checked?', proposal: { ...proposal(), decision: 'clarify', questions: ['Which UI state should be checked?'] }, retiredCriterionIds: [], retirementSources: [] };
  assert.equal(validateFollowupProposal(value, context()).proposal?.questions[0], value.response);
  assert.throws(() => validateFollowupProposal({ ...value, proposal: null }, context()), /explicit nonempty questions/);
  assert.throws(() => validateFollowupProposal({ ...value, proposal: { ...proposal(), decision: 'clarify', questions: ['   '] } }, context()), /nonempty/);
  assert.throws(() => validateFollowupProposal({ ...value, proposal: { ...proposal(), decision: 'clarify', questions: [] } }, context()), /questions/);
  assert.throws(() => validateFollowupProposal({ ...value, retiredCriterionIds: ['sum'] }, context()), /cannot retire/);
});

test('P6-FUP-U05 revision keeps old necessary acceptance and admits an additive ready fully covered plan', () => {
  const c = context(), value = revision(), before = structuredClone(c);
  value.proposal!.facts.push({ text: 'Add a UI check.', sourceId: 'new-user', origin: 'explicit' });
  value.proposal!.criteria.push({ id: 'ui', description: 'Show correct sum', kind: 'ui', target: 'index.html', checks: ['Correct sum is visible'] });
  value.proposal!.steps.push({ id: 'ui', description: 'Add requested UI', dependencies: ['build'], acceptanceIds: ['ui'] });
  const validated = validateFollowupProposal(value, c); assert.equal(validated.proposal?.criteria.length, 2);
  assert.deepEqual(c, before, 'validator cannot mutate the frozen contract/session/messages');
  assert.notEqual(validated, value, 'validated model JSON is a detached result');
});

test('P6-FUP-U06 old required IDs cannot be silently removed renamed or declared retired while still present', () => {
  const value = revision(); value.proposal!.criteria[0]!.id = 'renamed'; value.proposal!.steps[0]!.acceptanceIds = ['renamed'];
  assert.throws(() => validateFollowupProposal(value, context()), /missing without explicit retirement/);
  assert.throws(() => validateFollowupProposal({ ...revision(), retiredCriterionIds: ['sum'] }, context()), /omitted original/);
  assert.throws(() => validateFollowupProposal({ ...revision(), retiredCriterionIds: ['unknown'] }, context()), /omitted original/);
  assert.throws(() => validateFollowupProposal({ ...revision(), retiredCriterionIds: ['sum', 'sum'] }, context()), /Duplicate/);
});

test('P6-FUP-U07 explicit retirement needs an exact current-user quote and historical permission cannot authorize it', () => {
  const c = context(), value = revision();
  value.proposal!.criteria[0]!.id = 'multiply'; value.proposal!.steps[0]!.acceptanceIds = ['multiply']; value.retiredCriterionIds = ['sum'];
  assert.throws(() => validateFollowupProposal(value, c), /source evidence/);
  authorize(value); assert.equal(validateFollowupProposal(value, c).retiredCriterionIds[0], 'sum');
  const historical = structuredClone(value); historical.retirementSources[0] = { criterionId: 'sum', messageId: 'historical-user', quote: 'Previously I allowed removal of the sum criterion.' };
  assert.throws(() => validateFollowupProposal(historical, c), /never historical authority/);
  for (const quote of ['invented removal permission', '   ', 'replace sum check with multiplication', 'Replace sum\0']) {
    const fabricated = structuredClone(value); fabricated.retirementSources[0]!.quote = quote;
    assert.throws(() => validateFollowupProposal(fabricated, c), /exact nonempty substring/);
  }
});

test('P6-FUP-U08 same-ID description kind target and check edits all require new-user semantic-change evidence', () => {
  const changes = [
    (p: GoalProposal) => { p.criteria[0]!.description = 'Multiply two numbers'; },
    (p: GoalProposal) => { p.criteria[0]!.kind = 'ui'; },
    (p: GoalProposal) => { p.criteria[0]!.target = 'other-test.mjs'; },
    (p: GoalProposal) => { p.criteria[0]!.checks = ['sum returns any number']; },
  ];
  for (const change of changes) {
    const value = revision(); change(value.proposal!);
    assert.throws(() => validateFollowupProposal(value, context()), /semantic change sum needs/);
    authorize(value); assert.equal(validateFollowupProposal(value, context()).proposal?.criteria[0]?.id, 'sum');
    assert.deepEqual(value.retiredCriterionIds, [], 'same-ID semantic revision is not an omitted ID');
  }
});

test('P6-FUP-U09 retirement sources cannot claim unrelated unchanged or newly added acceptance IDs', () => {
  const unchanged = revision(); authorize(unchanged); assert.throws(() => validateFollowupProposal(unchanged, context()), /actual retirement or semantic change/);
  const unrelated = revision(); unrelated.proposal!.criteria[0]!.description = 'Different sum'; authorize(unrelated, 'unknown');
  assert.throws(() => validateFollowupProposal(unrelated, context()), /actual retirement or semantic change/);
  const duplicate = revision(); duplicate.proposal!.criteria[0]!.description = 'Different sum'; authorize(duplicate); authorize(duplicate);
  assert.throws(() => validateFollowupProposal(duplicate, context()), /Duplicate/);
});

test('P6-FUP-U10 unknown baseline cannot silently weaken checks and stale structured baseline is rejected', () => {
  const c = context(); c.originalProposal = null;
  assert.doesNotThrow(() => validateFollowupProposal(revision(), c), 'Rendered contract preserves kind target and checks without a structured proposal');
  const weakened = revision(); weakened.proposal!.criteria[0]!.checks = ['Any output']; assert.throws(() => validateFollowupProposal(weakened, c), /source evidence/);
  c.originalContract.criteria[0]!.description = 'Adds two numbers';
  assert.throws(() => validateFollowupProposal(revision(), c), /source evidence/, 'Raw description cannot establish original checks or target');
  const stale = context(); stale.originalProposal!.criteria[0]!.description = 'A baseline never admitted';
  assert.throws(() => validateFollowupProposal(revision(), stale), /does not match/);
});

test('P6-FUP-U11 revision reuses actual proposal validation for escaped targets uncovered acceptance bad provenance and cyclic dependencies', () => {
  const edits = [
    (p: GoalProposal) => { p.criteria[0]!.target = '../escaped.mjs'; },
    (p: GoalProposal) => { p.steps[0]!.acceptanceIds = []; },
    (p: GoalProposal) => { p.facts[0]!.text = 'Publish production'; },
    (p: GoalProposal) => { p.steps[0]!.dependencies = ['build']; },
    (p: GoalProposal) => { p.questions = ['Unanswered question']; },
  ];
  for (const edit of edits) { const value = revision(); edit(value.proposal!); assert.throws(() => validateFollowupProposal(value, context())); }
  assert.throws(() => validateFollowupProposal({ ...revision(), proposal: { ...proposal(), decision: 'clarify', questions: ['Which requirement?'] } }, context()), /ready executable/);
});

test('P6-FUP-U12 frozen input rejects future boundaries duplicate IDs wrong conversation reordered sequences and conflicting source text', () => {
  const contexts = [
    (c: FollowupValidationContext) => { c.newMessageId = 'historical-user'; },
    (c: FollowupValidationContext) => { c.newMessageId = 'future-user'; },
    (c: FollowupValidationContext) => { c.frozenMessages[1]!.id = 'historical-user'; },
    (c: FollowupValidationContext) => { c.frozenMessages[1]!.conversationId = 'another-conversation'; },
    (c: FollowupValidationContext) => { c.frozenMessages.reverse(); },
    (c: FollowupValidationContext) => { c.session.messages.push({ id: 'new-user', role: 'user', text: 'Changed behind the frozen boundary', createdAt: 'now' }); },
  ];
  for (const edit of contexts) { const c = context(); edit(c); assert.throws(() => validateFollowupProposal(revision(), c)); }
});

test('P6-FUP-U13 quote provenance is retained for independent semantic review rather than treated as semantic authorization', () => {
  const value = revision(); value.proposal!.criteria[0]!.checks = ['Weakened sum behavior'];
  value.retirementSources = [{ criterionId: 'sum', messageId: 'new-user', quote: 'Add a UI check.' }];
  const result = validateFollowupProposal(value, context());
  assert.deepEqual(result.retirementSources, value.retirementSources, 'Exact source is retained; controller reviewer must reject unrelated semantic permission');
  assert.equal(Object.hasOwn(result, 'authorized'), false);
  assert.throws(() => validateFollowupProposal({ ...value, confidence: 1, authorized: true }, context()), /prohibited/);
});
