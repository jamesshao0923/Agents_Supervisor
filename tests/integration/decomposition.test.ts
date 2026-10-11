import {goalProposalSchema} from '../../packages/contracts/p5.js';
import {parseReasonerOutput,validateReasonerSchema} from '../../packages/orchestration/reasoner-schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,cp,chmod,unlink,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TaskDecompositionDeclaration,DecompositionStep} from '../../packages/contracts/p7-decomposition.js';
import {projectDeclaredDependencies,inspectDeclaredChanges} from '../../packages/orchestration/decomposition.js';
import {captureGraphSeed} from '../../packages/workspace/graph-workspaces.js';
import {captureCandidate} from '../../packages/verification/candidate.js';
const steps:DecompositionStep[]=[{id:'a',dependencies:[],acceptanceIds:['original-a']},{id:'b',dependencies:[],acceptanceIds:['original-b']},{id:'c',dependencies:['a'],acceptanceIds:['original-a','original-b']}];
const decl=(taskId:string,path=taskId+'.ts'):TaskDecompositionDeclaration=>({taskId,knowledge:'declared',reads:[],writes:[{path,kind:'file'}],resources:[],reason:'Synthetic declaration tests structural projection only; no model or authorization.'});
const project=(tasks:TaskDecompositionDeclaration[],values=steps)=>projectDeclaredDependencies(values,{schemaVersion:1,tasks});
test('P7-DECOMP-I01 independent declarations preserve every original edge without adding redundant order',()=>{
 const original=structuredClone(steps),result=project(steps.map(s=>decl(s.id)));assert.deepEqual(result.tasks,[{taskId:'a',dependencies:[]},{taskId:'b',dependencies:[]},{taskId:'c',dependencies:['a']}]);assert.deepEqual(steps,original);
 const reordered=project(steps.map(s=>decl(s.id)),[steps[2]!,steps[1]!,steps[0]!]);assert.deepEqual(reordered.tasks.find(x=>x.taskId==='c')?.dependencies,['a']);
});
test('P7-DECOMP-I02 read write overlap and real resource conflict serialize but shared read does not',()=>{
 const a=decl('a','src/a.ts'),b=decl('b','src/b.ts'),c=decl('c');b.reads=[{path:'src',kind:'tree'}];let r=project([a,b,c]);assert.equal(r.addedEdges[0]?.reason,'logical-path-conflict');assert.ok(r.tasks.find(x=>x.taskId==='b')?.dependencies.includes('a'));
 b.reads=[];a.resources=[{kind:'port',key:'host:3000',mode:'write'}];b.resources=[{kind:'port',key:'host:3000',mode:'read'}];r=project([a,b,c]);assert.equal(r.addedEdges[0]?.reason,'resource-conflict');a.resources[0]!.mode='read';assert.deepEqual(project([a,b,c]).addedEdges,[]);
 const first=decl('a','src/a.ts'),second=decl('b','other/b.ts');
 second.reads=[{path:'.',kind:'tree'}];assert.equal(project([first,second],steps.slice(0,2)).addedEdges[0]?.reason,'logical-path-conflict');
 second.reads=[];first.reads=[{path:'.',kind:'tree'}];assert.equal(project([first,second],steps.slice(0,2)).addedEdges[0]?.reason,'logical-path-conflict');
 first.writes=[];second.writes=[];second.reads=[{path:'.',kind:'tree'}];assert.deepEqual(project([first,second],steps.slice(0,2)).addedEdges,[]);
});
test('P7-DECOMP-I03 legacy and incomplete declarations conservatively serialize all ambiguous pairs',()=>{
 const r=projectDeclaredDependencies(steps);assert.deepEqual(r.tasks.map(x=>x.dependencies),[[],['a'],['a','b']]);const a=decl('a'),b=decl('b'),c=decl('c');b.knowledge='unknown';assert.ok(project([a,b,c]).tasks.find(x=>x.taskId==='c')?.dependencies.includes('b'));
 assert.throws(()=>project([a,a]),/duplicate declaration/);assert.throws(()=>project([decl('other')]),/foreign/);assert.throws(()=>projectDeclaredDependencies([{id:'a',dependencies:['b'],acceptanceIds:['x']},{id:'b',dependencies:['a'],acceptanceIds:['x']}]),/cycle/);
});
test('P7-DECOMP-I04 unsafe paths reject and Unicode case aliases add conflicts rather than removing dependencies',()=>{
 for(const path of ['../escape','/absolute','a//b','.supervisor/input','C:/temp','a\\b'])assert.throws(()=>project([decl('a',path)]),/unsafe/);
 for(const path of ['.','./','a/./b','../escape','node_modules','src/.supervisor/x','src/*']){
  assert.throws(()=>project([{...decl('a'),writes:[{path,kind:'tree'}]}]),/unsafe/);
  if(path!=='.')assert.throws(()=>project([{...decl('a'),reads:[{path,kind:'tree'}]}]),/unsafe/);
 }
 assert.throws(()=>project([{...decl('a'),reads:[{path:'.',kind:'file'}]}]),/unsafe/);
 const a=decl('a','SRC/É.ts'),b=decl('b','src/e\u0301.ts');assert.equal(project([a,b,decl('c')]).addedEdges[0]?.reason,'logical-path-conflict');
});
test('P7-DECOMP-I05 actual stopped-style immutable files expose changes deletions creation and executable mode violations',async()=>{
 // Real FS mechanism only. There is no ExecutionRecord and no provider claim.
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-decomp-')));try{
  const source=join(root,'source'),out=join(root,'out');await mkdir(source);await writeFile(join(source,'a.ts'),'old');await writeFile(join(source,'delete.ts'),'keep');await writeFile(join(source,'mode.ts'),'same');const seed=await captureGraphSeed(source,join(root,'seed'));await cp(source,out,{recursive:true});
  await writeFile(join(out,'a.ts'),'changed');await writeFile(join(out,'new.ts'),'new');await unlink(join(out,'delete.ts'));await chmod(join(out,'mode.ts'),0o755);const candidate=await captureCandidate(out,join(root,'candidate'));const value=inspectDeclaredChanges({seed,candidate,declaration:decl('a')});
  assert.deepEqual(value.changed,['a.ts','delete.ts','mode.ts','new.ts']);assert.deepEqual(value.violations,['delete.ts','mode.ts','new.ts']);const rootReader=decl('a');rootReader.reads=[{path:'.',kind:'tree'}];assert.deepEqual(inspectDeclaredChanges({seed,candidate,declaration:rootReader}).violations,value.violations);await writeFile(join(candidate.tree,'a.ts'),'tampered');assert.throws(()=>inspectDeclaredChanges({seed,candidate,declaration:decl('a')}),/actual bytes/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('P7-DECOMP-I06 empty source seed remains distinct from nonempty P4 evidence and unknown symlink bytes cannot pass',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'sv-decomp-')));try{const source=join(root,'source'),out=join(root,'out');await mkdir(source);await mkdir(out);const seed=await captureGraphSeed(source,join(root,'seed'));await assert.rejects(captureCandidate(source,join(root,'empty-candidate')),/no deliverable/);await writeFile(join(out,'A.ts'),'actual');const candidate=await captureCandidate(out,join(root,'candidate'));assert.deepEqual(inspectDeclaredChanges({seed,candidate,declaration:decl('a','a.ts')}).violations,['A.ts']);assert.deepEqual(inspectDeclaredChanges({seed,candidate,declaration:decl('a','A.ts')}).violations,[]);await symlink('/tmp',join(candidate.tree,'alias'));assert.throws(()=>inspectDeclaredChanges({seed,candidate,declaration:decl('a','A.ts')}),/symlink/);
 }finally{await rm(root,{recursive:true,force:true});}
});

// Exercises the actual schema sent to the provider and existing resource domain.
test('P7-DECOMP-I07 model schema distinguishes project file scopes from absolute shared resources',()=>{
 const schema=validateReasonerSchema(goalProposalSchema(['user-1'],'graph-v1'));
 const value={decision:'ready',summary:'One implementation',questions:[],facts:[{text:'Build',sourceId:'user-1',origin:'explicit'}],constraints:[],style:[],criteria:[{id:'check',description:'Actual behavior',kind:'command',target:'math.test.mjs',checks:['Arithmetic and invalid inputs']}],steps:[{id:'a',description:'Implement',dependencies:[],acceptanceIds:['check']}],decomposition:{schemaVersion:1,tasks:[decl('a','math.mjs')]}};
 assert.doesNotThrow(()=>parseReasonerOutput(JSON.stringify(value),schema));
 value.decomposition.tasks[0]!.resources=[{kind:'path',key:'math.mjs',mode:'write'}];assert.throws(()=>parseReasonerOutput(JSON.stringify(value),schema),/branch|pattern/);
 value.decomposition.tasks[0]!.resources=[{kind:'path',key:'/shared/database',mode:'write'}];assert.doesNotThrow(()=>parseReasonerOutput(JSON.stringify(value),schema));assert.doesNotThrow(()=>project(value.decomposition.tasks,[{id:'a',dependencies:[],acceptanceIds:['check']}]));
 value.decomposition.tasks[0]!.resources=[{kind:'path',key:'/shared/../database',mode:'write'}];assert.throws(()=>project(value.decomposition.tasks,[{id:'a',dependencies:[],acceptanceIds:['check']}]),/canonical/);
 value.decomposition.tasks[0]!.resources=[{kind:'database',key:'shared-db',mode:'write'}];assert.doesNotThrow(()=>parseReasonerOutput(JSON.stringify(value),schema));
});
