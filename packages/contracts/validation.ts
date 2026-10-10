import type { Command, CreateRunInput, Query, RunAction } from './p1.js';

type Shape = Record<string, unknown>;
function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
function object(value: unknown, path: string, keys?: string[], optional: string[] = []): Shape {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !('value' in descriptors[key]!)) fail(path, 'accessors and symbols are forbidden');
    if (!descriptors[key]!.enumerable) fail(path, 'nonenumerable fields are forbidden');
    if (keys && !keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
  }
  if (keys) for (const key of keys) if (!optional.includes(key) && !Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required field');
  return value as Shape;
}
function string(value: unknown, path: string, empty = false): void {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0')) fail(path, 'must be a nonempty string without NUL');
}
function number(value: unknown, path: string, minimum = 0, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) fail(path, 'must be a finite nonnegative number in range');
}
function bool(value: unknown, path: string): void { if (typeof value !== 'boolean') fail(path, 'must be boolean'); }
function choice(value: unknown, path: string, choices: string[]): void { if (!choices.includes(value as string)) fail(path, 'invalid value'); }
function array(value: unknown, path: string, check: (item: unknown, path: string) => void): void {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || !('value' in descriptor) || !descriptor.enumerable) fail(path, 'array fields must be plain enumerable indices');
  }
  for (let i = 0; i < value.length; i++) { if (!Object.hasOwn(value, i)) fail(path, 'sparse arrays are forbidden'); check(value[i], `${path}[${i}]`); }
}
const strings = (v: unknown, p: string): void => array(v, p, string);
function contract(v: unknown, p: string): void {
  const o = object(v, p, ['version', 'goal', 'criteria']); number(o.version, `${p}.version`, 1, true); string(o.goal, `${p}.goal`);
  array(o.criteria, `${p}.criteria`, (v, p) => { const o = object(v, p, ['id', 'description', 'required']); string(o.id, `${p}.id`); string(o.description, `${p}.description`); bool(o.required, `${p}.required`); });
}
function input(v: unknown, p: string): void {
  const o = object(v, p, ['id', 'projectId', 'contract', 'nodes', 'budget']); string(o.id, `${p}.id`); string(o.projectId, `${p}.projectId`); contract(o.contract, `${p}.contract`);
  array(o.nodes, `${p}.nodes`, (v, p) => { const o = object(v, p, ['id', 'dependencies', 'required']); string(o.id, `${p}.id`); strings(o.dependencies, `${p}.dependencies`); bool(o.required, `${p}.required`); });
  const b = object(o.budget, `${p}.budget`, ['limit', 'verificationReserve', 'unit'], ['unit']); number(b.limit, `${p}.budget.limit`, 0, true); number(b.verificationReserve, `${p}.budget.verificationReserve`, 0, true);
  if (b.unit !== undefined) choice(b.unit, `${p}.budget.unit`, ['work-unit', 'token']);
  if ((b.verificationReserve as number) > (b.limit as number)) fail(`${p}.budget`, 'verification reserve exceeds limit');
}
function artifact(v: unknown, p: string): void {
  const o = object(v, p, ['id', 'digest', 'path', 'contractVersion']); for (const k of ['id', 'digest', 'path']) string(o[k], `${p}.${k}`); number(o.contractVersion, `${p}.contractVersion`, 1, true);
}
function evidence(v: unknown, p: string): void {
  const o = object(v, p, ['id', 'criterionId', 'contractVersion', 'artifactDigest', 'verdict', 'verifierVersion']);
  for (const k of ['id', 'criterionId', 'artifactDigest', 'verifierVersion']) string(o[k], `${p}.${k}`); number(o.contractVersion, `${p}.contractVersion`, 1, true); choice(o.verdict, `${p}.verdict`, ['passed', 'failed', 'unknown']);
}
function action(v: unknown, p: string): void {
  const t = object(v, p).type;
  let keys: string[];
  switch (t) {
    case 'startAttempt': keys = ['type', 'attemptId', 'nodeId', 'contractVersion', 'reservation', 'purpose', 'resources', 'futureVerificationAllocationId']; break;
    case 'finishAttempt': keys = ['type', 'attemptId', 'outcome']; break;
    case 'settleAttempt': keys = ['type', 'attemptId', 'actual']; break;
    case 'setOperation': keys = ['type', 'operationId', 'attemptId', 'status']; break;
    case 'releaseLease': keys = ['type', 'resource', 'attemptId']; break;
    case 'pause': case 'resume': case 'cancel': case 'complete': keys = ['type']; break;
    case 'admit': keys = ['type', 'contract', 'nodes']; break;
    case 'revisePlan': keys = ['type', 'contract', 'nodes', 'reason']; break;
    case 'appendRepairNodes': keys = ['type', 'contractVersion', 'nodes', 'reason', 'failureJobId', 'failedObligationIds']; break;
    case 'setFutureVerification': keys = ['type', 'contractVersion', 'allocationId', 'amount', 'reason']; break;
    case 'replaceContract': keys = ['type', 'contract']; break;
    case 'recordEvidence': keys = ['type', 'evidence']; break;
    case 'setArtifact': keys = ['type', 'artifact']; break;
    default: fail(`${p}.type`, 'unknown action');
  }
  const o = object(v, p, keys, t === 'startAttempt' ? ['futureVerificationAllocationId'] : []);
  for (const k of ['attemptId', 'nodeId', 'operationId', 'resource']) if (keys.includes(k)) string(o[k], `${p}.${k}`);
  if (t === 'startAttempt') { number(o.contractVersion, `${p}.contractVersion`, 1, true); number(o.reservation, `${p}.reservation`, 0, true); choice(o.purpose, `${p}.purpose`, ['execution', 'verification', 'reasoning', 'inspection']); strings(o.resources, `${p}.resources`); }
  if (t === 'startAttempt' && Object.hasOwn(o, 'futureVerificationAllocationId')) string(o.futureVerificationAllocationId, `${p}.futureVerificationAllocationId`);
  if (t === 'finishAttempt') choice(o.outcome, `${p}.outcome`, ['succeeded', 'failed', 'cancelled']);
  if (t === 'settleAttempt') number(o.actual, `${p}.actual`, 0, true);
  if (t === 'setOperation') choice(o.status, `${p}.status`, ['pending', 'confirmed', 'unknown']);
  if (t === 'admit' || t === 'revisePlan') input({id:'admit',projectId:'admit',contract:o.contract,nodes:o.nodes,budget:{limit:1,verificationReserve:0}},p);
  if (t === 'revisePlan') string(o.reason, `${p}.reason`);
  if (t === 'appendRepairNodes') {
    number(o.contractVersion, `${p}.contractVersion`, 1, true); string(o.reason, `${p}.reason`); string(o.failureJobId, `${p}.failureJobId`); strings(o.failedObligationIds, `${p}.failedObligationIds`);
    array(o.nodes, `${p}.nodes`, (v,p) => {const n=object(v,p,['id','dependencies','required']);string(n.id,`${p}.id`);strings(n.dependencies,`${p}.dependencies`);bool(n.required,`${p}.required`);});
  }
  if (t === 'setFutureVerification') {number(o.contractVersion, `${p}.contractVersion`, 1, true);string(o.allocationId, `${p}.allocationId`);number(o.amount, `${p}.amount`, 0, true);string(o.reason, `${p}.reason`);}
  if (t === 'replaceContract') contract(o.contract, `${p}.contract`);
  if (t === 'recordEvidence') evidence(o.evidence, `${p}.evidence`);
  if (t === 'setArtifact') artifact(o.artifact, `${p}.artifact`);
}
function evidenceRefs(value: unknown, path: string): void {
  const seen = new Set<string>();
  array(value, path, (v, p) => {
    const o = object(v, p, ['runId', 'artifactId']); string(o.runId, `${p}.runId`); string(o.artifactId, `${p}.artifactId`);
    const key = JSON.stringify([o.runId, o.artifactId]); if (seen.has(key)) fail(p, 'duplicate evidence reference'); seen.add(key);
  });
}
export function validateVerificationChangeShape(v: unknown): void {
  const p = 'change'; const o = object(v, p, ['id', 'baseVersion', 'reason', 'cases', 'status', 'evidenceRefs'], ['evidenceRefs']); string(o.id, `${p}.id`); string(o.reason, `${p}.reason`); number(o.baseVersion, `${p}.baseVersion`, 0, true); choice(o.status, `${p}.status`, ['proposed', 'published', 'rejected']);
  if (Object.hasOwn(o, 'evidenceRefs')) evidenceRefs(o.evidenceRefs, `${p}.evidenceRefs`);
  array(o.cases, `${p}.cases`, (v, p) => { const o = object(v, p, ['id', 'revision', 'criterionIds', 'definition', 'status', 'replaces', 'defectRefs']); string(o.id, `${p}.id`); number(o.revision, `${p}.revision`, 1, true); strings(o.criterionIds, `${p}.criterionIds`); string(o.definition, `${p}.definition`); choice(o.status, `${p}.status`, ['active', 'retired']); strings(o.replaces, `${p}.replaces`); strings(o.defectRefs, `${p}.defectRefs`); });
}
export function validateVerificationPlanShape(v: unknown): void {
  const p = 'plan'; const o = object(v, p, ['id', 'catalogVersion', 'contractVersion', 'artifactDigest', 'cases', 'evidenceRefs'], ['evidenceRefs']); string(o.id, `${p}.id`); number(o.catalogVersion, `${p}.catalogVersion`, 1, true); number(o.contractVersion, `${p}.contractVersion`, 1, true); string(o.artifactDigest, `${p}.artifactDigest`);
  if (Object.hasOwn(o, 'evidenceRefs')) evidenceRefs(o.evidenceRefs, `${p}.evidenceRefs`);
  array(o.cases, `${p}.cases`, (v, p) => { const o = object(v, p, ['id', 'revision', 'parameters']); string(o.id, `${p}.id`); number(o.revision, `${p}.revision`, 1, true); const params = object(o.parameters, `${p}.parameters`); for (const [k, v] of Object.entries(params)) { string(k, `${p}.parameter key`); string(v, `${p}.parameters.${k}`, true); } });
}
export function parseCreateRunInput(v: unknown): CreateRunInput { input(v, 'input'); return structuredClone(v) as CreateRunInput; }
export function parseRunAction(v: unknown): RunAction { action(v, 'action'); return structuredClone(v) as RunAction; }
export function parseCommand(v: unknown): Command {
  const t = object(v, 'command').type;
  const fields: Record<string, string[]> = {
    createProject: ['project'], createRun: ['input'], act: ['projectId', 'runId', 'expectedRevision', 'action'], publishArtifact: ['projectId', 'runId', 'expectedRevision', 'artifactId', 'content'],
    proposeVerificationChange: ['projectId', 'change'], publishVerificationChange: ['projectId', 'changeId', 'baseVersion'], freezeVerificationPlan: ['projectId', 'runId', 'plan'],
  };
  if (typeof t !== 'string' || !Object.hasOwn(fields, t)) fail('command.type', 'unknown command');
  const o = object(v, 'command', ['commandId', 'type', ...fields[t]!]); string(o.commandId, 'command.commandId');
  for (const k of ['projectId', 'runId', 'artifactId', 'changeId']) if (Object.hasOwn(o, k)) string(o[k], `command.${k}`);
  if (Object.hasOwn(o, 'expectedRevision')) number(o.expectedRevision, 'command.expectedRevision', 0, true);
  if (t === 'createProject') { const project = object(o.project, 'command.project', ['id', 'name']); string(project.id, 'command.project.id'); string(project.name, 'command.project.name'); }
  if (t === 'createRun') input(o.input, 'command.input');
  if (t === 'act') action(o.action, 'command.action');
  if (t === 'publishArtifact') string(o.content, 'command.content', true);
  if (t === 'proposeVerificationChange') validateVerificationChangeShape(o.change);
  if (t === 'publishVerificationChange') number(o.baseVersion, 'command.baseVersion', 0, true);
  if (t === 'freezeVerificationPlan') validateVerificationPlanShape(o.plan);
  return structuredClone(v) as Command;
}
export function parseQuery(v: unknown): Query {
  const t = object(v, 'query').type;
  const fields: Record<string, string[]> = { projects: [], runs: ['projectId'], run: ['projectId', 'runId'], events: ['after', 'projectId'], catalog: ['projectId'], changes: ['projectId'], plans: ['projectId', 'runId'] };
  if (typeof t !== 'string' || !Object.hasOwn(fields, t)) fail('query.type', 'unknown query');
  const o = object(v, 'query', ['type', ...fields[t]!]);
  for (const k of fields[t]!) { if (k === 'after') number(o[k], `query.${k}`, 0, true); else string(o[k], `query.${k}`); }
  return structuredClone(v) as Query;
}
