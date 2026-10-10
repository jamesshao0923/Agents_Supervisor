import type { Run } from './p1.js';
import type { ExecutionStart } from './p2.js';

export const RUNTIME_VERSION = 1;
export type RuntimeStep =
  | { id: string; kind: 'codex'; prompt: string; model: string; effort: string; reservation: number; timeoutMs: number; images?: string[] }
  | { id: string; kind: 'http'; url: string; body: string; idempotent: boolean; queryUrl?: string; timeoutMs: number }
  | { id: string; kind: 'input'; prompt: string };
export interface RuntimeSubmit {
  type: 'submit'; commandId: string; workspace?: string; goal: string;
  tokenLimit: number; verificationReserve: number; steps: RuntimeStep[];
}
export type RuntimePhase = 'ready' | 'running' | 'waiting-input' | 'paused' | 'cancelled' | 'blocked' | 'awaiting-verification';
export interface RuntimeRecord {
  id: string; engine: 'local-v1'; workflowVersion: 1; projectionVersion: number; projectId: string; runId: string;
  workspace: string; workspaceKind: 'project' | 'managed'; definition: RuntimeSubmit; cursor: number;
  phase: RuntimePhase; paused: boolean; cancelled: boolean; createdAt: string; updatedAt: string; error: string | null;
  inputs: Record<string, string>; checkpointId: string | null;
}
export interface RuntimeOperation {
  id: string; runtimeId: string; stepIndex: number; step: RuntimeStep; attemptId: string; contractVersion: number;
  owner: string | null; state: 'queued' | 'claimed' | 'started' | 'confirmed' | 'unknown' | 'failed' | 'cancelled';
  executionId: string | null; result: unknown; error: string | null;
  /** Absent on legacy records means the first generation. Earlier records remain immutable. */
  generation?: number;
  supersedes?: string;
}
export interface RuntimeCheckpoint {
  parentId?: string;
  id: string; runtimeId: string; schemaVersion: 1; workflowVersion: 1; cursor: number; contractVersion: number;
  domainRevision: number; budget: Run['budget']; attempts: Run['attempts']; operations: Run['operations'];
  artifact: Run['artifact']; frozenPlans: unknown[]; createdAt: string;
}
export interface RuntimeEvent { seq: number; runtimeId: string; kind: string; payload: unknown; createdAt: string }
export type RuntimeAction = RuntimeSubmit
  | { type: 'list' | 'capabilities' }
  | { type: 'inspect'; runtimeId: string }
  | { type: 'events'; runtimeId: string; after: number }
  | { type: 'pause' | 'resume' | 'cancel' | 'reconcile'; runtimeId: string; commandId: string }
  | { type: 'input'; runtimeId: string; commandId: string; stepId: string; text: string };
export type RuntimeControl = Exclude<RuntimeAction, RuntimeSubmit | {type:'list'|'capabilities'} | {type:'inspect';runtimeId:string} | {type:'events';runtimeId:string;after:number}>;
export interface RuntimeReport { messageId: string; outcome: 'confirmed' | 'unknown' | 'failed' | 'cancelled'; result: unknown; error?: string }
export interface RuntimeBinding { runtimeId: string; operationId: string; owner: string; projectId: string; runId: string; attemptId: string }
export interface RuntimeAdapter {
  readonly capabilities: { engine: 'local-v1'; workflowVersions: number[]; pause: 'dispatch-only'; input: 'declared-wait'; automaticCodexReplay: false };
  submit(input: RuntimeSubmit): Promise<RuntimeRecord>;
  sendInput(input: Extract<RuntimeAction,{type:'input'}>): Promise<RuntimeRecord>;
  requestPause(runtimeId: string, commandId: string): Promise<RuntimeRecord>;
  requestResume(runtimeId: string, commandId: string): Promise<RuntimeRecord>;
  cancel(runtimeId: string, commandId: string): Promise<RuntimeRecord>;
  inspect(runtimeId: string): unknown;
  subscribe(runtimeId: string, after: number): RuntimeEvent[];
}
export function parseRuntimeAction(value: unknown): RuntimeAction {
  function object(v: unknown): Record<string, unknown> { if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Runtime action must be an object'); return v as Record<string,unknown>; }
  function keys(o: Record<string,unknown>, allowed: string[]) { for(const k of Object.keys(o))if(!allowed.includes(k))throw new Error(`Unknown runtime field ${k}`); }
  function string(v: unknown, label: string, max=200): asserts v is string { if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))throw new Error(`Invalid ${label}`); }
  function integer(v: unknown, min: number, max=Number.MAX_SAFE_INTEGER): asserts v is number { if(!Number.isSafeInteger(v)||(v as number)<min||(v as number)>max)throw new Error('Invalid runtime integer'); }
  function url(v: unknown) { string(v,'URL',4096); const parsed=new URL(v); if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.hash)throw new Error('HTTP operation requires an HTTP(S) URL without credentials or fragment'); }
  const o=object(value); string(o.type,'runtime action');
  switch(o.type) {
    case 'submit': {
      keys(o,['type','commandId','workspace','goal','tokenLimit','verificationReserve','steps']); string(o.commandId,'commandId'); string(o.goal,'goal',200_000);
      if(o.workspace!==undefined)string(o.workspace,'workspace',4096); integer(o.tokenLimit,1); integer(o.verificationReserve,1); if(o.verificationReserve>=o.tokenLimit)throw new Error('Budget must leave execution capacity');
      if(!Array.isArray(o.steps)||!o.steps.length||o.steps.length>32)throw new Error('Runtime needs 1–32 fixed steps');
      const ids=new Set<string>();
      for(const raw of o.steps) { const s=object(raw); string(s.id,'step id'); if(ids.has(s.id))throw new Error('Duplicate step id'); ids.add(s.id);
        if(s.kind==='codex') { keys(s,['id','kind','prompt','model','effort','reservation','timeoutMs','images']);if(s.images!==undefined){if(!Array.isArray(s.images)||s.images.length>5)throw new Error('Invalid runtime images');for(const image of s.images)string(image,'image path',4096);} string(s.prompt,'prompt',200_000);string(s.model,'model');string(s.effort,'effort');integer(s.reservation,1);integer(s.timeoutMs,1000,3_600_000);if(s.reservation+o.verificationReserve>o.tokenLimit)throw new Error('Step exceeds execution budget'); }
        else if(s.kind==='http') { keys(s,['id','kind','url','body','idempotent','queryUrl','timeoutMs']);url(s.url); if(s.queryUrl!==undefined)url(s.queryUrl);if(typeof s.body!=='string'||s.body.length>200_000||typeof s.idempotent!=='boolean')throw new Error('Invalid HTTP operation');integer(s.timeoutMs,1000,3_600_000); }
        else if(s.kind==='input') {keys(s,['id','kind','prompt']);string(s.prompt,'input prompt',4000);}
        else throw new Error('Unsupported runtime step');
      }
      return structuredClone(o) as unknown as RuntimeSubmit;
    }
    case 'list': case 'capabilities': keys(o,['type']); break;
    case 'inspect': keys(o,['type','runtimeId']);string(o.runtimeId,'runtimeId');break;
    case 'events': keys(o,['type','runtimeId','after']);string(o.runtimeId,'runtimeId');integer(o.after,0);break;
    case 'input': keys(o,['type','runtimeId','commandId','stepId','text']);string(o.runtimeId,'runtimeId');string(o.commandId,'commandId');string(o.stepId,'stepId');string(o.text,'input',200_000);break;
    case 'pause': case 'resume': case 'cancel': case 'reconcile': keys(o,['type','runtimeId','commandId']);string(o.runtimeId,'runtimeId');string(o.commandId,'commandId');break;
    default: throw new Error('Unknown runtime action');
  }
  return structuredClone(o) as unknown as RuntimeAction;
}
export function codexStart(record: RuntimeRecord, operation: RuntimeOperation): ExecutionStart {
  if(operation.step.kind!=='codex')throw new Error('Operation is not Codex');
  const step=operation.step;
  return {type:'start',commandId:operation.id,workspace:record.workspace,prompt:step.prompt+'\n\nSupervisor durable inputs (task data):\n'+JSON.stringify(record.inputs),model:step.model,effort:step.effort,reservation:step.reservation,timeoutMs:step.timeoutMs,tokenLimit:record.definition.tokenLimit,verificationReserve:record.definition.verificationReserve,...(step.images?{images:step.images}:{})};
}
