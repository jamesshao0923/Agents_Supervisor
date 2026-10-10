import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseRuntimeAction, type RuntimeAction, type RuntimeAdapter, type RuntimeRecord, type RuntimeSubmit } from '../contracts/p3.js';
import { SupervisorStore } from '../persistence/store.js';
import { spawnManagedProcess } from '../process-control/index.js';
import { createOwnership, launcherAlive, readOwnership, retireOwnership, workerAlive, writeOwnership, type WorkerOwnership } from './worker-ownership.js';

export class LocalRuntimeAdapter implements RuntimeAdapter {
  readonly capabilities = { engine: 'local-v1' as const, workflowVersions: [1], pause: 'dispatch-only' as const, input: 'declared-wait' as const, automaticCodexReplay: false as const };
  private ensuring?: Promise<WorkerOwnership>;
  constructor(private readonly store: SupervisorStore, private readonly dataDir: string, private readonly options: { managedWorkspaceRoot?: string } = {}) {}

  async dispatch(value: unknown): Promise<unknown> {
    const action = parseRuntimeAction(value);
    switch (action.type) {
      case 'submit': return this.submit(action);
      case 'input': return this.sendInput(action);
      case 'pause': return this.requestPause(action.runtimeId, action.commandId);
      case 'resume': return this.requestResume(action.runtimeId, action.commandId);
      case 'cancel': return this.cancel(action.runtimeId, action.commandId);
      case 'reconcile': return this.control(action);
      case 'list': return this.store.runtime.list();
      case 'inspect': return this.inspect(action.runtimeId);
      case 'events': return this.subscribe(action.runtimeId, action.after);
      case 'capabilities': return this.capabilities;
    }
  }

  async submit(value: RuntimeSubmit): Promise<RuntimeRecord> {
    const input = parseRuntimeAction(value) as RuntimeSubmit;
    const previous = this.store.runtime.list().find(record => record.definition.commandId === input.commandId);
    let workspace: string;
    let workspaceKind: 'managed' | 'project';
    if (input.workspace !== undefined) {
      if (!isAbsolute(input.workspace)) throw new Error('Runtime workspace must be absolute');
      workspace = await realpath(input.workspace);
      if (workspace === '/' || !(await stat(workspace)).isDirectory()) throw new Error('Select an existing project directory');
      workspaceKind = [...this.store.runtime.list(), ...this.store.executionList()].some(record => record.workspace === workspace && record.workspaceKind === 'managed') ? 'managed' : 'project';
    } else if (previous) {
      if (previous.workspaceKind !== 'managed') throw new Error('Runtime commandId was submitted with an explicit project workspace');
      workspace = previous.workspace; workspaceKind = previous.workspaceKind;
    } else {
      const root = this.options.managedWorkspaceRoot ?? join(homedir(), '.supervisor', 'workspace');
      if (!isAbsolute(root)) throw new Error('Managed workspace root must be absolute');
      await mkdir(root, { recursive: true, mode: 0o700 });
      workspace = join(await realpath(root), createHash('sha256').update(input.commandId).digest('hex'));
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const metadata = await lstat(workspace);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Managed runtime workspace must be a real directory');
      workspace = await realpath(workspace); workspaceKind = 'managed';
    }
    const record = this.store.runtime.submit({ ...input, workspace, workspaceKind });
    await this.ensureWorker();
    return record;
  }

  async sendInput(input: Extract<RuntimeAction, { type: 'input' }>): Promise<RuntimeRecord> { return this.control(input); }
  async requestPause(runtimeId: string, commandId: string): Promise<RuntimeRecord> { return this.control({ type: 'pause', runtimeId, commandId }); }
  async requestResume(runtimeId: string, commandId: string): Promise<RuntimeRecord> { return this.control({ type: 'resume', runtimeId, commandId }); }
  async cancel(runtimeId: string, commandId: string): Promise<RuntimeRecord> { return this.control({ type: 'cancel', runtimeId, commandId }); }
  private async control(input: Parameters<SupervisorStore['runtime']['control']>[0]): Promise<RuntimeRecord> {
    const record = this.store.runtime.control(input); await this.ensureWorker(); return record;
  }
  inspect(runtimeId: string): unknown { return this.store.runtime.inspect(runtimeId); }
  subscribe(runtimeId: string, after: number) { return this.store.runtime.events(runtimeId, after); }
  async health() {
    const worker = await readOwnership(this.dataDir);
    return { capabilities: this.capabilities, worker, active: worker !== null && await workerAlive(worker) };
  }
  ensureWorker(): Promise<WorkerOwnership> {
    this.ensuring ??= this.launchWorker().finally(() => { delete this.ensuring; });
    return this.ensuring;
  }
  private async launchWorker(): Promise<WorkerOwnership> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    let ownership = await readOwnership(this.dataDir);
    if (ownership) {
      if (await workerAlive(ownership)) return ownership;
      if (!ownership.ready && await launcherAlive(ownership)) {
        return this.awaitReady(ownership.owner);
      }
      await retireOwnership(this.dataDir, ownership);
    }
    ownership = await createOwnership(this.dataDir);
    if (!ownership) {
      const concurrent = await readOwnership(this.dataDir);
      if (!concurrent) throw new Error('Runtime worker ownership is being published; retry the durable command');
      return this.awaitReady(concurrent.owner);
    }
    const owner = ownership.owner;
    const executable = fileURLToPath(new URL('../../apps/runtime-worker/main.js', import.meta.url));
    const child = await spawnManagedProcess({ operationId: 'runtime-worker-' + owner, command: process.execPath,
      args: [executable, '--data', this.dataDir, '--owner', owner], cwd: this.dataDir,
      onBeforeSpawn: async intent => { ownership = { ...ownership!, intent }; await writeOwnership(this.dataDir, ownership); },
      onIdentity: async identity => { ownership = { ...ownership!, identity }; await writeOwnership(this.dataDir, ownership); },
    }).catch(async error => {
      await writeOwnership(this.dataDir, { ...ownership!, ready: true, error: String(error) }); throw error;
    });
    child.stderr.on('data', (chunk: Buffer) => { void appendFile(join(this.dataDir, 'runtime-worker-startup.log'), chunk); });
    try {
      const ready = await this.awaitReady(owner);
      child.detach();
      return ready;
    } catch (error) {
      await child.terminate();
      const current = await readOwnership(this.dataDir);
      if (current?.owner === owner) await writeOwnership(this.dataDir, { ...current, ready: true, error: String(error) });
      throw error;
    }
  }
  private async awaitReady(owner: string): Promise<WorkerOwnership> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = await readOwnership(this.dataDir);
      if (!current || current.owner !== owner) throw new Error('Runtime worker ownership changed during startup');
      if (current.ready && await workerAlive(current)) return current;
      if (current.error) throw new Error('Runtime worker startup failed: ' + current.error);
      await delay(50);
    }
    throw new Error('Runtime worker readiness was not observed');
  }
  /** A UI/service disconnect leaves the durable worker and its activities running. */
  async close(): Promise<void> { await this.ensuring?.catch(() => {}); }
}
