import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TaskClarification,TaskComposer,type TaskComposerProps} from '../../apps/desktop/task-conversation.js';
import type {GoalSession} from '../../packages/contracts/p5.js';
const session:GoalSession={id:'goal',projectId:'p',workspace:'/p',workspaceKind:'project',revision:1,goal:'Research',phase:'clarifying',messages:[],jobs:[],proposal:{decision:'clarify',summary:'Need detail',questions:['哪个行业？','融资时间？'],facts:[],constraints:[],style:[],criteria:[],steps:[]},runtimeId:null,error:null,createdAt:'2026-10-12',updatedAt:'2026-10-12',config:{model:'unused',effort:'low',reservation:1,timeoutMs:1000},maxContextChars:60000};
test('task clarification renders concrete numbered questions without collapsed details and hides stale questions',()=>{
  const html=renderToStaticMarkup(React.createElement(TaskClarification,{session,conversation:null}));
  assert.match(html,/需要你补充的信息/);assert.match(html,/<ol><li>哪个行业？<\/li><li>融资时间？<\/li><\/ol>/);assert.doesNotMatch(html,/<details/);
  assert.equal(renderToStaticMarkup(React.createElement(TaskClarification,{session:{...session,phase:'thinking'},conversation:null})),'');
  assert.match(renderToStaticMarkup(React.createElement(TaskClarification,{session:{...session,proposal:null},conversation:null})),/暂未读取到/);
});
test('task composer exposes labelled editable input attachment controls and explicit media reading limits',()=>{
  const props:TaskComposerProps={text:'用户补充',attachments:[{name:'intro.mp4',kind:'video',path:'/snapshot',sha256:'a'.repeat(64),size:1024}],disabled:false,canSend:true,sending:false,attaching:false,pending:false,hint:'',error:'',kind:'unclassified',clarifying:true,onText(){},onKind(){},onAttach(){},onRemove(){},onSend(){}};
  const html=renderToStaticMarkup(React.createElement(TaskComposer,props));
  assert.match(html,/aria-label="任务消息"/);assert.match(html,/用户补充/);assert.match(html,/发送补充信息/);assert.match(html,/添加图片 \/ 视频 \/ 文件/);assert.match(html,/待执行阶段提取/);assert.match(html,/移除附件 intro.mp4/);assert.doesNotMatch(html,/disabled=""/);
  const pending=renderToStaticMarkup(React.createElement(TaskComposer,{...props,disabled:true,canSend:true,pending:true,error:'提交待核对'}));
  assert.match(pending,/重试同一条消息/);assert.match(pending,/提交待核对/);assert.match(pending,/disabled=""/);assert.match(pending,/用户补充/);
});
