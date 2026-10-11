import {authorRecoveryInput,authorWireInput,type AuthorRecoveryFeedback} from '../orchestration/author-presentation.js';
import {assertAuthorWireProof} from '../orchestration/author-presentation-proofs.js';
import {readAuthorReviewRejection} from './author-review-rejection.js';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync,readdirSync} from 'node:fs';
import {join,relative,isAbsolute,sep} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {AuthorRejection,AuthorRouteReceipt} from '../contracts/p6-author-routing.js';
import type {RoutingCapabilities,SupervisionRoutingPolicy} from '../contracts/p6-routing.js';
import {SUPERVISOR_ROUTING_POLICY_V1} from '../contracts/p6-routing.js';
import {SupervisionRepository} from './supervision.js';
import {RuntimeRepository,runtimeCanonical as canonical} from './runtime.js';
import {VerificationRepository} from './verification.js';
import {readRoutingCapabilities} from '../orchestration/supervision-routing-capabilities.js';
import {selectAcceptanceAuthorRoute} from '../orchestration/acceptance-authoring-route.js';
import {acceptanceReferenceDiagnostic} from '../orchestration/acceptance-authoring-feedback.js';
import {acceptanceAuthoringSchema,diagnoseAcceptanceAuthoringResult,type AcceptanceAuthoringContext} from '../orchestration/acceptance-authoring.js';
import {parseReasonerOutput,ReasonerSchemaError} from '../orchestration/reasoner-schema.js';
import {assertCandidate,environmentFingerprint,exclusions,canonical as candidateCanonical,type Candidate} from '../verification/candidate.js';
import {inspectProcess,type ProcessIdentity} from '../process-control/index.js';
import type {ExecutionRecord} from '../contracts/p2.js';
import type {Run} from '../contracts/p1.js';
const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const hash=(v:unknown)=>sha(canonical(v));
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function ensure(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
function files(directory:string):Record<string,string>{const root=realpathSync(directory),out:Record<string,string>={};let total=0;const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){if(exclusions.includes(name))continue;const path=join(dir,name),s=lstatSync(path);ensure(!s.isSymbolicLink(),'Author candidate symlink');if(s.isDirectory())walk(path);else{ensure(s.isFile(),'Unsupported author candidate file');total+=s.size;ensure(total<=256*1024*1024&&Object.keys(out).length<10000,'Author candidate capacity');out[relative(root,path).split(sep).join('/')]=createHash('sha256').update(readFileSync(path)).update('\0executable:'+String(s.mode&0o111)).digest('hex');}}};walk(root);return out;}
export interface BeginAuthorRoute {commandId:string;loopId:string;expectedRevision:number;previousJobId:string;rejection:AuthorRejection;capabilities:RoutingCapabilities}
/** This repository grants one replacement author reservation, never acceptance or repair. */
export class AuthorRoutingRepository {
 private readonly supervision:SupervisionRepository;private readonly runtime:RuntimeRepository;
 constructor(private readonly db:DatabaseSync,private readonly dataDir:string,private readonly policy:SupervisionRoutingPolicy=SUPERVISOR_ROUTING_POLICY_V1){this.supervision=new SupervisionRepository(db);this.runtime=new RuntimeRepository(db);}
 transaction<T>(body:()=>T):T{return this.supervision.transaction(body);}
 routes(loopId:string):AuthorRouteReceipt[]{return this.db.prepare('SELECT record FROM supervision_author_routes WHERE loop_id=? ORDER BY rowid').all(loopId).map(r=>JSON.parse(String(r.record)) as AuthorRouteReceipt);}
 /** All writers sharing the filesystem boundary matter, even in another Run.
  * The exact set is frozen into assessment, then re-read under begin's lock. */
 private workspaceBoundary(workspace:string){
  const executions=this.db.prepare('SELECT record FROM executions ORDER BY id').all().map(row=>JSON.parse(String(row.record)) as ExecutionRecord).filter(e=>overlaps(e.workspace,workspace));
  const ledgers=executions.map(execution=>{
   ensure(['completed','cancelled','failed','interrupted'].includes(execution.state)&&execution.stopConfirmed,'Workspace has active or unverified execution');
   ensure(execution.usageStatus==='reported'&&execution.usage!==null&&Number.isSafeInteger(execution.usage.totalTokens)&&execution.usage.totalTokens>=0,'Workspace execution accounting unresolved');
   const row=this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(execution.projectId,execution.runId);ensure(row,'Workspace execution Run missing');
   const run=JSON.parse(String(row.snapshot)) as Run,attempt=run.attempts.find(a=>a.id===execution.attemptId),operations=run.operations.filter(o=>o.attemptId===execution.attemptId),leases=run.leases.filter(l=>l.attemptId===execution.attemptId);
   ensure(attempt?.purpose==='execution'&&attempt.status!=='running'&&attempt.settled&&attempt.actual===execution.usage.totalTokens&&operations.length>0&&operations.every(o=>o.status==='confirmed')&&leases.every(l=>l.released),'Workspace execution ledger is unsettled or effects unresolved');
   return {executionId:execution.id,attempt,operations,leases};
  });
  const verification=new VerificationRepository(this.db);verification.assertNoVerificationWriter(workspace);
  const jobs=verification.list('job').filter(job=>overlaps(job.workspace,workspace)).sort((a,b)=>a.id.localeCompare(b.id));
  return {executions,jobs,ledgers};
 }
 private actual(loopId:string,jobId:string,reviewRebuild=false){
  const loop=this.supervision.get(loopId),job=this.supervision.job(jobId),{runtime,run}=this.runtime.inspect(loop.runtimeId);
  this.supervision.assertEligible(loop.id);
  ensure(loop.phase===(reviewRebuild?'reviewing':'authoring')&&loop.references.authorJobId===job.id&&!runtime.paused&&!runtime.cancelled,'Author rejection is not current');
  ensure(job.loopId===loopId&&job.runtimeId===runtime.id&&job.projectId===run.projectId&&job.runId===run.id&&job.contractVersion===run.contract.version&&job.contractDigest===loop.contractDigest,'Author scope changed');
  ensure(job.purpose==='acceptance-authoring'&&job.status==='finished'&&job.modelStarted&&job.stopConfirmed&&job.threadId&&job.usage!==null&&job.usage>=job.observedUsage&&job.usage<=job.config.reservation,'Author stop or accounting is unresolved');
  const attempt=run.attempts.find(a=>a.id===job.attemptId);
  ensure(attempt?.purpose==='reasoning'&&attempt.nodeId==='@supervisor'&&attempt.contractVersion===job.contractVersion&&attempt.reservation===job.config.reservation&&attempt.settled&&attempt.actual===job.usage&&attempt.status===(job.error?'failed':'succeeded'),'Author actual accounting changed');
  ensure(run.attempts.every(a=>a.settled&&a.status!=='running')&&run.operations.every(o=>o.status==='confirmed')&&run.leases.every(l=>l.released),'Author recovery requires fully settled quiet boundary');
  ensure(run.operations.some(o=>o.id===job.id&&o.attemptId===job.attemptId),'Author operation missing');
  ensure(hash({usage:job.reportedUsage??job.usage,stopConfirmed:job.stopConfirmed,error:job.error,proofs:job.proofs,threadId:job.threadId,result:job.result})===job.completionDigest,'Author completion changed');
  ensure(hash(job.input)===job.inputDigest,'Author input digest changed');
  const input=job.input as {prompt:string;outputSchema:Record<string,unknown>;context:{acceptance:AcceptanceAuthoringContext;candidate:Candidate;authorFeedback?:unknown;evolution?:unknown}};
  ensure(input&&Object.keys(input).sort().join(',')==='context,outputSchema,prompt'&&typeof input.prompt==='string'&&input.context?.acceptance&&input.context.candidate,'Author input missing');
  ensure(!Object.hasOwn(input.context,'evolution'),'V2 author recovery is not implemented');
  ensure(reviewRebuild||!Object.hasOwn(input.context,'authorFeedback'),'Author replacement limit exhausted');
  if(reviewRebuild)ensure(!this.routes(loopId).some(r=>r.rejection.kind==='review'),'Review reconstruction limit exhausted');
  ensure(same(input.context.acceptance.contract,run.contract)&&input.context.candidate.root===runtime.workspace,'Author frozen contract/workspace changed');
  const candidate=input.context.candidate;
  ensure(sha(candidateCanonical(candidate.files))===candidate.digest&&same(files(candidate.tree),candidate.files)&&same(files(candidate.root),candidate.files),'Author actual candidate changed');
  const textSnapshot=input.context.acceptance.candidate;
  ensure(textSnapshot.workspace===candidate.root&&textSnapshot.digest===candidate.digest&&same(textSnapshot.files.map(f=>f.path).sort(),Object.keys(candidate.files).sort()),'Author text snapshot does not cover the actual candidate');
  for(const file of textSnapshot.files){const bytes=readFileSync(join(candidate.tree,file.path));ensure(bytes.equals(Buffer.from(file.content,'utf8'))&&sha(bytes)===file.sha256,'Author prompt text differs from actual frozen candidate bytes');}
  const workspaceBoundary=this.workspaceBoundary(runtime.workspace);
  const logs=join(realpathSync(this.dataDir),'supervision-reasoning',sha(job.id));let bytes=0;
  for(const [path,digest]of Object.entries(job.proofs)){const stat=lstatSync(path),resolved=realpathSync(path),suffix=relative(logs,resolved);ensure(stat.isFile()&&!stat.isSymbolicLink()&&suffix&&!suffix.startsWith('..'+sep)&&suffix!=='..'&&!isAbsolute(suffix),'Author proof escaped private root');bytes+=stat.size;ensure(bytes<=64*1024*1024&&sha(readFileSync(path))===digest,'Author proof changed or exceeded capacity');}
  const read=(name:string)=>{const path=join(logs,name);ensure(Object.hasOwn(job.proofs,path),'Author required proof missing: '+name);return readFileSync(path,'utf8');};
  const wire=authorWireInput(input,job.purpose);
  assertAuthorWireProof(job,logs);
  const raw=read('output.txt');ensure(Buffer.byteLength(raw)<=2*1024*1024,'Author raw output exceeds capacity');
  const result=JSON.parse(read('result.json')),events=read('events.jsonl').trim().split('\n').map(line=>JSON.parse(line));
  ensure(result.threadId===job.threadId&&result.usage===job.usage&&result.stopConfirmed===true&&result.modelStarted===true,'Author transport accounting changed');
  const recorded=events.filter(e=>e.kind==='reasoner-input');ensure(recorded.length===1&&recorded[0].value.id===job.id&&recorded[0].value.prompt===wire.prompt&&same(recorded[0].value.outputSchema,input.outputSchema)&&recorded[0].value.model===job.config.model&&recorded[0].value.effort===job.config.effort,'Actual author prompt/schema/config changed');
  const completed=events.filter(e=>e.kind==='codex-event'&&e.value?.raw?.method==='turn/completed').map(e=>e.value.raw.params);
  ensure(completed.length===1&&completed[0].threadId===job.threadId&&completed[0].turn.id===result.turnId&&completed[0].turn.status==='completed','Actual provider turn was not completed');
  const messages=completed[0].turn.items.filter((i:any)=>i.type==='agentMessage');ensure(messages.at(-1)?.text===raw,'Raw author output differs from actual completed message');
  ensure(job.identities.length>0&&job.identities.length===job.intents.length&&new Set(job.identities.map(i=>i.operationId)).size===job.identities.length,'Author process ownership incomplete');
  for(const id of job.identities){const intent=job.intents.find(i=>i.operationId===id.operationId&&i.ownerToken===id.ownerToken);const stops=events.filter(e=>e.kind==='process-stop'&&same(e.value?.result?.identity,id));ensure(intent&&stops.length===1&&stops[0].value.result.stopped&&stops[0].value.result.stop?.status==='stopped'&&stops[0].value.result.stop.stopped&&stops[0].value.result.stop.members.length===0,'Author process stop evidence incomplete');}
  let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw Error('Author raw JSON is incomplete; not a schema rejection');}
  let schemaError:ReasonerSchemaError|undefined;try{parseReasonerOutput(raw,input.outputSchema);}catch(e){if(!(e instanceof ReasonerSchemaError))throw e;schemaError=e;}
  let kind:AuthorRejection['kind'],message:string;let review:AuthorRejection['review'];
  if(reviewRebuild){ensure(!schemaError&&job.error===null&&same(result.value,parsed)&&same(job.result,parsed)&&result.outputRejection===undefined&&!diagnoseAcceptanceAuthoringResult(parsed,input.context.acceptance),'Review rebuild requires a complete valid original author');review=readAuthorReviewRejection(this.db,this.dataDir,loop,job,input.context.acceptance,run);kind='review';message=review.classification+': '+review.review.error;}
  else if(schemaError){const marker={schemaVersion:1,kind:'schema',rawOutputDigest:sha(raw),message:schemaError.message},error=JSON.parse(read('error.json'));ensure(job.error===schemaError.message&&job.result===null&&result.value===null&&same(result.outputRejection,marker)&&error.name==='ReasonerSchemaError'&&error.message===schemaError.message,'Author schema failure lacks typed transport classification');kind='schema';message=schemaError.message;}
  else {ensure(job.error===null&&same(result.value,parsed)&&same(job.result,parsed)&&result.outputRejection===undefined,'Author failed for a non-schema reason');let diagnostic:{message:string}|null;try{diagnostic=diagnoseAcceptanceAuthoringResult(parsed,input.context.acceptance);}catch(error){if(!(error instanceof ReasonerSchemaError))throw error;diagnostic={message:error.message};}ensure(diagnostic,'Author result is not rejected');kind='semantic';message=diagnostic.message;}
  const rejection:AuthorRejection={schemaVersion:1,kind,previousJobId:job.id,jobDigest:hash(job),inputDigest:job.inputDigest,schemaDigest:hash(input.outputSchema),rawOutputPath:join(logs,'output.txt'),rawOutputDigest:sha(raw),message,raw:parsed,proofsDigest:hash(job.proofs),workspaceBoundaryDigest:hash(workspaceBoundary),...(review?{review}:{})};
  return {loop,job,run,runtime,input,rejection,workspaceBoundary};
 }
 async assess(loopId:string,jobId:string,reviewRebuild=false):Promise<AuthorRejection>{
  ensure(!this.db.isTransaction,'Physical author inspection must precede transaction');const before=this.actual(loopId,jobId,reviewRebuild);
  if(before.rejection.review)ensure(before.rejection.review.review.environmentDigest===(await environmentFingerprint(before.rejection.review.review.environmentScope)).digest,'Rejected review environment changed');
  const identities=[...before.job.identities];
  for(const execution of before.workspaceBoundary.executions)if(execution.identity)identities.push(execution.identity as ProcessIdentity);
  for(const verification of before.workspaceBoundary.jobs)identities.push(...verification.identities);
  for(const identity of identities)ensure((await inspectProcess(identity)).status==='stopped','Author boundary process is not physically stopped');
  await assertCandidate(before.input.context.candidate);
  const after=this.actual(loopId,jobId,reviewRebuild);ensure(same(before.rejection,after.rejection),'Author rejection changed during physical inspection');return after.rejection;
 }
 begin(input:BeginAuthorRoute):{receipt:AuthorRouteReceipt;job:ReturnType<SupervisionRepository['job']>}{return this.transaction(()=>{
  ensure(typeof input.commandId==='string'&&input.commandId.trim()&&input.commandId.length<=200,'Invalid author command');
  const request={...input,policyDigest:hash(this.policy)},prior=this.db.prepare('SELECT request,record FROM supervision_author_routes WHERE command_id=?').get(input.commandId);
  if(prior){ensure(prior.request===canonical(request),'Conflicting author route commandId');const receipt=JSON.parse(String(prior.record)) as AuthorRouteReceipt;return {receipt,job:this.supervision.job(receipt.nextJobId)};}
  const value=this.actual(input.loopId,input.previousJobId,input.rejection.kind==='review');ensure(value.loop.revision===input.expectedRevision,'Stale author route revision');ensure(same(value.rejection,input.rejection),'Author rejection binding changed');
  ensure(!this.routes(input.loopId).some(r=>r.rejection.previousJobId===input.previousJobId),'Author already has a replacement');
  const actual=readRoutingCapabilities(this.dataDir,input.capabilities),age=Date.now()-Date.parse(actual.checkedAt);ensure(age>=0&&age<=this.policy.capabilityMaxAgeMs,'Author capabilities stale or from future');
  const selected=selectAcceptanceAuthorRoute(actual,value.job.config,this.policy);
  // Full immutable proof inventories stay in the route receipt. The model gets
  // all authored bytes, actual control checks/reasons/logs and review judgment;
  // protocol-file paths are operational metadata, not additional source context.
  const bound=input.rejection.review;
  const rejectionFeedback=bound?{schemaVersion:1,kind:'review',message:input.rejection.message,raw:input.rejection.raw,rawOutputDigest:input.rejection.rawOutputDigest,authorProofsDigest:input.rejection.proofsDigest,review:{classification:bound.classification,proposalId:bound.proposalId,proposalDigest:bound.proposalDigest,baseDigest:bound.baseDigest,candidateDigest:bound.candidateDigest,definitionDigest:bound.definitionDigest,reviewId:bound.review.id,reviewDigest:hash(bound.review),proofsDigest:hash(bound.review.proofs),usage:bound.review.usage,stopConfirmed:bound.review.stopConfirmed,controls:bound.review.controls.map(c=>({id:c.id,passed:c.passed,results:c.results.map(({proofFiles:_paths,...result})=>result)})),diagnostics:bound.diagnostics,independentReview:bound.independentReview?{verdict:bound.independentReview.verdict,reason:bound.independentReview.reason,observations:bound.independentReview.observations,usage:bound.independentReview.usage,threadId:bound.independentReview.threadId,turnId:bound.independentReview.turnId}:null}}:input.rejection;
  const feedback={schemaVersion:1,attempt:1,previousJobId:value.job.id,inputDigest:value.job.inputDigest,rejection:rejectionFeedback,references:acceptanceReferenceDiagnostic(input.rejection.raw)};
  const context={...structuredClone(value.input.context),authorFeedback:feedback};
  const nextInput=authorRecoveryInput({...context,authorFeedback:feedback as AuthorRecoveryFeedback},acceptanceAuthoringSchema(context.acceptance));
  ensure(canonical(nextInput).length+6000<=value.loop.limits.maxContextChars,'Author recovery exceeds complete context capacity; no truncation');
  const job=this.supervision.beginJob({commandId:input.commandId+':job',loopId:value.loop.id,expectedRevision:value.loop.revision,purpose:'acceptance-authoring',context:nextInput,config:selected});
  const current=this.supervision.get(value.loop.id),references={...current.references,authorJobId:job.id};if(input.rejection.kind==='review'){delete references.proposalId;delete references.reviewId;}this.supervision.update(current.id,current.revision,{phase:'authoring',reason:null,references});
  const receipt:AuthorRouteReceipt={schemaVersion:1,id:'author-route-'+sha(input.commandId).slice(0,24),commandId:input.commandId,loopId:input.loopId,contractDigest:value.loop.contractDigest,rejection:structuredClone(input.rejection),policy:structuredClone(this.policy),policyDigest:hash(this.policy),capabilities:structuredClone(input.capabilities),baseline:value.job.config,selected,nextInputDigest:job.inputDigest,nextJobId:job.id,createdAt:new Date().toISOString()};
  this.db.prepare('INSERT INTO supervision_author_routes VALUES(?,?,?,?,?,?)').run(receipt.id,input.commandId,input.previousJobId,input.loopId,canonical(request),canonical(receipt));return {receipt,job};
 });}
}
