import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,writeFile,readFile,readdir,cp} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {researchReaderFixture} from './research-reader-fixture.js';
import {indexedCodexProtocol} from './indexed-codex-protocol.js';
import {spawnManagedProcess,inspectProcess,type ManagedProcess} from '../../packages/process-control/index.js';
import {CodexAdapter,type LineTransport,type RawEvent,type NormalizedEvent} from '../../packages/executor-codex/index.js';
import {MaterialReaderSession} from '../../packages/executor-codex/material-reader-session.js';
import {researchDigest} from '../../packages/workspace/research-materials.js';
import {researchGroupPrompt,researchGroupOutputSchema,validateResearchGroupOutput} from '../../packages/orchestration/research-group-output.js';
import type {ResearchGroupInput} from '../../packages/contracts/p8-research-groups.js';
import type {ResearchReadResult,ResearchReaderAudit} from '../../packages/contracts/p8-research-reader.js';

/** Ordinary real Node/FS/material session check for the exact generated fixture.
 * Synthetic group answers/token notifications are not provider/model evidence. */
export async function indexedGroupProtocolPreflight(t:TestContext,evidenceRoot:string):Promise<void>{
 const f=await researchReaderFixture(t),schemas=join(f.root,'schemas'),barrier=join(f.root,'group-reader-ready'),reply=join(f.root,'reply.json');
 await mkdir(barrier);
 const version=execFileSync('codex',['--version'],{encoding:'utf8',timeout:15000}).trim();
 execFileSync('codex',['app-server','generate-json-schema','--experimental','--out',schemas],{timeout:15000,stdio:'pipe'});
 await writeFile(reply,JSON.stringify({kind:'group',groupBarrier:{directory:barrier,participantIds:['first','second']},value:{citations:[{id:'q',materialId:'one',start:0,end:2,quote:f.text.slice(0,2)}]}}));
 const script=await indexedCodexProtocol(f.root,reply);
 const children:ManagedProcess[]=[],results:unknown[]=[],stops:unknown[]=[];
 f.addCleanup(async()=>{await mkdir(evidenceRoot,{recursive:true});await cp(f.root,join(evidenceRoot,basename(f.root)),{recursive:true,errorOnExist:true,force:false});});
 t.diagnostic('actual root '+f.root);
 try{
  const participants=await Promise.all(['first','second'].map(async(groupId)=>{
   const body={schemaVersion:2 as const,authority:'untrusted-group-extraction-only' as const,registrationId:'explicit-protocol-check',group:{id:groupId,purpose:'Ordinary two-participant actual reader protocol check',materialIds:['one'],criterionIds:['research'],reservation:100},materialReceiptDigest:f.index.indexDigest,context:f.context,indexed:f.reader,sources:[{materialId:'one',text:null,status:f.index.entries[0]!.status}]};
   const input:ResearchGroupInput={...body,digest:researchDigest(body)};
   const receipts:unknown[]=[];
   const child=await spawnManagedProcess({operationId:'group-protocol-'+groupId,command:process.execPath,args:[script],cwd:f.root,timeoutMs:15000,onBeforeSpawn:i=>{receipts.push({kind:'intent',value:i});},onIdentity:i=>{receipts.push({kind:'identity',value:i});}});
   children.push(child);
   const raw:RawEvent[]=[],events:NormalizedEvent[]=[],stderr:string[]=[];child.stderr.on('data',chunk=>stderr.push(String(chunk)));
   const lines=createInterface({input:child.stdout});
   const transport:LineTransport={write(line){child.writeLine(line.trimEnd());},onLine(callback){lines.on('line',callback);return()=>{lines.off('line',callback);};},onClose(callback){const close=()=>callback('owned Node stdout closed');lines.on('close',close);return()=>{lines.off('close',close);};}};
   const session=await MaterialReaderSession.create({reader:f.reader,owner:{jobId:'group-protocol-'+groupId,attemptId:'group-protocol-'+groupId,inputDigest:input.digest,processIdentity:child.identity},protocolDirectory:schemas,version,assertEligible(){assert.equal(child.identity.operationId,'group-protocol-'+groupId);}});
   let resolveTerminal!:()=>void,rejectTerminal!:(error:Error)=>void;
   const terminal=new Promise<void>((resolve,reject)=>{resolveTerminal=resolve;rejectTerminal=reject;});terminal.catch(()=>{});
   const adapter=new CodexAdapter({transport,materialReader:session,requestTimeoutMs:15000,onRawEvent:e=>{raw.push(e);},onEvent:e=>{events.push(e);if(e.kind==='turn-status'&&e.terminal)resolveTerminal();if(e.kind==='protocol-error')rejectTerminal(Error(JSON.stringify(e)));}});
   child.completion.then(()=>rejectTerminal(Error('Actual process exited before complete turn'))).catch(rejectTerminal);
   return {groupId,input,child,session,adapter,lines,raw,events,stderr,receipts,terminal};
  }));
  try{
   await Promise.all(participants.map(async p=>{
    await p.adapter.initialize();const thread=await p.adapter.startThread({cwd:f.root,sandbox:'read-only',approvalPolicy:'never'});
    await p.adapter.startTurn(thread.thread.id,[{type:'text',text:researchGroupPrompt(p.input)}],{outputSchema:researchGroupOutputSchema(p.input)});
    await p.terminal;await p.adapter.drain();await p.session.finish();
    const files=(await readdir(p.session.directory)).filter(name=>/^\d+\.json$/.test(name)).sort((a,b)=>parseInt(a)-parseInt(b));
    const audits:ResearchReaderAudit[]=await Promise.all(files.map(async name=>JSON.parse(await readFile(join(p.session.directory,name),'utf8')) as ResearchReaderAudit));
    assert.deepEqual(audits.map(a=>a.stage),['prepared','write-attempt','written','observed','closed']);
    const response:ResearchReadResult=JSON.parse(audits[0]!.response!.contentItems[0]!.text) as ResearchReadResult;
    assert.equal(response.request.type,'range');assert.equal(response.request.materialId,'one');assert.equal(response.ranges[0]!.text,f.text.slice(0,2));
    const message=p.events.find(e=>e.kind==='message');assert.ok(message&&message.kind==='message'&&typeof message.text==='string');
    await validateResearchGroupOutput({intake:f.intake,input:p.input,output:JSON.parse(message.text)});
    results.push({groupId:p.groupId,inputDigest:p.input.digest,identity:p.child.identity,receipts:p.receipts,raw:p.raw,events:p.events,audits,response,stderr:p.stderr});
   }));
   const starts=participants.map(p=>Date.parse(p.raw.find(e=>e.message&&typeof e.message==='object'&&'result'in e.message&&(e.message.result as {turn?:unknown}).turn)!.receivedAt));
   const ends=participants.map(p=>Date.parse(p.raw.find(e=>e.line.includes('"method":"turn/completed"'))!.receivedAt));
   assert.ok(Math.max(...starts)<Math.min(...ends),'actual generated participant turn intervals overlap');
   const markers=await Promise.all(['first','second'].map(async id=>JSON.parse(await readFile(join(barrier,id+'.json'),'utf8')) as {groupId:string;threadId:string;materialId:string}));
   assert.equal(new Set(markers.map(m=>m.threadId)).size,2);assert.deepEqual(markers.map(m=>m.groupId),['first','second']);assert.ok(markers.every(m=>m.materialId==='one'));
   await writeFile(join(f.root,'actual-preflight.json'),JSON.stringify({scope:'explicit synthetic generated transport, actual material reader/session/FS/process evidence; no provider/P4/budget authority',results,markers,overlapMs:Math.min(...ends)-Math.max(...starts)},null,2));
  }finally{for(const p of participants){p.adapter.dispose();await p.session.cancel().catch(()=>{});p.lines.close();}}
 }finally{
  for(const child of children){const stopped=await child.terminate(),inspection=await inspectProcess(child.identity);stops.push({identity:child.identity,stopped,inspection});assert.equal(stopped.stopped,true);assert.equal(inspection.status,'stopped');}
  await writeFile(join(f.root,'actual-stops.json'),JSON.stringify(stops,null,2));
 }
}
