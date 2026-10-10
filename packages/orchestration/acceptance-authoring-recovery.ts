import type {SupervisorStore} from '../persistence/store.js';
import {AuthorRoutingRepository} from '../persistence/author-routing.js';
import {captureRoutingCapabilities} from './supervision-routing-capabilities.js';
/** Recovery composes the existing main loop, without a new timer or model runner. */
export class AcceptanceAuthorRecovery {
 constructor(private readonly store:SupervisorStore,private readonly repository:AuthorRoutingRepository,private readonly dataDir:string){}
 async begin(loopId:string,previousJobId:string,beforeReserve?:()=>void,reviewRebuild=false){
  const prior=this.repository.routes(loopId).find(row=>row.rejection.previousJobId===previousJobId);
  if(prior)return {receipt:prior,job:this.store.supervision.job(prior.nextJobId)};
  const rejection=await this.repository.assess(loopId,previousJobId,reviewRebuild);
  const capabilities=await captureRoutingCapabilities(this.store,this.dataDir);
  const after=await this.repository.assess(loopId,previousJobId,reviewRebuild);
  if(JSON.stringify(rejection)!==JSON.stringify(after))throw Error('Author rejection changed across capability probe');
  return this.repository.transaction(()=>{const effect:unknown=beforeReserve?.();if(effect&&typeof (effect as {then?:unknown}).then==='function')throw Error('Author reserve callback must be synchronous');return this.repository.begin({commandId:'author-recover:'+previousJobId,loopId,previousJobId,expectedRevision:this.store.supervision.get(loopId).revision,rejection:after,capabilities});});
 }
}
