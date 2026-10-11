import {lstatSync,realpathSync,readdirSync,readFileSync} from 'node:fs';
import {resolve,join,relative,sep} from 'node:path';
import type {DecompositionStep,DependencyProjection,GoalDecomposition,LogicalPathScope,TaskDecompositionDeclaration} from '../contracts/p7-decomposition.js';
import type {GraphSeedSnapshot} from '../contracts/p7-graph.js';
import type {Candidate} from '../verification/candidate.js';
import {canonical,digest,exclusions} from '../verification/candidate.js';
import {schedulerResourcesConflict} from '../domain/task-scheduler.js';
import {safeResultJSON} from '../contracts/p7-results.js';
function ensure(v:unknown,message:string):asserts v{if(!v)throw Error('Decomposition: '+message);}
function text(v:unknown):asserts v is string{ensure(typeof v==='string'&&v.trim()&&v.length<=12000&&!v.includes('\0'),'invalid text');}
function exact(v:object,keys:string[]){ensure(canonical(Object.keys(v).sort())===canonical([...keys].sort()),'unknown or missing fields');}
function list(v:unknown):asserts v is unknown[]{ensure(Array.isArray(v)&&v.length<=128,'invalid bounded list');}
function paths(values:LogicalPathScope[],allowRootRead=false):void{
 list(values);const seen=new Set<string>();
 for(const value of values){exact(value,['path','kind']);text(value.path);ensure(['file','tree'].includes(value.kind),'invalid scope kind');
  const rootRead=allowRootRead&&value.kind==='tree'&&value.path==='.';
  ensure(rootRead||(!/[?*\[\]]/.test(value.path)&&!value.path.includes('\\')&&!value.path.startsWith('/')&&!/^[A-Za-z]:/.test(value.path)&&value.path.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!exclusions.includes(x))),'unsafe or excluded logical path');
  const id=canonical(value);ensure(!seen.has(id),'duplicate path scope');seen.add(id);
 }
}
function declaration(value:TaskDecompositionDeclaration):void{
 exact(value,['taskId','knowledge','reads','writes','resources','reason']);text(value.taskId);text(value.reason);ensure(['declared','unknown'].includes(value.knowledge),'invalid knowledge');paths(value.reads,true);paths(value.writes);list(value.resources);
 const seen=new Set<string>();for(const resource of value.resources){schedulerResourcesConflict(resource,resource);const key=resource.kind+':'+resource.key;ensure(!seen.has(key),'duplicate resource');seen.add(key);}
}
const folded=(p:string)=>p.normalize('NFC').toLowerCase();
function overlap(a:LogicalPathScope,b:LogicalPathScope):boolean{const x=folded(a.path),y=folded(b.path);return a.kind==='tree'&&x==='.'||b.kind==='tree'&&y==='.'||x===y||a.kind==='tree'&&y.startsWith(x+'/')||b.kind==='tree'&&x.startsWith(y+'/');}
/** Original dependencies always win. No declaration can remove an original edge.
 * Outputs remain advisory until compiler/proposal/producer persistence binds them. */
export function projectDeclaredDependencies(steps:DecompositionStep[],input?:GoalDecomposition):DependencyProjection{
 safeResultJSON(steps);if(input!==undefined)safeResultJSON(input);list(steps);ensure(steps.length>0,'empty graph');const ids=new Set<string>();
 for(const step of steps){exact(step,['id','dependencies','acceptanceIds']);text(step.id);ensure(!ids.has(step.id),'duplicate task');ids.add(step.id);list(step.dependencies);list(step.acceptanceIds);ensure(step.acceptanceIds.length>0,'missing original criterion refs');for(const xs of [step.dependencies,step.acceptanceIds]){xs.forEach(text);ensure(new Set(xs).size===xs.length,'duplicate reference');}}
 for(const step of steps)ensure(step.dependencies.every(id=>ids.has(id)&&id!==step.id),'foreign or self dependency');
 const ordered:DecompositionStep[]=[],pending=[...steps];while(pending.length){const i=pending.findIndex(step=>step.dependencies.every(id=>ordered.some(x=>x.id===id)));ensure(i>=0,'dependency cycle');ordered.push(pending.splice(i,1)[0]!);}
 const declarations=new Map<string,TaskDecompositionDeclaration>();if(input){exact(input,['schemaVersion','tasks']);ensure(input.schemaVersion===1,'unsupported schema');list(input.tasks);for(const value of input.tasks){declaration(value);ensure(ids.has(value.taskId)&&!declarations.has(value.taskId),'foreign or duplicate declaration');declarations.set(value.taskId,value);}}
 const tasks=ordered.map(step=>({taskId:step.id,dependencies:[...step.dependencies]})),addedEdges:DependencyProjection['addedEdges']=[];
 for(let i=0;i<ordered.length;i++)for(let j=i+1;j<ordered.length;j++){
  const earlier=ordered[i]!,later=ordered[j]!,a=declarations.get(earlier.id),b=declarations.get(later.id);let reason:DependencyProjection['addedEdges'][number]['reason']|undefined;
  if(!a||!b||a.knowledge==='unknown'||b.knowledge==='unknown')reason='unknown-scope';
  else if(a.writes.some(x=>[...b.reads,...b.writes].some(y=>overlap(x,y)))||b.writes.some(x=>a.reads.some(y=>overlap(x,y))))reason='logical-path-conflict';
  else if(a.resources.some(x=>b.resources.some(y=>schedulerResourcesConflict(x,y))))reason='resource-conflict';
  if(reason&&!tasks[j]!.dependencies.includes(earlier.id)){tasks[j]!.dependencies.push(earlier.id);addedEdges.push({from:earlier.id,to:later.id,reason});}
 }
 return {schemaVersion:1,policyVersion:'conservative-scopes-v1',tasks,addedEdges};
}
function scanGraphFiles(root:string):Record<string,string>{
 const files:Record<string,string>=Object.create(null) as Record<string,string>;let bytes=0,entries=0;
 const walk=(directory:string,depth:number)=>{ensure(depth<=64,'snapshot directory depth exceeded');for(const name of readdirSync(directory).sort()){
  if(exclusions.includes(name))continue;ensure(++entries<=20000,'snapshot entry capacity exceeded');const path=join(directory,name),stat=lstatSync(path);ensure(!stat.isSymbolicLink(),'snapshot symlink');
  if(stat.isDirectory())walk(path,depth+1);else{ensure(stat.isFile(),'unsupported snapshot file');bytes+=stat.size;ensure(Object.keys(files).length<10000&&bytes<=256*1024*1024,'snapshot byte capacity exceeded');files[relative(root,path).split(sep).join('/')]=digest(Buffer.concat([readFileSync(path),Buffer.from('\0executable:'+String(stat.mode&0o111))]));}
 }};walk(root,0);return files;
}
/** Read-only actual snapshot check. Caller must additionally bind these exact
 * snapshots to the real claim/stop/usage/input ledger; this returns no permission. */
export function inspectDeclaredChanges(input:{seed:GraphSeedSnapshot;candidate:Candidate;declaration:TaskDecompositionDeclaration}):{changed:string[];violations:string[];seedDigest:string;candidateDigest:string}{
 safeResultJSON(input);declaration(input.declaration);const {seed,candidate}=input;
 ensure(seed.schemaVersion===1&&seed.kind==='graph-seed'&&canonical(seed.excluded)===canonical(exclusions)&&canonical(candidate.excluded)===canonical(exclusions),'unsupported snapshot');
 const verify=(value:{tree:string;files:Record<string,string>;digest:string})=>{ensure(realpathSync(value.tree)===resolve(value.tree)&&!lstatSync(value.tree).isSymbolicLink(),'snapshot path alias');ensure(digest(canonical(value.files))===value.digest&&canonical(scanGraphFiles(value.tree))===canonical(value.files),'snapshot actual bytes changed');};
 verify(seed);verify(candidate);ensure(seed.tree!==candidate.tree,'distinct source and candidate snapshots required');
 const changed=[...new Set([...Object.keys(seed.files),...Object.keys(candidate.files)])].filter(path=>seed.files[path]!==candidate.files[path]).sort();
 // Exact spelling controls permission; folding is used only to add conservative
 // conflicts, never to broaden a write scope on a case-sensitive filesystem.
 const violations=changed.filter(path=>!input.declaration.writes.some(scope=>scope.path===path||scope.kind==='tree'&&path.startsWith(scope.path+'/')));
 verify(seed);verify(candidate);return {changed,violations,seedDigest:seed.digest,candidateDigest:candidate.digest};
}

/** Same bounded actual byte/mode check for a real stopped execution workspace.
 * The producer separately revalidates the P2 inventory before and after this. */
export function inspectDeclaredWorkspaceChanges(seed:GraphSeedSnapshot,workspace:string,value:TaskDecompositionDeclaration):ReturnType<typeof inspectDeclaredChanges>{
 const files=scanGraphFiles(workspace),candidate:Candidate={root:workspace,tree:workspace,files,digest:digest(canonical(files)),excluded:[...exclusions],createdAt:new Date().toISOString()};
 return inspectDeclaredChanges({seed,candidate,declaration:value});
}
