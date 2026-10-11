import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {VerificationSpec} from '../../packages/contracts/p4.js';

/** Explicit user-supplied assets; these are never a seeded approval or model output. */
export async function prepareSuppliedIncrement(root:string,contractVersion:number,checks:string[]){
  const ids=['increment.finite','increment.invalid','increment.cli','increment.scope'];
  const source=`import assert from 'node:assert/strict';import{readFile,readdir,writeFile}from'node:fs/promises';import{join}from'node:path';import{pathToFileURL}from'node:url';
const root=process.argv[2],mode=JSON.parse(process.argv[3]).kind;const checks=[];let verdict='passed',reason='Independent current business check completed';
try{if(mode==='finite'||mode==='invalid'){const m=await import(pathToFileURL(join(root,'result.mjs')).href);assert.equal(typeof m.increment,'function');if(mode==='finite'){for(const v of [2,-2,0,0.5,17,-0,Number.MIN_VALUE,Number.MAX_VALUE])assert.equal(m.increment(v),v+1);}else{for(const v of [NaN,Infinity,-Infinity,'2','',null,undefined,true,false,{},[],new Number(1),1n,Symbol('value')])assert.throws(()=>m.increment(v),TypeError);}}else if(mode==='cli'){await readFile(join(root,'result.test.mjs'));/* Engine candidateEntries already ran this exact CLI and recorded exit0/stop. No claim about assertion quality. */}else if(mode==='scope'){assert.deepEqual((await readdir(root)).sort(),['result.mjs','result.test.mjs']);}else throw Error('Unknown frozen mode');}catch(e){verdict='failed';reason=String(e);}
process.exitCode=verdict==='failed'?1:0;checks.push({obligationId:'increment.'+mode,verdict,reason});await writeFile(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks}));`;
  await mkdir(root,{recursive:true});await writeFile(join(root,'checker.mjs'),source);
  const good="export function increment(value){if(typeof value!=='number'||!globalThis.Number.isFinite(value))throw new TypeError('finite number');return value+1;}\n";
  const test="import assert from 'node:assert/strict';import{increment}from'./result.mjs';for(const[v,e]of[[2,3],[-2,-1],[0,1],[0.5,1.5]])assert.equal(increment(v),e);for(const v of[NaN,Infinity,-Infinity,'2',null,undefined,true,false,{},[]])assert.throws(()=>increment(v),TypeError);\n";
  const controls=[{id:'positive_increment',code:good,test,expect:'passed' as const,mustFail:[]},{id:'negative_addition',code:good.replace('return value+1','return value+2'),test:'process.exitCode=0;\n',expect:'failed' as const,mustFail:['increment.finite']},{id:'negative_invalid',code:"export function increment(v){if(typeof v!=='number')throw new TypeError('number');return v+1;}\n",test:'process.exitCode=0;\n',expect:'failed' as const,mustFail:['increment.invalid']},{id:'negative_cli',code:good,test:'process.exitCode=1;\n',expect:'failed' as const,mustFail:['increment.cli']},{id:'negative_scope',code:good,test,expect:'failed' as const,mustFail:['increment.scope']}];
  const files:Record<string,string>={};
  for(const control of controls){const workspace=join(root,'controls',control.id);await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'result.mjs'),control.code);await writeFile(join(workspace,'result.test.mjs'),control.test);if(control.id==='negative_scope')await writeFile(join(workspace,'extra.mjs'),'export const extra=1;\n');}
  const spec:VerificationSpec={schemaVersion:1,contractVersion,standardsVersion:'increment-core-v1',obligations:ids.map((id,i)=>({id,criterionId:'increment',expectation:checks[i]!,required:true,applicable:true})),cases:ids.map(id=>({id:id+'.case',revision:1,obligationIds:[id],parameters:[{kind:id.slice('increment.'.length)}],modules:['increment'],replaces:[],defectRefs:[],verifier:{kind:'command',version:'direct-increment-v1',entry:'checker.mjs',files:['checker.mjs'],timeoutMs:30000,...(id==='increment.cli'?{candidateEntries:['result.test.mjs']}: {})}})),controls:controls.map(c=>({id:c.id,workspace:join(root,'controls',c.id),expect:c.expect,mustFail:c.mustFail})),moduleDependencies:{increment:[]}};
  const specPath=join(root,'spec.json');await writeFile(specPath,JSON.stringify(spec,null,2));
  for(const path of [join(root,'checker.mjs'),specPath,...controls.flatMap(c=>[join(root,'controls',c.id,'result.mjs'),join(root,'controls',c.id,'result.test.mjs'),...(c.id==='negative_scope'?[join(root,'controls',c.id,'extra.mjs')]:[])])])files[path]=createHash('sha256').update(await readFile(path)).digest('hex');
  return{spec,specPath,files};
}
