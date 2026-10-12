import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { importTaskAttachments, taskAttachmentContext, verifyTaskAttachment } from '../../packages/workspace/task-attachments.js';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { parseConversationAction } from '../../packages/contracts/p6-actions.js';
import { parseOrchestrationAction } from '../../packages/contracts/p5.js';
import { scanCandidate } from '../../packages/verification/candidate.js';
import { admittedPlan } from '../../packages/orchestration/admission.js';

async function fixture() {
  const root = await mkdtemp('/tmp/sv-attachments-'), workspace = join(root, 'project'); await mkdir(workspace);
  return { root, workspace, close: () => rm(root, { recursive: true, force: true }) };
}
test('task attachments snapshot real files and expose honest bounded text image and video context', async () => {
  const f = await fixture(); try {
    await writeFile(join(f.workspace,'deliverable.txt'),'Existing deliverable');
    const before=await scanCandidate(f.workspace);
    const paths = ['需求.md', 'screen.png', 'clip.mp4', 'document.pdf'].map(n => join(f.root, n));
    await writeFile(paths[0]!, 'reference-specific-事实\n' + 'a'.repeat(13000));
    await writeFile(paths[1]!, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    await writeFile(paths[2]!, Buffer.from([0,0,0,16,102,116,121,112,109,112,52,50,0,0,0,0]));
    await writeFile(paths[3]!, '%PDF-1.4\n');
    const attachments = await importTaskAttachments(f.workspace, paths);
    assert.deepEqual(await scanCandidate(f.workspace),before,'A new chat attachment must not invalidate an existing delivery candidate');
    assert.deepEqual(attachments.map(a=>a.kind), ['text', 'image', 'video', 'file']);
    await writeFile(paths[0]!, 'changed original');
    assert.match((await verifyTaskAttachment(f.workspace, attachments[0]!)).toString(), /reference-specific/);
    const context = await taskAttachmentContext(f.workspace, [{ attachments }]);
    assert.deepEqual(context.images, [attachments[1]!.path]); assert.match(context.text, /reference-specific/);
    assert.match(context.text, /仅提供前 12000 字符/); assert.match(context.text, /本轮未解码/);
    assert.match(context.text, /untrusted source data/); assert.match(context.text, /document.pdf/);
    assert.equal((await readFile(paths[0]!, 'utf8')), 'changed original');
  } finally { await f.close(); }
});
test('task attachments reject changed foreign symlink oversized and overcount inputs without partial selection', async () => {
  const f = await fixture(); try {
    const source=join(f.root,'data.txt');await writeFile(source,'original');
    const [entry]=await importTaskAttachments(f.workspace,[source]);
    await assert.rejects(verifyTaskAttachment(f.workspace,{...entry!,path:source}),/不属于/);
    const link=join(f.root,'link.txt');await symlink(source,link);
    await assert.rejects(importTaskAttachments(f.workspace,[link]));
    await assert.rejects(importTaskAttachments(f.workspace,Array(11).fill(source)),/1–10/);
    const large=join(f.root,'large.bin');await writeFile(large,'');await truncate(large,64*1024*1024+1);
    await assert.rejects(importTaskAttachments(f.workspace,[source,large]),/64 MB/);
    await chmod(entry!.path,0o600);await writeFile(entry!.path,'tampered');
    await assert.rejects(taskAttachmentContext(f.workspace,[{attachments:[entry!]}]),/已改变/);
    const other=join(f.root,'other');await mkdir(other);
    await assert.rejects(verifyTaskAttachment(other,entry!),/不属于/);
  } finally { await f.close(); }
});
test('task attachment messages persist through real SQLite reopen idempotency and frozen followup requirements', async () => {
  const f=await fixture();const data=join(f.root,'data');let store=new SupervisorStore(data);
  try {
    const source=join(f.root,'facts.md');await writeFile(source,'research scope 2026');
    const attachments=await importTaskAttachments(f.workspace,[source]);
    const initial=store.goals.start({type:'start',commandId:'start',goal:'Research supplied sources',model:'not-called',effort:'low',reservation:20,timeoutMs:1000,tokenLimit:500,verificationReserve:20},f.workspace,'project');
    store.goals.finish(initial.session.id,initial.session.jobs[0]!.id,j=>{j.usage=0;j.stopConfirmed=true;j.proposal={decision:'clarify',summary:'Need scope',questions:['What scope?'],facts:[],constraints:[],style:[],criteria:[],steps:[]};});
    const conversation=store.conversations.ensureForGoal(initial.session.id);
    const action=parseConversationAction({type:'send',conversationId:conversation.id,commandId:'reply',kind:'change',text:'Use this scope',attachments});
    assert.equal(action.type,'send');if(action.type!=='send')throw Error('wrong action');
    const {type,...input}=action;const message=store.conversations.receive({...input,source:'user'});
    assert.deepEqual(store.conversations.receive({...input,source:'user'}),message);
    assert.throws(()=>store.conversations.receive({...input,attachments:[],source:'user'}),/Conflicting/);
    store.close();store=new SupervisorStore(data);
    assert.deepEqual(store.conversations.message(message.id).attachments,attachments);
    const frozen=store.goals.beginFollowup(initial.session.id,message.id).session.jobs.at(-1)!.followup!.messages;
    assert.deepEqual(frozen.at(-1)!.attachments,attachments);
    const context=await taskAttachmentContext(f.workspace,frozen);assert.match(context.text,/research scope 2026/);
    const current=store.goals.get(initial.session.id);
    const plan=admittedPlan({...current,proposal:{decision:'ready',summary:'Plan',questions:[],facts:[],constraints:[],style:[],criteria:[{id:'report',kind:'command',description:'Report',target:'report.test.mjs',checks:['Read supplied scope']}],steps:[{id:'work',description:'Write report',dependencies:[],acceptanceIds:['report']}]}},store.goals.inspect(current.id).run);
    assert.match(JSON.stringify(plan.steps),/facts.md/);assert.match(JSON.stringify(plan.steps),/untrusted/);
    assert.equal(parseOrchestrationAction({type:'answer',sessionId:current.id,commandId:'answer',expectedRevision:current.revision,text:'Scope',attachments}).type,'answer');
    assert.throws(()=>parseConversationAction({...action,attachments:[{...attachments[0],sha256:'bad'}]}),/附件/);
  } finally {store.close();await f.close();}
});
