import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVerificationSpec, type VerificationContract, type VerificationResult, type VerificationSelection, type VerificationSpec, type VerificationSpecCase } from '../../packages/contracts/p4.js';
import { evaluateVerification, selectInstances, validateSpecChange } from '../../packages/verification/rules.js';

const contract: VerificationContract = { version: 1, criteria: [{ id: 'price', description: 'Discount and illegal inputs meet their declared contract', required: true }] };
function spec(): VerificationSpec {
  return { schemaVersion: 1, contractVersion: 1, standardsVersion: 'price-standard-v1', obligations: [
    { id: 'normal', criterionId: 'price', expectation: '200 at 25 percent costs 150', required: true, applicable: true },
    { id: 'invalid', criterionId: 'price', expectation: 'Negative amount raises RangeError', required: true, applicable: true },
  ], cases: [{ id: 'price-check', revision: 1, obligationIds: ['normal', 'invalid'], parameters: [{ platform: 'mac', input: 'negative' }, { platform: 'mac', input: 'normal' }], modules: ['price'], replaces: [], defectRefs: ['WRONG-FORMULA', 'NEGATIVE-ACCEPTED'], verifier: { kind: 'command', version: 'command-v1', entry: 'checks/price.mjs', files: ['checks/price.mjs'], timeoutMs: 5000 } }],
    controls: [{ id: 'good', workspace: '/isolated/good', expect: 'passed', mustFail: [] }, { id: 'bad-formula', workspace: '/isolated/bad', expect: 'failed', mustFail: ['normal'] }], moduleDependencies: { ui: ['price'], app: ['ui'] } };
}
function passed(selection: VerificationSelection): VerificationResult[] {
  return selection.instances.map(instance => ({ instanceId: instance.id, executionStatus: 'executed', checks: instance.obligationIds.map(obligationId => ({ obligationId, verdict: 'passed', reason: 'Actual declared assertion succeeded' })), reason: 'Real verifier report' }));
}
function replacement(input = spec()): VerificationSpec {
  const next = structuredClone(input), original = next.cases[0]!;
  next.cases.push({ ...structuredClone(original), revision: 2, status: 'retired' });
  next.cases.push({ ...structuredClone(original), id: 'merged-check', revision: 1, replaces: [original.id] }); return next;
}

test('verification spec parses independent command UI and source definitions without retaining caller objects', () => {
  const value = spec(); const ui: VerificationSpecCase = { ...structuredClone(value.cases[0]!), id: 'ui-check', modules: ['ui'], verifier: { kind: 'ui', version: 'ui-v1', entry: 'index.html', steps: [{ kind: 'fill', selector: '#amount', value: '200' }, { kind: 'click', selector: '#quote' }, { kind: 'assertText', selector: '#result', text: '150' }, { kind: 'assertVisible', selector: '#result' }], expectations: ['Result is visible and readable'], timeoutMs: 5000 } };
  if(value.cases[0]!.verifier.kind==='command')value.cases[0]!.verifier.candidateEntries=['app.js','test.mjs','legacy.cjs'];
  value.cases.push(ui, { ...structuredClone(value.cases[0]!), id: 'source-check', verifier: { kind: 'source', version: 'source-v1', claimFile: 'claims.json', sources: [{ id: 'primary', url: 'https://example.org/primary', excerpt: 'The original source actually states this fact.', maxAgeMs: 1000 }], timeoutMs: 5000 } });
  const parsed = parseVerificationSpec(value); assert.deepEqual(parsed, value); parsed.cases[0]!.parameters[0]!.platform = 'changed'; assert.equal(value.cases[0]!.parameters[0]!.platform, 'mac'); validateSpecChange(null, value, contract);
});

test('verification spec rejects unknown fields accessors prototypes sparse arrays and malformed primitive values', () => {
  const value = spec(); let reads = 0; const accessor = { ...value }; Object.defineProperty(accessor, 'contractVersion', { enumerable: true, get() { reads++; return 1; } }); assert.throws(() => parseVerificationSpec(accessor), /accessors/); assert.equal(reads, 0);
  assert.throws(() => parseVerificationSpec(Object.assign(Object.create(value) as object, value)), /plain object/);
  for (const update of [{ unknown: true }, { contractVersion: NaN }, { schemaVersion: 2 }, { controls: [] }, { obligations: [{ ...value.obligations[0], required: 'true' }] }, { cases: new Array(1) }]) assert.throws(() => parseVerificationSpec({ ...value, ...update }));
  const parameter = JSON.parse('{"__proto__":"unsafe"}'); value.cases[0]!.parameters = [parameter]; assert.throws(() => parseVerificationSpec(value), /unsafe object key/);
});

test('verification spec rejects escaping command and UI paths invalid source URLs and missing good bad controls', () => {
  for (const entry of ['../outside.mjs', '/absolute.mjs', 'checks/../outside.mjs', 'C:\\outside.mjs', 'checks//entry.mjs']) { const value = spec(); value.cases[0]!.verifier = { kind: 'command', version: 'v1', entry, files: [entry], timeoutMs: 1 }; assert.throws(() => parseVerificationSpec(value), /relative path/); }
  const value = spec(); value.cases[0]!.verifier = { kind: 'command', version: 'v1', entry: 'check.mjs', files: ['different.mjs'], timeoutMs: 1 }; assert.throws(() => parseVerificationSpec(value), /contain the entry/);
  for(const candidateEntries of [[],['../outside.mjs'],['/absolute.mjs'],['C:/outside.js'],['nested/../outside.js'],['nested\\entry.cjs'],['entry.ts'],['entry.mjs?escaped'],['entry.mjs','entry.mjs'],Array.from({length:9},(_,i)=>`entry-${i}.mjs`)]) {
    const input=spec();if(input.cases[0]!.verifier.kind==='command')input.cases[0]!.verifier.candidateEntries=candidateEntries;assert.throws(()=>parseVerificationSpec(input),/candidate|relative path|array/);
  }
  for (const url of ['http://example.org/source', 'https://user:secret@example.org/source', 'file:///source', 'https://example.org/source#unbound']) { const input = spec(); input.cases[0]!.verifier = { kind: 'source', version: 'v1', claimFile: 'claim.json', sources: [{ id: 'source', url, excerpt: 'actual passage', maxAgeMs: 1 }], timeoutMs: 1 }; assert.throws(() => parseVerificationSpec(input), /HTTPS/); }
  assert.throws(() => parseVerificationSpec({ ...spec(), controls: [spec().controls[0], { ...spec().controls[1], expect: 'passed', mustFail: [] }] }), /good and bad/);
});

test('verification not applicable requires a frozen reason and cannot be attached to an applicable obligation', () => {
  const value = spec(); value.obligations[0]!.applicable = false; assert.throws(() => parseVerificationSpec(value), /frozen reason/); value.obligations[0]!.notApplicableReason = 'Contract explicitly excludes this platform'; assert.doesNotThrow(() => parseVerificationSpec(value));
  value.obligations[0]!.applicable = true; assert.throws(() => parseVerificationSpec(value), /cannot carry/);
});

test('verification standard and necessary semantics cannot change through a verifier maintenance publication', () => {
  const old = spec(), next = spec(); next.obligations[0]!.expectation = 'Copy the current wrong result'; assert.throws(() => validateSpecChange(old, next, contract), /Standards version/); next.standardsVersion = 'v2'; assert.throws(() => validateSpecChange(old, next, contract), /Necessary obligation/);
  for (const change of [{ required: false }, { applicable: false, notApplicableReason: 'Temporary exception to pass' }]) { const changed = spec(); changed.standardsVersion = 'v2'; Object.assign(changed.obligations[1]!, change); assert.throws(() => validateSpecChange(old, changed, contract), /Necessary obligation/); }
  const missing = spec(); missing.standardsVersion = 'v2'; missing.obligations.pop(); for (const c of missing.cases) c.obligationIds = ['normal']; assert.throws(() => validateSpecChange(old, missing, contract), /Necessary obligation/);
  const revised = spec(); revised.contractVersion = 2; revised.standardsVersion = 'v2'; revised.obligations[0]!.expectation = 'An explicitly changed contract expectation'; assert.doesNotThrow(() => validateSpecChange(old, revised, { ...contract, version: 2 }));
});

test('verification changed implementation needs a new case revision while standards and original revision stay fixed', () => {
  const old = spec(), edited = spec(); edited.cases[0]!.verifier.version = 'fixed-implementation'; assert.throws(() => validateSpecChange(old, edited, contract), /revision/);
  const fixed = spec(); fixed.cases.push({ ...structuredClone(fixed.cases[0]!), revision: 2, verifier: { kind: 'command', version: 'fixed-implementation', entry: 'checks/fixed.mjs', files: ['checks/fixed.mjs'], timeoutMs: 5000 } }); validateSpecChange(old, fixed, contract); assert.equal(fixed.standardsVersion, old.standardsVersion);
  fixed.cases[1]!.parameters.pop(); assert.throws(() => validateSpecChange(old, fixed, contract), /parameter instance/);
});

test('verification publication preserves both control identities actual workspace and negative obligations', () => {
  const old = spec(); for (const mutate of [(v: VerificationSpec) => { v.controls.pop(); }, (v: VerificationSpec) => { v.controls[1]!.expect = 'passed'; v.controls[1]!.mustFail = []; }, (v: VerificationSpec) => { v.controls[1]!.workspace = '/different/current-broken-output'; }, (v: VerificationSpec) => { v.controls[1]!.mustFail = ['invalid']; }]) { const changed = spec(); mutate(changed); assert.throws(() => validateSpecChange(old, changed, contract)); }
  const stronger = spec(); stronger.controls[1]!.mustFail.push('invalid'); assert.doesNotThrow(() => validateSpecChange(old, stronger, contract));
});

test('verification replacement checks concrete obligations and parameter instances even when criterion labels remain equal', () => {
  const old = spec(), next = replacement(); validateSpecChange(old, next, contract);
  const missingAssertion = replacement(); missingAssertion.cases.at(-1)!.obligationIds = ['normal']; assert.throws(() => validateSpecChange(old, missingAssertion, contract), /assertion and parameter/);
  const missingFaultInput = replacement(); missingFaultInput.cases.at(-1)!.parameters = [{ platform: 'mac', input: 'normal' }]; assert.throws(() => validateSpecChange(old, missingFaultInput, contract), /assertion and parameter/);
  const renamedParameters = replacement(); renamedParameters.cases.at(-1)!.parameters = [{ platform: 'linux', input: 'normal' }, { platform: 'linux', input: 'negative' }]; assert.throws(() => validateSpecChange(old, renamedParameters, contract), /assertion and parameter/);
});

test('verification transitive retirement retains original fault assertions when intermediate retired metadata narrows', () => {
  const initial = spec(), merged = replacement(); validateSpecChange(initial, merged, contract);
  const next = structuredClone(merged), intermediate = next.cases.at(-1)!; next.cases.push({ ...structuredClone(intermediate), revision: 2, status: 'retired', obligationIds: ['normal'], parameters: [{ platform: 'mac', input: 'normal' }] });
  next.cases.push({ ...structuredClone(intermediate), id: 'final-check', revision: 1, replaces: [intermediate.id], obligationIds: ['normal'], parameters: [{ platform: 'mac', input: 'normal' }] });
  assert.throws(() => validateSpecChange(merged, next, contract), /assertion and parameter/);
  const final = next.cases.at(-1)!; final.obligationIds = ['normal', 'invalid']; final.parameters = structuredClone(initial.cases[0]!.parameters); assert.doesNotThrow(() => validateSpecChange(merged, next, contract));
});

test('verification instance selection deduplicates canonical parameter equality but preserves every distinct fault instance', () => {
  const value = spec(); value.cases[0]!.parameters.push({ input: 'negative', platform: 'mac' }, { platform: 'linux', input: 'negative' });
  const final = selectInstances(value, { mode: 'final' }), impact = selectInstances(value, { mode: 'impact', changedModules: ['price'] }); assert.equal(final.instances.length, 3); assert.equal(new Set(final.instances.map(i => i.id)).size, 3); assert.deepEqual(final.instances.map(i => i.id), impact.instances.map(i => i.id));
  final.instances[0]!.parameters.platform = 'modified'; assert.equal(value.cases[0]!.parameters[0]!.platform, 'mac');
});

test('verification impact selection expands transitive consumers broadens unknown impact and excludes retired dispatch', () => {
  const value = replacement(), original = value.cases.at(-1)!; value.cases.push({ ...structuredClone(original), id: 'ui-check', replaces: [], modules: ['ui'] }, { ...structuredClone(original), id: 'app-check', replaces: [], modules: ['app'] }, { ...structuredClone(original), id: 'other-check', replaces: [], modules: ['other'] });
  const scoped = selectInstances(value, { mode: 'impact', changedModules: ['price'] }); assert.deepEqual(new Set(scoped.instances.map(i => i.caseId)), new Set(['merged-check', 'ui-check', 'app-check'])); assert.equal(scoped.completeScope, false); assert.deepEqual(scoped.excludedCaseIds, ['other-check']);
  assert.deepEqual(selectInstances(value, { mode: 'impact', changedModules: ['unknown-file'] }).instances, selectInstances(value, { mode: 'final' }).instances); assert.deepEqual(selectInstances(value, { mode: 'impact', changedModules: [] }).instances, selectInstances(value, { mode: 'final' }).instances);
});

test('verification completion requires every necessary check on every parameter instance with optional failures retained', () => {
  const value = spec(); value.obligations.push({ id: 'optional', criterionId: 'price', expectation: 'Optional appearance feedback', required: false, applicable: true }); value.cases.push({ ...structuredClone(value.cases[0]!), id: 'optional', obligationIds: ['optional'], parameters: [{}], defectRefs: [] }); const selection = selectInstances(value, { mode: 'final' }), results = passed(selection); results.at(-1)!.checks[0]!.verdict = 'failed';
  const evaluation = evaluateVerification(value, selection, results); assert.equal(evaluation.complete, true); assert.equal(evaluation.obligations.find(o => o.id === 'optional')?.satisfied, false);
  results[0]!.checks[1]!.verdict = 'failed'; assert.equal(evaluateVerification(value, selection, results).complete, false); assert.equal(evaluateVerification(value, selection, passed(selection)).complete, true);
});

test('verification execution state cannot masquerade as a passed product verdict', () => {
  const value = spec(), selection = selectInstances(value, { mode: 'final' });
  for (const executionStatus of ['environment-blocked', 'verifier-error', 'not-run'] as const) { const results = passed(selection); results[0]!.executionStatus = executionStatus; const evaluation = evaluateVerification(value, selection, results); assert.equal(evaluation.complete, false); assert.ok(evaluation.obligations[0]!.reasons.some(r => r.includes(executionStatus))); }
  for (const verdict of ['failed', 'unknown', 'not-applicable'] as const) { const results = passed(selection); results[0]!.checks[0]!.verdict = verdict; assert.equal(evaluateVerification(value, selection, results).complete, false); }
});

test('verification explicit not applicable follows the frozen contract basis and never excuses applicable assertions', () => {
  const value = spec(); value.obligations[1]!.applicable = false; value.obligations[1]!.notApplicableReason = 'Frozen contract excludes negative inputs for this fixture'; const selection = selectInstances(value, { mode: 'final' }), results = passed(selection); for (const r of results) r.checks[1]!.verdict = 'not-applicable'; assert.equal(evaluateVerification(value, selection, results).complete, true);
  value.obligations[1]!.applicable = true; delete value.obligations[1]!.notApplicableReason; assert.equal(evaluateVerification(value, selectInstances(value, { mode: 'final' }), results).complete, false);
});

test('verification missing conflicting duplicate and foreign reports cannot conceal an earlier failure', () => {
  const value = spec(), selection = selectInstances(value, { mode: 'final' }); const missing = passed(selection); missing.pop(); assert.equal(evaluateVerification(value, selection, missing).complete, false);
  const failed = passed(selection); failed[0]!.checks[0]!.verdict = 'failed'; assert.equal(evaluateVerification(value, selection, [...failed, passed(selection)[0]!]).complete, false);
  const duplicateCheck = passed(selection); duplicateCheck[0]!.checks.push({ ...duplicateCheck[0]!.checks[0]!, verdict: 'failed' }); assert.equal(evaluateVerification(value, selection, duplicateCheck).complete, false);
  const omitted = passed(selection); omitted[0]!.checks.pop(); assert.equal(evaluateVerification(value, selection, omitted).complete, false);
  const foreign = passed(selection); foreign[0]!.checks.push({ obligationId: 'unselected', verdict: 'passed', reason: 'Unrelated check' }); assert.equal(evaluateVerification(value, selection, foreign).complete, false);
  assert.equal(evaluateVerification(value, selection, [...passed(selection), { ...passed(selection)[0]!, instanceId: 'foreign-instance' }]).complete, false);
});

test('verification partial stale forged and zero instance evaluations never claim completed delivery', () => {
  const value = spec(), selection = selectInstances(value, { mode: 'final' }); assert.equal(evaluateVerification(value, selection, passed(selection), { current: false }).complete, false);
  const impact = selectInstances(value, { mode: 'impact', changedModules: ['price'] }); assert.equal(evaluateVerification(value, impact, passed(impact)).passed, true); assert.equal(evaluateVerification(value, impact, passed(impact)).complete, false);
  const omitted = structuredClone(selection); omitted.instances.pop(); assert.equal(evaluateVerification(value, omitted, passed(omitted)).complete, false);
  const forged = structuredClone(selection); forged.instances[0]!.required = false; forged.instances[0]!.obligationIds = ['normal']; assert.equal(evaluateVerification(value, forged, passed(forged)).complete, false);
  const zero: VerificationSelection = { mode: 'final', instances: [], completeScope: true, excludedCaseIds: [] }; assert.equal(evaluateVerification(value, zero, []).passed, false); assert.equal(evaluateVerification(value, zero, []).complete, false);
});
