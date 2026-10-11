import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {SupervisorStore} from '../../packages/persistence/store.js';
import {ExecutionManager} from '../../packages/execution/manager.js';
import {inspectProcess} from '../../packages/process-control/index.js';
import {MATERIAL_READER_SCHEMA_FILES} from '../../packages/executor-codex/material-reader-baseline.js';

// Existing ordinary lifecycle portions only. This Node writes explicit empty schema
// fixtures; it proves process ownership/lifecycle, not provider protocol support.
async function wait<T>(read:()=>T,predicate:(value:T)=>boolean,ms=6000):Promise<T>{
 const end=Date.now()+ms;while(Date.now()<end){const value=read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Actual lifecycle boundary timeout');
}
async function fixture(mode:string,timeoutMs=10000){
 const root=await realpath(await mkdtemp('/tmp/sv-indexed-probe-')),data=join(root,'data'),workspace=join(root,'workspace');await mkdir(workspace);
 const tool=join(root,'schema-fixture.mjs');
 await writeFile(tool,`#!${process.execPath}\nimport fs from 'node:fs';import {dirname,join} from 'node:path';const args=process.argv.slice(2),directory=args[args.indexOf('--out')+1];await new Promise(resolve=>setTimeout(resolve,${mode==='complete'?80:20000}));for(const name of ${JSON.stringify(MATERIAL_READER_SCHEMA_FILES)}){const path=join(directory,name);fs.mkdirSync(dirname(path),{recursive:true});fs.writeFileSync(path,'{}');}\n`,{mode:0o700});
 const store=new SupervisorStore(data);
 const record=store.executionCreate({type:'start',commandId:mode,workspace,workspaceKind:'project',prompt:'Explicit non-model managed schema lifecycle fixture',model:'uninvoked',effort:'low',timeoutMs,tokenLimit:100,reservation:60,verificationReserve:20}).record;
 return {root,data,store,record,manager:new ExecutionManager(store,data,tool)};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function collect(f:Fixture,label:string){
 const record=f.store.executionGet(f.record.id),events=f.manager['indexedProbeEvents'](record.id);
 const identity=events.find(event=>event.kind==='indexed-schema-identity')?.payload as Parameters<typeof inspectProcess>[0]|undefined;
 assert.ok(identity);const stop=await inspectProcess(identity);assert.equal(stop.status,'stopped');
 return {label,root:f.root,record,events,identity,stop};
}

test('P8-IDXC-I02 actual managed schema cancel close restart deadline and per-execution private directories preserve owned stop receipts',{timeout:90000},async()=>{
 const evidence:unknown[]=[];
 for(const mode of ['cancel','close','restart','deadline']){
  const f=await fixture(mode,mode==='deadline'?1000:10000);
  const handled=f.manager['indexedProtocol'](f.record.id).then(()=>({ok:true}),error=>({ok:false,error:String(error)}));
  try{
   await wait(()=>f.manager['indexedProbeEvents'](f.record.id),events=>events.some(event=>event.kind==='indexed-schema-identity'));
   if(mode==='cancel')await f.manager.cancel(f.record.id);
   if(mode==='close')await f.manager.close();
   if(mode==='restart'){const other=new ExecutionManager(f.store,f.data);try{await other.initialize();}finally{await other.close();}}
   assert.equal((await handled).ok,false);evidence.push(await collect(f,mode));
   if(mode!=='deadline')assert.equal(f.store.executionGet(f.record.id).stopConfirmed,true);
  }finally{await f.manager.close();await handled;f.store.close();}
 }
 const a=await fixture('complete');await mkdir(join(a.root,'workspace-B'));
 const record=a.store.executionCreate({type:'start',commandId:'complete-B',workspace:join(a.root,'workspace-B'),workspaceKind:'project',prompt:'Second same-host schema operation',model:'uninvoked',effort:'low',timeoutMs:10000,tokenLimit:100,reservation:60,verificationReserve:20}).record;
 const b={...a,record};
 try{
  const [x,y]=await Promise.all([a.manager['indexedProtocol'](a.record.id),a.manager['indexedProtocol'](b.record.id)]);
  assert.notEqual(x,y);assert.equal(dirname(x),dirname(y));evidence.push(await collect(a,'directory-A'),await collect(b,'directory-B'));
 }finally{await a.manager.close();a.store.close();}
 const output=join(process.env.SUPERVISOR_EVIDENCE_DIR??join(process.cwd(),'.supervisor-dev','indexed-schema-lifecycle'),'lifecycle.json');
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify({scope:'Actual owned Node lifecycle only; no model, schema semantics or fault injection',evidence},null,2));
});
