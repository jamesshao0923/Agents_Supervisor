import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {goalProposalSchema} from '../../packages/contracts/p5.js';
import {parseReasonerOutput, validateReasonerSchema, ReasonerSchemaError} from '../../packages/orchestration/reasoner-schema.js';
import {validateResearchGroups, assessResearchGrouping} from '../../packages/orchestration/research-group-admission.js';
import {createDraftRun} from '../../packages/domain/index.js';
import {ResearchGroupsProposal} from '../../apps/desktop/research-groups-panel.js';
import {configuration, proposal, session} from '../helpers/research-group-admission-fixture.js';
function run(limit = 1000) {return createDraftRun({id: 'goal', projectId: 'project', goal: 'Trace all five materials.', budget: {unit: 'token', limit, verificationReserve: 300}});}
test('P8-GADMIT-U01 configured research schema freezes material IDs and excludes model cost while legacy schemas remain unchanged', () => {
  const schema = goalProposalSchema(['message'], 'legacy', configuration());
  validateReasonerSchema(schema); const p = proposal();
  assert.deepEqual(parseReasonerOutput(JSON.stringify(p), schema), p);
  const latest={...p,decomposition:null,iteration:null,exploration:[]};
  parseReasonerOutput(JSON.stringify(latest),goalProposalSchema(['message'],'graph-exploration-v1',configuration()));
  parseReasonerOutput(JSON.stringify({...latest,researchGroups:null}),goalProposalSchema(['message'],'graph-exploration-v1',configuration()));
  assert.throws(() => parseReasonerOutput(JSON.stringify({...p, researchGroups: {...p.researchGroups!, groups: [{...p.researchGroups!.groups[0]!, reservation: 1}]}}), schema), ReasonerSchemaError);
  const foreign = structuredClone(p); foreign.researchGroups!.groups[0]!.materialIds = ['foreign'];
  assert.throws(() => parseReasonerOutput(JSON.stringify(foreign), schema), ReasonerSchemaError);
  const legacy = structuredClone(p); delete legacy.researchGroups;
  parseReasonerOutput(JSON.stringify(legacy), goalProposalSchema(['message']));
  assert.throws(() => parseReasonerOutput(JSON.stringify(p), goalProposalSchema(['message'])), ReasonerSchemaError);
  assert.throws(() => validateResearchGroups(p, {...session(), research: undefined} as never), /configured/);
});
test('P8-GADMIT-U02 grouping preserves every original material criterion pair and rejects duplicate or invented scope', () => {
  const p = proposal(), s = session(); validateResearchGroups(p, s);
  for (const fault of ['missing', 'duplicate', 'criterion', 'purpose'] as const) {
    const bad = structuredClone(p);
    if (fault === 'missing') bad.researchGroups!.groups.pop();
    if (fault === 'duplicate') bad.researchGroups!.groups[0]!.materialIds.push('m2');
    if (fault === 'criterion') bad.researchGroups!.groups[0]!.criterionIds = ['invented'];
    if (fault === 'purpose') bad.researchGroups!.groups[0]!.purpose = ' ';
    assert.throws(() => validateResearchGroups(bad, s), /Research grouping/);
  }
  assert.throws(() => validateResearchGroups(p, {...s, runtimeId: 'already-admitted'}), /initial/);
});
test('P8-GADMIT-U03 actual shared budget protects original analysis and verification and single fallback gives an explicit structural reason', () => {
  const s = session(), before = structuredClone(s), r = run();
  const admitted = assessResearchGrouping(s, r);
  assert.equal(admitted.decision.mode, 'grouped'); assert.equal(admitted.decision.maxActive, 2);
  assert.equal(admitted.decision.groupReservation, 400); assert.equal(admitted.decision.totalProtectedReservation, 800);
  assert.ok(admitted.groups.every(group => group.reservation === s.config.reservation));
  const limited = assessResearchGrouping(s, run(700)); assert.equal(limited.decision.mode, 'single');
  assert.match(limited.decision.reason, /cannot fund every proposed group/); assert.equal(limited.decision.groupReservation, 0);
  assert.throws(() => assessResearchGrouping(s, run(399)), /original full analysis/);
  const one = structuredClone(s); one.proposal!.researchGroups!.groups = [{id: 'all', purpose: 'Full extraction', materialIds: ['m1', 'm2', 'm3', 'm4', 'm5'], criterionIds: ['trace']}];
  assert.match(assessResearchGrouping(one, r).decision.reason, /structural parallel/);
  const unknown = structuredClone(r); unknown.attempts.push({id: 'unsettled', nodeId: '@supervisor', contractVersion: 1, status: 'cancelled', purpose: 'reasoning', reservation: 100, actual: null, settled: false, requestedModel: 'fixture', resources: []} as never);
  assert.throws(() => assessResearchGrouping(s, unknown), /unknown accounting/);
  assert.deepEqual(s, before); assert.equal(r.budget.spent, 0);
});
test('P8-GADMIT-U04 actual React proposal presentation separates model suggestion from host single fallback and never declares efficiency or acceptance', () => {
  const p = proposal(); const suggestion = renderToStaticMarkup(createElement(ResearchGroupsProposal, {proposal: p}));
  assert.match(suggestion, /2.*4/); assert.match(suggestion, /建议尚未派发/);
  const decision = assessResearchGrouping(session(), run(700)).decision;
  const fallback = renderToStaticMarkup(createElement(ResearchGroupsProposal, {proposal: p, decision}));
  assert.match(fallback, /采用原单分析路径/); assert.doesNotMatch(fallback, /已注册/);
  assert.match(fallback, /全部原材料和问题/); assert.match(fallback, /不是验收或交付/);
  const escaped = structuredClone(p); escaped.researchGroups!.groups[0]!.purpose = '<script>unsafe</script>';
  assert.doesNotMatch(renderToStaticMarkup(createElement(ResearchGroupsProposal, {proposal: escaped})), /<script>/);
});
