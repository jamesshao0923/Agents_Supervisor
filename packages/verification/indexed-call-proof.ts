import {join} from 'node:path';
import {assertIndexedConsumerArchiveSync} from '../runtime/indexed-research-consumer.js';
import {researchDigest} from '../workspace/research-materials.js';
import {readBounded} from '../workspace/research-runtime-files.js';
import {canonical,digest} from './candidate.js';
import {readMaterialBindingSync} from './material.js';
import {indexedCallScopes,exactIndexedCallScope} from './indexed-call-scope.js';
import {verificationDirectory} from './scoped-environment.js';
import type {Proposal,VerificationJob} from './records.js';
import type {SupervisorStore} from '../persistence/store.js';
import type {ProcessIdentity} from '../process-control/index.js';
import type {ResearchReaderAudit} from '../contracts/p8-research-reader.js';
function ensure(v:unknown,m:string):asserts v{if(!v)throw Error('Indexed call proof: '+m);}
/** The same correlation is required by definition publication and by final capture. */
export function assertIndexedToolCorrelation(records:ResearchReaderAudit[],events:ReturnType<typeof JSON.parse>[],threadId:string,turnId:string):Set<number>{
 const permitted=new Set<number>();
 for(const record of records.filter(r=>r.stage==='observed')){
  const written=records.find(r=>r.stage==='written'&&r.rpcId===record.rpcId&&r.callId===record.callId);
  const request=events.find(e=>e.kind==='server-request'&&e.raw?.id===record.rpcId&&researchDigest(e.raw)===record.requestDigest);
  const item=events.find(e=>e.sequence===record.eventSequence);
  const started=events.find(e=>e.method==='item/started'&&e.sequence<record.eventSequence!&&e.raw?.params?.item?.id===record.itemId);
  const same=(e:typeof item)=>e&&e.threadId===threadId&&e.turnId===turnId&&e.raw?.params?.item?.type==='dynamicToolCall'&&e.raw.params.item.id===record.itemId&&e.raw.params.item.namespace==null&&e.raw.params.item.tool===(record.request?.type==='range'?'research_material_range':'research_material_search')&&canonical(e.raw.params.item.arguments)===canonical(Object.fromEntries(Object.entries(record.request!).filter(([key])=>key!=='type')));
  ensure(written&&request&&request.method==='item/tool/call'&&request.sequence<item?.sequence&&request.threadId===threadId&&request.turnId===turnId&&same(started)&&same(item)&&item.method==='item/completed'&&item.raw.params.item.status==='completed'&&item.raw.params.item.success===true&&canonical(item.raw.params.item.contentItems)===canonical(written.response?.contentItems)&&record.responseDigest===written.responseDigest,'Tool response differs from exact same-turn journal');
  permitted.add(request.sequence);permitted.add(started.sequence);permitted.add(item.sequence);
 }
 return permitted;
}
export function assertIndexedCall(job:VerificationJob,proposal:Proposal,root:string){
 const read=(name:string,limit=8*1024*1024)=>{const p=join(root,name);ensure(job.proofs[p]&&digest(readBounded(p,limit))===job.proofs[p],'Required actual call proof missing/changed: '+name);return readBounded(p,limit).toString('utf8');};
 const events=read('events.jsonl').trim().split('\n').map(line=>JSON.parse(line)),result=JSON.parse(read('result.json'));
 const inputs=events.filter(e=>e.kind==='review-input');ensure(inputs.length===1&&typeof inputs[0].value.prompt==='string','Exact actual call prompt missing');
 const input=inputs[0].value,process=JSON.parse(read('review.process.json')),identity=process.identity as ProcessIdentity;
 ensure(identity&&job.identities.some(i=>canonical(i)===canonical(identity))&&process.intent&&job.intents.some(i=>canonical(i)===canonical(process.intent))&&process.result?.stopped===true&&process.intent.operationId===identity.operationId&&process.intent.ownerToken===identity.ownerToken,'Exact actual model process binding missing');
 for(const [kind,value]of [['process-intent',process.intent],['process-identity',identity],['process-stop',process.result]])ensure(events.some(e=>e.kind===kind&&e.value.kind==='review'&&canonical(e.value[kind==='process-intent'?'intent':kind==='process-identity'?'identity':'result'])===canonical(value)),'Actual call process event differs');
 ensure(input.model===job.config.model&&input.effort===job.config.effort&&input.cwd===(job.environmentScope?.workspace??job.workspace),'Actual call configuration differs');
 const bindingPath=join(root,'indexed-reader','binding.json');read('indexed-reader/binding.json');
 const bindings=proposal.spec.cases.flatMap(c=>c.verifier.kind==='material'?[c.verifier.binding]:[]).filter(b=>readMaterialBindingSync(b).input.indexed);
 ensure(bindings.length>0,'Actual indexed producer missing');
 const actual=assertIndexedConsumerArchiveSync(bindingPath,{jobId:job.id,attemptId:job.attemptId,identities:[identity]});
 ensure(actual.proof.grantVersion===2&&actual.proof.callRoot===root&&bindings.every(binding=>{const indexed=readMaterialBindingSync(binding).input.indexed!;return canonical(indexed)===canonical(actual.proof.reader)&&actual.proof.owner.inputDigest===researchDigest({request:job.request,proposal:proposal.id,definition:proposal.bundle.digest,detectorDigest:digest(input.prompt),binding,reader:indexed.digest,callRoot:root});}),'Actual prompt/producer reader grant differs');
 for(const[p,sha]of Object.entries(actual.proof.files))ensure(job.proofs[p]===sha&&digest(readBounded(p,6*1024*1024))===sha,'Actual call archive inventory missing/changed');
 ensure(result.modelStarted&&result.stopConfirmed&&result.threadId&&result.turnId&&Number.isSafeInteger(result.usage)&&result.usage>0&&result.usage<=job.usage,'Actual call terminal/accounting incomplete');
 const thread=events.filter(e=>e.kind==='review-thread'),turn=events.filter(e=>e.kind==='review-turn-started'),intents=events.filter(e=>e.kind==='review-turn-intent');
 ensure(thread.length===1&&thread[0].value.thread.id===result.threadId&&turn.length===1&&turn[0].value.turn.id===result.turnId&&intents.length===1&&intents[0].value.threadId===result.threadId&&canonical(intents[0].value.input.filter((i:{type:string})=>i.type==='text'))===canonical([{type:'text',text:input.prompt}]),'Actual prompt/thread/turn acknowledgement differs');
 const normalized=events.filter(e=>e.kind==='codex-event').map(e=>e.value),raw=events.filter(e=>e.kind==='codex-raw').map(e=>JSON.parse(e.value.line));
 const permitted=assertIndexedToolCorrelation(actual.records,normalized,result.threadId,result.turnId);
 for(const e of normalized.filter(e=>permitted.has(e.sequence)||e.kind==='turn-status'&&e.terminal))ensure(raw.some(r=>canonical(r)===canonical(e.raw)),'Normalized event differs from original wire');
 ensure(normalized.some(e=>e.kind==='turn-status'&&e.terminal&&e.status==='completed'&&e.method==='turn/completed'&&e.threadId===result.threadId&&e.turnId===result.turnId&&e.raw.params.turn?.error==null),'Actual clean terminal missing');
 const usage=normalized.filter(e=>e.kind==='token-usage'&&e.threadId===result.threadId&&(!e.turnId||e.turnId===result.turnId)).map(e=>e.tokenUsage?.total?.totalTokens);ensure(usage.length&&usage.every((v,i)=>Number.isSafeInteger(v)&&v>=0&&(i===0||v>=usage[i-1]))&&usage.at(-1)===result.usage,'Actual call usage differs');
 const text=normalized.filter(e=>e.method==='item/completed'&&e.threadId===result.threadId&&e.turnId===result.turnId&&e.raw?.params?.item?.type==='agentMessage').at(-1)?.text;ensure(text===read('output.txt')&&canonical(JSON.parse(text))===canonical({verdict:result.verdict,reason:result.reason,observations:result.observations}),'Actual completed output differs');
 ensure(!normalized.some(e=>['protocol-error','waiting'].includes(e.kind)||e.kind==='error'&&e.willRetry!==true||e.kind==='turn-status'&&e.terminal&&e.status!=='completed'||e.kind==='server-request'&&!permitted.has(e.sequence)||['item/started','item/completed'].includes(e.method)&&!permitted.has(e.sequence)&&!['userMessage','reasoning','agentMessage','contextCompaction'].includes(e.raw?.params?.item?.type)),'Fatal/unauthorized tool remains in actual call');
 return actual;
}
/** Mandatory call roots come from frozen instances and actual classifications, never a mutable proof whitelist. */
export function assertIndexedVerificationCalls(store:Pick<SupervisorStore,'verification'>,job:VerificationJob){
 const proposal=store.verification.get('proposal',job.proposalId);
 if(!proposal.spec.cases.some(c=>c.verifier.kind==='material'&&readMaterialBindingSync(c.verifier.binding).input.indexed))return;
 const scopes=indexedCallScopes(store.verification.dataDirectory(),job,proposal,job.planId?store.verification.get('plan',job.planId):undefined),roots=new Set<string>();
 if(job.kind==='review')roots.add(scopes.find(s=>s.role==='definition-review')!.root);
 const add=(results:VerificationJob['results'],label:string)=>{for(const result of results){const scope=scopes.find(s=>s.label===label&&s.instance?.id===result.instanceId);if(!scope)continue;const definition=proposal.spec.cases.find(c=>c.id===scope.instance!.caseId&&c.revision===scope.instance!.revision)!;if(result.executionStatus==='executed'&&definition.verifier.kind==='material'){
  roots.add(scope.root);const actual=assertIndexedCall(job,proposal,scope.root),model=JSON.parse(readBounded(join(scope.root,'result.json')).toString('utf8'));
  const obligations=proposal.spec.obligations.filter(o=>scope.instance!.obligationIds.includes(o.id));
  ensure(canonical(result.checks)===canonical(obligations.map(o=>({obligationId:o.id,verdict:o.applicable?model.verdict:'not-applicable',reason:model.reason})))&&result.reason===model.reason,'Actual instance classification differs from its bound call');
 }}};
 if(job.kind==='verification')add(job.results,'candidate');else for(const control of job.controls)add(control.results,'control-'+digest(control.id));
 for(const root of roots)assertIndexedCall(job,proposal,root);
 for(const path of Object.keys(job.proofs).filter(p=>p.endsWith('/indexed-reader/binding.json')))ensure(roots.has(path.slice(0,-'/indexed-reader/binding.json'.length)),'Unbound indexed call archive');
}
