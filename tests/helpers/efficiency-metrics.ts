import type {ExecutionRecord, ExecutionEvent} from '../../packages/contracts/p2.js';
import type {Run} from '../../packages/contracts/p1.js';
import type {VerificationJob} from '../../packages/verification/records.js';

export interface ArmInput {
  mode:'serial'|'parallel'; startedAt:string; graphReadyAt:string; finishedAt:string;
  executionRecords:{execution:ExecutionRecord;events:ExecutionEvent[];logicalKey:string}[];
  physicalSamples:{at:string;ids:string[];checks?:unknown[]}[];
  run:Run; jobs:VerificationJob[];
  environmentBefore:unknown; environmentAfter:unknown;
}
export function measureArm(input:ArmInput) {
  const timestamp=(value:string)=>{const number=Date.parse(value);if(!Number.isFinite(number))throw Error('Invalid evidence timestamp');return number;};
  const intervals=input.executionRecords.map(({execution,events,logicalKey})=>{
    const start=events.find(event=>event.kind==='turn-started')?.receivedAt;
    const stop=events.find(event=>event.kind==='execution-stopped')?.receivedAt;
    if(!start||!stop)throw Error('Missing actual turn-started/execution-stopped evidence');
    const startMs=timestamp(start),stopMs=timestamp(stop);
    if(startMs<timestamp(execution.createdAt)||timestamp(execution.createdAt)<timestamp(input.startedAt)||stopMs<startMs)throw Error('Evidence clock moved backwards');
    const key=logicalKey;
    return {id:execution.id,key,createdAt:execution.createdAt,start,stop,
      startMs,stopMs,activeMs:stopMs-startMs,
      elapsedBeforeDispatchMs:timestamp(execution.createdAt)-timestamp(input.startedAt),
      graphDispatchWaitMs:logicalKey==='integration'?null:timestamp(execution.createdAt)-timestamp(input.graphReadyAt),
      startupWaitMs:startMs-timestamp(execution.createdAt),
      usage:execution.usage,usageStatus:execution.usageStatus,
      reservation:execution.reservation,state:execution.state,stopConfirmed:execution.stopConfirmed};
  });
  const branches=intervals.filter(interval=>interval.key!=='integration');
  if(branches.length!==2)throw Error('Comparison requires exactly two branch executions');
  const branchOverlapMs=Math.max(0,Math.min(...branches.map(i=>i.stopMs))-Math.max(...branches.map(i=>i.startMs)));
  const counts=new Map<string,number>();for(const interval of intervals)counts.set(interval.key,(counts.get(interval.key)??0)+1);
  const unknownAttempts=input.run.attempts.filter(attempt=>!attempt.settled).map(attempt=>({id:attempt.id,reservation:attempt.reservation,actual:attempt.actual}));
  const repeatedCommands:Record<string,number>={};
  // The complete raw stream is retained separately. Exact repeated command text
  // is an observation, not proof the work was unnecessary (tests can repeat).
  for(const {events}of input.executionRecords)for(const event of events){
    const payload=event.payload as {raw?:{method?:string;params?:{item?:{type?:string;command?:string}}}};
    const raw=event.kind==='codex-raw'?event.payload as NonNullable<typeof payload.raw>:payload?.raw;
    if(raw?.method==='item/started'&&raw.params?.item?.type==='commandExecution'&&typeof raw.params.item.command==='string'){
      const command=raw.params.item.command;repeatedCommands[command]=(repeatedCommands[command]??0)+1;
    }
  }
  return {
    mode:input.mode,startedAt:input.startedAt,finishedAt:input.finishedAt,
    deliveryWallMs:timestamp(input.finishedAt)-timestamp(input.startedAt),
    branchOverlapMs,physicalOverlapObserved:input.physicalSamples.some(sample=>sample.ids.length===2),
    physicalSamples:input.physicalSamples,intervals,
    duplicateAttempts:[...counts.values()].reduce((sum,count)=>sum+Math.max(0,count-1),0),
    repeatedCommands:Object.entries(repeatedCommands).filter(([,count])=>count>1),
    semanticDuplicateWork:'Not inferred from token count or repeated tests; inspect full raw events and diffs.',
    attempts:input.run.attempts,unknownAttempts,spent:input.run.budget.spent,
    unsettledReservation:unknownAttempts.reduce((sum,attempt)=>sum+attempt.reservation,0),
    allStopped:input.executionRecords.every(({execution})=>execution.stopConfirmed)&&input.jobs.every(job=>job.stopConfirmed),
    jobs:input.jobs.map(job=>({id:job.id,kind:job.kind,startedAt:job.startedAt,finishedAt:job.finishedAt,usage:job.usage,usageUnknown:job.usageUnknown,stopConfirmed:job.stopConfirmed,proofs:job.proofs})),
    environmentBefore:input.environmentBefore,environmentAfter:input.environmentAfter,
    cachedInputTokens:input.executionRecords.reduce((sum,{execution})=>sum+(execution.usage?.cachedInputTokens??0),0),
    cacheCoverage:'P2 execution counters only; P4 raw review proofs retained without inventing missing cache counters.',
  };
}
export type ArmMetrics=ReturnType<typeof measureArm>;
