import { createHash } from 'node:crypto';
import type { SupervisorStore } from '../persistence/store.js';
import { SupervisionRoutingRepository } from '../persistence/supervision-routing.js';
import { runtimeCanonical } from '../persistence/runtime.js';
import { captureRoutingCapabilities } from './supervision-routing-capabilities.js';
import type { SupervisionJob } from '../contracts/p6-supervision.js';
import type { SupervisionRouteReceipt } from '../contracts/p6-routing.js';
const hash=(v:unknown)=>createHash('sha256').update(runtimeCanonical(v)).digest('hex');
/** One adapter for the existing main loop. No timer or alternate repair runner. */
export class SupervisionRoutingAdapter {
  constructor(private readonly store:SupervisorStore,private readonly repository:SupervisionRoutingRepository,private readonly dataDir:string){}
  async beginDiagnosis(input:{loopId:string;failureJobId:string;input:unknown},beforeReserve?:()=>void):Promise<{receipt:SupervisionRouteReceipt;job:SupervisionJob}>{
    const old=this.repository.routes(input.loopId).find(r=>r.failureJobId===input.failureJobId);
    if(old){if(old.inputDigest!==hash(input.input))throw new Error('Existing routed diagnosis has a different frozen input; recover the original job');return {receipt:old,job:this.store.supervision.job(old.reasoningJobId)};}
    const loop=this.store.supervision.get(input.loopId);
    if(runtimeCanonical(input.input).length+6000>loop.limits.maxContextChars)throw new Error('Complete routing context exceeds maxContextChars; no automatic expansion or truncation');
    const round=await this.repository.observeVerification(input.loopId,input.failureJobId);
    if(round.decision.exhausted)throw new Error('Bounded repeated product failures exhausted the no-progress policy');
    await this.repository.assertFailureBoundary(input.loopId,input.failureJobId);
    const capabilities=await captureRoutingCapabilities(this.store,this.dataDir);
    await this.repository.assertFailureBoundary(input.loopId,input.failureJobId);
    return this.repository.transaction(()=>{const effect:unknown=beforeReserve?.();if(effect&&typeof (effect as {then?:unknown}).then==='function')throw new Error('Routing reservation callback must be synchronous');return this.repository.beginDiagnosis({...input,commandId:'route:'+input.failureJobId,capabilities});});
  }
}
