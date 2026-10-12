import {tokenRemaining,tokenCapacity} from '../contracts/token-policy.js';
import type {GoalProposal,GoalSession} from '../contracts/p5.js';
import type {Run} from '../contracts/p1.js';
import type {ScheduledPlan} from '../contracts/p7-dispatch.js';
import type {GraphSeedSnapshot,GoalGraphAdmission} from '../contracts/p7-graph.js';
import type {GoalIterationProposal,GoalLoopHostPolicy,GoalLoopAdmissionDecision} from '../contracts/p7-goal-loop.js';
import {goalIterationSchema,DEFAULT_GOAL_LOOP_POLICY} from '../contracts/p7-goal-loop.js';
import type {LoopProgramNode,LoopProgramSource} from '../contracts/p7-loop.js';
import {programNodes,validateLoopSource} from './loop-program.js';
import {projectDeclaredDependencies} from './decomposition.js';
import {parseReasonerOutput} from './reasoner-schema.js';
import {canonical,digest,exclusions} from '../verification/candidate.js';
import {futureVerificationFloor,futureExecutionFloor} from '../domain/index.js';
const hash=(v:unknown)=>digest(canonical(v));
function ensure(v:unknown,s:string):asserts v{if(!v)throw Error('Goal loop admission: '+s);}
export function validateGoalLoopPolicy(value:GoalLoopHostPolicy):void{
 ensure(value&&canonical(Object.keys(value).sort())===canonical(['schemaVersion','maxIterations','maxUnchangedIterations'].sort())&&value.schemaVersion===1,'invalid host policy');
 ensure(Number.isSafeInteger(value.maxIterations)&&value.maxIterations>0&&value.maxIterations<=128&&Number.isSafeInteger(value.maxUnchangedIterations)&&value.maxUnchangedIterations>0&&value.maxUnchangedIterations<=128,'invalid host numeric cap');
}
/** Decode exactly one tree; shared children, cycles and unreachable nodes reject. */
export function goalIterationTree(value:GoalIterationProposal):LoopProgramNode{
 parseReasonerOutput(JSON.stringify(value),goalIterationSchema());
 const nodes=value.tree.nodes,seen=new Set<string>();ensure(new Set(nodes.map(n=>n.id)).size===nodes.length,'duplicate strategy node');
 function visit(id:string,depth:number):LoopProgramNode{ensure(depth<=5,'strategy nesting exceeds finite planning capacity');ensure(!seen.has(id),'shared or cyclic strategy node');seen.add(id);const n=nodes.find(n=>n.id===id);ensure(n,'unknown strategy node');if(n.kind==='task')return structuredClone(n);if(n.kind==='loop')return {...structuredClone(n),body:visit(n.body,depth+1)};return {...structuredClone(n),children:n.children.map(child=>visit(child,depth+1))};}
 const tree=visit(value.tree.rootId,0);ensure(seen.size===nodes.length,'unreachable strategy nodes');return tree;
}
/** Validate the entire tree, including dependencies first reached in later bodies. */
export function assertGoalIterationProposal(p:GoalProposal):void{
 if(p.iteration==null)return;
 const tree=goalIterationTree(p.iteration);ensure(p.decision==='ready','clarification cannot propose executable iteration');
 const nodes=programNodes(tree),leaves=nodes.filter((n):n is Extract<LoopProgramNode,{kind:'task'}>=>n.kind==='task');
 ensure(nodes.length<=128&&new Set(nodes.map(n=>n.id)).size===nodes.length,'duplicate or excessive strategy nodes');
 ensure(leaves.length===p.steps.length&&new Set(leaves.map(n=>n.taskId)).size===p.steps.length&&leaves.every(n=>p.steps.some(s=>s.id===n.taskId)),'strategy must cover each original task exactly once');
 ensure(nodes.some(n=>n.kind==='loop'),'strategy has no loop');
 const paths=new Map<string,{node:LoopProgramNode;index:number}[]>();
 function walk(n:LoopProgramNode,path:{node:LoopProgramNode;index:number}[]){if(n.kind==='task'){paths.set(n.taskId,path);return;}if(n.kind==='loop')walk(n.body,[...path,{node:n,index:0}]);else n.children.forEach((child,index)=>walk(child,[...path,{node:n,index}]));}walk(tree,[]);
 const declarations=p.decomposition?{...p.decomposition,tasks:p.decomposition.tasks.map(t=>t.resources.length?{...t,knowledge:'unknown' as const}:t)}:undefined;
 const dependencies=projectDeclaredDependencies(p.steps.map(({id,dependencies,acceptanceIds})=>({id,dependencies,acceptanceIds})),declarations);
 for(const task of dependencies.tasks)for(const dependency of task.dependencies){const a=paths.get(dependency)!,b=paths.get(task.taskId)!;let i=0;while(i<a.length&&i<b.length&&a[i]!.node.id===b[i]!.node.id&&a[i]!.index===b[i]!.index)i++;
  ensure(i<a.length&&i<b.length&&a[i]!.node.id===b[i]!.node.id,'incompatible dependency tree');const common=a[i]!.node;
  if(common.kind==='sequence'){ensure(a[i]!.index<b[i]!.index,'dependency refers to a later sequence subtree');continue;}
  ensure(common.kind==='parallel'&&[...a.slice(i+1),...b.slice(i+1)].every(x=>x.node.kind==='parallel'),'dependency crosses independently repeated or deferred parallel subtrees');
 }
 for(const node of nodes)if(node.kind==='loop'){
  ensure(programNodes(node.body).some(n=>n.kind==='task'&&n.taskId===node.until.taskId),'predicate must name an actual body task');
  const path=node.until.path;ensure(!path.startsWith('/')&&!/^[A-Za-z]:/.test(path)&&!/[\\?*\[\]]/.test(path)&&path.endsWith('.json')&&path.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!exclusions.includes(x)),'unsafe or unsupported numeric artifact');
  const task=p.steps.find(s=>s.id===node.until.taskId)!,declaration=p.decomposition?.tasks.find(d=>d.taskId===task.id);
  ensure(declaration?.knowledge==='declared'&&declaration.resources.length===0&&declaration.writes.some(s=>s.path===path||s.kind==='tree'&&path.startsWith(s.path+'/')),'numeric artifact lacks an exact declared project write scope');
  ensure(task.description.includes(path)&&task.description.includes(node.until.field),'numeric artifact path and field must already be described by the original task');
 }
}
export function goalIterationTaskFraming(p:GoalProposal,taskId:string):string{
 if(!p.iteration)return '';const conditions=programNodes(goalIterationTree(p.iteration)).filter((n):n is Extract<LoopProgramNode,{kind:'loop'}>=>n.kind==='loop'&&n.until.taskId===taskId).map(n=>({loop:n.id,until:n.until}));
 return '\nHOST-VALIDATED INTERNAL ITERATION STRATEGY: Perform only this one occurrence. Read the real supplied predecessor/previous-iteration packages. The host, not this process, decides whether another occurrence is admitted. Numeric artifacts below are internal strategy stop signals, never verification, delivery or permission to change requirements. Preserve declared file scope and all original checks.\n'+canonical(conditions);
}
export function assessGoalIteration(input:{session:GoalSession;baseRun:Run;admission:GoalGraphAdmission;templatePlan:ScheduledPlan;seed:GraphSeedSnapshot;preparationRoot:string;hostPolicy?:GoalLoopHostPolicy}):{decision:GoalLoopAdmissionDecision;source:LoopProgramSource}{
 const {session,baseRun,admission,templatePlan,seed,preparationRoot}=input,proposal=session.proposal!,requested=proposal.iteration,policy=structuredClone(input.hostPolicy??DEFAULT_GOAL_LOOP_POLICY);
 ensure(requested,'missing strategy');assertGoalIterationProposal(proposal);validateGoalLoopPolicy(policy);
 ensure(templatePlan.runId===baseRun.id&&templatePlan.projectId===baseRun.projectId&&templatePlan.runtimeId===session.id&&templatePlan.contractDigest===hash(admission.contract),'actual template scope differs');
 const program={schemaVersion:1 as const,policyVersion:'bounded-data-loop-v1' as const,sourceDigest:hash(templatePlan),tree:goalIterationTree(requested)};
 const source:LoopProgramSource={templatePlan:structuredClone(templatePlan),program,seed:structuredClone(seed),preparationRoot,startedAtMs:Date.parse(seed.createdAt)};validateLoopSource(source);
 const verified=baseRun.attempts.filter(a=>a.purpose==='verification'&&a.contractVersion===admission.contract.version).reduce((n,a)=>n+(a.settled?a.actual!:a.reservation),0),remaining=tokenRemaining(baseRun.budget.limit,baseRun.budget.spent+Math.max(0,baseRun.budget.verificationReserve-verified,futureVerificationFloor(baseRun))+Math.max(futureExecutionFloor(baseRun),admission.integrationStep.reservation));
 const duration=templatePlan.limits.deadlineMs-source.startedAtMs;
 for(const node of programNodes(program.tree))if(node.kind==='loop'){
  ensure(node.limits.iterations<=policy.maxIterations&&node.limits.unchangedIterations<=policy.maxUnchangedIterations,'requested repeat/no-progress cap exceeds host policy');
  ensure(node.limits.durationMs<=duration&&node.limits.tokens<=tokenCapacity(remaining),'requested loop exceeds original time or remaining shared budget');
  const minimum=programNodes(node.body).filter((n):n is Extract<LoopProgramNode,{kind:'task'}>=>n.kind==='task').reduce((n,leaf)=>n+templatePlan.tasks.find(t=>t.node.id===leaf.taskId)!.node.reservation,0);ensure(baseRun.budget.limit===null||node.limits.tokens>=minimum,'loop cannot fund one full original body');
 }
 return {source,decision:{schemaVersion:1,policyVersion:'goal-loop-admission-v1',proposalDigest:hash(requested),hostPolicyDigest:hash({policy,graphLimits:templatePlan.limits,remaining}),taskTemplateDigest:hash(templatePlan),contractDigest:templatePlan.contractDigest,effectiveProgramDigest:hash(program),allowed:true,reasons:['Every original task and criterion retained; full-tree dependencies validated','Host hard bounds and same-Run protected final/P4 allocations retained','Internal numeric yield only; original final integration and independent P4 remain mandatory']}};
}
