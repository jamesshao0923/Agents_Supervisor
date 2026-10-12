import assert from 'node:assert/strict';
import test from 'node:test';
import { describeGoalProblem } from '../../apps/desktop/presentation.js';

test('followup proposal inconsistency identifies invalid output without claiming a stale record', () => {
  for (const reason of [
    'Revision needs a ready executable proposal',
    'Clarification needs explicit nonempty questions',
    'Clarification needs concrete questions',
    'Answer cannot include a requirements proposal',
    'Unanswered questions prevent admission',
  ]) {
    const message = describeGoalProblem(reason);
    assert.match(message, /决策与提案不一致/);
    assert.match(message, /需求尚未应用/);
    assert.doesNotMatch(message, /记录已有更新/);
  }
});

test('followup material configuration and actual capability failure have distinct actionable explanations', () => {
  const material = describeGoalProblem('Material acceptance needs admitted Run-owned acquisition configuration');
  assert.match(material, /未配置材料采集/);
  assert.match(material, /网页来源与报告检查/);
  assert.doesNotMatch(material, /记录已有更新|需要补充需求/);
  const capability = describeGoalProblem('Required test tools absent: native verifier not supported by host');
  assert.match(capability, /能力无法完成/);
  assert.match(capability, /保留原需求和验收标准/);
  assert.doesNotMatch(capability, /记录已有更新/);
});

test('followup stale guidance is reserved for concrete persisted record conflicts', () => {
  for (const reason of ['Goal revision changed', 'Run revision conflict', 'Graph Run revision changed', 'Contract changed after follow-up reasoning', 'Follow-up message has a stale processing boundary']) {
    assert.match(describeGoalProblem(reason), /记录已有更新/);
  }
  for (const reason of ['Case revision is immutable', 'Revision requires unsupported host capability', 'Stale source evidence', 'future-revision-error']) {
    assert.doesNotMatch(describeGoalProblem(reason), /记录已有更新/);
  }
});
