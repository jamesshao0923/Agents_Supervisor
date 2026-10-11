import {explorationDeclaration} from './exploration.js';
import type { Run } from '../contracts/p1.js';
import type { GoalSession } from '../contracts/p5.js';
import type { RuntimeRecord } from '../contracts/p3.js';
import type { ScheduledPlan } from '../contracts/p7-dispatch.js';
import type { GoalGraphAdmission,GoalGraphHostPolicy,GraphPreparationReceipt } from '../contracts/p7-graph.js';
import {projectDeclaredDependencies} from './decomposition.js';
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
 const optional=session.proposal.exploration??[];
 for(const candidate of optional)steps.push({...steps[0]!,id:candidate.id,prompt:'Perform ONLY the optional supplemental analysis below within its declared read/write scope. Do not implement or replace required work, change business requirements, write outside the declared supplemental directory, access new external resources or claim independent verification. A skipped optional analysis never waives acceptance.\nORIGINAL REQUIREMENTS:\n'+canonical(session.messages)+'\nFULL CORE ACCEPTANCE:\n'+canonical(session.proposal.criteria)+'\nOPTIONAL CANDIDATE AND SOURCES:\n'+canonical(candidate)});
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
 return compileGoalScheduledTemplate({session,baseRun,admission,preparation,policy});
}
/** Deterministic preparation projection only; commit still validates actual Run/runtime. */
export function compileGoalScheduledTemplate(input:{session:GoalSession;baseRun:Run;admission:GoalGraphAdmission;preparation:GraphPreparationReceipt;policy:GoalGraphHostPolicy}):ScheduledPlan{
 const {session,baseRun,admission,preparation,policy}=input;
 ensure(same(admission,buildGoalGraphAdmission(session,baseRun)),'Frozen goal graph template changed');
 const run={...baseRun,contract:admission.contract},runtime={id:session.id,workspace:session.workspace};
 ensure(preparation.request.projectId===run.projectId&&preparation.request.runId===run.id&&preparation.request.admissionDigest===admission.digest&&preparation.request.seed.root===runtime.workspace&&same(preparation.request.taskIds,admission.implementationSteps.map(s=>s.id)),'Preparation does not match the admitted task');
 assertPreparedGraphWorkspaces(preparation,preparation.request,policy.preparationRoot);
 ensure(policy.schedulerId.trim()&&['low','medium','high','unlimited'].includes(policy.tier),'Invalid host scheduler policy');
 const limits=policy.limits;ensure(Object.values(limits).every(n=>Number.isSafeInteger(n)&&n>0)&&limits.maxNodes>=admission.implementationSteps.length&&limits.deadlineMs>Date.now(),'Host graph limits do not admit this task');
 const verificationUsed=run.attempts.filter(a=>a.purpose==='verification'&&a.contractVersion===run.contract.version).reduce((n,a)=>n+(a.settled?a.actual!:a.reservation),0);
 const protectedAmount=Math.max(0,run.budget.verificationReserve-verificationUsed,futureVerificationFloor(run));
 const initialExecution=admission.implementationSteps.filter(step=>session.proposal!.steps.some(core=>core.id===step.id)).reduce((n,s)=>n+s.reservation,admission.integrationStep.reservation);
 ensure(Number.isSafeInteger(initialExecution)&&run.budget.limit-run.budget.spent-protectedAmount>=initialExecution,'Initial branches and final integration exceed remaining same-Run execution budget');
 // Concrete external-resource alias/isolation qualification is not implemented
 // by this automatic bridge. Any declared resource keeps conservative order;
 // it cannot act as a claim of permission or safe external concurrency.
 const declarations=session.proposal!.decomposition,projected=projectDeclaredDependencies(session.proposal!.steps.map(({id,dependencies,acceptanceIds})=>({id,dependencies,acceptanceIds})),declarations?{...declarations,tasks:declarations.tasks.map(task=>task.resources.length?{...task,knowledge:'unknown' as const}:task)}:undefined);
 const optional=session.proposal!.exploration??[];
 const allSteps=[...session.proposal!.steps.map(({id,dependencies,acceptanceIds})=>({id,dependencies,acceptanceIds})),...optional.map(candidate=>({id:candidate.id,dependencies:[...new Set([...session.proposal!.steps.map(core=>core.id),...candidate.dependencies])],acceptanceIds:candidate.relatedCriterionIds}))];
 const allDeclarations={schemaVersion:1 as const,tasks:[...(declarations?.tasks??[]),...optional.map(explorationDeclaration)]};
 const optionalProjection=optional.length?projectDeclaredDependencies(allSteps,allDeclarations):null;
 const tasks=admission.implementationSteps.map((step,index)=>{
  const candidate=optional.find(value=>value.id===step.id);
  if(candidate){
   const declaration=explorationDeclaration(candidate),dependencies=optionalProjection!.tasks.find(task=>task.taskId===step.id)!.dependencies,workspace=preparation.workspaces[index]!.path;
   return {scopeBinding:{schemaVersion:1 as const,sourceDigest:admission.sourceDigest,seed:structuredClone(preparation.request.seed),declaration},node:{id:step.id,dependencies,required:false,admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:[...candidate.relatedCriterionIds],quality:candidate.quality,value:candidate.value,reasons:['Optional supplemental proposal admitted by user tier; original core and criteria remain independently required',candidate.qualityReason,candidate.valueReason,...candidate.sources.map(source=>source.messageId+': '+source.quote)]},resources:[{kind:'path' as const,key:workspace,mode:'write' as const}],reservation:step.reservation,loopIds:[]},inputRequirements:dependencies.map(dependencyNodeId=>({dependencyNodeId,minimumState:'submitted' as const})),step:structuredClone(step),workspace,workspaceKind:'managed' as const,generation:1};
  }
  const original=session.proposal!.steps.find(s=>s.id===step.id)!;
  const dependencies=declarations?[...projected.tasks.find(task=>task.taskId===step.id)!.dependencies]:[...original.dependencies],declaration=declarations?.tasks.find(task=>task.taskId===step.id);
  const prior=admission.implementationSteps[index-1];if(!declarations&&prior&&!dependencies.includes(prior.id))dependencies.push(prior.id);
  const scopeBinding=declaration?.knowledge==='declared'?{schemaVersion:1 as const,sourceDigest:admission.sourceDigest,seed:structuredClone(preparation.request.seed),declaration:structuredClone(declaration)}:undefined;
  const workspace=preparation.workspaces[index]!.path;
  return {...(scopeBinding?{scopeBinding}:{}),node:{id:step.id,dependencies,required:true,admission:{authorized:true,executable:true,relevant:true,duplicate:false,independentVerificationPurpose:null,requirementRefs:[...original.acceptanceIds],quality:'strong' as const,value:'strong' as const,reasons:['Original required P5 step; all original dependencies retained; host computes scope conflicts, serializes uncertainty and enforces declared actual changes at publication']},resources:[{kind:'path' as const,key:workspace,mode:'write' as const}],reservation:step.reservation,loopIds:[]},inputRequirements:dependencies.map(dependencyNodeId=>({dependencyNodeId,minimumState:'submitted' as const})),step:structuredClone(step),workspace,workspaceKind:'managed' as const,generation:1};
 });
 return {schemaVersion:1,engine:'scheduled-v1',workflowVersion:2,id:policy.schedulerId,runtimeId:runtime.id,projectId:run.projectId,runId:run.id,revision:1,contractVersion:run.contract.version,contractDigest:digest(canonical(run.contract)),integrationNodeId:admission.integrationStep.id,tasks,tier:policy.tier,loops:[],limits:structuredClone(limits)};
}
