import { renderControlEvolutionPrompt, CONTROL_EVOLUTION_PRESENTATION_PROMPT_V2 } from './author-presentation.js';
import type {MaintenanceContext,MaintenancePlan,RegressionContext} from '../contracts/p6-control-maintenance.js';
import {assertMaintenanceContext,assertRegressionContext} from '../verification/control-maintenance-replay.js';
import {assertMaintenancePlan,maintenanceInstance} from '../verification/control-maintenance-rules.js';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { AppliedContractTransition, ProposalBase } from '../contracts/p4-lineage.js';
import type { AuthoredControlPlan, ControlBootstrapHistory } from '../contracts/p4-control-draft.js';
import { safeControlJSON } from '../contracts/p4-controls.js';
import type { VerificationSpecCase } from '../contracts/p4.js';
import { assertDefinition } from '../verification/definition.js';
import { canonical, digest, relativeFile } from '../verification/candidate.js';
import { controlDigest } from '../verification/control-rules.js';
import { specimenText, validateControlImplementationHistory } from '../verification/control-definition.js';
import { parseReasonerOutput, validateReasonerSchema } from './reasoner-schema.js';
import { acceptanceAuthoringContextDigest, currentAcceptanceAssetSchema, materializeCurrentAcceptanceAssets, validateCurrentAcceptanceAssets } from './acceptance-authoring.js';
import type { AcceptanceAuthoringContext, AcceptanceBundle, MaterializedAcceptanceBundle } from './acceptance-authoring.js';

export interface ControlEvolutionAuthoringContext {
  schemaVersion: 1;
  maintenance?:MaintenanceContext;
  regression?:RegressionContext;
  current: AcceptanceAuthoringContext;
  base: ProposalBase;
  transitions: AppliedContractTransition[];
  history: ControlBootstrapHistory;
  /** Complete frozen source text, not a summary or a model supplied history. */
  historyText: { definitions: Record<string, Record<string, string>>; specimens: Record<string, Record<string, string>>; specimenModes: Record<string, Record<string, number>> };
}
export interface ControlEvolutionBundle {
  maintenance?:MaintenancePlan;
  contextDigest: string;
  assets: AcceptanceBundle;
  plan: AuthoredControlPlan;
}
export interface MaterializedControlEvolution {
  assets: MaterializedAcceptanceBundle;
  declarationPath: string;
  declarationDigest: string;
}
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const text = { type: 'string', minLength: 1, maxLength: 12000 };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, additionalProperties: false, required: Object.keys(properties) });
const array = (items: unknown, maxItems = 128) => ({ type: 'array', items, maxItems });
const key = (ref: { id: string; revision: number }) => `${ref.id}:${ref.revision}`;
function frozen(context: ControlEvolutionAuthoringContext): ControlEvolutionAuthoringContext {
  safeControlJSON(context);
  ensure(Buffer.byteLength(canonical(context)) <= 2_000_000, 'Complete evolution context exceeds capacity; never truncate history');
  ensure(context.schemaVersion === 1 && context.current.previousSpec === null, 'Evolution uses a separately bound historical definition');
  acceptanceAuthoringContextDigest(context.current);
  ensure(context.base.target.contractDigest === controlDigest(context.current.contract), 'Evolution target contract binding changed');
  ensure(canonical(context.base.transitionIds) === canonical(context.transitions.map(t => t.id)), 'Evolution transition order changed');
  ensure(context.history.manifest?.lineageId === context.base.lineageId || context.history.manifest === null, 'Evolution lineage changed');
  const base = context.history.definitions.find(d => d.definition.definitionDigest === context.base.baseDefinitionDigest);
  ensure(context.base.baseDefinitionDigest === null ? context.history.definitions.length === 0 && context.history.specimens.length === 0 && context.history.manifest === null : !!base, 'Exact published base definition is missing');
  if (context.history.manifest) ensure(context.history.manifest.targetDefinitionDigest === context.base.baseDefinitionDigest, 'History is not the frozen published frontier');
  validateControlImplementationHistory(context.history.definitions);
  const expectedDefinitions = context.history.definitions.map(d => d.definition.definitionDigest).sort();
  ensure(new Set(expectedDefinitions).size === expectedDefinitions.length && canonical(Object.keys(context.historyText.definitions).sort()) === canonical(expectedDefinitions), 'Incomplete historical detector text');
  for (const entry of context.history.definitions) {
    const files = context.historyText.definitions[entry.definition.definitionDigest]!;
    ensure(canonical(Object.keys(files).sort()) === canonical(Object.keys(entry.bundle.files).sort()), 'Historical detector file inventory changed');
    for (const [name, value] of Object.entries(files)) ensure(digest(value) === entry.bundle.files[name], 'Historical detector source hash changed');
  }
  const expectedSpecimens = context.history.specimens.map(s => key(s.revision.ref)).sort();
  ensure(new Set(expectedSpecimens).size === expectedSpecimens.length && canonical(Object.keys(context.historyText.specimens).sort()) === canonical(expectedSpecimens), 'Incomplete historical specimen text');
  ensure(canonical(Object.keys(context.historyText.specimenModes).sort()) === canonical(expectedSpecimens), 'Historical specimen modes missing');
  for (const specimen of context.history.specimens) {
    const files = context.historyText.specimens[key(specimen.revision.ref)]!, modes = context.historyText.specimenModes[key(specimen.revision.ref)]!;
    ensure(canonical(Object.keys(files).sort()) === canonical(Object.keys(specimen.candidate.files).sort()) && canonical(Object.keys(modes).sort()) === canonical(Object.keys(files).sort()), 'Historical specimen file inventory changed');
    for (const [name, value] of Object.entries(files)) {
      const mode = modes[name]!; ensure(Number.isInteger(mode) && (mode & 0o111) === mode, 'Invalid specimen executable mode');
      ensure(digest(Buffer.concat([Buffer.from(value), Buffer.from('\0executable:' + String(mode))])) === specimen.candidate.files[name], 'Historical specimen source or mode changed');
    }
  }
  if(context.regression){assertRegressionContext(context.regression);ensure(context.regression.passingCandidate.digest===context.current.candidate.digest,'Inherited regression positive differs');}
  if(context.maintenance){assertMaintenanceContext(context.maintenance);ensure(canonical(context.maintenance.basis.base)===canonical(context.base)&&context.maintenance.basis.contractDigest===controlDigest(context.current.contract)&&context.maintenance.basis.passingCandidate.digest===context.current.candidate.digest,'Maintenance author target differs');}
  return structuredClone(context);
}
export async function captureControlEvolutionContext(input: Omit<ControlEvolutionAuthoringContext, 'schemaVersion' | 'historyText'>): Promise<ControlEvolutionAuthoringContext> {
  safeControlJSON(input);
  const definitions: Record<string, Record<string, string>> = {}; let size = 0;
  for (const entry of input.history.definitions) {
    await assertDefinition(entry.definition.spec, entry.bundle, false);
    const files: Record<string, string> = {};
    for (const name of Object.keys(entry.bundle.files)) {
      const bytes = await readFile(await relativeFile(entry.bundle.directory, name)); size += bytes.length;
      ensure(size <= 1_000_000, 'Complete historical detector text exceeds capacity');
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      ensure(!value.includes('\0') && digest(bytes) === entry.bundle.files[name], 'Historical detector changed or needs binary support'); files[name] = value;
    }
    definitions[entry.definition.definitionDigest] = files;
  }
  const specimens = await specimenText(input.history.specimens, 1_000_000), specimenModes: Record<string, Record<string, number>> = {};
  for (const specimen of input.history.specimens) {
    const modes: Record<string, number> = {};
    for (const name of Object.keys(specimen.candidate.files)) modes[name] = (await lstat(await relativeFile(specimen.candidate.tree, name))).mode & 0o111;
    specimenModes[key(specimen.revision.ref)] = modes;
  }
  return frozen({ schemaVersion: 1, ...structuredClone(input), historyText: { definitions, specimens, specimenModes } });
}
function historicalCases(context: ControlEvolutionAuthoringContext): VerificationSpecCase[] {
  const cases = new Map<string, VerificationSpecCase>();
  for (const entry of context.history.definitions) for (const item of entry.definition.spec.cases) {
    const id = `${item.id}:${item.revision}`, previous = cases.get(id);
    ensure(!previous || canonical(previous) === canonical(item), 'Published case revision changed across history'); cases.set(id, item);
  }
  return [...cases.values()];
}
function frontier(context: ControlEvolutionAuthoringContext): string[] {
  return context.history.manifest?.entries.filter(e => e.disposition === 'current').map(e => key(e.specimen)) ?? [];
}
export function controlEvolutionContextDigest(context: ControlEvolutionAuthoringContext): string { return controlDigest(frozen(context)); }
export function controlEvolutionAuthoringSchema(input: ControlEvolutionAuthoringContext): Record<string, unknown> {
  const context = frozen(input), keys = frontier(context), ref = keys.length ? { type: 'string', enum: keys } : { type: 'null' };
  return validateReasonerSchema(object({
    ...((context.maintenance||context.regression)?{maintenance:object({regressions:{...array(object({defectRef:{type:'string',enum:(context.maintenance?.basis.sources??context.regression!.sources).map(s=>s.defectRef)},caseId:text,revision:{type:'integer',minimum:1},parameters:{anyOf:[object({}),...(context.maintenance?.basis.sources??context.regression!.sources).map(s=>object(Object.fromEntries(Object.entries(s.instance.parameters).map(([k,v])=>[k,{type:'string',const:v}]))))]}})),minItems:(context.maintenance?.basis.sources??context.regression!.sources).length,maxItems:(context.maintenance?.basis.sources??context.regression!.sources).length},reason:text})}:{}),
    contextDigest: { type: 'string', const: controlDigest(context) }, assets: currentAcceptanceAssetSchema(context.current, historicalCases(context)),
    plan: object({
      controlPlan: { ...array(object({ controlId: text, kind: { type: 'string', enum: ['positive-full', 'negative'] }, predecessorKey: { anyOf: [ref, { type: 'null' }] } }), 32), minItems: 2 },
      historyPlan: { ...array(object({ specimenKey: keys.length ? ref : text, successorControlId: { anyOf: [text, { type: 'null' }] }, retireObligationIds: array(text) })), minItems: keys.length, maxItems: keys.length },
      evolutionExplanation: text,
    }),
  }));
}
export function validateControlEvolutionBundle(value: unknown, input: ControlEvolutionAuthoringContext): ControlEvolutionBundle {
  const context = frozen(input); safeControlJSON(value);
  const bundle = parseReasonerOutput(JSON.stringify(value), controlEvolutionAuthoringSchema(context)) as ControlEvolutionBundle;
  validateCurrentAcceptanceAssets(bundle.assets, context.current, historicalCases(context));
  const plan = bundle.plan, controls = bundle.assets.spec.controls, frontierKeys = frontier(context);
  ensure(plan.controlPlan.length === controls.length && new Set(plan.controlPlan.map(p => p.controlId)).size === controls.length, 'Every current control needs exactly one evolution entry');
  for (const entry of plan.controlPlan) {
    const control = controls.find(c => c.id === entry.controlId);
    ensure(control && (control.expect === 'passed' ? entry.kind === 'positive-full' : entry.kind === 'negative'), 'Control kind differs from executable expectation');
    if (entry.predecessorKey !== null) {
      const old = context.history.specimens.find(s => key(s.revision.ref) === entry.predecessorKey);
      ensure(old && old.revision.kind === entry.kind && frontierKeys.includes(entry.predecessorKey), 'Only the published current frontier can gain a successor');
      ensure(plan.historyPlan.some(p => p.specimenKey === entry.predecessorKey && p.successorControlId === entry.controlId), 'Successor and historical mapping disagree');
    }
  }
  ensure(new Set(plan.historyPlan.map(p => p.specimenKey)).size === frontierKeys.length && plan.historyPlan.every(p => frontierKeys.includes(p.specimenKey)), 'Historical frontier is missing or duplicated');
  for (const entry of plan.historyPlan) {
    ensure(new Set(entry.retireObligationIds).size === entry.retireObligationIds.length, 'Duplicate requested retirement');
    if (entry.successorControlId !== null) ensure(plan.controlPlan.some(p => p.controlId === entry.successorControlId && p.predecessorKey === entry.specimenKey), 'Historical successor mapping disagrees');
    const old = context.history.specimens.find(s => key(s.revision.ref) === entry.specimenKey)!;
    ensure(old && entry.retireObligationIds.every(id => old.revision.scope.some(s => s.obligationId === id)), 'Requested retirement is outside historical scope');
  }
  const maintenanceSpec={...bundle.assets.spec,controls:bundle.assets.spec.controls.map(c=>({...c,workspace:'/authoring-private/controls/'+c.id}))};
  if(context.regression){ensure(bundle.maintenance,'Missing inherited regression mappings');const sources=context.regression.sources;ensure(canonical(bundle.maintenance.regressions.map(m=>m.defectRef).sort())===canonical(sources.map(s=>s.defectRef).sort()),'Inherited regression mappings missing or duplicated');for(const source of sources)maintenanceInstance(maintenanceSpec,bundle.maintenance.regressions.find(m=>m.defectRef===source.defectRef)!,source);}
  if(context.maintenance){ensure(bundle.maintenance,'Missing required regression mappings');const previous=context.history.definitions.find(d=>d.definition.definitionDigest===context.base.baseDefinitionDigest)!;assertMaintenancePlan(context.maintenance.basis,previous.definition.spec,maintenanceSpec,bundle.maintenance);}
  return bundle;
}
export function buildControlEvolutionAuthoringPrompt(input: ControlEvolutionAuthoringContext): string {
  return renderControlEvolutionPrompt(frozen(input));
}
/** New host presentation retains the complete audit context without embedding it twice. */
export function controlEvolutionAuthorInput<T extends {acceptance: AcceptanceAuthoringContext; candidate: unknown; evolution: ControlEvolutionAuthoringContext}>(context:T) {
  frozen(context.evolution);
  return {prompt: CONTROL_EVOLUTION_PRESENTATION_PROMPT_V2, outputSchema: controlEvolutionAuthoringSchema(context.evolution),
    context: {...structuredClone(context), authorPresentation: {schemaVersion:2 as const,kind:'control-evolution' as const}}};
}
/** Controller-owned location. Proposal import must independently verify this
 * declaration against persisted author job, exact base and actual frozen files. */
export async function materializeControlEvolutionBundle(options: { privateRoot: string; jobId: string; context: ControlEvolutionAuthoringContext; bundle: unknown }): Promise<MaterializedControlEvolution> {
  const context = frozen(options.context), bundle = validateControlEvolutionBundle(options.bundle, context);
  const assets = await materializeCurrentAcceptanceAssets({ privateRoot: options.privateRoot, jobId: options.jobId, context: context.current, historicalCases: historicalCases(context), bundle: bundle.assets });
  const root = resolve(options.privateRoot, '.evolution-declarations');
  // The asset materializer already checked every ancestor and canonical workspace
  // exclusion. Keep declarations outside its exact immutable file inventory.
  try { await mkdir(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(root); ensure(stat.isDirectory() && !stat.isSymbolicLink(), 'Unsafe evolution declaration directory');
  ensure(dirname(root) === resolve(options.privateRoot) && root.startsWith(resolve(options.privateRoot) + sep), 'Evolution declaration escaped private root');
  const declarationPath = join(root, options.jobId + '.json');
  const declaration = { schemaVersion: 1, context, bundle, assets }, content = canonical(declaration), declarationDigest = digest(content);
  try { await writeFile(declarationPath, content, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(declarationPath); ensure(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && digest(await readFile(declarationPath)) === declarationDigest, 'Conflicting or tampered evolution declaration');
  return { assets, declarationPath, declarationDigest };
}
