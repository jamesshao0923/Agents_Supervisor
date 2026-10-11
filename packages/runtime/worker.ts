import {ResearchGroupActivity} from './research-group-activity.js';
import {ResearchRuntimeActivity} from './research-activity.js';
import {ScheduledRuntimeWorker} from './scheduled-worker.js';
import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type RuntimeOperation, type RuntimeReport } from '../contracts/p3.js';
import type { ExecutionRecord } from '../contracts/p2.js';
import { SupervisorStore } from '../persistence/store.js';
import { ExecutionManager } from '../execution/manager.js';
import { captureProcessMember, inspectManagedMember } from '../process-control/index.js';
import { readOwnership, workerAlive, writeOwnership } from './worker-ownership.js';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const payloadDigest = (body: string): string => createHash('sha256').update(body).digest('hex');
interface EffectReceipt { operationId: string; payloadDigest: string; result: unknown }
function receipt(value: unknown, operation: RuntimeOperation): EffectReceipt {
  if (operation.step.kind !== 'http' || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HTTP effect receipt is missing');
  const object = value as Record<string, unknown>;
  if (object.operationId !== operation.id || object.payloadDigest !== payloadDigest(operation.step.body) || !Object.hasOwn(object, 'result')) throw new Error('HTTP effect receipt operation or payload digest differs');
  return object as unknown as EffectReceipt;
}

export class LocalRuntimeWorker {
  private readonly manager: ExecutionManager;
  private readonly research:ResearchRuntimeActivity;
  private readonly scheduled:ScheduledRuntimeWorker;
  private stopping = false;
  private readonly reconciled = new Map<string, number>();
  private readonly eventCursors = new Map<string, { cursor: number; latestReconciliation: number }>();
  private readonly blocked = new Map<string, string>();
  private readonly faulted = new Set<string>();
  constructor(private readonly store: SupervisorStore, private readonly dataDir: string, readonly owner: string) {
    this.research=new ResearchRuntimeActivity(store,dataDir);
    this.scheduled = new ScheduledRuntimeWorker(store,dataDir,owner);
    this.manager = new ExecutionManager(store, dataDir, process.env.SUPERVISOR_CODEX_PATH ?? 'codex', {
      scope: 'runtime',
      eligibility: executionId => {
        const op = this.store.runtime.operations().find(operation => operation.executionId === executionId);
        if (!op) throw new Error('Execution has no durable runtime operation');
        this.store.runtime.eligible(op.id, this.owner);
      },
    });
  }

  async run(): Promise<void> {
    const ownership = await readOwnership(this.dataDir);
    if (!ownership || ownership.owner !== this.owner || !ownership.identity) throw new Error('Runtime worker lacks its durable released identity');
    if (ownership.worker && await workerAlive(ownership) && ownership.worker.pid !== process.pid) throw new Error('Another live worker holds this execution qualification');
    const worker = await captureProcessMember(process.pid);
    if (!worker || !await inspectManagedMember(ownership.identity, worker)) throw new Error('Runtime worker process ownership cannot be verified');
    const initialOperation = this.store.runtime.operations()[0];
    if (initialOperation) await this.fault('before-worker-receipt', initialOperation);
    // Readiness proves the actual worker, not just its guardian, has released.
    await writeOwnership(this.dataDir, { ...ownership, worker, ready: false });
    await this.manager.initialize();
    await this.scheduled.initialize();
    await writeOwnership(this.dataDir, { ...ownership, worker, ready: true });
    while (!this.stopping) {
      const current = await readOwnership(this.dataDir);
      if (!current || current.owner !== this.owner) throw new Error('Runtime worker ownership was superseded');
      await this.scheduled.tick();
      for(const error of this.scheduled.errors()){const key="scheduled:"+error.schedulerId;if(this.blocked.get(key)!==error.reason){this.blocked.set(key,error.reason);await this.log({kind:"scheduled-blocked",...error});}}
      const runtimes = this.store.runtime.list();
      for (const runtime of runtimes) {
        if (this.stopping) break;
        try { await this.tick(runtime.id); this.blocked.delete(runtime.id); }
        catch (error) {
          const detail = message(error);
          if (this.blocked.get(runtime.id) !== detail) {
            this.blocked.set(runtime.id, detail); this.store.runtime.block(runtime.id, detail);
            await this.log({ kind: 'runtime-blocked', runtimeId: runtime.id, error: detail });
          }
        }
      }
      const delayMs = runtimes.some(runtime => ['ready', 'running'].includes(runtime.phase)) ? 100
        : runtimes.some(runtime => !['cancelled', 'awaiting-verification'].includes(runtime.phase)) ? 250 : 1000;
      await delay(delayMs);
    }
  }

  private async tick(runtimeId: string): Promise<void> {
    const runtime = this.store.runtime.synchronizeCancellation(runtimeId);
    const operation = this.store.runtime.currentOperations(runtimeId).find(op => op.stepIndex === runtime.cursor && ['claimed', 'started', 'unknown'].includes(op.state));
    if (operation) {
      if (operation.owner !== this.owner) {
        // Adapter startup already established the previous worker is absent;
        // manager.initialize proved its managed writers stopped or recorded uncertainty.
        this.store.runtime.adopt(operation.id, this.owner);
        await this.recover({ ...operation, owner: this.owner });
        return;
      }
      if (operation.state === 'unknown') {
        const latest = this.lastReconciliation(runtimeId);
        if (latest > (this.reconciled.get(operation.id) ?? 0)) {
          this.reconciled.set(operation.id, latest);
          await this.recover(operation, true);
        }
        return;
      }
      if (runtime.cancelled) { await this.cancelOperation(operation); return; }
      if (runtime.paused) return;
      await this.execute(operation);
      return;
    }
    if (runtime.cancelled || runtime.paused || runtime.cursor >= runtime.definition.steps.length) return;
    await new ResearchGroupActivity(this.store,this.dataDir).advance(runtimeId);
    const claimed = this.store.runtime.claim(runtimeId, this.owner);
    if (claimed) await this.execute(claimed);
  }

  private lastReconciliation(runtimeId: string): number {
    const observed = this.eventCursors.get(runtimeId) ?? { cursor: 0, latestReconciliation: 0 };
    for (;;) {
      const page = this.store.runtime.events(runtimeId, observed.cursor);
      for (const event of page) if (event.kind === 'reconcile') observed.latestReconciliation = event.seq;
      if (page.length) observed.cursor = page.at(-1)!.seq;
      this.eventCursors.set(runtimeId, observed);
      if (page.length < 500) return observed.latestReconciliation;
    }
  }

  private async execute(operation: RuntimeOperation): Promise<void> {
    const runtime = this.store.runtime.get(operation.runtimeId);
    if (runtime.cancelled) { await this.cancelOperation(operation); return; }
    if (runtime.paused) return;
    await this.research.prepare(operation.id,this.owner);
    this.store.runtime.prepareIntegrationInputs(operation.id, this.owner);
    this.store.runtime.eligible(operation.id, this.owner);
    await this.fault('after-claim-before-effect', operation);
    // The persisted intent precedes every request with possible side effects.
    this.store.runtime.markStarted(operation.id, this.owner);
    if (operation.step.kind === 'codex') {
      const binding = this.store.runtime.binding(operation.id, this.owner);
      const input = this.store.runtime.executionInput(operation.id, this.owner);
      let record = await this.manager.startBound(input, binding);
      while (!record.stopConfirmed && record.state !== 'unknown' && !this.stopping) {
        if (this.store.runtime.get(runtime.id).cancelled) await this.manager.cancel(record.id);
        await delay(100);
        record = this.store.executionGet(record.id);
      }
      if (this.stopping && !record.stopConfirmed) return;
      await this.reportCodex(operation, record);
    } else if(operation.step.kind==='materials'){await this.research.acquire(operation,this.owner);
    } else if (operation.step.kind === 'http') {
      await this.postEffect(operation);
    } else {
      await this.report(operation, 'confirmed', { stepId: operation.step.id, input: runtime.inputs[operation.step.id] });
    }
  }

  private async recover(operation: RuntimeOperation, explicit = false): Promise<void> {
    const runtime = this.store.runtime.get(operation.runtimeId);
    if (operation.step.kind === 'codex') {
      const execution = this.store.executionList().find(record => record.id === operation.executionId);
      if (execution?.state === 'queued' && !execution.identity && !execution.turnIntent && !runtime.cancelled) {
        if (!runtime.paused) await this.execute(operation);
      } else if (execution) {
        if (!execution.stopConfirmed) await this.manager.reconcile(execution.id);
        await this.reportCodex(operation, this.store.executionGet(execution.id));
      } else if (operation.state === 'claimed' || operation.state === 'started') {
        // executionCreate is committed before guardian release. Absence of
        // that receipt proves this local Activity has not released a model target.
        if (runtime.cancelled) await this.cancelOperation(operation);
        else if (!runtime.paused) await this.execute(operation);
      } else {
        // markStarted precedes startBound; without an execution receipt no target
        // can have released, but a claimed Activity must not invent a successful result.
        await this.report(operation, 'unknown', { reason: 'Codex effect intent has no durable execution receipt' }, 'Codex execution receipt requires reconciliation');
      }
      return;
    }
    if(operation.step.kind==='materials'){await this.research.recover(operation,this.owner);return;}
    if (operation.step.kind === 'input') {
      if (runtime.cancelled) await this.cancelOperation(operation);
      else if (!runtime.paused) await this.execute(operation);
      return;
    }
    if (operation.state === 'claimed') {
      if (runtime.cancelled) await this.cancelOperation(operation);
      else if (!runtime.paused) await this.execute(operation);
      return;
    }
    const priorRequest = this.lastReconciliation(runtime.id);
    this.reconciled.set(operation.id, priorRequest);
    if (operation.step.queryUrl) {
      try {
        const query = new URL(operation.step.queryUrl); query.searchParams.set('operationId', operation.id);
        const response = await fetch(query, { method: 'GET', signal: AbortSignal.timeout(Math.min(operation.step.timeoutMs, 20_000)), redirect: 'error' });
        if (response.ok) {
          const found = receipt(await response.json(), operation);
          await this.report(operation, 'confirmed', found);
          return;
        }
        if (response.status !== 404) throw new Error('Effect reconciliation query returned ' + response.status);
      } catch (error) {
        await this.report(operation, 'unknown', { reason: message(error) }, 'Effect reconciliation could not establish the actual receipt');
        return;
      }
    }
    if (runtime.cancelled) {
      await this.report(operation, 'unknown', { reason: 'Cancelled HTTP request may have committed remotely' }, 'Cancelled HTTP effect requires actual-state reconciliation');
    } else if (operation.step.idempotent && !runtime.paused && operation.state !== 'unknown' && !explicit) {
      // Stable keys prevent duplicating an already committed effect; an unsafe
      // operation never reaches this branch, even if its query currently says absent.
      await this.postEffect(operation);
    } else {
      await this.report(operation, 'unknown', { reason: 'No matching durable receipt was found', automaticRetry: false }, 'HTTP effect is unknown; no unsafe replay was performed');
    }
  }

  private async postEffect(operation: RuntimeOperation): Promise<void> {
    if (operation.step.kind !== 'http') throw new Error('Expected HTTP operation');
    this.store.runtime.eligible(operation.id, this.owner);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('HTTP operation timeout')), operation.step.timeoutMs);
    const cancellation = setInterval(() => { if (this.stopping || this.store.runtime.get(operation.runtimeId).cancelled) controller.abort(new Error('HTTP operation cancellation')); }, 50);
    try {
      const response = await fetch(operation.step.url, { method: 'POST', body: operation.step.body, signal: controller.signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operation.id, 'X-Supervisor-Payload-SHA256': payloadDigest(operation.step.body) } });
      if (!response.ok) throw new Error('HTTP effect returned ' + response.status);
      const effect = receipt(await response.json(), operation);
      await this.fault('after-effect-before-report', operation);
      await this.report(operation, 'confirmed', effect);
    } catch (error) {
      await this.report(operation, 'unknown', { reason: message(error) }, 'HTTP request outcome is unknown; reconcile actual effects before continuing');
    } finally { clearTimeout(deadline); clearInterval(cancellation); }
  }

  private async reportCodex(operation: RuntimeOperation, record: ExecutionRecord): Promise<void> {
    const runtime = this.store.runtime.get(operation.runtimeId);
    const outcome: RuntimeReport['outcome'] = !record.stopConfirmed ? 'unknown' : runtime.cancelled || record.state === 'cancelled' ? 'cancelled'
      : record.state === 'completed' ? 'confirmed' : record.state === 'failed' ? 'failed' : 'unknown';
    await this.report(operation, outcome, { executionId: record.id, state: record.state, stopConfirmed: record.stopConfirmed, artifactId: record.artifactId, usage: record.usage, usageStatus: record.usageStatus, error: record.error },
      outcome === 'unknown' ? 'Codex turn outcome or accounting is unknown; no automatic replay' : outcome === 'failed' ? record.error ?? 'Codex execution failed' : undefined);
  }

  private async cancelOperation(operation: RuntimeOperation): Promise<void> {
    if (operation.step.kind === 'codex' && operation.executionId) {
      const record = this.store.executionList().find(execution => execution.id === operation.executionId);
      if (record) {
        await this.manager.cancel(record.id);
        while (!this.store.executionGet(record.id).stopConfirmed && this.store.executionGet(record.id).state !== 'unknown' && !this.stopping) await delay(50);
        await this.reportCodex(operation, this.store.executionGet(record.id));
        return;
      }
    }
    await this.report(operation, operation.state === 'claimed' ? 'cancelled' : 'unknown', { reason: operation.state === 'claimed' ? 'Cancelled before external dispatch' : 'Cancellation cannot undo an unknown effect' });
  }

  private async report(operation: RuntimeOperation, outcome: RuntimeReport['outcome'], result: unknown, error?: string): Promise<void> {
    await this.fault('before-report', operation);
    const semantic = JSON.stringify({ outcome, result, error: error ?? null });
    const report: RuntimeReport = { messageId: operation.id + ':' + this.owner + ':' + createHash('sha256').update(semantic).digest('hex'), outcome, result, ...(error === undefined ? {} : { error }) };
    this.store.runtime.report(operation.id, this.owner, report);
  }

  private async fault(point: string, operation: RuntimeOperation): Promise<void> {
    const key = operation.id + ':' + point;
    if (process.env.SUPERVISOR_RUNTIME_FAULT !== point || this.faulted.has(key)) return;
    this.faulted.add(key);
    const marker = { point, operationId: operation.id, pid: process.pid, owner: this.owner, time: new Date().toISOString() };
    await writeFile(join(this.dataDir, 'runtime-worker-fault.json'), JSON.stringify(marker) + '\n', { mode: 0o600 });
    await this.log({ kind: 'fault-boundary', ...marker });
    process.kill(process.pid, 'SIGSTOP');
  }
  private async log(value: unknown): Promise<void> { await appendFile(join(this.dataDir, 'runtime-worker.log'), JSON.stringify(value) + '\n', { mode: 0o600 }); }
  async close(): Promise<void> { this.stopping = true; await this.scheduled.close(); await this.manager.close({ cancel: false }); }
}
