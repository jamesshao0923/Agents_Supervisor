import type {Run, DomainEvent} from '../contracts/p1.js';
import type {ScheduledPlan} from '../contracts/p7-dispatch.js';
import {applyAction} from './index.js';
import {createScheduledDispatch} from './scheduled-dispatch.js';
import {createTaskResultDomain} from './task-results.js';
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw Error('Research group graph: ' + message);
}
/** Host repository must derive these identities from the actual native outbox.
 * This pure graph operation grants no filesystem, P2, model or P4 permissions. */
export function installResearchGroupGraph(input: {
  run: Run; plan: ScheduledPlan; acquisitionNodeId: string;
  acquisitionAttemptId: string; acquisitionOperationId: string;
  analysisAttemptId: string;
  analysisReservation: number;
  sha256: (text: string) => string;
}): {run: Run; events: DomainEvent[]} {
  const {run, plan, acquisitionNodeId, acquisitionAttemptId, acquisitionOperationId} = input;
  const dispatch = createScheduledDispatch({sha256: input.sha256});
  dispatch.validatePlan(run, plan);
  const material = run.nodes.find(node => node.id === acquisitionNodeId);
  const anchor = run.nodes.find(node => node.id === plan.integrationNodeId);
  ensure(run.nodes.length === 2 && material?.status === 'succeeded' &&
    material.dependencies.length === 0 && anchor?.required && anchor.status === 'pending' &&
    anchor.dependencies.length === 1 && anchor.dependencies[0] === material.id,
    'only settled native acquisition followed by unstarted original analysis is supported');
  ensure(!run.artifact && run.evidence.length === 0 && run.admission !== 'draft' &&
    ['ready', 'running'].includes(run.status), 'active same-contract pre-analysis boundary required');
  ensure(run.attempts.every(attempt => attempt.settled && attempt.status !== 'running' &&
    (attempt.purpose === 'reasoning' || attempt.id === acquisitionAttemptId &&
      attempt.nodeId === acquisitionNodeId && attempt.purpose === 'execution' &&
      attempt.status === 'succeeded' && attempt.actual === 0)), 'unsettled or foreign execution blocks installation');
  ensure(run.attempts.some(attempt => attempt.id === acquisitionAttemptId) &&
    run.operations.every(operation => operation.status === 'confirmed') &&
    run.operations.some(operation => operation.id === acquisitionOperationId &&
      operation.attemptId === acquisitionAttemptId) && run.leases.every(lease => lease.released),
    'actual acquisition accounting, effects and released writers required');
  ensure(plan.tasks.every(task => task.node.required && task.node.dependencies.length === 0),
    'first slice requires independent mandatory extraction groups');
  const next = structuredClone(run);
  next.nodes.splice(1, 0, ...plan.tasks.map(task => ({id: task.node.id,
    dependencies: [...task.node.dependencies], required: true, status: 'pending' as const})));
  next.nodes.find(node => node.id === anchor.id)!.dependencies.push(...plan.tasks.map(task => task.node.id));
  next.revision++;
  const existing = run.budget.futureExecution;
  ensure(!existing || existing.contractVersion === run.contract.version && existing.nodeId === anchor.id &&
    existing.attemptId === input.analysisAttemptId && existing.amount === input.analysisReservation,
    'existing final floor belongs to another exact attempt');
  const allocation = existing ?? {
    allocationId: 'research-groups:' + plan.id, contractVersion: run.contract.version,
    nodeId: anchor.id, attemptId: input.analysisAttemptId, amount: input.analysisReservation,
  };
  const floor = applyAction(next, {type: 'setFutureExecution', allocation, reason: 'Protect the unchanged original full research analysis after submitted group extraction'});
  // Use the actual scheduler policy and actual shared Run budget. No extra ledger.
  dispatch.evaluate({run: floor.run, plan,
    ledger: createTaskResultDomain({sha256: input.sha256}).createResultLedger(),
    claims: [], operations: [], leases: [], nowMs: 0});
  return {run: floor.run, events: [{type: 'research-group-graph-extension',
    runId: run.id, revision: next.revision, details: {
      planId: plan.id, planDigest: dispatch.digest(plan),
      acquisitionOperationId, acquisitionAttemptId,
      analysisNodeId: anchor.id, analysisAttemptId: input.analysisAttemptId,
      preservedDependencies: [acquisitionNodeId], addedTaskIds: plan.tasks.map(task => task.node.id),
      authority: 'untrusted-group-extraction-only',
    }}, ...floor.events]};
}
