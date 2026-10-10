import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat, lstat, mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { Run, RunAction } from '../contracts/p1.js';
import { parseExecutionAction, type ExecutionAction, type ExecutionRecord, type ExecutionStart, type ExecutionState, type ExecutorCapabilities, type ModelCapability } from '../contracts/p2.js';
import { SupervisorStore } from '../persistence/store.js';
import { spawnManagedProcess, inspectProcess, terminateProcess, type ManagedProcess, type ProcessIdentity, type ProcessResult } from '../process-control/index.js';
import { CodexAdapter, inspectProtocol, type LineTransport, type NormalizedEvent, type UserInput } from '../executor-codex/index.js';

const execute = promisify(execFile);
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
const terminal = (s: ExecutionState): boolean => ['completed','cancelled','failed','interrupted','unknown'].includes(s);
function transport(child: ManagedProcess): LineTransport {
  const lines = createInterface({ input: child.stdout });
  return {
    write: line => { child.stdin.write(line); },
    onLine: callback => { lines.on('line',callback); return () => { lines.off('line',callback); }; },
    onClose: callback => { const close = () => callback('managed stdout closed'); lines.on('close',close); return () => { lines.off('close',close); }; },
  };
}
interface Active { process: ManagedProcess; adapter: CodexAdapter; finishing?: Promise<void>; terminalStatus?: string; launchedTurn: boolean }
export interface ExecutionManagerOptions { managedWorkspaceRoot?: string }
export class ExecutionManager {
  private readonly active = new Map<string, Active>();
  private readonly launches = new Map<string, Promise<void>>();
  private readonly reconciliations = new Map<string, Promise<ExecutionRecord>>();
  private protocolCache?: Promise<{version:string;schemaDigest:string}>;
  private capabilityCache?: Promise<ExecutorCapabilities>;
  private closing = false;
  private argsCache?: Promise<string[]>;
  constructor(private readonly store: SupervisorStore, private readonly dataDir: string, private readonly codex = process.env.SUPERVISOR_CODEX_PATH ?? 'codex', private readonly options: ExecutionManagerOptions = {}) {}

  async initialize(): Promise<void> {
    // A disconnected observation is never treated as success or blindly replayed.
    for (const record of this.store.executionList()) if (!record.stopConfirmed) await this.reconcile(record.id);
  }
  async dispatch(value: unknown): Promise<unknown> {
    const action = parseExecutionAction(value);
    if(this.closing) throw new Error('Supervisor is shutting down');
    switch(action.type) {
      case 'list': return this.store.executionList();
      case 'inspect': return this.store.executionGet(action.executionId);
      case 'events': return this.store.executionEvents(action.executionId,action.after);
      case 'capabilities': return this.capabilities();
      case 'start': return this.start(action);
      case 'cancel': return this.cancel(action.executionId);
      case 'reconcile': return this.reconcile(action.executionId);
    }
  }
  private protocol() {
    this.protocolCache ??= (async () => {
      const {stdout} = await execute(this.codex,['--version'],{timeout:10_000,maxBuffer:32_768});
      const directory=join(this.dataDir,'protocol'); await mkdir(directory,{recursive:true,mode:0o700});
      await execute(this.codex,['app-server','generate-json-schema','--out',directory],{timeout:15_000,maxBuffer:65_536});
      return inspectProtocol(stdout.trim(),directory);
    })().catch(error=>{ delete this.protocolCache;throw error; });
    return this.protocolCache;
  }
  private processArgs(): Promise<string[]> {
    this.argsCache ??= (async()=>{
      // Empty TOML maps merge with user configuration; disable each registered
      // server explicitly so unrelated account connectors are not inherited.
      const {stdout}=await execute(this.codex,['-c','features.plugins=false','-c','features.apps=false','mcp','list','--json'],{timeout:10_000,maxBuffer:1024*1024});
      const servers:unknown=JSON.parse(stdout);
      if(!Array.isArray(servers))throw new Error('Cannot establish the isolated executor tool configuration');
      const args=['app-server','--stdio','-c','features.apps=false','-c','features.plugins=false','-c','features.multi_agent=false','-c','web_search="disabled"'];
      for(const server of servers) {
        if(server?.enabled===false)continue;
        if(!server||typeof server.name!=='string'||!/^[A-Za-z0-9_-]+$/.test(server.name))throw new Error('Invalid MCP server configuration');
        args.push('-c',`mcp_servers.${server.name}.enabled=false`);
      }
      return args;
    })().catch(error=>{delete this.argsCache;throw error;});
    return this.argsCache;
  }
  async capabilities(): Promise<ExecutorCapabilities> {
    this.capabilityCache ??= (async () => {
      const protocol = await this.protocol();
      const dir=join(this.dataDir,'capabilities');await mkdir(dir,{recursive:true,mode:0o700});
      const log=join(dir,randomUUID()+'.jsonl');
      const child=await spawnManagedProcess({operationId:'capabilities-'+randomUUID(),command:this.codex,args:await this.processArgs(),cwd:this.dataDir,timeoutMs:25_000,
        onBeforeSpawn:intent=>writeFile(log,JSON.stringify({kind:'intent',intent})+'\n',{flag:'wx',mode:0o600}),
        onIdentity:identity=>appendFile(log,JSON.stringify({kind:'identity',identity})+'\n')});
      child.stderr.on('data',(chunk:Buffer)=>{void appendFile(log,JSON.stringify({kind:'stderr',text:chunk.toString('utf8').slice(0,65_536)})+'\n');});
      const adapter=new CodexAdapter({transport:transport(child),onRawEvent:event=>appendFile(log,JSON.stringify(event)+'\n'),onEvent:()=>{},requestTimeoutMs:15_000});
      try {
        await adapter.initialize(); const models: ModelCapability[]=[];let cursor: string|undefined;
        for(let page=0;page<10;page++) {
          const result=await adapter.listModels(cursor);
          for(const model of result.data) {
            const efforts=Array.isArray(model.supportedReasoningEfforts)?model.supportedReasoningEfforts.map(x=>String((x as {reasoningEffort:string}).reasoningEffort)):[];
            models.push({id:model.model,label:typeof model.displayName==='string'?model.displayName:model.model,inputModalities:model.inputModalities,reasoningEfforts:efforts,defaultEffort:typeof model.defaultReasoningEffort==='string'?model.defaultReasoningEffort:'medium'});
          }
          if(!result.nextCursor) break;cursor=result.nextCursor;
        }
        const result={...protocol,models,imageInput:models.some(m=>m.inputModalities.includes('image')),checkedAt:new Date().toISOString()};
        await writeFile(join(dir,'latest.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
      } finally {adapter.dispose();const stop=await child.terminate();await appendFile(log,JSON.stringify({kind:'stop',stop})+'\n');if(!stop.stopped)throw new Error('Capability probe process stop could not be verified');}
    })().catch(error=>{delete this.capabilityCache;throw error;});
    return this.capabilityCache;
  }
  private async start(input: ExecutionStart): Promise<ExecutionRecord> {
    const images=[];
    for(const path of input.images??[]) {if(!isAbsolute(path))throw new Error('Image paths must be absolute');const actual=await realpath(path);const metadata=await stat(actual);if(!metadata.isFile()||metadata.size>20*1024*1024)throw new Error('Image must be a local file at most 20 MiB');images.push(actual);}
    let workspaceKind:'managed'|'project'=input.workspace===undefined?'managed':'project';
    let workspace:string;
    if(input.workspace!==undefined) {
      if(!isAbsolute(input.workspace)) throw new Error('Workspace must be an absolute path');
      workspace=await realpath(input.workspace);
      if(workspace==='/' || !(await stat(workspace)).isDirectory())throw new Error('Select an existing project directory');
      // Directory ownership survives an explicit follow-up selected in the UI.
      if(this.store.executionList().some(record=>record.workspace===workspace&&record.workspaceKind==='managed'))workspaceKind='managed';
    } else {
      const previous=this.store.executionList().find(record=>record.commandId===input.commandId);
      if(previous && previous.workspaceKind!=='managed')throw new Error('commandId already used with a different execution');
      if(previous) {
        // A retry reads its durable receipt without recreating missing files or
        // rebinding ownership when the configured root later changes.
        return this.store.executionCreate({...input,workspace:previous.workspace,workspaceKind,images}).record;
      }
      const root=this.options.managedWorkspaceRoot??join(homedir(),'.supervisor','workspace');
      if(!isAbsolute(root))throw new Error('Managed workspace root must be an absolute path');
      await mkdir(root,{recursive:true,mode:0o700});
      workspace=join(await realpath(root),createHash('sha256').update(input.commandId).digest('hex'));
      await mkdir(workspace,{recursive:true,mode:0o700});
      // The generated leaf cannot be redirected to another project's files.
      const metadata=await lstat(workspace);
      if(metadata.isSymbolicLink()||!metadata.isDirectory())throw new Error('Managed workspace must be a directory, not a symbolic link');
      workspace=await realpath(workspace);
    }
    const {record,created}=this.store.executionCreate({...input,workspace,workspaceKind,images});
    if(created) {
      const work=Promise.resolve().then(()=>this.launch(record.id)).catch(error=>this.fail(record.id,error)).finally(()=>{this.launches.delete(record.id);});
      this.launches.set(record.id,work);
    }
    return record;
  }
  private async launch(id: string): Promise<void> {
    let record=this.store.executionGet(id);
    if(record.stopConfirmed)return;
    if(record.cancelRequested){await this.finishWithoutProcess(id,'cancelled');return;}
    const capabilities=await this.capabilities();
    const model=capabilities.models.find(m=>m.id===record.model);
    if(!model || !model.reasoningEfforts.includes(record.effort))throw new Error('Requested model or reasoning effort is not advertised by this Codex account');
    if(record.images.length && !model.inputModalities.includes('image'))throw new Error('Requested model does not advertise image input');
    record=this.store.executionGet(id);
    if(record.stopConfirmed)return;
    if(record.cancelRequested){await this.finishWithoutProcess(id,'cancelled');return;}
    this.store.executionUpdate(id,{state:'starting',protocolVersion:capabilities.version,schemaDigest:capabilities.schemaDigest},'protocol-verified',capabilities);
    const remaining=Date.parse(record.deadline)-Date.now(); if(remaining<=0)throw new Error('Execution deadline reached before spawn');
    const child=await spawnManagedProcess({operationId:id,command:this.codex,args:await this.processArgs(),cwd:record.workspace,timeoutMs:remaining,
      onBeforeSpawn:intent=>{this.assertLaunchEligible(id);this.store.executionUpdate(id,{},'process-intent',intent);},
      onIdentity:identity=>{this.assertLaunchEligible(id);this.store.executionUpdate(id,{identity,pid:identity.pid},'process-identity',identity);}});
    const adapter=new CodexAdapter({transport:transport(child),requestTimeoutMs:Math.min(20_000,remaining),
      onRawEvent:event=>{this.store.executionUpdate(id,{},'codex-raw',event);},
      onEvent:event=>this.onEvent(id,event)});
    const active:Active={process:child,adapter,launchedTurn:false};this.active.set(id,active);
    child.stderr.on('data',(chunk:Buffer)=>{this.store.executionUpdate(id,{},'codex-stderr',{text:chunk.toString('utf8').slice(0,65_536)});});
    void child.completion.then(result=>this.onProcessExit(id,result)).catch(error=>this.fail(id,error));
    await adapter.initialize();
    if(this.store.executionGet(id).cancelRequested){await this.stop(id);return;}
    const thread=await adapter.startThread({cwd:record.workspace,model:record.model,approvalPolicy:'never',sandbox:'workspace-write',ephemeral:false,
      developerInstructions:'Work only on the requested task in the given workspace. Do not spawn subagents, change global configuration, send messages, or access unrelated projects. Report what changed and actual validation; do not claim independent Supervisor acceptance.',
      config:{'features.multi_agent':false,web_search:'disabled'}});
    this.store.executionUpdate(id,{threadId:thread.thread.id},'thread-created',{threadId:thread.thread.id});
    if(this.store.executionGet(id).cancelRequested){await this.stop(id);return;}
    const input:UserInput[]=[{type:'text',text:record.prompt},...record.images.map(path=>({type:'localImage' as const,path}))];
    active.launchedTurn=true;
    this.store.executionUpdate(id,{},'turn-intent',{threadId:thread.thread.id,model:record.model,effort:record.effort,input});
    const result=await adapter.startTurn(thread.thread.id,input,{model:record.model,effort:record.effort,cwd:record.workspace});
    const latest=this.store.executionGet(id);
    this.store.executionUpdate(id,{turnId:result.turn.id,...(!terminal(latest.state)&&!latest.cancelRequested?{state:'running' as const}:{})},'turn-started',{threadId:thread.thread.id,turn:result.turn});
    if(this.store.executionGet(id).cancelRequested)await this.stop(id);
  }
  private onEvent(id:string,event:NormalizedEvent): void {
    const record=this.store.executionGet(id);const active=this.active.get(id);
    const patch:Partial<ExecutionRecord>={};
    if(event.threadId)patch.threadId=event.threadId;if(event.turnId)patch.turnId=event.turnId;
    if(event.tokenUsage && (!record.usage || event.tokenUsage.total.totalTokens>=record.usage.totalTokens)) {patch.usage=event.tokenUsage.total;patch.usageStatus='reported';}
    if(event.diff!==undefined)patch.diff=event.diff;
    if(event.text!==undefined)patch.message=event.method==='item/agentMessage/delta'?record.message+event.text:event.text;
    if(!terminal(record.state)&&!record.cancelRequested) {
      if(event.kind==='waiting')patch.state='waiting';
      if(event.kind==='thread-status'&&event.status==='active')patch.state='running';
      if(event.kind==='error')patch.error=JSON.stringify(event.raw.params);
      if(event.kind==='protocol-error'||event.kind==='disconnected'&&!(active?.finishing&&active.terminalStatus))patch.error='Codex connection interrupted; outcome requires reconciliation';
    }
    this.store.executionUpdate(id,patch,'codex-event',event);
    if(event.tokenUsage && event.tokenUsage.total.totalTokens>=record.reservation && !record.cancelRequested && !event.terminal) {
      void this.cancel(id,'Observed token usage reached the reserved attempt limit');
    }
    if(event.kind==='turn-status'&&event.terminal&&active) {
      active.terminalStatus=event.status ?? 'unknown';
      // Scheduling avoids deadlocking the adapter's ordered receive queue.
      setImmediate(()=>{void this.finish(id).catch(error=>this.fail(id,error));});
    } else if((event.kind==='protocol-error'||event.kind==='disconnected')&&active&&!active.finishing) {
      setImmediate(()=>{void this.fail(id,new Error('Codex transport lost; no automatic resend'));});
    }
  }
  private async fail(id:string,error:unknown): Promise<void> {
    const record=this.store.executionGet(id);
    if(record.stopConfirmed)return;
    this.store.executionUpdate(id,{error:errorText(error)},'execution-error',{message:errorText(error)});
    const active=this.active.get(id);
    if(active){await this.finish(id);}
    else await this.finishWithoutProcess(id,record.cancelRequested?'cancelled':'failed');
  }
  async cancel(id:string,reason='User requested cancellation'): Promise<ExecutionRecord> {
    const record=this.store.executionGet(id);if(record.stopConfirmed)return record;
    if(!record.cancelRequested)this.store.executionUpdate(id,{cancelRequested:true,state:'cancelling',error:reason==='User requested cancellation'?record.error:reason},'cancel-requested',{reason},[{type:'cancel'}]);
    if(this.active.has(id))void this.stop(id).catch(error=>this.fail(id,error));
    else if(!this.launches.has(id))await this.reconcile(id);
    return this.store.executionGet(id);
  }
  private async stop(id:string): Promise<void> {
    const active=this.active.get(id);if(!active)return;
    const record=this.store.executionGet(id);
    if(record.threadId&&record.turnId) {
      try {await Promise.race([active.adapter.interruptTurn(record.threadId,record.turnId),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Interrupt acknowledgement deadline')),1500))]);}
      catch(error){this.store.executionUpdate(id,{},'interrupt-unconfirmed',{message:errorText(error)});}
    }
    await this.finish(id);
  }
  private finish(id:string): Promise<void> {
    const active=this.active.get(id);if(!active)return Promise.resolve();
    active.finishing??=(async()=>{
      const stop=await active.process.terminate();
      await active.adapter.drain();active.adapter.dispose();
      const record=this.store.executionGet(id);
      let state:ExecutionState=record.cancelRequested?'cancelled':active.terminalStatus==='completed'?'completed':active.terminalStatus==='failed'?'failed':'interrupted';
      if(!stop.stopped)state='unknown';
      await this.finalize(id,state,stop.stopped,{stop,terminalStatus:active.terminalStatus??null},active.launchedTurn,!!active.terminalStatus);
      this.active.delete(id);
    })();return active.finishing;
  }
  private async onProcessExit(id:string,result:ProcessResult): Promise<void> {
    const active=this.active.get(id);if(!active||active.finishing)return;
    await active.adapter.drain();
    if(result.reason==='timeout')this.store.executionUpdate(id,{error:'Execution deadline reached'},'deadline-reached',result);
    await this.finish(id);
  }
  private async finishWithoutProcess(id:string,state:ExecutionState) {
    const record=this.store.executionGet(id);
    if(record.identity){await this.reconcileStopped(id);return;}
    await this.finalize(id,state,true,{reason:'No target process was released'},false);
  }
  private async finalize(id:string,state:ExecutionState,stopped:boolean,evidence:unknown,launched:boolean,authoritativeTerminal=false) {
    let record=this.store.executionGet(id);
    // Stop observation is persisted immediately, but the workspace stays reserved
    // until candidate capture finishes. A later writer cannot contaminate it.
    let snapshot:unknown;
    if(stopped) {
      this.store.executionUpdate(id,{},'process-stop-observed',evidence);
      snapshot=await this.workspaceSnapshot(record.workspace);
      this.store.executionUpdate(id,{},'workspace-captured',snapshot);
    }
    record=this.store.executionGet(id);
    if(record.cancelRequested && stopped)state='cancelled';
    const run=this.store.query({type:'run',projectId:record.projectId,runId:record.runId}) as Run;
    let artifactId:string|null=record.artifactId;
    if(stopped&&run.status!=='cancelled') {
      artifactId='execution-'+randomUUID();
      this.store.command({type:'publishArtifact',commandId:artifactId,projectId:record.projectId,runId:record.runId,expectedRevision:run.revision,artifactId,content:JSON.stringify({executionId:id,threadId:record.threadId,turnId:record.turnId,state,message:record.message,diff:record.diff,usage:record.usage,snapshot})});
    }
    const attempt=run.attempts.find(a=>a.id===record.attemptId)!;
    const actions:RunAction[]=[];
    if(attempt.status==='running')actions.push({type:'finishAttempt',attemptId:record.attemptId,outcome:state==='completed'?'succeeded':state==='cancelled'?'cancelled':'failed'});
    if(!attempt.settled && ((record.usage && authoritativeTerminal) || !launched))actions.push({type:'settleAttempt',attemptId:record.attemptId,actual:record.usage?.totalTokens??0});
    actions.push({type:'setOperation',operationId:id,attemptId:id,status:stopped?'confirmed':'unknown'});
    if(stopped&&run.leases.some(l=>!l.released))actions.push({type:'releaseLease',resource:'workspace:'+record.workspace,attemptId:id});
    this.store.executionUpdate(id,{state,stopConfirmed:stopped,artifactId},'execution-stopped',{evidence,usageSettled:!!record.usage&&authoritativeTerminal||!launched},actions);
  }
  private async workspaceSnapshot(workspace:string):Promise<unknown> {
    try {
      const status=await execute('git',['status','--porcelain=v1'],{cwd:workspace,timeout:5000,maxBuffer:1024*1024});
      const diff=await execute('git',['diff','--no-ext-diff','--binary','HEAD'],{cwd:workspace,timeout:5000,maxBuffer:4*1024*1024});
      const listed=await execute('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:workspace,timeout:5000,maxBuffer:4*1024*1024});
      const files:Record<string,unknown>={};
      for(const path of listed.stdout.split('\0').filter(Boolean).sort()) {
        const full=join(workspace,path);
        try {
          const metadata=await lstat(full);
          if(metadata.isSymbolicLink()){files[path]={unavailable:'Symlink content excluded'};continue;}
          if(!metadata.isFile()){files[path]={unavailable:'Not a regular file'};continue;}
          if(metadata.size>20*1024*1024){files[path]={unavailable:'Exceeds snapshot hash size limit',size:metadata.size};continue;}
          files[path]={digest:createHash('sha256').update(await readFile(full)).digest('hex'),size:metadata.size};
        } catch(error){files[path]={unavailable:errorText(error)};}
      }
      return {gitStatus:status.stdout,diff:diff.stdout,diffDigest:createHash('sha256').update(diff.stdout).digest('hex'),files};
    } catch(error){return {unavailable:errorText(error)};}
  }
  private assertLaunchEligible(id:string):void {
    const record=this.store.executionGet(id);
    if(this.closing||record.cancelRequested||record.stopConfirmed||terminal(record.state))throw new Error('Execution no longer eligible to launch');
  }
  async reconcile(id:string):Promise<ExecutionRecord> {
    if(this.active.has(id)||this.launches.has(id))return this.cancel(id);
    let work=this.reconciliations.get(id);
    if(!work){work=this.reconcileStopped(id).finally(()=>this.reconciliations.delete(id));this.reconciliations.set(id,work);}
    return work;
  }
  private async reconcileStopped(id:string):Promise<ExecutionRecord> {
    const record=this.store.executionGet(id);if(record.stopConfirmed)return record;
    if(this.active.has(id))return this.cancel(id);
    let stopped=!record.identity;let evidence:unknown={reason:'No recorded released process identity'};
    if(record.identity) {
      const identity=record.identity as ProcessIdentity;
      const inspection=await inspectProcess(identity);evidence=inspection;
      if(inspection.status==='verified'){const stop=await terminateProcess(identity);stopped=stop.stopped;evidence=stop;}
      else stopped=inspection.status==='stopped';
    }
    // A lost live connection leaves result and usage uncertain. Do not turn it into a successful run.
    await this.finalize(id,stopped?(record.cancelRequested?'cancelled':'interrupted'):'unknown',stopped,evidence,record.turnId!==null||record.threadId!==null);
    return this.store.executionGet(id);
  }
  async close():Promise<void> {
    this.closing=true;
    for(const record of this.store.executionList())if(!record.stopConfirmed)await this.cancel(record.id,'Supervisor shutdown');
    await Promise.allSettled([...this.launches.values()]);
    await Promise.allSettled([...this.active.keys()].map(id=>this.stop(id)));
  }
}
