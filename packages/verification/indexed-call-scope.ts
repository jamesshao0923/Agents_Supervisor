import {join,resolve} from 'node:path';
import {verificationDirectory} from './scoped-environment.js';
import {selectInstances} from './rules.js';
import type {VerificationInstance} from '../contracts/p4.js';
import type {Proposal,VerificationJob,FrozenPlan} from './records.js';
export interface IndexedCallScope {root:string;role:'definition-review'|'instance';instance?:VerificationInstance;label?:string}
/** Host-derived exact roots for a frozen P4 stage; never supplied by a model. */
export function indexedCallScopes(dataDir:string,job:VerificationJob,proposal:Proposal,plan?:FrozenPlan):IndexedCallScope[]{
 if(job.proposalId!==proposal.id||job.runtimeId!==proposal.runtimeId)throw Error('Indexed call stage differs from actual proposal');
 const directory=verificationDirectory(dataDir,job),scopes:IndexedCallScope[]=[];
 if(job.kind==='review')scopes.push({root:join(directory,'definition-review'),role:'definition-review'});
 const instances=job.kind==='verification'?plan?.selection.instances:selectInstances(proposal.spec,{mode:'final'}).instances;
 if(!instances||job.kind==='verification'&&(plan?.id!==job.planId||plan.proposalId!==proposal.id))throw Error('Indexed call requires actual frozen selection');
 const labels=job.kind==='verification'?['candidate']:proposal.spec.controls.map(c=>'control-'+digestId(c.id));
 for(const label of labels)for(const instance of instances){const definition=proposal.spec.cases.find(c=>c.id===instance.caseId&&c.revision===instance.revision);if(!definition)throw Error('Indexed call frozen detector missing');if(definition.verifier.kind!=='command')scopes.push({root:join(directory,label,instance.id,definition.verifier.kind==='mobile'?'mobile-review':'model'),role:'instance',instance,label});}
 return scopes;
}
import {digest as digestId} from './candidate.js';
export function exactIndexedCallScope(scopes:IndexedCallScope[],root:string):IndexedCallScope{const actual=scopes.find(s=>s.root===root);if(!actual||resolve(root)!==root)throw Error('Indexed call root is not an actual frozen stage/instance');return actual;}
