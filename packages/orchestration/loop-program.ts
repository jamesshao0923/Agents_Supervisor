import type {LoopProgramSource,LoopProgramNode,LoopState,LoopFrame,LoopObservation,LoopAdvance,LoopOccurrence,LoopDecision} from '../contracts/p7-loop.js';
import {canonical,digest} from '../verification/candidate.js';
import {safeResultJSON} from '../contracts/p7-results.js';
const hash=(v:unknown)=>digest(canonical(v));
function ensure(v:unknown,s:string):asserts v{if(!v)throw Error('Loop program: '+s);}
const id=(s:string)=>typeof s==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(s);
export function programNodes(tree:LoopProgramNode):LoopProgramNode[]{return [tree,...(tree.kind==='task'?[]:tree.kind==='loop'?programNodes(tree.body):tree.children.flatMap(programNodes))];}
export function validateLoopSource(source:LoopProgramSource):void{
 safeResultJSON(source);const {program,templatePlan:plan}=source,nodes=programNodes(program.tree);
 ensure(program.schemaVersion===1&&program.policyVersion==='bounded-data-loop-v1'&&program.sourceDigest===hash(plan),'program source is not the exact admitted template plan');
 ensure(plan.revision===1&&plan.loops.length===0&&Number.isSafeInteger(source.startedAtMs)&&source.startedAtMs>=0&&source.startedAtMs<plan.limits.deadlineMs,'invalid initial scope or time');
 ensure(nodes.length<=128&&nodes.every(n=>id(n.id))&&new Set(nodes.map(n=>n.id)).size===nodes.length,'invalid/duplicate program node IDs');
 const tasks=nodes.filter(n=>n.kind==='task');ensure(tasks.length===plan.tasks.length&&new Set(tasks.map(n=>n.taskId)).size===tasks.length&&tasks.every(n=>plan.tasks.some(t=>t.node.id===n.taskId)),'program must cover each original task template exactly once');
 ensure(nodes.some(n=>n.kind==='loop'),'program contains no loop');ensure(plan.tasks.every(t=>t.node.resources.length===1&&t.node.resources[0]!.kind==='path'&&t.node.resources[0]!.key===t.workspace&&t.node.resources[0]!.mode==='write'),'loop slice supports isolated workspace resources only; external resource qualification is required separately');
 function walk(n:LoopProgramNode,depth:number,parentTokens:number):void{
  if(n.kind==='task')return;
  if(n.kind==='loop'){
   ensure(depth+1<=plan.limits.maxDepth,'maximum loop depth exceeded');const b=n.limits;
   ensure(Object.values(b).every(v=>Number.isSafeInteger(v)&&v>0)&&b.iterations<=128&&b.nodes<=plan.limits.maxNodes&&b.tokens<=parentTokens,'invalid child bounds');
   ensure(programNodes(n.body).some(x=>x.kind==='task'&&x.taskId===n.until.taskId),'predicate must name a body task');
   ensure(n.until.path.length>0&&!n.until.path.startsWith('/')&&!n.until.path.includes('\\')&&n.until.path.split('/').every(p=>p&&p!=='.'&&p!=='..')&&id(n.until.field)&&Number.isFinite(n.until.atLeast),'invalid numeric predicate');walk(n.body,depth+1,b.tokens);
  }else{ensure(n.children.length>0&&n.children.length<=32,'invalid composite children');n.children.forEach(c=>walk(c,depth,parentTokens));}
 }
 walk(program.tree,0,Number.MAX_SAFE_INTEGER);
}
function frame(node:LoopProgramNode,key:string,inputs:string[],ancestry:string[],deadline:number):LoopFrame{return {key,nodeId:node.id,kind:node.kind,state:'new',reason:null,taskId:null,ordinal:0,children:[],inputs:[...inputs],outputs:[],ancestry:[...ancestry],deadlineMs:deadline,fingerprints:[]};}
export function initialLoopState(source:LoopProgramSource):LoopState{validateLoopSource(source);return {schemaVersion:1,schedulerId:source.templatePlan.id,revision:0,lastObservedMs:source.startedAtMs,rootKey:'root',frames:[frame(source.program.tree,'root',[],[],source.templatePlan.limits.deadlineMs)]};}
/** Inputs are host repository observations of sealed packages, never raw model decisions. */
export function deriveLoopAdvance(source:LoopProgramSource,previous:LoopState,observations:LoopObservation[],nowMs:number):LoopAdvance{
 validateLoopSource(source);ensure(previous.schedulerId===source.templatePlan.id&&Number.isSafeInteger(nowMs)&&nowMs>=previous.lastObservedMs,'clock moved backwards');
 const state=structuredClone(previous),occurrences:LoopOccurrence[]=[],decisions:LoopDecision[]=[],nodes=programNodes(source.program.tree),beforeDigest=hash(previous);
 const get=(key:string)=>{const f=state.frames.find(f=>f.key===key);ensure(f,'missing frame');return f;};
 const create=(node:LoopProgramNode,key:string,inputs:string[],ancestors:string[],deadline:number)=>{ensure(!state.frames.some(f=>f.key===key),'frame identity replay');const f=frame(node,key,inputs,ancestors,deadline);state.frames.push(f);return f;};
 function blocked(f:LoopFrame,reason:string){f.state='blocked';f.reason=reason;}
 function visit(f:LoopFrame):void{
  if(['yielded','blocked','stopped'].includes(f.state))return;const n=nodes.find(n=>n.id===f.nodeId)!;
  if(nowMs>=f.deadlineMs){blocked(f,'Absolute loop/program deadline reached; no acceptance granted');return;}
  if(n.kind==='task'){
   if(f.state==='new'){f.taskId='loop-task-'+hash({scheduler:state.schedulerId,key:f.key}).slice(0,40);f.state='active';occurrences.push({taskId:f.taskId,templateId:n.taskId,frameKey:f.key,loopIds:[...f.ancestry],dependencies:[...f.inputs]});return;}
   const failedInput=f.inputs.find(taskId=>observations.some(o=>o.taskId===taskId&&o.state==='failed')||state.frames.some(parent=>parent.taskId===taskId&&['blocked','stopped'].includes(parent.state)));if(failedInput){blocked(f,'Required actual dependency failed or stopped: '+failedInput);return;}
   const o=observations.find(o=>o.taskId===f.taskId);if(o?.state==='failed'){blocked(f,o.reason??'Actual body execution/publication failed');return;}if(o?.state==='submitted'){ensure(o.ref,'submitted observation lacks result');f.state='yielded';f.outputs=[f.taskId!];}return;
  }
  if(n.kind!=='loop'){
   if(f.state==='new'){f.state='active';for(const [index,c] of n.children.entries())f.children.push(create(c,f.key+'/'+index,[],f.ancestry,f.deadlineMs).key);}
   let outputs=n.kind==='sequence'?[...f.inputs]:[];for(const key of f.children){const child=get(key);if(child.state==='new')child.inputs=n.kind==='sequence'?[...outputs]:[...f.inputs];visit(child);if(child.state==='yielded')outputs=n.kind==='sequence'?[...child.outputs]:[...new Set([...outputs,...child.outputs])];else if(n.kind==='sequence'){if(['blocked','stopped'].includes(child.state))blocked(f,child.reason??'Required child blocked');return;}}
   const children=f.children.map(get);if(children.every(c=>c.state==='yielded')){f.state='yielded';f.outputs=outputs;}else if(children.every(c=>['yielded','blocked','stopped'].includes(c.state)))blocked(f,'Required parallel child blocked; independent siblings retained');return;
  }
  if(f.state==='new'){
   f.state='active';f.ordinal=1;f.deadlineMs=Math.min(f.deadlineMs,nowMs+n.limits.durationMs);f.children=[create(n.body,f.key+'/iteration-1',[...f.inputs],[...f.ancestry,f.key],f.deadlineMs).key];
  }
  const body=get(f.children[0]!);visit(body);if(['blocked','stopped'].includes(body.state)){blocked(f,body.reason??'Loop body blocked');return;}if(body.state!=='yielded')return;
  const actual=state.frames.filter(f=>f.taskId&&(f.key===body.key||f.key.startsWith(body.key+'/'))).map(f=>observations.find(o=>o.taskId===f.taskId)).filter((o):o is LoopObservation=>!!o&&o.state==='submitted');
  const target=actual.filter(o=>{const child=state.frames.find(f=>f.taskId===o.taskId);return child&&nodes.find(n=>n.id===child.nodeId&&n.kind==='task')?.kind==='task'&&(nodes.find(n=>n.id===child.nodeId) as Extract<LoopProgramNode,{kind:'task'}>).taskId===n.until.taskId;}).at(-1);
  let value:number|null=null;const raw=target?.json[n.until.path];if(raw&&typeof raw==='object'&&!Array.isArray(raw)){const v=(raw as Record<string,unknown>)[n.until.field];if(typeof v==='number'&&Number.isFinite(v))value=v;}
  const latest=new Map<string,string>();for(const o of actual)latest.set(state.frames.find(f=>f.taskId===o.taskId)!.nodeId,o.fingerprint);const fingerprint=hash([...latest].sort(([a],[b])=>a.localeCompare(b))),prior=f.fingerprints.at(-1);
  f.fingerprints.push(fingerprint);let decision:LoopDecision['decision']='continue',reason='Actual bounded numeric state requires another iteration';
  if(value===null){decision='blocked';reason='Predicate lacks one actual finite numeric artifact field';}
  else if(value>=n.until.atLeast){decision='yield';reason='Internal numeric strategy condition reached; independent final P4 remains required';}
  else if(f.ordinal>=n.limits.iterations){decision='blocked';reason='Iteration cap reached without yield';}
  else {let equal=0;for(let i=f.fingerprints.length-1;i>0&&f.fingerprints[i]===f.fingerprints[i-1];i--)equal++;if(prior===fingerprint&&equal>=n.limits.unchangedIterations){decision='blocked';reason='Actual unchanged outputs across distinct iterations';}}
  const iterationId=f.key+'/iteration-'+f.ordinal;decisions.push({id:'loop-decision-'+hash({scheduler:state.schedulerId,iterationId}),iterationId,loopId:f.key,ordinal:f.ordinal,decision,reason,resultRefs:actual.map(o=>o.ref!),fingerprint,value});
  if(decision==='blocked'){blocked(f,reason);return;}f.outputs=[...body.outputs];
  if(decision==='yield'){f.state='yielded';return;}
  f.ordinal++;f.children=[create(n.body,f.key+'/iteration-'+f.ordinal,[...new Set([...f.inputs,...f.outputs])],[...f.ancestry,f.key],f.deadlineMs).key];visit(get(f.children[0]!));
 }
 visit(get(state.rootKey));
 // Freeze original dependency mapping; occurrence dependencies also include all
 // sequencing/prior-iteration inputs. Unknown/shared declaration edges survive.
 const existing=state.frames.filter(f=>f.taskId).map(f=>({taskId:f.taskId!,templateId:(nodes.find(n=>n.id===f.nodeId) as Extract<LoopProgramNode,{kind:'task'}>).taskId,frameKey:f.key}));
 for(const o of occurrences){const original=source.templatePlan.tasks.find(t=>t.node.id===o.templateId)!;for(const templateId of original.node.dependencies){const sameBatch=occurrences.find(x=>x.templateId===templateId&&x.taskId!==o.taskId),prior=existing.filter(x=>x.templateId===templateId&&state.frames.find(f=>f.key===x.frameKey)!.state==='yielded').at(-1),dependency=sameBatch??prior;ensure(dependency,'Original dependency unavailable in program ordering: '+templateId);if(!o.dependencies.includes(dependency.taskId))o.dependencies.push(dependency.taskId);}get(o.frameKey).inputs=[...o.dependencies];}
 if(hash(state)!==beforeDigest){state.revision++;state.lastObservedMs=nowMs;}
 return {sourceDigest:hash(source),beforeDigest,state,occurrences,decisions};
}
