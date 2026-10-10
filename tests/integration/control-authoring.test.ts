import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapFixture } from '../helpers/control-bootstrap-fixture.js';
import { acceptanceAuthoringContextDigest } from '../../packages/orchestration/acceptance-authoring.js';
import { buildControlEvolutionAuthoringPrompt, captureControlEvolutionContext, controlEvolutionContextDigest, controlEvolutionAuthoringSchema, materializeControlEvolutionBundle, validateControlEvolutionBundle } from '../../packages/orchestration/acceptance-authoring-v2.js';
import type { ControlEvolutionAuthoringContext, ControlEvolutionBundle } from '../../packages/orchestration/acceptance-authoring-v2.js';
import { controlDigest } from '../../packages/verification/control-rules.js';
import { digest } from '../../packages/verification/candidate.js';
import { prepareControlDraft, executeControlBootstrap, assembleQualification } from '../../packages/verification/control-bootstrap.js';
import { parseReasonerOutput } from '../../packages/orchestration/reasoner-schema.js';
import type { TestContext } from 'node:test';

async function setup(t: TestContext) {
  const f = await bootstrapFixture(t), item = { id: 'math', description: 'Exact addition', kind: 'command' as const, target: 'data.json', checks: ['Sum is exactly 3'] };
  const contract = { version: 1, goal: 'Exact sum', criteria: [{ id: item.id, required: true, description: [item.description, 'Acceptance kind: command; target: data.json', ...item.checks].join('\n') }] };
  f.input.target.definition.contract = contract; f.input.base.target.contractDigest = controlDigest(contract);
  const content = await readFile(join(f.root, 'good/data.json'), 'utf8');
  const current = { contract, criteria: [item], previousSpec: null, candidate: { workspace: join(f.root, 'good'), digest: f.input.target.bundle.controls[0]!.candidate.digest, files: [{ path: 'data.json', content, sha256: digest(content) }] }, environment: { node: process.version }, failureContext: null };
  const context = await captureControlEvolutionContext({ current, base: f.input.base, transitions: [], history: f.input.history });
  const spec = structuredClone(f.input.target.definition.spec); spec.moduleDependencies = { math: [] };
  for (const c of spec.controls) c.workspace = c.id;
  for (const c of spec.cases) c.status = 'active';
  const bundle: ControlEvolutionBundle = { contextDigest: controlEvolutionContextDigest(context), plan: f.input.authoredPlan, assets: { contextDigest: acceptanceAuthoringContextDigest(current), spec, verifierFiles: [{ path: 'check.mjs', content: await readFile(join(f.root, 'defs/check.mjs'), 'utf8') }], controls: await Promise.all(['good', 'bad'].map(async id => ({ id, files: [{ path: 'data.json', content: await readFile(join(f.root, id, 'data.json'), 'utf8') }] }))), coverageExplanation: [{ criterionId: 'math', check: item.checks[0]!, caseIds: ['sum-detector'], explanation: 'Real independent checker reads sum and compares to three.' }] } };
  return { ...f, engineContext: f.context, context, bundle };
}

test('P6-CONTROL-AUTH-I01 proposed evolution binds exact contract and full sources and rejects invented permission fields', async t => {
  const f = await setup(t), result = validateControlEvolutionBundle(f.bundle, f.context);
  assert.deepEqual(result, f.bundle); assert.doesNotThrow(() => parseReasonerOutput(JSON.stringify(result), controlEvolutionAuthoringSchema(f.context)));
  const prompt = buildControlEvolutionAuthoringPrompt(f.context); assert.match(prompt, /PROPOSALS/); assert.ok(prompt.includes(JSON.stringify(f.context.current.contract.criteria[0]!.description).slice(1, -1)));
  assert.throws(() => validateControlEvolutionBundle({ ...f.bundle, approved: true }, f.context));
  const changed = structuredClone(f.context); changed.current.contract.version++;
  assert.throws(() => controlEvolutionAuthoringSchema(changed), /target contract/);
  let read = false; const bad = Object.defineProperty({ ...f.bundle }, 'status', { enumerable: true, get() { read = true; return 'passed'; } });
  assert.throws(() => validateControlEvolutionBundle(bad, f.context), /Unsafe/); assert.equal(read, false);
});

test('P6-CONTROL-AUTH-I02 every current control and every frozen check remain mandatory independently of evolution suggestions', async t => {
  const f = await setup(t);
  const mutations: ((b: ControlEvolutionBundle) => void)[] = [b => { b.plan.controlPlan.pop(); }, b => { b.plan.controlPlan[1]!.kind = 'positive-full'; }, b => { b.assets.coverageExplanation = []; }, b => { b.assets.spec.obligations[0]!.required = false; }, b => { b.assets.spec.controls[1]!.mustFail = []; }, b => { b.plan.historyPlan.push({ specimenKey: 'invented:1', successorControlId: null, retireObligationIds: [] }); }, b => { b.plan.controlPlan[1]!.predecessorKey = 'invented:1'; }, b => { b.assets.spec.controls[0]!.workspace = '/tmp/unchecked'; }];
  for (const mutate of mutations) { const b = structuredClone(f.bundle); mutate(b); assert.throws(() => validateControlEvolutionBundle(b, f.context)); }
});

test('P6-CONTROL-AUTH-I03 actual private materialization is immutable idempotent and never changes the live candidate', async t => {
  const f = await setup(t), options = { privateRoot: join(f.root, 'authored'), jobId: 'author-real-files', context: f.context, bundle: f.bundle };
  const original = await readFile(join(f.root, 'good/data.json'));
  const material = await materializeControlEvolutionBundle(options);
  assert.deepEqual(await materializeControlEvolutionBundle(options), material);
  const declaration = JSON.parse(await readFile(material.declarationPath, 'utf8'));
  assert.deepEqual(declaration.bundle, f.bundle); assert.equal(declaration.assets.status, 'proposed');
  assert.deepEqual(await readFile(join(f.root, 'good/data.json')), original);
  await writeFile(material.declarationPath, '{}'); await assert.rejects(materializeControlEvolutionBundle(options), /tampered evolution declaration/);
  await assert.rejects(materializeControlEvolutionBundle({ ...options, privateRoot: join(f.root, 'good/unsafe') }), /outside candidate/);
  await symlink(join(f.root, 'good'), join(f.root, 'linked'));
  await assert.rejects(materializeControlEvolutionBundle({ ...options, privateRoot: join(f.root, 'linked/assets') }), /candidate|symlink/);
});

test('P6-CONTROL-AUTH-I04 actual historical witnesses are supplied completely and only current frontier can be evolved', async t => {
  const f = await setup(t), draft = await prepareControlDraft(f.input), engine = f.engineContext('author-history'), evidence = await executeControlBootstrap(engine, draft);
  assert.equal(evidence.usable, true);
  const qualification = await assembleQualification({ draft, evidence, reviewJob: engine.job });
  // Executable historical mechanism fixture. No model approval or DB publication is claimed.
  const input = { current: f.context.current, base: { ...f.input.base, expectedHeadRevision: 1, baseProposalId: 'historical-fixture', baseDefinitionDigest: draft.target.definition.definitionDigest }, transitions: [], history: { definitions: [draft.target], specimens: qualification.specimens, manifest: qualification.frozen.manifest, transitions: [] } };
  const context = await captureControlEvolutionContext(input), bundle = structuredClone(f.bundle);
  bundle.contextDigest = controlEvolutionContextDigest(context);
  bundle.assets.spec.cases = structuredClone(draft.target.definition.spec.cases);
  bundle.plan.controlPlan = qualification.specimens.map(s => ({ controlId: s.revision.controlId, kind: s.revision.kind, predecessorKey: `${s.revision.ref.id}:${s.revision.ref.revision}` }));
  bundle.plan.historyPlan = bundle.plan.controlPlan.map(p => ({ specimenKey: p.predecessorKey!, successorControlId: p.controlId, retireObligationIds: [] }));
  assert.doesNotThrow(() => validateControlEvolutionBundle(bundle, context));
  const missing = structuredClone(bundle); missing.plan.historyPlan.pop(); assert.throws(() => validateControlEvolutionBundle(missing, context));
  const wrong = structuredClone(bundle); wrong.plan.historyPlan[0]!.successorControlId = null; assert.throws(() => validateControlEvolutionBundle(wrong, context), /mapping/);
  const key = Object.keys(context.historyText.specimens)[0]!, path = Object.keys(context.historyText.specimens[key]!)[0]!;
  const changed: ControlEvolutionAuthoringContext = structuredClone(context); changed.historyText.specimens[key]![path] += ' '; assert.throws(() => controlEvolutionAuthoringSchema(changed), /source or mode/);
  const changedMode = structuredClone(context); changedMode.historyText.specimenModes[key]![path] = 0o111; assert.throws(() => controlEvolutionAuthoringSchema(changedMode), /source or mode/);
  const proof = Object.keys(evidence.proofs)[0]!; await writeFile(proof, 'corrupted original proof'); await assert.rejects(captureControlEvolutionContext(input), /proof changed/);
});
