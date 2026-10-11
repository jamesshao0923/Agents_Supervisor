import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import type {SupervisorStore} from '../../packages/persistence/store.js';
import type {TaskContract} from '../../packages/contracts/p1.js';
import type {GoalProposal} from '../../packages/contracts/p5.js';
import {spawnManagedProcess} from '../../packages/process-control/index.js';
import {parseFollowupEvolution,followupEvolutionReviewSchema} from '../../packages/orchestration/followup-evolution.js';
import {digest,canonical} from '../../packages/verification/candidate.js';
const readFileSyncCompatible=readFileSync;
/** Reuses the ordinary two actual owned authorization processes and explicit
 * synthetic receipts from the existing refresh fixture. No provider claim. */
export async function actualIndexedRefreshFollowup(
 f:{store:SupervisorStore;root:string;workspace:string},sessionId:string,messageId:string,
 originalContract:TaskContract,originalProposal:GoalProposal,rawFollowup:unknown
){
 const begun=f.store.goals.beginFollowup(sessionId,messageId);
 const context={originalContract:originalContract,originalProposal:originalProposal,
  frozenMessages:f.store.conversations.messages(f.store.conversations.message(messageId).conversationId),newMessageId:messageId,session:begun.session,researchConfiguration:begun.session.research};
 const followup=parseFollowupEvolution(rawFollowup,context,[]);
 const reviewSchema=followupEvolutionReviewSchema(followup,context,[]) as {properties:{proposalDigest:{const:string};sourceDigest:{const:string}}};
 const review={...(followup.sourceRefresh?{sourceRefresh:{intentDigest:digest(canonical(followup.sourceRefresh)),authorized:true,reasons:['Explicit synthetic independent review of exact original-only refresh request']}}:{}),approved:true,proposalDigest:reviewSchema.properties.proposalDigest.const,sourceDigest:reviewSchema.properties.sourceDigest.const,
  changes:followup.criterionChanges!.map(change=>({kind:change.kind,criterionId:change.criterionId,authorized:true,reasons:['Explicit synthetic authorization review of actual new user quotation; no model approval claimed']}))};
 const followupJob=begun.session.jobs.at(-1)!,followupProof=join(f.root,followupJob.id+'-authorization.process.json');
 let followupIntent:unknown,followupIdentity:unknown;
 const reasonNode=await spawnManagedProcess({operationId:followupJob.id,command:process.execPath,args:['-e','process.exit(0)'],cwd:f.workspace,timeoutMs:3000,
  onBeforeSpawn:i=>{followupIntent=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.intents.push(i);});},
  onIdentity:i=>{followupIdentity=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.identities.push(i);});}});
 const reasonStop=await reasonNode.completion;assert.equal(reasonStop.stopped,true);
 await writeFile(followupProof,JSON.stringify({intent:followupIntent,identity:followupIdentity,result:reasonStop,output:rawFollowup}));
 const reviewProof=join(f.root,followupJob.id+'-review.process.json');let reviewIntent:unknown,reviewIdentity:unknown;
 const reviewNode=await spawnManagedProcess({operationId:followupJob.id+'-review',command:process.execPath,args:['-e','process.exit(0)'],cwd:f.workspace,timeoutMs:3000,
  onBeforeSpawn:i=>{reviewIntent=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.intents.push(i);});},
  onIdentity:i=>{reviewIdentity=i;f.store.goals.update(sessionId,followupJob.id,j=>{j.identities.push(i);});}});
 const reviewStop=await reviewNode.completion;assert.equal(reviewStop.stopped,true);
 await writeFile(reviewProof,JSON.stringify({intent:reviewIntent,identity:reviewIdentity,result:reviewStop,output:review}));
 const proofMap={[followupProof]:digest(readFileSyncCompatible(followupProof)),[reviewProof]:digest(readFileSyncCompatible(reviewProof))};
 f.store.goals.finish(sessionId,followupJob.id,j=>{j.modelStarted=true;j.usage=2;j.stopConfirmed=true;j.threadId='synthetic-followup-author';j.proofs=proofMap;j.followupResult=followup;j.context={input:context,acceptanceReview:review,callReceipts:[{id:followupJob.id,output:rawFollowup,outputDigest:digest(canonical(rawFollowup)),threadId:'synthetic-proposal-thread',usage:1,stopConfirmed:true,proofs:{[followupProof]:proofMap[followupProof]}},{id:followupJob.id+'-review',output:review,outputDigest:digest(canonical(review)),threadId:'synthetic-authorization-review-thread',usage:1,stopConfirmed:true,proofs:{[reviewProof]:proofMap[reviewProof]}}]};});
 return f.store.goals.applyFollowup(sessionId,followupJob.id);
}
