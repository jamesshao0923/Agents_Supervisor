// Core scope v6 supplied verifier: direct business API and host CLI only.
// No candidate-test-quality, dependency inventory or framework qualification.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {GoalProposal} from '../../packages/contracts/p5.js';
import type {Run} from '../../packages/contracts/p1.js';
import type {VerificationSpec} from '../../packages/contracts/p4.js';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export const checker="import assert from 'node:assert/strict';\nimport {writeFile,stat} from 'node:fs/promises';\nimport {join,dirname} from 'node:path';\nimport {pathToFileURL} from 'node:url';\nconst root=process.argv[2],parameters=JSON.parse(process.argv[3]),name=parameters.name;\nassert.ok(['sum','multiply'].includes(name),'Frozen function scope required');\nlet verdict='passed',reason='Independent actual API behavior and required artifact presence passed; script success is checked by the P4 host';\ntry {\n for(const file of ['math.mjs','math.test.mjs'])assert.ok((await stat(join(root,file))).isFile(),'Required artifact must be a file: '+file);\n const api=await import(pathToFileURL(join(root,'math.mjs')).href);\n assert.equal(typeof api[name],'function');\n if(name==='sum'){assert.equal(api.sum(2,3),5);assert.equal(api.sum(-1,1),0);}\n else{assert.equal(api.multiply(3,4),12);assert.equal(api.multiply(-2,3),-6);}\n for(const a of [-11,-2,-0.5,0,0.25,1,2,3,7,12])for(const b of [-7,-1,-0.25,0,0.5,2,3,4,9])assert.ok(api[name](a,b)===(name==='sum'?a+b:a*b),'Actual finite '+name+' result differs');\n for(const value of [NaN,Infinity,-Infinity,'2','',null,undefined,true,false,{},[],2n,Symbol('invalid'),()=>{},new Number(2)]){assert.throws(()=>api[name](value,1),TypeError);assert.throws(()=>api[name](1,value),TypeError);}\n // The P4 host separately executes the original math.test.mjs as its candidate entry.\n // No mutation, assertion proxy, simulated test runner or candidate-test quality claim.\n}catch(error){verdict='failed';reason=String(error);}\nawait writeFile(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks:[{obligationId:parameters.obligationId,verdict,reason}]}));process.exitCode=verdict==='passed'?0:1;\n";
export function controlModule(defect?:string):string {
 return ['sum','multiply'].map(name=>`export function ${name}(a,b){
  if(typeof a!=='number'||!Number.isFinite(a)||typeof b!=='number'||!Number.isFinite(b)){${defect===name+'-type'?'return 0;':"throw new TypeError('Finite numbers required');"}}
  return ${defect===name+'-arithmetic'?'a-b':name==='sum'?'a+b':'a*b'};
 }`).join('\n')+'\nexport const version=1;\n';
}
export function controlTests(omit?:string,alternative=false):string {
 const perFunction=(name:string)=>omit===name?'':(name==='sum'
  ?"assert.equal(api['sum'](2,3),5);assert.equal(api['sum'](-1,1),0);"
  :"assert.equal(api['multiply'](3,4),12);assert.equal(api['multiply'](-2,3),-6);")+
  `for(const x of [NaN,Infinity,-Infinity,'2']){assert.throws(()=>api[${JSON.stringify(name)}](x,1),TypeError);assert.throws(()=>api[${JSON.stringify(name)}](1,x),TypeError);}`;
 const body=omit==='all'?'':perFunction('sum')+perFunction('multiply');
 return "import assert from 'node:assert/strict';import * as api from './math.mjs';\n"+
 (alternative?body+"assert.equal(api['version'],1);\n":body+'\n');
}
export const suppliedControlCases=[
 {id:'good',expect:'passed',mustFail:[]},
 {id:'good-additive-computed-sync',expect:'passed',mustFail:[]},
 ...['sum','multiply'].flatMap(name=>[
  {id:name+'-arithmetic',expect:'failed',mustFail:[name+'-complete']},
  {id:name+'-type',expect:'failed',mustFail:[name+'-complete']},
 ]),
 {id:'missing-module',expect:'failed',mustFail:['sum-complete','multiply-complete']},
] as const;

export async function prepareFollowupVerifier(root:string,proposal:Pick<GoalProposal,'criteria'>,run:Pick<Run,'contract'>){
 assert.deepEqual(proposal.criteria.map(c=>c.id).sort(),['multiply','sum']);
 assert.deepEqual(run.contract.criteria.map(c=>c.id).sort(),['multiply','sum']);
 for(const criterion of proposal.criteria){
  assert.equal(criterion.kind,'command');assert.equal(criterion.target,'math.test.mjs');assert.ok(criterion.checks.length);
  assert.ok(run.contract.criteria.some(c=>c.id===criterion.id&&c.required));
 }
 const bundle=join(root,'supplied-verifier');await mkdir(bundle);await writeFile(join(bundle,'check.mjs'),checker);
 const controls=[];
 for(const entry of suppliedControlCases){
  const workspace=join(root,'control-'+entry.id);await mkdir(workspace);
  if(entry.id!=='missing-module')await writeFile(join(workspace,'math.mjs'),controlModule(entry.id));
  const badAPI=entry.id.endsWith('-arithmetic')||entry.id.endsWith('-type');
  await writeFile(join(workspace,'math.test.mjs'),badAPI?businessControlScript:controlTests(undefined,entry.id==='good-additive-computed-sync'));
  controls.push({id:entry.id,workspace,expect:entry.expect as 'passed'|'failed',mustFail:[...entry.mustFail]});
 }
 const scope='Core scope v6 qualifies only the exact business API, presence of math.mjs and math.test.mjs, and actual successful host CLI execution. General candidate assertion quality, dependency inventory, framework/asynchronous classification and historical implementation activity are explicitly outside this qualification. Original host permissions remain unchanged and are not a claim of general dependency/framework support. Exact current criteria are ALL-OF; independent P4 review remains mandatory.';
 const mapping=proposal.criteria.flatMap(c=>c.checks.map(check=>({criterionId:c.id,check,obligationId:c.id+'-complete',detector:'check.mjs',parameters:{name:c.id},reviewRequired:true})));
 const spec:VerificationSpec={schemaVersion:1,contractVersion:run.contract.version,standardsVersion:'running-followup-supplied-core-v6',
  obligations:proposal.criteria.map(c=>({id:c.id+'-complete',criterionId:c.id,required:true,applicable:true,expectation:[c.description,...c.checks,scope].join('\n')})),
  cases:proposal.criteria.map(c=>({id:c.id+'-complete',revision:1,obligationIds:[c.id+'-complete'],parameters:[{name:c.id,obligationId:c.id+'-complete'}],modules:[c.id],replaces:[],defectRefs:['arithmetic','invalid-input','missing-artifacts'],status:'active',verifier:{kind:'command',version:'supplied-followup-core-v6',entry:'check.mjs',files:['check.mjs','coverage.json'],candidateEntries:['math.test.mjs'],timeoutMs:30000}})),
  controls,moduleDependencies:{sum:[],multiply:[]}};
 const specPath=join(bundle,'spec.json');await writeFile(specPath,JSON.stringify(spec,null,2));
 const provenance={kind:'supplied-fixed-verifier',version:6,autonomousAuthor:false,contract:run.contract,criteria:proposal.criteria,mapping,scope,checkerSHA:sha(checker),controlSource:'Frozen test source; no candidate file content or result used to create assets'};
 await writeFile(join(bundle,'coverage.json'),JSON.stringify(provenance,null,2));
 return{spec,specPath,mapping,provenance};
}



// Bad API controls deliberately run a successful real script so P4 reaches the checker.
export const businessControlScript="console.log('control script completed');\n";
export const followupScopeV6Criteria:GoalProposal["criteria"]=[
  {
    "id": "sum",
    "description": "Independent sum API behavior, current required files and successful script execution.",
    "kind": "command",
    "target": "math.test.mjs",
    "checks": [
      "math.mjs is a Node ESM module exporting sum(a,b). Finite number inputs return a+b, including sum(2,3)===5 and sum(-1,1)===0. Any non-number or nonfinite input in either argument position throws TypeError synchronously.",
      "The current artifact contains math.mjs and math.test.mjs as files.",
      "The host actually runs node math.test.mjs against the current artifact and requires exit code 0. Candidate assertion precision, completeness and mutation sensitivity, dependency inventory, framework/asynchronous classification, and historical implementation activity are outside this acceptance scope."
    ]
  },
  {
    "id": "multiply",
    "description": "Independent multiply API behavior, current required files and successful script execution.",
    "kind": "command",
    "target": "math.test.mjs",
    "checks": [
      "math.mjs also exports multiply(a,b). Finite number inputs return a*b, including multiply(3,4)===12 and multiply(-2,3)===-6. Any non-number or nonfinite input in either argument position throws TypeError synchronously.",
      "The current artifact contains math.mjs and math.test.mjs as files.",
      "The host actually runs node math.test.mjs against the current artifact and requires exit code 0. Candidate assertion precision, completeness and mutation sensitivity, dependency inventory, framework/asynchronous classification, and historical implementation activity are outside this acceptance scope."
    ]
  }
];
export const followupScopeV6Goal="Build math.mjs as a Node ESM math API and math.test.mjs as an executable Node script. Return exactly the following acceptance criterion description and ordered checks verbatim. This core personal-trial scope qualifies only direct business API behavior, the two current files and actual script exit code 0. Do not add candidate assertion-quality, synchronous-framework, no-external-dependency, or historical-process qualification requirements. Existing host execution permissions remain unchanged; this scenario does not certify general dependency/framework/asynchronous support. Additional local files and exports are allowed. Return exactly one implementation step with acceptanceIds=[\"sum\"], constraints=[] and style=[]. Do not add acceptance obligations elsewhere. Independent full P4 and sealed delivery remain mandatory. No clarification is needed.\nEXACT CRITERION:\n{\n  \"id\": \"sum\",\n  \"description\": \"Independent sum API behavior, current required files and successful script execution.\",\n  \"kind\": \"command\",\n  \"target\": \"math.test.mjs\",\n  \"checks\": [\n    \"math.mjs is a Node ESM module exporting sum(a,b). Finite number inputs return a+b, including sum(2,3)===5 and sum(-1,1)===0. Any non-number or nonfinite input in either argument position throws TypeError synchronously.\",\n    \"The current artifact contains math.mjs and math.test.mjs as files.\",\n    \"The host actually runs node math.test.mjs against the current artifact and requires exit code 0. Candidate assertion precision, completeness and mutation sensitivity, dependency inventory, framework/asynchronous classification, and historical implementation activity are outside this acceptance scope.\"\n  ]\n}";
export const followupScopeV6Change="While this task is running, add multiply(a,b) to the same math.mjs and update math.test.mjs. Retain all original sum business behavior and the sum criterion id/description/kind/target/checks byte-for-byte; the host verifies this planning/version invariant, not a checker reading historical receipts. Add exactly the following multiply criterion description and ordered checks. Keep one implementation step, acceptanceIds=[\"sum\",\"multiply\"], constraints=[] and style=[]. Do not add test-quality, dependency-inventory or framework-classification obligations. Existing host permissions and independent full P4/sealed delivery remain unchanged. This change is explicitly authorized; do not ask again.\nEXACT NEW CRITERION:\n{\n  \"id\": \"multiply\",\n  \"description\": \"Independent multiply API behavior, current required files and successful script execution.\",\n  \"kind\": \"command\",\n  \"target\": \"math.test.mjs\",\n  \"checks\": [\n    \"math.mjs also exports multiply(a,b). Finite number inputs return a*b, including multiply(3,4)===12 and multiply(-2,3)===-6. Any non-number or nonfinite input in either argument position throws TypeError synchronously.\",\n    \"The current artifact contains math.mjs and math.test.mjs as files.\",\n    \"The host actually runs node math.test.mjs against the current artifact and requires exit code 0. Candidate assertion precision, completeness and mutation sensitivity, dependency inventory, framework/asynchronous classification, and historical implementation activity are outside this acceptance scope.\"\n  ]\n}";
