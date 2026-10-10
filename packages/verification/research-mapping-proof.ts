import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { VerificationRepository } from '../persistence/verification.js';
import type { GoalSession } from '../contracts/p5.js';
import type { ResearchWorkflowProposal } from '../contracts/p4-research-workflow.js';
import type { Proposal, VerificationJob } from './records.js';
import { canonical, digest } from './candidate.js';
import { verificationDirectory } from './scoped-environment.js';
import { readBounded } from '../workspace/research-runtime-files.js';
import { validateResearchProofPlan, originalResearchChecks } from './research-workflow.js';
function ensure(v: unknown, m: string): asserts v {
    if (!v)
        throw Error('Research mapping approval: ' + m);
}
const bodyDigest = (v: object) => {
    const { digest: _, ...body } = v as Record<string, unknown>;
    return digest(canonical(body));
};
/** Independently persisted host role; missing optional projection fields cannot
 * turn a native artifact proposal into an ordinary final permission. */
export function persistedResearchWorkflow(db: DatabaseSync, proposalId: string): ResearchWorkflowProposal | null {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_workflow_plans'").get()) return null;
    const row = db.prepare('SELECT record FROM research_workflow_plans WHERE proposal_id=?').get(proposalId);
    if (!row) return null;
    const native = JSON.parse(String(row.record)) as ResearchWorkflowProposal;
    ensure(native.proposalId === proposalId && native.digest === bodyDigest(native), 'Persisted native role changed');
    return native;
}
export function assertResearchMappingApproval(db: DatabaseSync, p: Proposal, j: VerificationJob): void {
    const row = db.prepare('SELECT record FROM research_workflow_plans WHERE proposal_id=?').get(p.id);
    ensure(row, 'Native mapping missing');
    const native = JSON.parse(String(row.record)) as ResearchWorkflowProposal;
    ensure(native.digest === bodyDigest(native), 'Native mapping envelope changed');
    const repo = new VerificationRepository(db), sessionRow = db.prepare('SELECT record FROM goal_sessions WHERE id=? AND project_id=?').get(p.runId, p.projectId);
    ensure(sessionRow, 'Original admitted session missing');
    const session = JSON.parse(String(sessionRow.record)) as GoalSession;
    ensure(session.runtimeId === p.runtimeId
        && session.research
        && session.proposal?.decision === 'ready', 'Original research scope missing');
    const run = repo.run(p.projectId, p.runId);
    validateResearchProofPlan(native.proofPlan, originalResearchChecks(session.proposal!.criteria, run.contract), p.contractDigest, p.spec.obligations.filter(o => o.required
        && o.applicable).map(o => o.id));
    ensure(p.researchProofPlanDigest === native.proofPlan.digest
        && j.researchProofPlanDigest === native.proofPlan.digest
        && j.proposalId === p.id
        && j.projectId === p.projectId
        && j.runId === p.runId
        && j.runtimeId === p.runtimeId
        && j.kind === 'review'
        && j.approved
        && !j.error
        && j.status === 'finished'
        && j.modelStarted
        && !j.usageUnknown
        && j.stopConfirmed, 'mapping requires actual independent definition approval');
    const root = join(verificationDirectory(repo.dataDirectory(), j), 'definition-review'), paths = ['result.json', 'output.txt', 'events.jsonl'].map(name => join(root, name));
    for (const path of paths)
        ensure(j.proofs[path]
            && digest(readBounded(path, 32 * 1024 * 1024)) === j.proofs[path], 'independent mapping proof missing/changed');
    const result = JSON.parse(readBounded(paths[0]!).toString()), raw = JSON.parse(readBounded(paths[1]!).toString()), events = readBounded(paths[2]!, 32 * 1024 * 1024).toString().trim().split('\n').map(line => JSON.parse(line));
    ensure(result.verdict === 'passed'
        && result.stopConfirmed
        && result.modelStarted
        && Number.isSafeInteger(result.usage)
        && result.usage > 0
        && result.usage <= j.usage
        && result.threadId
        && result.turnId
        && canonical(raw) === canonical({
        verdict: result.verdict,
        reason: result.reason,
        observations: result.observations
    }), 'independent mapping review is not a known completed approval');
    const inputs = events.filter(e => e.kind === 'review-input');
    ensure(inputs.length === 1
        && typeof inputs[0].value.prompt === 'string', 'complete mapping prompt absent');
    const prompt = inputs[0].value.prompt as string, context = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
    ensure(canonical(context.researchProofPlan) === canonical(native.proofPlan), 'independent reviewer did not receive exact complete mapping');
    const expectedControls = j.controls.map(control => ({
        id: control.id,
        passed: control.passed,
        results: control.results.map(({ instanceId, executionStatus, checks, reason }) => ({
            instanceId,
            executionStatus,
            checks,
            reason
        }))
    })), implementations = Object.fromEntries(Object.keys(p.bundle.files).map(file => [file, readBounded(join(p.bundle.directory, file)).toString('utf8')]));
    ensure(canonical(context.contract) === canonical(run.contract)
        && canonical(context.proposed) === canonical(p.spec)
        && canonical(context.actualControls) === canonical(expectedControls)
        && canonical(context.implementations) === canonical(implementations)
        && context.previous === null
        && canonical(context.previousImplementations) === canonical({}), 'mapping reviewer did not receive exact original contract definition controls and implementations');
    const modelInput = inputs[0].value;
    ensure(modelInput.model === j.config.model
        && modelInput.effort === j.config.effort
        && modelInput.cwd === (j.environmentScope?.workspace ?? j.workspace), 'mapping review capability or workspace differs from the actual job');
    const normalized = events.filter(e => e.kind === 'codex-event').map(e => e.value), terminal = normalized.findIndex(e => e.kind === 'turn-status'
        && e.terminal === true
        && e.status === 'completed'
        && e.method === 'turn/completed'
        && e.threadId === result.threadId
        && e.turnId === result.turnId
        && e.raw?.params?.threadId === result.threadId
        && e.raw.params.turn?.id === result.turnId
        && e.raw.params.turn?.status === 'completed'
        && e.raw.params.turn?.error == null);
    ensure(terminal >= 0, 'mapping review has no authoritative completed turn');
    const accounting = normalized.filter(e => e.kind === 'token-usage'
        && e.threadId === result.threadId
        && (!e.turnId
        || e.turnId === result.turnId)).map(e => e.tokenUsage?.total?.totalTokens);
    ensure(accounting.length > 0
        && accounting.every((value, index) => Number.isSafeInteger(value)
        && value >= 0
        && (index === 0
        || value >= accounting[index - 1]!))
        && accounting.at(-1) === result.usage, 'mapping review known usage differs from actual same-thread notifications');
    const completed = normalized.slice(0, terminal).filter(e => e.kind === 'message'
        && e.method === 'item/completed'
        && e.threadId === result.threadId
        && e.turnId === result.turnId
        && e.raw?.params?.item?.type === 'agentMessage').at(-1);
    ensure(completed
        && completed.text === readBounded(paths[1]!).toString()
        && canonical(JSON.parse(completed.text)) === canonical(raw), 'mapping approval is not the actual completed same-turn message');
    ensure(!normalized.some(e => ['protocol-error', 'waiting'].includes(e.kind)
        || e.kind === 'error'
        && e.willRetry !== true
        || e.kind === 'turn-status'
        && e.terminal
        && e.status !== 'completed'
        || ['item/started', 'item/completed'].includes(e.method)
        && !['userMessage', 'reasoning', 'agentMessage', 'contextCompaction'].includes(e.raw?.params?.item?.type)), 'mapping approval retains fatal or unauthorized tool evidence');
}
