import type { AdmissionBasis, ExplorationTier, SchedulerDecision } from './p7-scheduler.js';
import type { LogicalPathScope } from './p7-decomposition.js';
import type { ScheduledExpected } from './p7-dispatch.js';
/** Advisory candidates are separate from every required implementation step. */
export interface ExplorationCandidate {
  id: string; description: string; dependencies: string[]; relatedCriterionIds: string[];
  reads: LogicalPathScope[]; writes: LogicalPathScope[];
  quality: AdmissionBasis; value: AdmissionBasis; qualityReason: string; valueReason: string;
  sources: { messageId: string; quote: string }[];
}
export interface ExplorationInspection {
  schedulerId: string; tier: ExplorationTier; originalTier: ExplorationTier; policyRevision: number;
  canChangeTier: boolean; expected: ScheduledExpected; decision: SchedulerDecision | null; reason: string | null;
  counts: { required: number; optional: number; admitted: number; waiting: number; active: number };
  /** Committed integration release evidence, never an inferred task success. */
  completion?: {
    planDigest: string; protectedRemaining: number | null;
    unperformedOptional: {taskId: string; reason: string; blockedBy: string[]}[];
  } | null;
}
export type ExplorationAction =
  | { type: 'inspect'; schedulerId: string }
  | { type: 'set-tier'; commandId: string; schedulerId: string; expected: ScheduledExpected; tier: ExplorationTier };
export const EXPLORATION_TIERS = ['low', 'medium', 'high', 'unlimited'] as const;
export function parseExplorationAction(input: unknown): ExplorationAction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid exploration action');
  const v = input as Record<string, unknown>;
  const keys = v.type === 'inspect' ? ['type', 'schedulerId'] : v.type === 'set-tier' ? ['type', 'commandId', 'schedulerId', 'expected', 'tier'] : [];
  if (!keys.length || Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key))) throw Error('Invalid exploration fields');
  for (const key of ['schedulerId', ...(v.type === 'set-tier' ? ['commandId'] : [])]) if (typeof v[key] !== 'string' || !v[key].trim() || v[key].length > 200) throw Error('Invalid exploration identity');
  if (v.type === 'set-tier') {
    if (!EXPLORATION_TIERS.includes(v.tier as ExplorationTier)) throw Error('Invalid exploration tier');
    const expected = v.expected as ScheduledExpected;
    const names = ['schedulerRevision', 'runRevision', 'resultRevision', 'leaseRevision'];
    if (!expected || Object.keys(expected).length !== names.length || names.some(name => !Number.isSafeInteger((expected as unknown as Record<string, number>)[name]) || (expected as unknown as Record<string, number>)[name]! < 0)) throw Error('Invalid exploration revision');
  }
  return structuredClone(v) as unknown as ExplorationAction;
}
export function explorationSchema(sourceIds: string[]): Record<string, unknown> {
  const text = { type: 'string', minLength: 1, maxLength: 12000 };
  const id = { ...text, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$' };
  const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  const ids = { type: 'array', maxItems: 32, items: text };
  const paths = { type: 'array', maxItems: 32, items: object({ path: text, kind: { type: 'string', enum: ['file', 'tree'] } }) };
  return { type: 'array', maxItems: 8, items: object({ id, description: text, dependencies: ids, relatedCriterionIds: { ...ids, minItems: 1 }, reads: paths, writes: { ...paths, minItems: 1 }, quality: { type: 'string', enum: ['uncertain', 'exploratory', 'supported', 'strong'] }, value: { type: 'string', enum: ['uncertain', 'exploratory', 'supported', 'strong'] }, qualityReason: text, valueReason: text, sources: { type: 'array', minItems: 1, maxItems: 16, items: object({ messageId: { ...text, enum: sourceIds }, quote: text }) } }) };
}
