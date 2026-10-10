import {writeFile} from 'node:fs/promises';
/** Real local Node app-server transport. Every judgment and token number is
 * deliberately synthetic; it verifies orchestration and evidence wiring only. */
export async function writeMaintenanceTransport(path:string,mode:'regression'|'dedup'|'reject'='regression'):Promise<void>{
 await writeFile(path,`#!${process.execPath}
const cp=require('node:child_process'),a=process.argv.slice(2);if(a.includes('--version')||a.includes('generate-json-schema')){process.stdout.write(cp.execFileSync('codex',a));process.exit(0)}if(a.includes('mcp')){console.log('[]');process.exit(0)}
const mode=${JSON.stringify(mode)};const send=x=>console.log(JSON.stringify(x)),thread='synthetic-'+process.pid;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize')return send({id:m.id,result:{userAgent:'explicit-mechanism-fixture',codexHome:'fixture',platformFamily:'unix',platformOs:'test'}});
if(m.method==='model/list')return send({id:m.id,result:{data:[{id:'maintenance-fixture',model:'maintenance-fixture',inputModalities:['text'],supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low',isDefault:true}],nextCursor:null}});
if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:thread,turns:[]}}});
if(m.method==='turn/start'){
 const schema=m.params.outputSchema;let value={verdict:'passed',reason:'Explicit synthetic review judgment; not a model acceptance claim',observations:[]};
 if(schema.properties.contextDigest){
  const prompt=m.params.input.find(i=>i.type==='text').text,c=JSON.parse(prompt.slice(prompt.lastIndexOf('\\n\\n')+2));
  const base=c.history.definitions.find(d=>d.definition.definitionDigest===c.base.baseDefinitionDigest),spec=structuredClone(base.definition.spec),sources=c.maintenance.basis.sources;
  for(const original of base.definition.spec.cases.filter(i=>i.status!=='retired'))spec.cases.push({...original,revision:original.revision+1,status:mode==='dedup'?'retired':'active',modules:c.current.criteria.map(x=>x.id),defectRefs:[...original.defectRefs,...sources.map(s=>s.defectRef)]});
  if(mode==='dedup')spec.cases.push({...base.definition.spec.cases[0],id:'merged-value',revision:1,status:'active',modules:c.current.criteria.map(x=>x.id),replaces:base.definition.spec.cases.map(x=>x.id),defectRefs:[...new Set([...base.definition.spec.cases.flatMap(x=>x.defectRefs),...sources.map(s=>s.defectRef)])]});
  spec.moduleDependencies=Object.fromEntries(c.current.criteria.map(x=>[x.id,[]]));spec.controls=spec.controls.map(x=>({...x,workspace:x.id}));
  const frontier=c.history.manifest.entries.filter(e=>e.disposition==='current'),lookup=e=>c.history.specimens.find(s=>s.revision.ref.id===e.specimen.id&&s.revision.ref.revision===e.specimen.revision),key=e=>e.specimen.id+':'+e.specimen.revision;
  value={contextDigest:schema.properties.contextDigest.const,assets:{contextDigest:schema.properties.assets.properties.contextDigest.const,spec,verifierFiles:Object.entries(c.historyText.definitions[base.definition.definitionDigest]).map(([path,content])=>({path,content})),controls:frontier.map(e=>({id:lookup(e).revision.controlId,files:Object.entries(c.historyText.specimens[key(e)]).map(([path,content])=>({path,content}))})),coverageExplanation:c.current.criteria.flatMap(i=>i.checks.map(check=>({criterionId:i.id,check,caseIds:[spec.cases.at(-1).id],explanation:'Actual strict value detector retained and fault reference added'})))},plan:{controlPlan:frontier.map(e=>({controlId:lookup(e).revision.controlId,kind:lookup(e).revision.kind,predecessorKey:key(e)})),historyPlan:frontier.map(e=>({specimenKey:key(e),successorControlId:lookup(e).revision.controlId,retireObligationIds:[]})),evolutionExplanation:'Synthetic authored revision for real component verification'},maintenance:{regressions:sources.map(s=>({defectRef:s.defectRef,caseId:spec.cases.at(-1).id,revision:spec.cases.at(-1).revision,parameters:s.instance.parameters})),reason:'Preserve actual regression witness without changing business standards'}};
 }
 if(mode==='reject'&&!schema.properties.contextDigest&&m.params.input.some(i=>i.type==='text'&&i.text.includes('complete control evolution and actual frozen qualification pairs')))value={verdict:'failed',reason:'Explicit synthetic rejection retained for required maintenance',observations:['No real model claim']};
 send({id:m.id,result:{turn:{id:'turn',status:'inProgress',items:[]}}});const usage={inputTokens:2,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:4},text=JSON.stringify(value);
 send({method:'thread/tokenUsage/updated',params:{threadId:thread,turnId:'turn',tokenUsage:{total:usage,last:usage}}});send({method:'item/completed',params:{threadId:thread,turnId:'turn',item:{id:'message',type:'agentMessage',text}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text}]}}});return;
}throw Error('Unexpected synthetic request '+m.method);});`,{mode:0o700});
}
