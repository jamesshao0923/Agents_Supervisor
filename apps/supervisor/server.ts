import {readWorkbench} from '../../packages/orchestration/workbench-reader.js';
import { parseRuntimeAction } from '../../packages/contracts/p3.js';
import { SupervisionController } from '../../packages/orchestration/supervision-controller.js';
import { OrchestrationController } from '../../packages/orchestration/controller.js';
import { ConversationController } from '../../packages/orchestration/conversation-controller.js';
import { VerificationController } from '../../packages/verification/controller.js';
import { LocalRuntimeAdapter } from '../../packages/runtime/index.js';
import { createServer, createConnection, type Socket } from 'node:net';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { parseCommand, parseQuery } from '../../packages/contracts/validation.js';
import type { Request, Response } from '../../packages/contracts/p1.js';
import { ExecutionManager } from '../../packages/execution/manager.js';

const MAX_BYTES = 1024 * 1024;
export const socketPath = (dataDir: string): string => join(resolve(dataDir), 'supervisor.sock');

function acquireLock(dataDir: string): () => void {
  const path = join(dataDir, 'service.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe service lock');
      let pid: unknown;
      try { pid = (JSON.parse(readFileSync(path, 'utf8')) as { pid: unknown }).pid; }
      catch { throw new Error('Service lock is incomplete; another service may be starting'); }
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw new Error('Invalid service lock; inspect it before recovery');
      try { process.kill(pid as number, 0); throw new Error('A supervisor service already owns this data directory'); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
      const current = lstatSync(path);
      if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('Service lock changed during recovery');
      unlinkSync(path);
      continue;
    }
    const stat = fstatSync(fd);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid }) + '\n'); }
    finally { closeSync(fd); }
    return () => {
      try {
        const current = lstatSync(path);
        if (current.ino === stat.ino && current.dev === stat.dev) unlinkSync(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
  }
  throw new Error('Could not acquire service ownership');
}

async function removeStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isSocket()) throw new Error('Socket path is occupied by a non-socket file');
  await new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); reject(new Error('Another service is listening on this socket')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Existing socket state is unknown')); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        if (existsSync(path)) unlinkSync(path);
        resolvePromise();
      } else reject(error);
    });
  });
}

export async function startService(directory: string): Promise<{ socket: string; close(): Promise<void> }> {
  const dataDir = resolve(directory);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (lstatSync(dataDir).isSymbolicLink() || !lstatSync(dataDir).isDirectory()) throw new Error('Data directory must be a real directory');
  const path = socketPath(dataDir);
  if (Buffer.byteLength(path) > 100) throw new Error('Data path is too long for a macOS Unix socket; choose a shorter directory');
  const unlock = acquireLock(dataDir);
  let store: SupervisorStore | undefined;
  let manager: ExecutionManager | undefined;
  let runtime: LocalRuntimeAdapter | undefined;
  let verification: VerificationController | undefined;
  let orchestration:OrchestrationController|undefined;
  let conversation:ConversationController|undefined;
  let supervision:SupervisionController|undefined;
  const connections = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    connections.add(socket);
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('error', () => { /* Connection failures do not change committed commands. */ });
    socket.once('close', () => connections.delete(socket));
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BYTES) { handled = true; socket.end(JSON.stringify({ id: '', ok: false, error: 'Request exceeds 1 MiB' }) + '\n'); return; }
      const newline = buffer.indexOf(10);
      if (newline === -1) return;
      handled = true;
      let id = '';
      let response: Response;
      try {
        const value: unknown = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a request object');
        const request = value as Request;
        if (typeof request.id !== 'string' || !request.id.trim() || request.id.length > 200) throw new Error('Request id is required');
        id = request.id;
        if(request.method==='command') {
          const command=parseCommand(request.command);
          if ('projectId' in command && ['proposeVerificationChange','publishVerificationChange'].includes(command.type) && store!.isManagedProject(command.projectId)) throw new Error('Managed project catalog changes must use independent verification review');
          if ('projectId' in command && 'runId' in command && store!.isManagedRun(command.projectId,command.runId)) throw new Error('Managed execution updates must use the execution controller');
        }
        // Validate and commit cancellation before aborting independent controllers.
        // Malformed or conflicting commands must have no cancellation side effects.
        let cancelledRuntime:unknown;
        if(request.method==='runtime'&&request.action.type==='cancel'){
          const action=parseRuntimeAction(request.action);if(action.type!=='cancel')throw new Error('Invalid runtime cancellation');
          cancelledRuntime=store!.runtime.control(action);
          verification!.cancelRuntime(action.runtimeId);orchestration!.cancelRuntime(action.runtimeId);conversation!.cancelRuntime(action.runtimeId);
          await supervision!.cancelRuntime(action.runtimeId);await runtime!.ensureWorker();
        }
        if(request.method==='execution'&&'executionId' in request.action&&['cancel','reconcile'].includes(request.action.type)&&store!.executionGet(request.action.executionId).runtimeBinding)throw new Error('Use runtime controller for durable activities');
        const result = request.method === 'exploration' ? store!.scheduler.dispatchExploration(request.action)
          : request.method === 'command' ? store!.command(parseCommand(request.command))
          : request.method === 'query' ? store!.query(parseQuery(request.query))
          : request.method === 'execution' ? await manager!.dispatch(request.action)
          : request.method === 'verification' ? await verification!.dispatch(request.action)
          : request.method === 'orchestration' ? await orchestration!.dispatch(request.action)
          : request.method === 'supervision' ? await supervision!.dispatch(request.action)
          : request.method === 'conversation' ? await conversation!.dispatch(request.action)
          : request.method === 'runtime' ? cancelledRuntime ?? await runtime!.dispatch(request.action)
          : request.method === 'workbench' ? await readWorkbench(store!,request.action)
          : request.method === 'health' ? { status: 'ready', stage: 'P5', requirementsReasoner:'codex-v1', conversationProtocol:'v1', taskAttachments:'v1', tokenPolicy:'nullable-limit-v1', publicWebResearch:'native-public-web-v1', supervisionProtocol:'v1', modelExecution: true, workspaceManagement: 'path-v1', durableRuntime: 'local-v1', runtime: await runtime!.health() }
          : (() => { throw new Error('Unknown request method'); })();
        if(request.method==='orchestration'&&request.action.type==='cancel')conversation!.cancelSession(request.action.sessionId);
        response = { id, ok: true, value: result };
      } catch (error) { response = { id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
      socket.end(JSON.stringify(response) + '\n');
    });
  });
  try {
    await removeStaleSocket(path);
    store = new SupervisorStore(dataDir);
    manager = new ExecutionManager(store,dataDir,undefined,{scope:'legacy'});
    runtime = new LocalRuntimeAdapter(store,dataDir);
    await manager.initialize();
    verification = new VerificationController(store,dataDir);
    await verification.initialize();
    orchestration=new OrchestrationController(store,dataDir,runtime);await orchestration.initialize();
    supervision=new SupervisionController(store,dataDir,runtime,verification);await supervision.initialize();
    conversation=new ConversationController(store,dataDir,runtime);await conversation.initialize();
    if(store.runtime.list().some(r=>!['awaiting-verification','cancelled'].includes(r.phase)) || store.runtime.operations().some(o=>['claimed','started','unknown'].includes(o.state)) || store.executionList().some(e=>e.runtimeBinding&&!e.stopConfirmed))await runtime.ensureWorker();
    server.maxConnections = 64;
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolvePromise(); });
    });
    chmodSync(path, 0o600);
  } catch (error) { server.close();await supervision?.close();await conversation?.close();await orchestration?.close();await verification?.close();await manager?.close();await runtime?.close();store?.close(); unlock(); throw error; }
  let closing: Promise<void> | undefined;
  return {
    socket: path,
    close() {
      closing ??= new Promise<void>((resolvePromise, reject) => {
        for (const socket of connections) socket.destroy();
        server.close(async error => {
          await supervision!.close().catch(reject);
          await conversation!.close().catch(reject);
          await orchestration!.close().catch(reject);
          await verification!.close().catch(reject);
          await manager!.close().catch(reject);
          await runtime!.close().catch(reject);
          try { store!.close(); unlock(); if (error) reject(error); else resolvePromise(); }
          catch (closeError) { reject(closeError); }
        });
      });
      return closing;
    },
  };
}
