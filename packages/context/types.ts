export interface MemorySource { kind: 'user' | 'model' | 'evidence'; ref: string }
export type MemoryScope = { level: 'project' } | { level: 'module'; module: string } | { level: 'submodule'; module: string; submodule: string };
export interface MemoryValidity { taskId?: string; contractVersion?: number; environmentDigest?: string; preferenceVersion?: number; expiresAt?: string }
export interface MemoryInput {
  id: string; scope: MemoryScope; kind: 'fact' | 'preference' | 'interface' | 'constraint' | 'failure';
  text: string; summary?: string; key?: string; attribution: 'explicit' | 'inferred'; sources: MemorySource[]; validity?: MemoryValidity;
}
export interface MemoryRecord extends MemoryInput {
  revision: number; updatedAt: string; status: 'active' | 'invalid'; invalidation?: { reason: string; sources: MemorySource[] };
  rawRef: string; digest: string;
}
export type MemoryChange = { type: 'upsert'; record: MemoryInput } | { type: 'invalidate'; id: string; reason: string; sources: MemorySource[] };
export interface MemoryProposalInput { baseVersion: number; reason: string; changes: MemoryChange[] }
export interface MemoryProposal extends MemoryProposalInput { id: string; projectId: string; createdAt: string; digest: string }
export interface MemorySnapshot { projectId: string; version: number; digest: string; records: MemoryRecord[] }
export interface ContextRequirement { id: string; text: string; sources: MemorySource[] }
export interface ContextContract {
  version: number; goal: string; sources: MemorySource[];
  requiredCriteria: ContextRequirement[]; constraints: ContextRequirement[];
}
export interface ContextInput {
  contract: ContextContract; taskId?: string; currentRequirements?: ContextRequirement[]; module?: string; submodule?: string;
  dependencies?: MemoryScope[]; requiredMemoryIds?: string[]; environmentDigest?: string; preferenceVersion?: number;
  maxChars: number; outputReserveChars?: number; now?: string;
}
export interface ContextEntry {
  id: string; kind: MemoryInput['kind']; scope: MemoryScope; text: string; rawRef: string; digest: string;
  attribution: MemoryInput['attribution']; sources: MemorySource[]; representation: 'text' | 'summary'; required: boolean;
}
export interface ContextManifest {
  id: string; projectId: string; taskId?: string; memoryVersion: number; memoryDigest: string; contractVersion: number; contractDigest: string;
  createdAt: string; maxChars: number; outputReserveChars: number; inputChars: number; digest: string; text: string;
  contract: ContextContract; currentRequirements: ContextRequirement[]; entries: ContextEntry[];
  excluded: { id: string; reason: string }[]; path: string;
}
