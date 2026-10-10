import type { Run } from '../contracts/p1.js';
import type { GoalSession } from '../contracts/p5.js';
import type { RuntimeRecord } from '../contracts/p3.js';
import type { ScheduledPlan } from '../contracts/p7-dispatch.js';
import type { GoalGraphAdmission,GoalGraphHostPolicy,GraphPreparationReceipt } from '../contracts/p7-graph.js';
import { admittedPlan } from './admission.js';
import { canonical,digest } from '../verification/candidate.js';
import { futureVerificationFloor } from '../domain/index.js';
import { assertPreparedGraphWorkspaces } from '../workspace/graph-workspaces.js';
function ensure(v:unknown,s:string):asserts v {if(!v)throw Error(s);}
function same(a:unknown,b:unknown):boolean{return canonical(a)===canonical(b);}
/** Reuses the existing paid proposal. The caller still owes normal P5 raw-output,
 * process-stop, proof and requirement authority checks before any DB admission. */
export function buildGoalGraphAdmission(session:GoalSession,baseRun:Run):GoalGraphAdmission{
 ensure(session.id===baseRun.id&&session.projectId===baseRun.projectId,'Goal/Run scope differs');
 ensure(session.phase==='ready'&&!session.runtimeId&&session.proposal?.decision==='ready','Goal is not ready for graph admission');
 ensure(baseRun.admission==='draft'&&baseRun.status==='ready'&&baseRun.attempts.every(a=>a.purpose==='reasoning'&&a.settled&&a.status!=='running')&&baseRun.operations.every(o=>o.status==='confirmed')&&baseRun.leases.every(l=>l.released),'Graph admission requires a settled draft');
 const plan=admittedPlan(session,baseRun),steps=plan.steps.map(s=>{ensure(s.kind==='codex','Graph requires original Codex steps');return s;});
 const source={sessionId:session.id,projectId:session.projectId,workspace:session.workspace,workspaceKind:session.workspaceKind,messages:session.messages,proposal:session.proposal,config:session.config,maxContextChars:session.maxContextChars};
 const sourceDigest=digest(canonical(source)),integrationId='integration-'+sourceDigest.slice(0,32);
 ensure(!steps.some(s=>s.id===integrationId),'Integration ID conflicts with an implementation step');
 const integrationStep={...steps[0]!,id:integrationId,prompt:'Integrate the complete original admitted task in this workspace using all required submitted branch packages supplied by the Supervisor host. Do not merge automatically, discard prior requirements, reduce acceptance coverage, publish externally, or treat branch submissions as independently verified. Implement and run the complete required checks. Independent P4 acceptance remains required after this final integration.\nAUTHORITATIVE CONTRACT (complete):\n'+canonical(plan.contract)+'\nORIGINAL REQUIREMENT MESSAGES (complete):\n'+canonical(session.messages)+'\nORIGINAL IMPLEMENTATION STEPS AND ACCEPTANCE REFERENCES (complete):\n'+canonical(session.proposal.steps)+'\nACCEPTANCE / CONSTRAINTS / STYLE (complete):\n'+canonical({criteria:session.proposal.criteria,constraints:session.proposal.constraints,style:session.proposal.style})};
 for(const s of [...steps,integrationStep])ensure(s.prompt.length<=Math.min(session.maxContextChars,200000),'Graph prompt exceeds the explicit context bound; nothing was truncated');
 const body={schemaVersion:1 as const,policyVersion:'goal-graph-conservative-v1' as const,sessionId:session.id,projectId:session.projectId,baseContractVersion:baseRun.contract.version,sourceDigest,contract:plan.contract,implementationSteps:steps,integrationStep};
 return {...body,digest:digest(canonical(body))};
}
/** No new permissions or model call. Missing write/resource declarations force a
 * conservative sequence while preserving every original dependency and ref. */
export function compileGoalScheduledPlan(input:{session:GoalSession;baseRun:Run;run:Run;runtime:RuntimeRecord;admission:GoalGraphAdmission;preparation:GraphPreparationReceipt;policy:GoalGraphHostPolicy}):ScheduledPlan{
 const {session,baseRun,run,runtime,admission,preparation,policy}=input;
 ensure(same(admission,buildGoalGraphAdmission(session,baseRun)),'Frozen goal graph admission changed');
 ensure(run.id===session.id&&run.projectId===session.projectId&&run.admission==='admitted'&&same(run.contract,admission.contract),'Actual admitted contract differs from the full original requirements');
 ensure(run.status==='ready'&&run.nodes.length===1&&run.nodes[0]!.id===admission.integrationStep.id&&run.nodes[0]!.required&&run.nodes[0]!.status==='pending'&&run.nodes[0]!.dependencies.length===0,'Graph needs the unique unstarted final integration anchor');
 ensure(runtime.runId===run.id&&runtime.projectId===run.projectId&&runtime.workspace===session.workspace&&runtime.workspaceKind===session.workspaceKind&&!runtime.paused&&!runtime.cancelled&&runtime.cursor===0&&runtime.phase==='ready'&&runtime.definition.goal===admission.contract.goal&&runtime.definition.workspace===session.workspace&&runtime.definition.tokenLimit===run.budget.limit&&runtime.definition.verificationReserve===run.budget.verificationReserve&&same(runtime.definition.steps,[admission.integrationStep]),'Actual runtime anchor or frozen prompt differs');
 ensure(same(run.attempts,baseRun.attempts)&&same(run.budget,baseRun.budget)&&same(run.operations,baseRun.operations)&&same(run.leases,baseRun.leases),'Admission changed cumulative accounting or started work');
 ensure(preparation.request.projectId===run.projectId&&preparation.request.runId===run.id&&preparation.request.admissionDigest===admission.digest&&preparation.request.seed.root===runtime.workspace&&same(preparation.request.taskIds,admission.implementationSteps.map(s=>s.id)),'Preparation does not match the admitted task');
 assertPreparedGraphWorkspaces(preparation,preparation.request,policy.preparationRoot);
 ensure(policy.schedulerId.trim()&&['low','medium','high','unlimited'].includes(policy.tier),'Invalid host scheduler policy');
 const limits=policy.limits;ensure(Object.values(limits).every(n=>Number.isSafeInteger(n)&&n>0)&&limits.maxNodes>=admission.implementationSteps.length&&limits.deadlineMs>Date.now(),'Host graph limits do not admit this task');
 const verificationUsed=run.attempts.filter(a=>a.purpose==='verification'&&a.contractVersion===run.contract.version).reduce((n,a)=>n+(a.settled?a.actual!:a.reservation),0);
 const protectedAmount=Math.max(0,run.budget.verificationReserve-verificationUsed,futureVerificationFloor(run));
 const initialExecution=admission.implementationSteps.reduce((n,s)=>n+s.reservation,admission.integrationStep.reservation);
 ensure(Number.isSafeInteger(initialExecution)&&run.budget.limit-run.budget.spent-protectedAmount>=initialExecution,'Initial branches and final integration exceed remaining same-Run execution budget');
 const tasks=admission.implementationSteps.map((step,index)=>{
  const original=session.proposal!.steps.find(s=>s.id===step.id)!;
  const dependencies=[...original.dependencies],prior=admission.implementationSteps[index-1];if(prior&&!dependencies.includes(prior.id))dependencies.push(prior.id);
  const workspace=preparation.workspaces[index]!.path;
  return {node:{id:step.id,dependencies,required:true,admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:[...original.acceptanceIds],quality:'strong' as const,value:'strong' as const,reasons:['Original required P5 step; host retains dependencies and conservatively serializes absent independence declarations']},resources:[{kind:'path' as const,key:workspace,mode:'write' as const}],reservation:step.reservation,loopIds:[]},inputRequirements:dependencies.map(dependencyNodeId=>({dependencyNodeId,minimumState:'submitted' as const})),step:structuredClone(step),workspace,workspaceKind:'managed' as const,generation:1};
 });
 return {schemaVersion:1,engine:'scheduled-v1',workflowVersion:2,id:policy.schedulerId,runtimeId:runtime.id,projectId:run.projectId,runId:run.id,revision:1,contractVersion:run.contract.version,contractDigest:digest(canonical(run.contract)),integrationNodeId:admission.integrationStep.id,tasks,tier:policy.tier,loops:[],limits:structuredClone(limits)};
}
