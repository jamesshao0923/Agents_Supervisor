import type { GoalProposal, GoalSession, ReasonerConfig } from './p5.js';
import type { Run } from './p1.js';
import type { ProcessIdentity, ProcessIntent } from '../process-control/index.js';

export interface CriterionRetirementSource { criterionId: string; messageId: string; quote: string }
export interface FollowupProposal {
  decision: 'answer' | 'clarify' | 'revise';
  response: string;
  proposal: GoalProposal | null;
  retiredCriterionIds: string[];
  retirementSources: CriterionRetirementSource[];
}

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
  replyToMessageId?:string;
}
export interface ConversationProcessing {
  attempt:number; runId:string; baseContractVersion:number; throughSequence:number; startedAt:string;
}
export interface ConversationMessage {
  id:string; conversationId:string; sequence:number; commandId:string; source:'user';
  kind:ConversationMessageKind; text:string; receivedRunId:string; receivedContractVersion:number;
  replyToMessageId?:string;
  createdAt:string; state:ConversationMessageState; processing:ConversationProcessing|null;
  processingHistory:ConversationProcessing[]; response:string|null; appliedContractVersion:number|null;
  history:{state:ConversationMessageState; at:string; reason:string|null}[];
}
export interface ConversationBudget {
  limit:number; spent:number; reserved:number; remaining:number; available:number;
  reasoningSpent:number; reasoningReserved:number;
  rounds:{runId:string; limit:number; spent:number; reserved:number; status:string}[];
}
export interface ConversationChildAuthorization {
  conversationId:string; projectId:string; workspace:string; predecessorRunId:string;
  predecessorDeliveryId:string; tokenLimit:number; verificationReserve:number;
}

/** These costs belong to the conversation, never to an immutable delivered Run. */
export interface TerminalAssessmentResult {decision:'answer'|'clarify'|'continue';response:string;questions:string[]}
export interface AssessmentPromotion {
  childRunId:string; childSessionId:string; childProcessingAttempt:number; childBaseContractVersion:number;
  parents:{id:string;processing:ConversationProcessing}[]; promotedAt:string;
}
export interface TerminalAssessmentJob {
  id:string; conversationId:string; messageId:string; processingAttempt:number;
  sessionId:string; runId:string; baseContractVersion:number; messageSequence:number;
  relatedMessageIds:string[]; workspace:string; config:ReasonerConfig; maxContextChars:number;
  input:{session:GoalSession;run:Run;messages:ConversationMessage[];budget:ConversationBudget};
  status:'running'|'finished'; startedAt:string; finishedAt:string|null;
  intents:ProcessIntent[];identities:ProcessIdentity[];modelStarted:boolean;observedUsage:number|null;
  usage:number|null;reportedUsage:number|null;stopConfirmed:boolean;settled:boolean;proofs:Record<string,string>;threadId:string|null;
  result:TerminalAssessmentResult|null;error:string|null;cancelRequested:boolean;publishedAt:string|null;
  promotion:AssessmentPromotion|null; finishRequest:string|null;
}
