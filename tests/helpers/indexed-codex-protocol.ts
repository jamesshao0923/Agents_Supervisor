import {writeFile,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
/** Explicit supplier protocol fixture. Real owned Node transport, not model/semantic evidence. */
export async function indexedCodexProtocol(root:string,replyPath:string):Promise<string>{
 const real=execFileSync('/usr/bin/which',['codex'],{encoding:'utf8'}).trim(),script=join(root,'synthetic-codex.mjs');
 await writeFile(script,`#!${process.execPath}
import fs from 'node:fs';import {execFileSync}from'node:child_process';import{createInterface}from'node:readline';
const args=process.argv.slice(2),real=${JSON.stringify(real)},reply=${JSON.stringify(replyPath)};
if(args.includes('--version')||args.includes('generate-json-schema')){process.stdout.write(execFileSync(real,args,{encoding:'utf8'}));process.exit(0);}
if(args.includes('mcp')){console.log('[]');process.exit(0);}
let dynamic=null,prompt='',seq=0,turn=0,pending=null,schema=null;const thread='synthetic-'+process.pid;
const send=x=>console.log(JSON.stringify(x));
function completed(value){const text=JSON.stringify(value),tokens={inputTokens:5,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:7};send({method:'item/completed',params:{threadId:thread,turnId:'turn-'+turn,item:{id:'agent-'+turn,type:'agentMessage',text}}});send({method:'thread/tokenUsage/updated',params:{threadId:thread,turnId:'turn-'+turn,tokenUsage:{total:tokens,last:tokens}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'completed',items:[],error:null}}});}
function answer(){const state=JSON.parse(fs.readFileSync(reply,'utf8'));if(schema?.properties?.verdict){let payload;try{payload=JSON.parse(prompt.slice(prompt.lastIndexOf('\\n')+1));}catch{};const bad=payload?.proposed?.proposal?.claims?.some(c=>c.text.includes('unbounded write'));completed({verdict:bad?'failed':'passed',reason:'Explicit synthetic semantic protocol metadata, no provider interpretation',observations:[]});}else{const value=structuredClone(state.value);if(schema?.properties?.contextDigest?.const)value.contextDigest=schema.properties.contextDigest.const;completed(value);}}
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.id===undefined)return;
 if(m.method==='initialize')return send({id:m.id,result:{userAgent:'explicit-synthetic-node',codexHome:'fixture',platformFamily:'unix',platformOs:'test'}});
 if(m.method==='model/list')return send({id:m.id,result:{data:[{id:'fixture',model:'explicit-synthetic-protocol-fixture-no-provider',displayName:'Fixture only',description:'No supplier',isDefault:true,inputModalities:['text'],supportedReasoningEfforts:[{reasoningEffort:'low',description:'fixture'}],defaultReasoningEffort:'low'}],nextCursor:null}});
 if(m.method==='thread/start'){dynamic=m.params.dynamicTools;return send({id:m.id,result:{thread:{id:thread,turns:[]}}});}
 if(m.method==='turn/start'){turn++;schema=m.params.outputSchema;prompt=m.params.input.filter(i=>i.type==='text').map(i=>i.text).join('\\n');send({id:m.id,result:{turn:{id:'turn-'+turn,status:'inProgress',items:[]}}});setTimeout(()=>{if(dynamic){pending={id:900+turn,callId:'call-'+turn,threadId:thread,turnId:'turn-'+turn,tool:'research_material_range',namespace:null,arguments:{materialId:dynamic[0].inputSchema.properties.materialId.enum[0],start:0,end:2}};const {id,...params}=pending;send({id,method:'item/tool/call',params});send({method:'item/started',params:{threadId:thread,turnId:'turn-'+turn,item:{id:'item-'+turn,type:'dynamicToolCall',tool:pending.tool,namespace:null,arguments:pending.arguments,status:'inProgress',contentItems:null,success:null,durationMs:null}}});}else answer();},30);return;}
 if(pending&&m.id===pending.id&&m.result){send({method:'item/completed',params:{threadId:thread,turnId:'turn-'+turn,item:{id:'item-'+turn,type:'dynamicToolCall',tool:pending.tool,namespace:null,arguments:pending.arguments,status:'completed',contentItems:m.result.contentItems,success:true,durationMs:1}}});answer();return;}
 if(m.method==='turn/interrupt')return send({id:m.id,result:{}});
});
`);await chmod(script,0o700);return script;
}
