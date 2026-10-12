import type { NormalizedEvent } from '../executor-codex/index.js';

export interface ReasonerEventState {
  threadId: string | null; turnId: string | null; usage: number | null;
  terminalStatus: string | undefined; completedMessages: string[];
}
export function createReasonerEventState(): ReasonerEventState {
  return { threadId: null, turnId: null, usage: null, terminalStatus: undefined, completedMessages: [] };
}
/** Observed cumulative tokens can settle only after an authoritative turn end. */
export function finalizeReasonerUsage(state: ReasonerEventState): number | null {
  return state.terminalStatus ? state.usage : null;
}
/** Real normalized protocol reduction; unit event inputs do not replace live evidence. */
export function reduceReasonerEvent(state: ReasonerEventState, event: NormalizedEvent, webSearch: 'live'|'disabled' = 'disabled'): { usageChanged: boolean; finished: boolean } {
  if (event.threadId && state.threadId && state.threadId !== event.threadId) throw new Error('Reasoner event belongs to another thread');
  if (event.turnId && state.turnId && state.turnId !== event.turnId) throw new Error('Reasoner event belongs to another turn');
  if (event.kind === 'waiting' || event.kind === 'server-request') throw new Error('Reasoner cannot request approval, user input or tool actions');
  if (event.kind === 'protocol-error') throw new Error('Reasoner protocol failed');
  if (event.kind === 'disconnected' && !state.terminalStatus) throw new Error('Reasoner disconnected before authoritative completion');
  if (event.kind === 'error' && !event.willRetry) throw new Error('Reasoner turn failed; authoritative completion unresolved');
  if (event.method === 'item/started' || event.method === 'item/completed') {
    const params = event.raw.params as { item?: { type?: string } } | undefined;
    const type = params?.item?.type;
    if (!type || !['agentMessage', 'reasoning', 'userMessage', 'plan', 'contextCompaction'].includes(type) && !(type === 'webSearch' && webSearch === 'live')) throw new Error(`Reasoner requested prohibited or unknown action: ${type ?? 'missing item type'}`);
  }
  let usageChanged = false;
  if (event.tokenUsage) {
    const usage = event.tokenUsage.total.totalTokens;
    if (!Number.isSafeInteger(usage) || usage < 0 || state.usage !== null && usage < state.usage) throw new Error('Reasoner token usage invalid or regressed');
    usageChanged = usage !== state.usage; state.usage = usage;
  }
  if (event.threadId) state.threadId = event.threadId;
  if (event.turnId) state.turnId = event.turnId;
  if (event.method === 'item/completed' && event.text !== undefined) state.completedMessages.push(event.text);
  if (event.kind === 'turn-status' && event.terminal) {
    if (!['completed', 'failed', 'interrupted'].includes(event.status ?? '')) throw new Error('Reasoner terminal status is unknown');
    if (state.terminalStatus && state.terminalStatus !== event.status) throw new Error('Reasoner terminal status conflicts');
    state.terminalStatus = event.status;
  }
  return { usageChanged, finished: !!state.terminalStatus };
}
