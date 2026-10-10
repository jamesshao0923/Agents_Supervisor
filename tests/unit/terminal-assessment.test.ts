import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationMessage } from '../../packages/contracts/p6.js';
import { parseConversationAction } from '../../packages/contracts/p6-actions.js';
import { validateTerminalAssessment, TERMINAL_ASSESSMENT_SCHEMA } from '../../packages/orchestration/terminal-assessment.js';

function message(kind:ConversationMessage['kind']='unclassified'):ConversationMessage {
  return {id:'message',conversationId:'conversation',sequence:1,commandId:'command',kind,source:'user',text:'Explain progress',receivedRunId:'delivered',receivedContractVersion:2,createdAt:'2026-10-10',state:'processing',processing:null,processingHistory:[],response:null,appliedContractVersion:null,history:[]};
}
test('P6-TERM-U01 terminal assessment schema carries no plan or authority; explicit inquiries cannot request continuation',()=>{
  const answer={decision:'answer',response:'Recorded status',questions:[]};assert.deepEqual(validateTerminalAssessment(answer,message('question'),[]),answer);
  assert.throws(()=>validateTerminalAssessment({...answer,decision:'continue'},message('question'),[]),/Explicit question/);
  assert.throws(()=>validateTerminalAssessment({...answer,proposal:{}},message(),[]));
  assert.throws(()=>validateTerminalAssessment({...answer,response:' '},message(),[]),/nonblank/);
  assert.ok(!JSON.stringify(TERMINAL_ASSESSMENT_SCHEMA).includes('uniqueItems'));
});
test('P6-TERM-U02 clarification and actual-change ancestors preserve unresolved intent until an executable followup is planned',()=>{
  assert.throws(()=>validateTerminalAssessment({decision:'answer',response:'Done',questions:[]},message(),[message('change')]),/Explicit change/);
  assert.throws(()=>validateTerminalAssessment({decision:'clarify',response:'Need input',questions:[]},message(),[]),/concrete/);
  const clarification={decision:'clarify',response:'Which behavior?',questions:['What do you want added?']};assert.deepEqual(validateTerminalAssessment(clarification,message(),[]),clarification);
  assert.throws(()=>validateTerminalAssessment({...clarification,decision:'continue'},message(),[]),/concrete/);
});
test('P6-TERM-U03 cancellation binds the exact assessment identity and rejects caller supplied accounting',()=>{
  const action={type:'cancelAssessment',conversationId:'conversation',messageId:'message',assessmentId:'assessment-1'};assert.deepEqual(parseConversationAction(action),action);
  assert.throws(()=>parseConversationAction({type:'cancelAssessment',conversationId:'conversation',messageId:'message'}),/assessmentId/);
  assert.throws(()=>parseConversationAction({...action,usage:0}),/Unknown conversation field/);
});
