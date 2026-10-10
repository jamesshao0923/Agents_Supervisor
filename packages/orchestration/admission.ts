import type { GoalProposal, GoalSession, AdmittedPlan } from '../contracts/p5.js';
import type { Run } from '../contracts/p1.js';
import {projectDeclaredDependencies} from './decomposition.js';
import { createRun } from '../domain/index.js';
function ensure(ok:unknown,reason:string):asserts ok {if(!ok)throw new Error(reason);}
export function validateProposal(p:GoalProposal,s:GoalSession):void {
  if(p.decomposition!==undefined&&p.decomposition!==null)projectDeclaredDependencies(p.steps.map(({id,dependencies,acceptanceIds})=>({id,dependencies,acceptanceIds})),p.decomposition);
  ensure(p.facts.every(f=>s.messages.some(m=>m.id===f.sourceId&&(f.origin!=='explicit'||m.text.includes(f.text)))),'Requirement source is missing or misattributed');
  ensure(p.decision!=='clarify'||p.questions.length>0,'Clarification needs concrete questions');
  if(p.decision!=='ready')return;
  ensure(p.questions.length===0,'Unanswered questions prevent admission');
  ensure(p.criteria.length>0&&p.steps.length>0,'Missing acceptance criteria or plan');
  const ids=new Set(p.criteria.map(c=>c.id));ensure(ids.size===p.criteria.length,'Duplicate acceptance id');
  for(const c of p.criteria){ensure(c.checks.length>0,'Acceptance needs observable checks');if(c.kind==='source'){const u=new URL(c.target);ensure(u.protocol==='https:'&&!u.username&&!u.password,'Source acceptance needs HTTPS');}else ensure(!/\s/.test(c.target)&&!c.target.startsWith('/')&&!c.target.includes('\\')&&!c.target.split('/').some(x=>!x||x==='.'||x==='..')&&!c.target.startsWith('.supervisor/'),'Acceptance target escapes project scope');}
  ensure(p.steps.every(x=>x.acceptanceIds.length>0&&x.acceptanceIds.every(id=>ids.has(id))),'Plan has unknown or missing acceptance coverage');
  ensure([...ids].every(id=>p.steps.some(x=>x.acceptanceIds.includes(id))),'Required acceptance is uncovered');
  createRun({id:s.id,projectId:s.projectId,contract:{version:2,goal:s.goal,criteria:p.criteria.map(c=>({id:c.id,description:c.description,required:true}))},nodes:p.steps.map(x=>({id:x.id,dependencies:x.dependencies,required:true})),budget:{limit:1,verificationReserve:0}});
}
export function admittedPlan(s:GoalSession,run:Run):AdmittedPlan {
  const p=s.proposal;ensure(p?.decision==='ready','Requirements are not ready');validateProposal(p,s);
  const done=new Set<string>(),ordered:GoalProposal['steps']=[];
  while(ordered.length<p.steps.length){const next=p.steps.find(x=>!done.has(x.id)&&x.dependencies.every(d=>done.has(d)));ensure(next,'Cyclic plan');done.add(next.id);ordered.push(next);}
  const authority=s.messages.map(m=>`${m.id}: ${m.text}`).join('\n');
  return {contract:{version:run.contract.version+1,goal:'Authoritative user requirements in chronological order. Later explicit changes override earlier requests:\n'+authority,criteria:p.criteria.map(c=>({id:c.id,description:[c.description,`Acceptance kind: ${c.kind}; target: ${c.target}`,...c.checks].join('\n'),required:true}))},steps:ordered.map(step=>({id:step.id,kind:'codex',model:s.config.model,effort:s.config.effort,reservation:s.config.reservation,timeoutMs:s.config.timeoutMs,prompt:`Implement this admitted Supervisor task inside the current workspace. User requirements are authoritative; do not change or weaken acceptance. Do not operate outside this project or publish externally. This is one fixed step, not an autonomous retry loop.\nUSER REQUIREMENTS:\n${authority}\nCURRENT STEP:\n${JSON.stringify(step)}\nDECLARED SCOPE (only this task; do not modify other source paths or dependency copies; unknown scope gives no independence):\n${JSON.stringify(p.decomposition?.tasks.find(task=>task.taskId===step.id)??null)}\nACCEPTANCE:\n${JSON.stringify(p.criteria)}\nCONSTRAINTS / STYLE:\n${JSON.stringify({constraints:p.constraints,style:p.style})}\nLeave real implementation and executable checks for the acceptance items in their specified project-relative targets. Preserve .supervisor memory. Record changed interfaces, unfinished work and failures in your final response. Completing this step is not independent acceptance or delivery.`}))};
}
