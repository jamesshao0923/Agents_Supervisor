export type ConversationMessageKind = 'question' | 'change' | 'unclassified';
export type ConversationMessageState = 'received' | 'waiting' | 'processing' | 'clarifying' | 'applied' | 'answered' | 'failed';
export interface Conversation {
  id:string; projectId:string; workspace:string; firstRunId:string; activeRunId:string;
  activeSessionId:string; authorizedLimit:number; createdAt:string;
}
export interface ConversationRound {
  conversationId:string; ordinal:number; sessionId:string; projectId:string; runId:string;
  predecessorRunId:string|null; predecessorDeliveryId:string|null; createdAt:string;
}
export interface ConversationMessageInput {
  conversationId:string; commandId:string; source:'user'; kind:ConversationMessageKind; text:string;
}
export interface ConversationProcessing {
  attempt:number; runId:string; baseContractVersion:number; throughSequence:number; startedAt:string;
}
export interface ConversationMessage {
  id:string; conversationId:string; sequence:number; commandId:string; source:'user';
  kind:ConversationMessageKind; text:string; receivedRunId:string; receivedContractVersion:number;
  createdAt:string; state:ConversationMessageState; processing:ConversationProcessing|null;
  processingHistory:ConversationProcessing[]; response:string|null; appliedContractVersion:number|null;
  history:{state:ConversationMessageState; at:string; reason:string|null}[];
}
export interface ConversationBudget {
  limit:number; spent:number; reserved:number; remaining:number; available:number;
  rounds:{runId:string; limit:number; spent:number; reserved:number; status:string}[];
}
export interface ConversationChildAuthorization {
  conversationId:string; projectId:string; workspace:string; predecessorRunId:string;
  predecessorDeliveryId:string; tokenLimit:number; verificationReserve:number;
}
