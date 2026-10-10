/** P2 controls one real attempt. Execution completion is not product acceptance. */
export type ExecutionState = 'queued' | 'starting' | 'running' | 'waiting' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'unknown';
export interface ExecutionStart {
  type: 'start'; commandId: string; workspace?: string; prompt: string;
  model: string; effort: string; timeoutMs: number;
  tokenLimit: number; reservation: number; verificationReserve: number; images?: string[];
}
/** Controller-resolved input; workspace ownership is never accepted from an IPC caller. */
export interface ResolvedExecutionStart extends ExecutionStart {
  workspace: string; workspaceKind: 'project' | 'managed';
}
export interface TokenUsage {
  inputTokens: number; cachedInputTokens: number; outputTokens: number;
  reasoningOutputTokens: number; totalTokens: number;
}
export interface ExecutionRecord {
  id: string; commandId: string; projectId: string; runId: string; attemptId: string;
  workspace: string; workspaceKind: 'project' | 'managed'; prompt: string; model: string; effort: string; images: string[];
  state: ExecutionState; createdAt: string; updatedAt: string; deadline: string;
  timeoutMs: number; tokenLimit: number; reservation: number; verificationReserve: number;
  identity: unknown; pid: number | null; threadId: string | null; turnId: string | null;
  lastEventSeq: number; message: string; diff: string; error: string | null;
  usage: TokenUsage | null; usageStatus: 'unknown' | 'reported';
  stopConfirmed: boolean; cancelRequested: boolean; artifactId: string | null;
  protocolVersion: string | null; schemaDigest: string | null;
}
export interface ExecutionEvent {
  seq: number; executionId: string; receivedAt: string; kind: string; payload: unknown;
}
export interface ModelCapability {
  id: string; label: string; inputModalities: string[]; reasoningEfforts: string[]; defaultEffort: string;
}
export interface ExecutorCapabilities {
  version: string; schemaDigest: string; models: ModelCapability[];
  imageInput: boolean; checkedAt: string;
}
export type ExecutionAction = ExecutionStart
  | { type: 'list' | 'capabilities' }
  | { type: 'inspect' | 'cancel' | 'reconcile'; executionId: string }
  | { type: 'events'; executionId: string; after: number };

export function parseExecutionAction(value: unknown): ExecutionAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Execution action must be an object');
  const o = value as Record<string, unknown>;
  const type = o.type;
  const fields: Record<string, string[]> = {
    start: ['type', 'commandId', 'workspace', 'prompt', 'model', 'effort', 'timeoutMs', 'tokenLimit', 'reservation', 'verificationReserve', 'images'],
    list: ['type'], capabilities: ['type'], inspect: ['type', 'executionId'], cancel: ['type', 'executionId'], reconcile: ['type', 'executionId'], events: ['type', 'executionId', 'after'],
  };
  if (typeof type !== 'string' || !Object.hasOwn(fields, type)) throw new Error('Unknown execution action');
  for (const key of Object.keys(o)) if (!fields[type]!.includes(key)) throw new Error(`Unknown execution field ${key}`);
  for (const key of fields[type]!) {
    if (key === 'images') continue;
    if (key === 'workspace' && (!Object.hasOwn(o, key) || typeof o[key] === 'string' && !(o[key] as string).trim())) continue;
    if (!Object.hasOwn(o, key)) throw new Error(`Missing execution field ${key}`);
    if (['after', 'timeoutMs', 'tokenLimit', 'reservation', 'verificationReserve'].includes(key)) {
      if (!Number.isSafeInteger(o[key]) || (o[key] as number) < 0) throw new Error(`Invalid ${key}`);
    } else if (typeof o[key] !== 'string' || !(o[key] as string).trim() || (o[key] as string).includes('\0')) throw new Error(`Invalid ${key}`);
  }
  if (type === 'start') {
    if ((o.timeoutMs as number) < 1000 || (o.timeoutMs as number) > 3_600_000) throw new Error('timeoutMs must be between 1000 and 3600000');
    if ((o.reservation as number) < 1 || (o.reservation as number) + (o.verificationReserve as number) > (o.tokenLimit as number)) throw new Error('Budget cannot cover the attempt and protected verification reserve');
    if ((o.prompt as string).length > 200_000 || (o.commandId as string).length > 200) throw new Error('Execution input too long');
    if (o.images !== undefined && (!Array.isArray(o.images) || o.images.length > 5 || o.images.some(x => typeof x !== 'string' || !x.trim() || x.includes('\0')))) throw new Error('Invalid images');
  }
  const action = structuredClone(value) as ExecutionAction;
  if (action.type === 'start' && action.workspace !== undefined && !action.workspace.trim()) delete action.workspace;
  return action;
}
