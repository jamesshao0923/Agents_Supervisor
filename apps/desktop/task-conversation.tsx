import React from 'react';
import type { TaskAttachment } from '../../packages/contracts/task-attachments.js';
import type { GoalSession } from '../../packages/contracts/p5.js';
import type { ConversationInspection } from '../../packages/contracts/p6-actions.js';

export function attachmentDescription(file: TaskAttachment): string {
  return file.kind === 'image' ? '图片 · 发送后供视觉分析' : file.kind === 'text' ? '文本 · 分析读取前 12000 字符' : file.kind === 'video' ? '视频 · 已保存，待执行阶段提取画面/音频' : '文件 · 已保存，待执行阶段解析';
}
export function TaskClarification({ session, conversation }: { session: GoalSession | null; conversation: ConversationInspection | null }) {
  const pending = conversation?.messages.findLast(m => m.state === 'clarifying' && !conversation.messages.some(reply => reply.replyToMessageId === m.id));
  const questions = session?.phase === 'clarifying' ? session.proposal?.questions ?? [] : [];
  if (!pending && !questions.length && session?.phase !== 'clarifying') return null;
  return <section className="task-clarification" aria-label="需要你补充的信息">
    <header><strong>需要你补充的信息</strong><span className="pill">等待你的回复</span></header>
    <p>在下方对话框直接回答，可按编号一次补充，也可以添加参考资料。</p>
    {pending ? <p className="clarification-response">{pending.response || '请补充这条消息的具体要求。'}</p> : questions.length ? <ol>{questions.map((q, i) => <li key={i}>{q}</li>)}</ol> : <p>具体问题暂未读取到，请点击「核对需求记录」重新同步；你也可以先补充目标、范围和交付要求。</p>}
  </section>;
}
export interface TaskComposerProps {
  text: string; attachments: TaskAttachment[]; disabled: boolean; canSend: boolean;
  sending: boolean; attaching: boolean; pending: boolean; hint: string; error: string;
  kind: 'question' | 'change' | 'unclassified'; clarifying: boolean;
  onText(text: string): void; onKind(kind: TaskComposerProps['kind']): void;
  onAttach(): void; onRemove(index: number): void; onSend(): void;
}
export function TaskComposer(p: TaskComposerProps) {
  return <form className="task-chat-dock" aria-label="任务对话输入" onSubmit={e => { e.preventDefault(); if(p.canSend) p.onSend(); }}>
    <div className="task-chat-heading"><strong>{p.clarifying ? '回复并补充需求' : '与当前任务对话'}</strong><span>⌘ Enter 发送 · Enter 换行</span></div>
    <label className="field"><span className="sr-only">任务消息</span><textarea aria-label="任务消息" placeholder={p.clarifying ? '在这里回答上方问题，或添加图片、视频和文件作为补充资料…' : '输入补充要求、调整方向，或询问当前进展…'} value={p.text} disabled={p.disabled} onChange={e => p.onText(e.target.value)} maxLength={40000} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if(p.canSend) p.onSend(); } }}/></label>
    {p.attachments.length > 0 && <ul className="task-attachments" aria-label="待发送附件">{p.attachments.map((file, index) => <li key={file.path}><div><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(2)} MB · {attachmentDescription(file)}</small></div><button type="button" className="button ghost" disabled={p.disabled} aria-label={`移除附件 ${file.name}`} onClick={() => p.onRemove(index)}>移除</button></li>)}</ul>}
    {p.error && <p className="validation" role="alert">{p.error}</p>}
    <div className="task-chat-toolbar"><button type="button" className="button" disabled={p.disabled || p.attaching || p.attachments.length >= 10} onClick={p.onAttach}>{p.attaching ? '正在保存附件…' : '＋ 添加图片 / 视频 / 文件'}</button>
      {!p.clarifying && <select aria-label="消息用途" value={p.kind} disabled={p.disabled} onChange={e => p.onKind(e.target.value as TaskComposerProps['kind'])}><option value="unclassified">让主控判断</option><option value="question">仅询问进展</option><option value="change">修改或补充要求</option></select>}
      <button type="submit" className="button primary" disabled={!p.canSend}>{p.sending ? '正在提交…' : p.pending ? '重试同一条消息' : p.clarifying ? '发送补充信息' : '发送消息'}</button></div>
    <p className="task-chat-hint">{p.hint || '最多 10 个附件；单文件 64 MB，图片 8 MB。图片参与视觉分析；视频及其他二进制文件不会被假定已读。'}</p>
  </form>;
}
