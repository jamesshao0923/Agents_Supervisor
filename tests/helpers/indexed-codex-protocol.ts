import {writeFile,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
/** Explicit supplier protocol fixture. Real owned Node transport, not model/semantic evidence. */
export async function indexedCodexProtocol(root:string,replyPath:string):Promise<string>{
 const real=execFileSync('/usr/bin/which',['codex'],{encoding:'utf8'}).trim(),script=join(root,'synthetic-codex.mjs');
 await writeFile(script,`#!${process.execPath}
import fs from 'node:fs';import {createHash}from'node:crypto';import {join}from'node:path';import {execFileSync}from'node:child_process';import{createInterface}from'node:readline';
const args=process.argv.slice(2),real=${JSON.stringify(real)},reply=${JSON.stringify(replyPath)};
if(args.includes('--version')||args.includes('generate-json-schema')){process.stdout.write(execFileSync(real,args,{encoding:'utf8'}));process.exit(0);}
if(args.includes('mcp')){console.log('[]');process.exit(0);}
let dynamic=null,prompt='',seq=0,turn=0,pending=null,schema=null;const thread='synthetic-'+process.pid;
const send=x=>console.log(JSON.stringify(x));
function completed(value){const text=JSON.stringify(value),tokens={inputTokens:5,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:7};send({method:'item/completed',params:{threadId:thread,turnId:'turn-'+turn,item:{id:'agent-'+turn,type:'agentMessage',text}}});send({method:'thread/tokenUsage/updated',params:{threadId:thread,turnId:'turn-'+turn,tokenUsage:{total:tokens,last:tokens}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'completed',items:[],error:null}}});}
// Ordinary fixture barrier: markers describe real received successful reader
// replies and emitted item/completed events. They do not replace host journals.
function groupReaderReady(response){
 const state=JSON.parse(fs.readFileSync(reply,'utf8'));
 if(!schema?.properties?.inputDigest?.const||!state.groupBarrier){answer();return;}
 const inp=JSON.parse(prompt.slice(prompt.lastIndexOf('\\n\\n')+2)),barrier=state.groupBarrier,ids=barrier.participantIds;
 if(!Array.isArray(ids)||ids.length!==2||new Set(ids).size!==2||!ids.every(id=>['first','second'].includes(id))||!ids.includes(inp.group.id)||response.success!==true)throw Error('Invalid explicit group barrier/reader response');
 const result=JSON.parse(response.contentItems[0].text);
 if(result.request.materialId!==pending.arguments.materialId||!Array.isArray(result.ranges)||result.ranges.length!==1||result.ranges[0].start!==0||result.ranges[0].end!==2)throw Error('Actual group reader result differs');
 let done=false,watcher,timer;
 const finish=error=>{if(done)return;done=true;clearTimeout(timer);watcher.close();if(error){console.error(String(error));process.exit(1);}else answer();};
 const check=()=>{try{const values=ids.map(id=>{const path=join(barrier.directory,id+'.json');return fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):null;});if(values.some(value=>value===null))return;
  if(!values.every((value,i)=>value.groupId===ids[i]&&value.success===true&&typeof value.threadId==='string'&&typeof value.turnId==='string'&&typeof value.responseDigest==='string')||new Set(values.map(value=>value.threadId)).size!==2)throw Error('Distinct actual group reader participants required');finish();
 }catch(error){finish(error);}};
 watcher=fs.watch(barrier.directory,check);watcher.on('error',finish);
 timer=setTimeout(()=>finish(Error('Explicit group reader barrier deadline15000ms')),15000);
 const marker=join(barrier.directory,inp.group.id+'.json'),staging=marker+'.tmp';if(fs.existsSync(marker))throw Error('Group barrier marker already exists');fs.writeFileSync(staging,JSON.stringify({groupId:inp.group.id,threadId:thread,turnId:pending.turnId,callId:pending.callId,materialId:result.request.materialId,responseDigest:createHash('sha256').update(JSON.stringify(response)).digest('hex'),success:true,receivedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});fs.renameSync(staging,marker);check();
}
function answer(){const state=JSON.parse(fs.readFileSync(reply,'utf8'));if(schema?.properties?.verdict){let payload;try{payload=JSON.parse(prompt.slice(prompt.lastIndexOf('\\n')+1));}catch{};const bad=payload?.proposed?.proposal?.claims?.some(c=>c.text.includes('unbounded write'));completed({verdict:bad?'failed':'passed',reason:'Explicit synthetic semantic protocol metadata, no provider interpretation',observations:[]});}else if(schema?.properties?.inputDigest?.const){const inp=JSON.parse(prompt.slice(prompt.lastIndexOf('\\n\\n')+2)),citations=inp.group.materialIds.map((materialId,i)=>{const quote=state.value.citations.find(c=>c.materialId===materialId);return{id:'group-q'+i,materialId,start:quote.start,end:quote.end,quote:quote.quote};});completed({schemaVersion:1,inputDigest:schema.properties.inputDigest.const,citations,materials:inp.group.materialIds.map(materialId=>({materialId,summary:'Explicit synthetic extraction with actual literal source span',citationIds:citations.filter(c=>c.materialId===materialId).map(c=>c.id),unresolved:[]})),extractions:citations.map((c,i)=>({id:'group-e'+i,criterionIds:inp.group.criterionIds,kind:'fact',text:'Explicit synthetic local source interpretation',supportCitationIds:[c.id],limitations:[]})),relationships:[],gaps:[]});}else{const value=structuredClone(state.value);if(schema?.properties?.contextDigest?.const)value.contextDigest=schema.properties.contextDigest.const;completed(value);}}
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.id===undefined)return;
 if(m.method==='initialize')return send({id:m.id,result:{userAgent:'explicit-synthetic-node',codexHome:'fixture',platformFamily:'unix',platformOs:'test'}});
 if(m.method==='model/list')return send({id:m.id,result:{data:[{id:'fixture',model:'explicit-synthetic-protocol-fixture-no-provider',displayName:'Fixture only',description:'No supplier',isDefault:true,inputModalities:['text'],supportedReasoningEfforts:[{reasoningEffort:'low',description:'fixture'}],defaultReasoningEffort:'low'}],nextCursor:null}});
 if(m.method==='thread/start'){dynamic=m.params.dynamicTools;return send({id:m.id,result:{thread:{id:thread,turns:[]}}});}
 if(m.method==='turn/start'){turn++;schema=m.params.outputSchema;prompt=m.params.input.filter(i=>i.type==='text').map(i=>i.text).join('\\n');send({id:m.id,result:{turn:{id:'turn-'+turn,status:'inProgress',items:[]}}});setTimeout(()=>{if(dynamic){pending={id:900+turn,callId:'call-'+turn,threadId:thread,turnId:'turn-'+turn,tool:'research_material_range',namespace:null,arguments:{materialId:dynamic[0].inputSchema.properties.materialId.enum[0],start:0,end:2}};const {id,...params}=pending;send({id,method:'item/tool/call',params});send({method:'item/started',params:{threadId:thread,turnId:'turn-'+turn,item:{id:'item-'+turn,type:'dynamicToolCall',tool:pending.tool,namespace:null,arguments:pending.arguments,status:'inProgress',contentItems:null,success:null,durationMs:null}}});}else answer();},30);return;}
 if(pending&&m.id===pending.id&&m.result){send({method:'item/completed',params:{threadId:thread,turnId:'turn-'+turn,item:{id:'item-'+turn,type:'dynamicToolCall',tool:pending.tool,namespace:null,arguments:pending.arguments,status:'completed',contentItems:m.result.contentItems,success:true,durationMs:1}}});groupReaderReady(m.result);return;}
 if(m.method==='turn/interrupt')return send({id:m.id,result:{}});
});
`);await chmod(script,0o700);return script;
}
