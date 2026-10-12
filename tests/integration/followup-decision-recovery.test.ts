import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { GoalProposal, GoalSession } from '../../packages/contracts/p5.js';
import type { FollowupProposal } from '../../packages/contracts/p6.js';
import { ConversationController } from '../../packages/orchestration/conversation-controller.js';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { LocalRuntimeAdapter } from '../../packages/runtime/index.js';
import { describeGoalProblem } from '../../apps/desktop/presentation.js';

function ready(session: GoalSession): GoalProposal {
  return { decision: 'ready', summary: 'Produce the requested local report', questions: [], facts: session.messages.map(message => ({ text: message.text, sourceId: message.id, origin: 'explicit' })), constraints: [], style: [], criteria: [{ id: 'report', kind: 'command', description: 'Produce a structured report', target: 'report.test.mjs', checks: ['Verify report structure and required fields'] }], steps: [{ id: 'write', description: 'Write the report and its executable check', dependencies: [], acceptanceIds: ['report'] }] };
}

// These fixtures are persisted output records, not simulated model calls. Actual
// SQLite, controller recovery, proof hashing, validation and UI mapping run below.
test('recovered inconsistent followup output preserves paid receipt and user intent without application or automatic retry', async () => {
  for (const invalid of ['revise-clarify', 'clarify-ready', 'clarify-empty', 'revise-questions'] as const) {
    const root = mkdtempSync('/tmp/sv-fup-dec-'), workspace = join(root, 'project'), data = join(root, 'data'); mkdirSync(workspace);
    const store = new SupervisorStore(data), runtime = new LocalRuntimeAdapter(store, data), controller = new ConversationController(store, data, runtime);
    try {
      const begun = store.goals.start({ type: 'start', commandId: 'initial', goal: 'Write a structured report', model: 'persisted-output-fixture-no-model-call', effort: 'low', reservation: 20, timeoutMs: 1000, tokenLimit: 300, verificationReserve: 20 }, workspace, 'project');
      const initial = store.goals.finish(begun.session.id, begun.session.jobs[0]!.id, job => { job.usage = 2; job.stopConfirmed = true; job.proposal = ready(begun.session); });
      const conversation = store.conversations.ensureForGoal(initial.session.id);
      const message = store.conversations.receive({ conversationId: conversation.id, commandId: 'change', source: 'user', kind: 'change', text: 'Research current public evidence and expand the report.' });
      const following = store.goals.beginFollowup(initial.session.id, message.id), jobId = following.session.jobs.at(-1)!.id;
      const proposal = ready(following.session);
      const decision = invalid.startsWith('revise') ? 'revise' : 'clarify';
      if (invalid !== 'clarify-ready' && invalid !== 'revise-questions') proposal.decision = 'clarify';
      if (invalid === 'revise-questions') proposal.questions = ['May I use already requested public searches?'];
      const output: FollowupProposal = { decision, response: 'Recorded output requires validation', proposal, retiredCriterionIds: [], retirementSources: [], criterionChanges: [] };
      const proofPath = join(root, 'first-output.json'), proofBody = JSON.stringify(output); writeFileSync(proofPath, proofBody);
      const proofDigest = createHash('sha256').update(proofBody).digest('hex');
      const receipt = { id: jobId, output, outputDigest: proofDigest, usage: 7, stopConfirmed: true, threadId: 'persisted-first-context', proofs: { [proofPath]: proofDigest } };
      store.goals.finish(initial.session.id, jobId, job => { job.usage = 7; job.stopConfirmed = true; job.modelStarted = true; job.threadId = receipt.threadId; job.proofs = receipt.proofs; job.context = { callReceipts: [receipt] }; job.followupResult = output; });
      const before = store.goals.inspect(initial.session.id);
      await controller.initialize(); await controller.scan();
      const failed = store.conversations.message(message.id), after = store.goals.inspect(initial.session.id);
      assert.equal(failed.state, 'failed'); assert.equal(failed.response, null); assert.equal(failed.appliedContractVersion, null);
      assert.match(failed.history.at(-1)!.reason!, /Revision needs a ready executable proposal|Clarification needs explicit nonempty questions|Unanswered questions prevent admission/);
      assert.match(describeGoalProblem(failed.history.at(-1)!.reason!), /决策与提案不一致/);
      assert.equal(failed.text, message.text); assert.equal(store.conversations.hasPendingForRun(initial.run.projectId, initial.run.id), true);
      assert.deepEqual(after, before, 'Rejected publication must retain the raw paid output, ledger and accepted plan');
      assert.equal(after.run.budget.spent, 9); assert.equal(store.conversations.budget(conversation.id).spent, 9);
      assert.equal(after.session.jobs.length, 2); assert.equal(after.session.runtimeId, null); assert.equal(store.runtime.list().length, 0);
      assert.deepEqual((after.session.jobs.at(-1)!.context as { callReceipts: unknown[] }).callReceipts, [receipt]);
      await controller.scan(); assert.deepEqual(store.conversations.message(message.id), failed, 'Recovery must not automatically retry invalid output');
    } finally { await controller.close(); await runtime.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
