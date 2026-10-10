import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { startService } from '../supervisor/server.js';
import { request } from './client.js';
import type { Request } from '../../packages/contracts/p1.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !value || value.startsWith('--') || options[key] !== undefined) throw new Error('Invalid or duplicate arguments');
    options[key] = value;
  }
  const allowed: Record<string, string[]> = {
    serve: ['--data'], health: ['--data'], projects: ['--data'],
    runs: ['--data', '--project'], show: ['--data', '--project', '--run'],
    events: ['--data', '--project', '--after'], send: ['--data', '--file'],
  };
  if (!command || !allowed[command] || Object.keys(options).some(key => !allowed[command]!.includes(key))) {
    throw new Error('Usage: supervisor serve|health|projects|runs|show|events|send --data PATH [--project ID] [--run ID] [--after CURSOR] [--file REQUEST.json]');
  }
  const dataDir = resolve(options['--data'] ?? '.supervisor/local');
  if (command === 'serve') {
    const service = await startService(dataDir);
    console.log(JSON.stringify({ event: 'listening', socket: service.socket, dataDir, stage: 'P1' }));
    const stop = () => { void service.close().catch(error => { console.error(error); process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  const required = (flag: string): string => { const value = options[flag]; if (!value) throw new Error(`${flag} is required`); return value; };
  let payload: Request;
  const id = randomUUID();
  if (command === 'send') {
    const input: unknown = JSON.parse(await readFile(required('--file'), 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request file must contain an object');
    payload = { ...input, id } as Request;
  } else if (command === 'health') payload = { id, method: 'health' };
  else if (command === 'projects') payload = { id, method: 'query', query: { type: 'projects' } };
  else if (command === 'runs') payload = { id, method: 'query', query: { type: 'runs', projectId: required('--project') } };
  else if (command === 'show') payload = { id, method: 'query', query: { type: 'run', projectId: required('--project'), runId: required('--run') } };
  else payload = { id, method: 'query', query: { type: 'events', projectId: required('--project'), after: Number(options['--after'] ?? 0) } };
  const response = await request(dataDir, payload);
  console.log(JSON.stringify(response, null, 2));
  if (!response.ok) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
