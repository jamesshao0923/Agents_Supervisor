import {mkdir,readFile,realpath,lstat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import type {SupervisorStore} from '../persistence/store.js';
import type {GoalGraphAdmissionInput,GraphPreparationRequest} from '../contracts/p7-graph.js';
import type {OrchestrationAction} from '../contracts/p5.js';
import {buildGoalGraphAdmission} from './goal-graph.js';
import {captureGraphSeed,prepareGraphWorkspaces} from '../workspace/graph-workspaces.js';
import {canonical,digest} from '../verification/candidate.js';
export interface GraphAdmissionOptions {tier:'low'|'medium'|'high'|'unlimited';maxActive:number;maxNodes:number;maxDepth:number;maxDurationMs:number}
export const DEFAULT_GRAPH_ADMISSION:GraphAdmissionOptions=Object.freeze({tier:'low',maxActive:2,maxNodes:32,maxDepth:1,maxDurationMs:24*60*60*1000});
function validateOptions(options:GraphAdmissionOptions):void {
 if(canonical(Object.keys(options).sort())!==canonical(['tier','maxActive','maxNodes','maxDepth','maxDurationMs'].sort())||!['low','medium','high','unlimited'].includes(options.tier)||Object.entries(options).some(([key,value])=>key!=='tier'&&(!Number.isSafeInteger(value)||Number(value)<1)))throw Error('Invalid host graph admission policy');
}
/** Reads actual host-owned preparation bytes within the admission transaction.
 * No caller-provided policy digest can replace this immutable request binding. */
export function assertGoalGraphPreparation(input:GoalGraphAdmissionInput,dataDir:string):void {
 const checkDirectory=(path:string)=>{if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory()||realpathSync(path)!==resolve(path))throw Error('Frozen graph request directory alias');};
 const read=(path:string)=>{const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||realpathSync(path)!==resolve(path))throw Error('Frozen graph request file alias');return readFileSync(path,'utf8');};
 const root=realpathSync(dataDir),base=join(root,'graph-admission'),directory=join(base,digest(input.action.commandId)),seedDirectory=join(directory,'seed'),preparationRoot=join(directory,'branches');
 for(const path of [root,base,directory,seedDirectory,preparationRoot])checkDirectory(path);
 const raw=read(join(directory,'prepare-request.json')),request=JSON.parse(raw) as {action:typeof input.action;expectedRunRevision:number;admissionDigest:string;options:GraphAdmissionOptions};
 if(!request||typeof request!=='object'||canonical(Object.keys(request).sort())!==canonical(['action','expectedRunRevision','admissionDigest','options'].sort()))throw Error('Frozen graph request has unknown fields');
 validateOptions(request.options);
 if(input.action.explorationTier!==undefined&&request.options.tier!==input.action.explorationTier)throw Error('Frozen graph request differs from the requested exploration tier');
 if(raw!==canonical({action:input.action,expectedRunRevision:input.expectedRunRevision,admissionDigest:input.admission.digest,options:request.options}))throw Error('Frozen graph request changed or conflicts with admission');
 const seedRaw=read(join(seedDirectory,'candidate.json'));
 if(seedRaw!==canonical(input.preparation.request.seed))throw Error('Frozen graph seed request changed');
 const seed=input.preparation.request.seed,time=Date.parse(seed.createdAt);
 if(!Number.isSafeInteger(time)||new Date(time).toISOString()!==seed.createdAt||seed.tree!==join(seedDirectory,'tree'))throw Error('Frozen graph seed time or path changed');
 const deadlineMs=time+request.options.maxDurationMs;
 if(!Number.isSafeInteger(deadlineMs))throw Error('Invalid frozen graph deadline');
 const policy={schedulerId:'graph-'+digest(canonical({sessionId:input.action.sessionId,commandId:input.action.commandId})),preparationRoot,tier:request.options.tier,limits:{maxActive:request.options.maxActive,maxNodes:request.options.maxNodes,maxDepth:request.options.maxDepth,deadlineMs}};
 if(canonical(policy)!==canonical(input.policy)||input.preparation.hostRoot!==preparationRoot||input.preparation.request.commandId!==input.action.commandId)throw Error('Frozen graph policy differs from actual preparation request');
}
/** No model calls. Reuses the same stopped paid GoalProposal and persistent seed.
 * Caller keeps original P5 evidence/physical-stop checks before this operation. */
export async function prepareGoalGraphAdmission(store:SupervisorStore,dataDir:string,action:Extract<OrchestrationAction,{type:'admit'}>,options:GraphAdmissionOptions=DEFAULT_GRAPH_ADMISSION):Promise<GoalGraphAdmissionInput>{
 // Freeze caller objects before the first await; later mutation cannot alter host intent.
 action=structuredClone(action);options={...structuredClone(options),tier:action.explorationTier??options.tier};validateOptions(options);
 store.goals.validateAdmission(action);const {session,run}=store.goals.inspect(action.sessionId),admission=buildGoalGraphAdmission(session,run);
 const base=join(await realpath(dataDir),'graph-admission');await mkdir(base,{recursive:true,mode:0o700});
 if((await lstat(base)).isSymbolicLink()||await realpath(base)!==base)throw Error('Graph admission root must be host owned');
 const directory=join(base,digest(action.commandId));await mkdir(directory,{mode:0o700,recursive:true});
 if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw Error('Graph admission command path alias');
 const requestPath=join(directory,'prepare-request.json'),frozenRequest=canonical({action,expectedRunRevision:run.revision,admissionDigest:admission.digest,options});
 try{await writeFile(requestPath,frozenRequest,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(await readFile(requestPath,'utf8')!==frozenRequest)throw Error('Graph preparation command conflicts with its original admission request');}
 const seedDir=join(directory,'seed');let seed:GraphPreparationRequest['seed'];
 try{seed=JSON.parse(await readFile(join(seedDir,'candidate.json'),'utf8')) as GraphPreparationRequest['seed'];}catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  // Existing incomplete seed storage is retained and create-exclusively rejects.
  seed=await captureGraphSeed(session.workspace,seedDir);
 }
 if(seed.kind!=='graph-seed'||seed.schemaVersion!==1||seed.root!==session.workspace||seed.tree!==join(seedDir,'tree'))throw Error('Graph seed is outside its frozen command scope');
 const preparationRoot=join(directory,'branches');await mkdir(preparationRoot,{mode:0o700,recursive:true});
 const request:GraphPreparationRequest={schemaVersion:1,commandId:action.commandId,admissionDigest:admission.digest,projectId:session.projectId,runId:session.id,taskIds:admission.implementationSteps.map(s=>s.id),seed};
 const preparation=await prepareGraphWorkspaces(preparationRoot,request),deadlineMs=Date.parse(seed.createdAt)+options.maxDurationMs;
 if(!Number.isSafeInteger(deadlineMs))throw Error('Invalid graph preparation deadline');
 const policy={schedulerId:'graph-'+digest(canonical({sessionId:session.id,commandId:action.commandId})),preparationRoot,tier:options.tier,limits:{maxActive:options.maxActive,maxNodes:options.maxNodes,maxDepth:options.maxDepth,deadlineMs}};
 const input={action,expectedRunRevision:run.revision,admission,preparation,policy};assertGoalGraphPreparation(input,dataDir);return input;
}
