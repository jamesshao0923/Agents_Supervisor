import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { startService } from '../supervisor/server.js';
import { request } from './client.js';
import type { Request } from '../../packages/contracts/p1.js';
import type { ExecutionStart } from '../../packages/contracts/p2.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !value || value.startsWith('--') || options[key] !== undefined) throw new Error('Invalid or duplicate arguments');
    options[key] = value;
  }
  const allowed: Record<string, string[]> = {
    supervision:['--data','--file'],supervisions:['--data'],'supervision-show':['--data','--loop'],
    conversation:['--data','--file'],conversations:['--data'],'conversation-show':['--data','--conversation'],
    goal: ['--data','--file'], goals:['--data'], 'goal-show':['--data','--goal'],
    verify: ['--data','--file'], 'verification-status':['--data','--runtime'], serve: ['--data'], health: ['--data'], projects: ['--data'],
    runs: ['--data', '--project'], show: ['--data', '--project', '--run'],
    events: ['--data', '--project', '--after'], send: ['--data', '--file'],
    run: ['--data','--file'], executions: ['--data'], capabilities: ['--data'],
    inspect: ['--data','--execution'], cancel: ['--data','--execution'], reconcile: ['--data','--execution'],
    trajectory: ['--data','--execution','--after'],
    workflow: ['--data','--file'], workflows:['--data'], runtime:['--data','--runtime'],
    pause:['--data','--runtime'], resume:['--data','--runtime'], 'cancel-runtime':['--data','--runtime'], 'reconcile-runtime':['--data','--runtime'],
    input:['--data','--runtime','--step','--text'], 'runtime-events':['--data','--runtime','--after'],
  };
  if (!command || !allowed[command] || Object.keys(options).some(key => !allowed[command]!.includes(key))) {
    throw new Error('Usage: supervisor serve|health|projects|runs|show|events|send --data PATH [--project ID] [--run ID] [--after CURSOR] [--file REQUEST.json]');
  }
  const dataDir = resolve(options['--data'] ?? '.supervisor/local');
  if (command === 'serve') {
    const service = await startService(dataDir);
    console.log(JSON.stringify({ event: 'listening', socket: service.socket, dataDir, stage: 'P5' }));
    const stop = () => { void service.close().catch(error => { console.error(error); process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  const required = (flag: string): string => { const value = options[flag]; if (!value) throw new Error(`${flag} is required`); return value; };
  let payload: Request;
  const id = randomUUID();
  if(command==='supervision')payload={id,method:'supervision',action:JSON.parse(await readFile(required('--file'),'utf8'))};
  else if(command==='supervisions')payload={id,method:'supervision',action:{type:'list'}};
  else if(command==='supervision-show')payload={id,method:'supervision',action:{type:'inspect',loopId:required('--loop')}};
  else if(command==='conversation')payload={id,method:'conversation',action:JSON.parse(await readFile(required('--file'),'utf8'))};
  else if(command==='conversations')payload={id,method:'conversation',action:{type:'list'}};
  else if(command==='conversation-show')payload={id,method:'conversation',action:{type:'inspect',conversationId:required('--conversation')}};
  else if(command==='goal')payload={id,method:'orchestration',action:JSON.parse(await readFile(required('--file'),'utf8'))};
  else if(command==='goals')payload={id,method:'orchestration',action:{type:'list'}};
  else if(command==='goal-show')payload={id,method:'orchestration',action:{type:'inspect',sessionId:required('--goal')}};
  else if(command==='verify')payload={id,method:'verification',action:JSON.parse(await readFile(required('--file'),'utf8'))};
  else if(command==='verification-status')payload={id,method:'verification',action:{type:'status',runtimeId:required('--runtime')}};
  else if (command === 'send') {
    const input: unknown = JSON.parse(await readFile(required('--file'), 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request file must contain an object');
    payload = { ...input, id } as Request;
  } else if(command==='workflow') {
    payload={id,method:'runtime',action:{...JSON.parse(await readFile(required('--file'),'utf8')),type:'submit'}};
  } else if(command==='workflows')payload={id,method:'runtime',action:{type:'list'}};
  else if(command==='runtime')payload={id,method:'runtime',action:{type:'inspect',runtimeId:required('--runtime')}};
  else if(['pause','resume','cancel-runtime','reconcile-runtime'].includes(command))payload={id,method:'runtime',action:{type:command.replace('-runtime','') as 'pause'|'resume'|'cancel'|'reconcile',runtimeId:required('--runtime'),commandId:id}};
  else if(command==='input')payload={id,method:'runtime',action:{type:'input',runtimeId:required('--runtime'),commandId:id,stepId:required('--step'),text:required('--text')}};
  else if(command==='runtime-events')payload={id,method:'runtime',action:{type:'events',runtimeId:required('--runtime'),after:Number(options['--after']??0)}};
  else if(command==='run') {
    const input=JSON.parse(await readFile(required('--file'),'utf8')) as ExecutionStart;
    payload={id,method:'execution',action:{...input,type:'start'}};
  } else if(command==='executions'||command==='capabilities')payload={id,method:'execution',action:{type:command==='executions'?'list':'capabilities'}};
  else if(command==='inspect'||command==='cancel'||command==='reconcile')payload={id,method:'execution',action:{type:command,executionId:required('--execution')}};
  else if(command==='trajectory')payload={id,method:'execution',action:{type:'events',executionId:required('--execution'),after:Number(options['--after']??0)}};
  else if (command === 'health') payload = { id, method: 'health' };
  else if (command === 'projects') payload = { id, method: 'query', query: { type: 'projects' } };
  else if (command === 'runs') payload = { id, method: 'query', query: { type: 'runs', projectId: required('--project') } };
  else if (command === 'show') payload = { id, method: 'query', query: { type: 'run', projectId: required('--project'), runId: required('--run') } };
  else payload = { id, method: 'query', query: { type: 'events', projectId: required('--project'), after: Number(options['--after'] ?? 0) } };
  const response = await request(dataDir, payload);
  console.log(JSON.stringify(response, null, 2));
  if (!response.ok) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
