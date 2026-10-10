import type {ProcessIntent,ProcessIdentity,ProcessResult} from '../process-control/index.js';
/** Cleanup may only target actual previously owned resources; it records effects even after cancellation. */
export interface MobileProcessHooks {assertEligible?():void;onIntent?(intent:ProcessIntent,cleanup:boolean):void|Promise<void>;onIdentity?(identity:ProcessIdentity):void|Promise<void>;onComplete?(result:ProcessResult|null):void|Promise<void>}
