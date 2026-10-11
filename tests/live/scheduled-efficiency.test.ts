import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonical} from '../../packages/verification/candidate.js';
import {runArm,goal,checker,dependencyChecker,parserLoader,controlModule,controlTests} from './efficiency-arm.js';
import type {ArmMetrics} from '../helpers/efficiency-metrics.js';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

// One paired observation, not a speedup promise or an automatic P5 planning test.
// Each arm retains the original budget and 1400s observation limit. No retries.
test('P7-EFFICIENCY-L01 identical frozen workload serial and parallel both independently deliver before comparison',{timeout:3_100_000},async t=>{
  const evidence=join(process.env.SUPERVISOR_EVIDENCE_DIR??resolve('.supervisor-dev/live'),'artifacts','p7-efficiency-'+randomUUID());
  await mkdir(evidence,{recursive:true});
  const save=(name:string,value:unknown)=>writeFile(join(evidence,name+'.json'),JSON.stringify(value,null,2));
  const scenario={schemaVersion:1,goal,seed:{'README.md':goal+'\n'},
    model:process.env.SUPERVISOR_LIVE_MODEL??'gpt-5.6-sol',effort:'low',
    budget:{tokenLimit:1_200_000,verificationReserve:300_000,reservation:180_000},
    limits:{requestMs:300_000,graphMs:900_000,armObserverMs:1_400_000},
    checker,dependencyChecker,parserLoader,good:[controlModule('add'),controlModule('subtract')],
    bad:controlModule('add',true),tests:controlTests(),
    // Whole immutable helper also freezes branch prompts, complete spec, every
    // control variant and original assertions before the first provider request.
    driverDigest:sha(await readFile(new URL('./efficiency-arm.js',import.meta.url))),
    order:['serial','parallel'],difference:'Only scheduler maxActive: 1 versus 2; no artificial delay.'};
  const digest=sha(canonical(scenario));await save('frozen-scenario',{digest,scenario});
  const results:ArmMetrics[]=[];
  const startedArms:string[]=[];
  let failure:string|null=null;
  try{
    for(const mode of ['serial','parallel'] as const){
      startedArms.push(mode);
      const result=await runArm(t,mode,join(evidence,mode),digest);
      assert.ok(result.deliveryWallMs<=1_480_000,`${mode} exceeded original per-arm observation envelope`);
      results.push(result);
    }
    const read=async(mode:string,name:string)=>JSON.parse(await readFile(join(evidence,mode,name+'.json'),'utf8')) as unknown;
    assert.deepEqual(await read('serial','frozen-workload'),await read('parallel','frozen-workload'),'Exact task/dependency/prompt/seed equality');
    assert.deepEqual(await read('serial','frozen-standards'),await read('parallel','frozen-standards'),'Exact original full standards and controls equality');
    const [serial,parallel]=results as [ArmMetrics,ArmMetrics];
    assert.equal(serial.unknownAttempts.length+parallel.unknownAttempts.length,0);
    const ratio=serial.deliveryWallMs/parallel.deliveryWallMs;
    await save('comparison',{status:'valid-single-observation',sampleCount:1,order:scenario.order,
      scenarioDigest:digest,serial,parallel,wallTimeRatioSerialOverParallel:ratio,
      observedFaster:ratio>1?'parallel':ratio<1?'serial':'equal',
      interpretation:ratio>1?'This sample delivered faster in parallel; not a general speedup claim.':'No observed parallel speed benefit. Review granularity/work-pool overhead before claiming efficiency.',
      environmentDifference:canonical(serial.environmentBefore)!==canonical(parallel.environmentBefore),
      caveats:['Fixed serial-first order can warm caches; actual cached token counters and environments are recorded.','Independent P4 review latency is included in delivery wall time.','No automatic P5 decomposition or nested-loop efficiency claim.']});
  }catch(error){failure=String(error);throw error;}
  finally{
    // This manifest exists even if an arm had unknown cost or was never started.
    // Each started arm preserves its full final/post-cleanup Run and all raw data.
    const armAccounting=[];
    for(const mode of startedArms){
      try{const ledger=JSON.parse(await readFile(join(evidence,mode,'post-cleanup-ledger.json'),'utf8'));
        armAccounting.push({mode,run:ledger.runtime?.run??null,jobs:ledger.jobs,executions:ledger.executions.map((row:{execution:unknown})=>row.execution)});
      }catch(error){armAccounting.push({mode,unavailable:String(error)});}
    }
    await save('pair-outcome',{armAccounting,startedArms,status:failure?'inconclusive-failed-arm':'finished',failure,
      completedArms:results.map(result=>result.mode),notStarted:['serial','parallel'].filter(mode=>!startedArms.includes(mode)),
      accounting:'Read every started arm post-cleanup-ledger.json; unsettled/unknown reservations remain explicit and are never summed as zero.',
      completedKnownSpent:results.reduce((sum,result)=>sum+result.spent,0),
      allStartedKnownSpent:armAccounting.reduce((sum,row)=>sum+('run' in row?(row.run?.budget.spent??0):0),0),
      unknownReservations:armAccounting.flatMap(row=>'run' in row?(row.run?.attempts??[]).filter((attempt:{settled:boolean})=>!attempt.settled).map((attempt:{id:string;reservation:number;actual:number|null})=>({mode:row.mode,...attempt})):[]),
      accountingIncomplete:armAccounting.some(row=>'unavailable' in row),
      noGeneralSpeedupClaim:true});
    t.diagnostic(JSON.stringify({evidence}));
  }
});
