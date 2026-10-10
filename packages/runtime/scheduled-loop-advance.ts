import type {SupervisorStore} from '../persistence/store.js';
import type {LoopProgramSource} from '../contracts/p7-loop.js';
import {canonical,digest} from '../verification/candidate.js';
/** Host-reviewed program entry plus the existing worker's automatic scan hook.
 * This is not a model template-authoring endpoint or another execution engine. */
export class ScheduledLoopController {
 constructor(private readonly store:SupervisorStore){}
 async install(input:{commandId:string;source:LoopProgramSource;expectedRunRevision:number;expectedResultRevision:number}){
  const saved=structuredClone(input),prepared=await this.store.scheduledLoops.prepareInstallation(saved.commandId,saved.source);
  return this.store.scheduledLoops.install({commandId:saved.commandId,prepared,expectedRunRevision:saved.expectedRunRevision,expectedResultRevision:saved.expectedResultRevision});
 }
 async advance(schedulerId:string):Promise<void>{const next=await this.store.scheduledLoops.prepareAdvance(schedulerId);if(!next)return;const request={id:schedulerId,...next},commandId='loop-advance:'+digest(canonical(request));this.store.scheduledLoops.append({commandId,...request});}
 stop(input:{commandId:string;id:string;frameKey:string;reason:string}){return this.store.scheduledLoops.stop(input);}
 inspect(id:string){return {state:this.store.scheduledLoops.inspect(id),decisions:this.store.scheduledLoops.decisions(id),iterations:this.store.scheduledLoops.iterations(id),budgets:this.store.scheduledLoops.budgets(id)};}
}
