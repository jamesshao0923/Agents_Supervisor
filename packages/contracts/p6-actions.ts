import type { GoalInspection } from './p5.js';
import type { Conversation, ConversationBudget, ConversationMessage, ConversationMessageKind, ConversationRound } from './p6.js';

export interface ConversationInspection {
  conversation:Conversation; rounds:ConversationRound[]; messages:ConversationMessage[];
  budget:ConversationBudget; active:GoalInspection;
}
export type ConversationAction =
  | {type:'list'}
  | {type:'inspect';conversationId:string}
  | {type:'forSession';sessionId:string}
  | {type:'send';conversationId:string;commandId:string;kind:ConversationMessageKind;text:string;replyToMessageId?:string}
  | {type:'retry';conversationId:string;messageId:string;reason:string};

/** The transport never accepts model authority, applied state, or a proposed plan. */
export function parseConversationAction(value:unknown):ConversationAction {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid conversation action');
  const v=value as Record<string,unknown>;
  const fields:Record<string,string[]>={list:[],inspect:['conversationId'],forSession:['sessionId'],send:['conversationId','commandId','kind','text','replyToMessageId'],retry:['conversationId','messageId','reason']};
  if(typeof v.type!=='string'||!Object.hasOwn(fields,v.type))throw new Error('Unknown conversation action');
  if(Object.keys(v).some(k=>k!=='type'&&!fields[v.type as string]!.includes(k)))throw new Error('Unknown conversation field');
  for(const key of fields[v.type]!){if(key==='replyToMessageId'&&v[key]===undefined)continue;if(typeof v[key]!=='string'||!(v[key] as string).trim()||(v[key] as string).includes('\0')||(v[key] as string).length>(key==='text'?40000:4096))throw new Error(`Invalid conversation ${key}`);}
  if(v.type==='send'&&!['question','change','unclassified'].includes(v.kind as string))throw new Error('Invalid conversation message kind');
  return structuredClone(v) as unknown as ConversationAction;
}
