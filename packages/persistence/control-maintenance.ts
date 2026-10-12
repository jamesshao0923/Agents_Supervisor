import {tokenCapacity,withinTokenReservation} from '../contracts/token-policy.js';
import {captureMaintenanceCausalEvidence,type MaintenanceCausalOperationInput} from '../verification/maintenance-causal-evidence.js';
import {assertLegacyControlReviewEvidence} from '../verification/legacy-review-evidence.js';
import {assertControlQualificationPublication} from './control-qualification.js';
import {expandedAuthorInput} from '../orchestration/indexed-history-presentation.js';
import {assertMaintenanceCommandEvidence} from '../verification/maintenance-command-evidence.js';
import { lstatSync } from 'node:fs';
import { sep, join, basename, dirname } from 'node:path';
import { verificationDirectory } from '../verification/scoped-environment.js';
import { inspectProcess, type ProcessIdentity } from '../process-control/index.js';
import type { ExecutionRecord } from '../contracts/p2.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Run, TaskContract } from '../contracts/p1.js';
import type { SupervisionJob } from '../contracts/p6-supervision.js';
import type { MaintenanceBasis, MaintenanceRecord, MaintenanceReplayStage, MaintenancePlan, RegressionSource, RegressionContext } from '../contracts/p6-control-maintenance.js';
import type { VerificationJob, Proposal, FrozenPlan } from '../verification/records.js';
import { canonical, digest } from '../verification/candidate.js';
import { FrozenReader, assertRecordedStops } from '../verification/frozen-reader.js';
import { maintenanceEnsure as ensure, maintenanceDigest as hash, regressionRef, assertMaintenancePlan, maintenanceInstance, assertMaintenanceReplay, inheritedExecutionRegression } from '../verification/control-maintenance-rules.js';
import { evaluateVerification, selectInstances } from '../verification/rules.js';
import { RuntimeRepository } from './runtime.js';
import { SupervisionRepository } from './supervision.js';
import { VerificationLineageRepository } from './verification-lineage.js';
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/** Same-Run bounded maintenance; all caller observations are reloaded under the writer transaction. */
export class ControlMaintenanceRepository {
    constructor(private readonly db: DatabaseSync, private readonly dataDir?: string) {
    }
    transaction<T>(body: () => T): T {
        const own = !this.db.isTransaction;
        if (own)
            this.db.exec('BEGIN IMMEDIATE');
        try {
            const value = body();
            ensure(!value || typeof (value as {
                then?: unknown;
            }).then !== 'function', 'Async transaction forbidden');
            if (own)
                this.db.exec('COMMIT');
            return value;
        }
        catch (e) {
            if (own)
                this.db.exec('ROLLBACK');
            throw e;
        }
    }
    private command<T>(id: string, input: unknown, body: () => T): T {
        return this.transaction(() => {
            ensure(typeof id === 'string' && id.trim(), 'Missing command identity');
            const row = this.db.prepare('SELECT request,result FROM control_maintenance_receipts WHERE command_id=?').get(id);
            if (row) {
                ensure(row.request === canonical(input), 'Conflicting maintenance command');
                return JSON.parse(String(row.result)) as T;
            }
            const result = body();
            this.db.prepare('INSERT INTO control_maintenance_receipts VALUES (?,?,?)').run(id, canonical(input), canonical(result));
            return result;
        });
    }
    private object<T>(kind: string, id: string): T {
        const row = this.db.prepare('SELECT record FROM verification_records WHERE kind=? AND id=?').get(kind, id);
        ensure(row, 'Missing actual ' + kind);
        return JSON.parse(String(row.record)) as T;
    }
    private run(projectId: string, runId: string): Run {
        const row = this.db.prepare('SELECT snapshot FROM runs WHERE project_id=? AND id=?').get(projectId, runId);
        ensure(row, 'Missing Run');
        return JSON.parse(String(row.snapshot)) as Run;
    }
    forLoop(loopId: string): MaintenanceRecord | null {
        const row = this.db.prepare('SELECT record FROM supervision_control_maintenance WHERE loop_id=?').get(loopId);
        return row ? JSON.parse(String(row.record)) as MaintenanceRecord : null;
    }
    get(id: string): MaintenanceRecord {
        const row = this.db.prepare('SELECT record FROM supervision_control_maintenance WHERE id=?').get(id);
        ensure(row, 'Unknown maintenance');
        const value = JSON.parse(String(row.record)) as MaintenanceRecord;
        ensure(hash(value.basis) === value.basisDigest, 'Maintenance basis changed');
        return value;
    }
    forProposal(id: string): MaintenanceRecord | null {
        return this.db.prepare('SELECT record FROM supervision_control_maintenance').all().map(r => JSON.parse(String(r.record)) as MaintenanceRecord).find(r => r.proposalId === id) ?? null;
    }
    private save(value: MaintenanceRecord): void {
        ensure(hash(value.basis) === value.basisDigest, 'Immutable basis changed');
        this.db.prepare('UPDATE supervision_control_maintenance SET record=? WHERE id=?').run(canonical(value), value.id);
        this.db.prepare('INSERT INTO control_maintenance_events(maintenance_id,record) VALUES (?,?)').run(value.id, canonical(value));
    }
    private settled(job: VerificationJob): void {
        const run = this.run(job.projectId, job.runId), a = run.attempts.find(a => a.id === job.attemptId);
        ensure(job.status === 'finished'
            && job.stopConfirmed
            && !job.usageUnknown
            && !job.error
            && Number.isSafeInteger(job.usage)
            && job.usage >= 0
            && withinTokenReservation(run.budget.limit, job.usage, job.config.reservation)
            && a?.settled
            && a.actual === job.usage
            && a.purpose === 'verification', 'Unsettled verification evidence');
        const reader = new FrozenReader(this.dataDir);
        assertRecordedStops(job, reader);
        const reports = Object.keys(job.proofs).filter(path => basename(path) === 'report.json'
            && basename(dirname(path)) === job.id), report = this.dataDir ? join(verificationDirectory(this.dataDir, job), 'report.json') : reports.length === 1 ? reports[0]! : '';
        ensure(report
            && job.proofs[report]
            && same(JSON.parse(reader.read(report).toString()), { results: job.results, controls: job.controls, evaluation: job.evaluation, error: job.error }), 'Actual finished verification report differs');
    }
    private final(job: VerificationJob, passed: boolean): {
        plan: FrozenPlan;
        proposal: Proposal;
    } {
        this.settled(job);
        ensure(job.kind === 'verification' && job.planId, 'Need actual product verification');
        const plan = this.object<FrozenPlan>('plan', job.planId), proposal = this.object<Proposal>('proposal', job.proposalId);
        ensure(plan.proposalId === proposal.id
            && plan.projectId === job.projectId
            && plan.runId === job.runId
            && plan.runtimeId === job.runtimeId
            && plan.definitionDigest === proposal.bundle.digest
            && plan.environmentDigest === job.environmentDigest
            && plan.contractDigest === proposal.contractDigest, 'Verification plan binding differs');
        ensure(plan.selection.mode === 'final'
            && plan.selection.completeScope
            && same(plan.selection, selectInstances(proposal.spec, { mode: 'final' }))
            && job.results.length > 0
            && job.results.every(r => r.executionStatus === 'executed'), 'Need complete actually executed product verification');
        const actual = evaluateVerification(proposal.spec, plan.selection, job.results);
        ensure(same(actual, job.evaluation) && actual.passed === passed && job.approved === passed && (!passed || actual.complete), 'Actual evaluation differs');
        const reader = new FrozenReader(this.dataDir);
        reader.candidate(plan.candidate);
        reader.definition(proposal.spec, proposal.bundle);
        return { plan, proposal };
    }
    private workspaceBoundary(workspace: string): ProcessIdentity[] {
        const overlap = (path: string) => path === workspace || path.startsWith(workspace + sep) || workspace.startsWith(path + sep), ids: ProcessIdentity[] = [];
        for (const row of this.db.prepare('SELECT record FROM executions').all()) {
            const e = JSON.parse(String(row.record)) as ExecutionRecord;
            if (!overlap(e.workspace))
                continue;
            ensure(['completed', 'cancelled', 'failed', 'interrupted'].includes(e.state)
                && e.stopConfirmed
                && e.usageStatus === 'reported'
                && e.usage !== null
                && Number.isSafeInteger(e.usage.totalTokens)
                && e.usage.totalTokens >= 0, 'Overlapping execution has unresolved stop or usage');
            if (e.identity)
                ids.push(e.identity as ProcessIdentity);
            const ledger = this.run(e.projectId, e.runId), attempt = ledger.attempts.find(a => a.id === e.attemptId), operations = ledger.operations.filter(o => o.attemptId === e.attemptId);
            ensure(attempt?.purpose === 'execution'
                && attempt.status !== 'running'
                && attempt.settled
                && attempt.actual === e.usage.totalTokens
                && operations.length > 0
                && operations.every(o => o.status === 'confirmed')
                && ledger.leases.filter(l => l.attemptId === e.attemptId).every(l => l.released), 'Overlapping execution accounting/effects unresolved');
        }
        for (const row of this.db.prepare("SELECT record FROM verification_records WHERE kind='job'").all()) {
            const job = JSON.parse(String(row.record)) as VerificationJob;
            if (!overlap(job.workspace))
                continue;
            ensure(job.status === 'finished' && job.stopConfirmed, 'Overlapping verification stop unresolved');
            ensure(!job.usageUnknown, 'Overlapping verification usage is unknown');
            ids.push(...job.identities);
        }
        return ids;
    }
    async assertPhysical(loopId: string): Promise<void> {
        const loop = new SupervisionRepository(this.db).get(loopId), workspace = new RuntimeRepository(this.db).get(loop.runtimeId).workspace;
        const ids = this.workspaceBoundary(workspace), before = hash(ids);
        for (const id of ids)
            ensure((await inspectProcess(id)).status === 'stopped', 'Actual workspace process is not stopped');
        ensure(hash(this.workspaceBoundary(workspace)) === before, 'Workspace identity boundary changed during physical check');
    }
    /** Pure database/FS revalidation, also used inside begin's writer transaction. */
    assess(loopId: string, passJobId: string): MaintenanceBasis | null {
        const loops = new SupervisionRepository(this.db), loop = loops.get(loopId);
        loops.assertEligible(loopId);
        const runtime = new RuntimeRepository(this.db), inspection = runtime.inspect(loop.runtimeId), run = inspection.run;
        ensure(run.attempts.every(a => a.settled)
            && run.operations.every(o => o.status === 'confirmed')
            && run.leases.every(l => l.released), 'Maintenance needs a fully quiet settled boundary');
        this.workspaceBoundary(inspection.runtime.workspace);
        const pass = this.object<VerificationJob>('job', passJobId), { plan, proposal } = this.final(pass, true), base = new VerificationLineageRepository(this.db).captureBase(run.projectId, run.id);
        ensure(pass.runtimeId === loop.runtimeId
            && pass.runId === loop.runId
            && pass.projectId === loop.projectId
            && base.baseProposalId === proposal.id
            && proposal.contractDigest === loop.contractDigest
            && run.artifact?.id === plan.id
            && run.artifact.digest === hash(plan.candidate), 'Original passing verification is not current');
        new FrozenReader().candidate({ ...plan.candidate, tree: inspection.runtime.workspace });
        const events = this.db.prepare("SELECT seq,payload,created_at FROM runtime_events WHERE runtime_id=? AND kind='repair-appended' ORDER BY seq").all(loop.runtimeId);
        const sources: RegressionSource[] = [];
        for (const event of events) {
            const request = JSON.parse(String(event.payload)) as {
                failureJobId: string;
                failedObligationIds: string[];
                steps: {
                    id: string;
                }[];
            };
            const failure = this.object<VerificationJob>('job', request.failureJobId);
            if (failure.proposalId !== proposal.id)
                continue;
            const failed = this.final(failure, false);
            ensure(failure.projectId === run.projectId
                && failure.runId === run.id
                && failure.runtimeId === loop.runtimeId
                && failure.finishedAt
                && pass.startedAt >= String(event.created_at)
                && String(event.created_at) >= failure.finishedAt, 'Failure/repair/pass order differs');
            ensure(request.steps.length > 0
                && request.steps.every(step => run.nodes.some(n => n.id === step.id
                && n.status === 'succeeded')
                && run.attempts.some(a => a.nodeId === step.id
                && a.purpose === 'execution'
                && a.settled
                && a.status === 'succeeded')), 'Repair execution has no actual successful settled attempt');
            for (const result of failure.results) {
                const ids = result.checks.filter(c => c.verdict === 'failed'
                    && request.failedObligationIds.includes(c.obligationId)
                    && proposal.spec.obligations.some(o => o.id === c.obligationId
                    && o.required
                    && o.applicable)).map(c => c.obligationId);
                if (!ids.length)
                    continue;
                const instance = failed.plan.selection.instances.find(i => i.id === result.instanceId);
                ensure(instance, 'Failure lacks frozen instance');
                sources.push({ defectRef: regressionRef(failure.id, instance, result), failureJobId: failure.id, repairEventSeq: Number(event.seq), candidate: failed.plan.candidate, instance, result, obligationIds: ids });
            }
        }
        if (!sources.length)
            return null;
        for (const source of this.requiredSources(base.baseProposalId, proposal.spec, base.transitionIds))
            if (!sources.some(s => s.defectRef === source.defectRef))
                sources.push(source);
        ensure(sources.length <= 16, 'Required regression replay exceeds bounded capacity');
        return { schemaVersion: 1, policy: 'same-contract-regression-v1', loopId, projectId: run.projectId, runId: run.id, runtimeId: loop.runtimeId, contractVersion: run.contract.version, contractDigest: loop.contractDigest, base, baselinePassJobId: pass.id, baselinePassPlanId: plan.id, passingCandidate: plan.candidate, environmentDigest: pass.environmentDigest, sources, necessity: 'required-regression' };
    }
    begin(input: {
        commandId: string;
        loopId: string;
        expectedRevision: number;
        basis: MaintenanceBasis;
        authorInput: unknown;
    }): {
        maintenance: MaintenanceRecord;
        job: SupervisionJob;
    } {
        return this.command(input.commandId, input, () => {
            ensure(!this.forLoop(input.loopId), 'Automatic maintenance allowance exhausted');
            const loops = new SupervisionRepository(this.db), loop = loops.get(input.loopId);
            ensure(loop.revision === input.expectedRevision, 'Stale maintenance revision');
            const basis = this.assess(loop.id, input.basis.baselinePassJobId);
            ensure(basis && same(basis, input.basis), 'Maintenance basis differs from actual records');
            const context = (input.authorInput as {
                context?: {
                    evolution?: {
                        maintenance?: {
                            basis?: unknown;
                        };
                    };
                };
            })?.context;
            ensure(same(context?.evolution?.maintenance?.basis, basis), 'Author input omits exact maintenance basis');
            const runtime = new RuntimeRepository(this.db), run = runtime.inspect(loop.runtimeId).run;
            ensure(!run.budget.futureVerification, 'Original final allocation must already be consumed');
            const legacyReserve = Math.max(0, run.budget.verificationReserve - run.attempts.filter(a => a.purpose === 'verification'
                && a.contractVersion === run.contract.version).reduce((sum, a) => sum + a.actual!, 0));
            ensure(tokenCapacity(run.budget.limit) - run.budget.spent - (run.budget.futureExecution?.amount ?? 0) >= 2 * loop.config.reservation + Math.max(legacyReserve, loop.config.reservation), 'Maintenance cannot fund author, review and protected full final');
            const id = 'maintenance-' + hash({ loopId: loop.id, policy: basis.policy }).slice(0, 32);
            runtime.setFutureVerification({ commandId: input.commandId + ':floor', runtimeId: loop.runtimeId, expectedContractVersion: loop.contractVersion, expectedRevision: run.revision, allocationId: id + ':final', amount: loop.config.reservation, reason: 'Protect full final after bounded same-contract control maintenance' });
            const job = loops.beginJob({ commandId: input.commandId + ':author', loopId: loop.id, expectedRevision: loop.revision, purpose: 'acceptance-authoring', context: input.authorInput });
            const record: MaintenanceRecord = { id, basis, basisDigest: hash(basis), authorJobId: job.id, status: 'authoring', proposalId: null, reviewId: null, finalJobId: null, reason: null };
            this.db.prepare('INSERT INTO supervision_control_maintenance VALUES (?,?,?)').run(id, loop.id, canonical(record));
            this.save(record);
            return { maintenance: record, job };
        });
    }
    bindProposal(proposalId: string, authorJobId: string, plan: MaintenancePlan): void {
        this.transaction(() => {
            const row = this.db.prepare('SELECT record FROM supervision_control_maintenance').all().map(r => JSON.parse(String(r.record)) as MaintenanceRecord).find(r => r.authorJobId === authorJobId);
            ensure(row, 'Maintenance author has no reserved basis');
            const record = this.get(row.id), proposal = this.object<Proposal>('proposal', proposalId), old = this.object<Proposal>('proposal', record.basis.base.baseProposalId!);
            ensure(proposal.projectId === record.basis.projectId
                && proposal.runId === record.basis.runId
                && proposal.contractDigest === record.basis.contractDigest
                && proposal.candidate.digest === record.basis.passingCandidate.digest, 'Maintenance proposal changed its target');
            ensure(proposal.maintenanceId === record.id && proposal.maintenanceDigest === record.basisDigest, 'Proposal omits frozen maintenance binding');
            assertMaintenancePlan(record.basis, old.spec, proposal.spec, plan);
            ensure(record.status === 'authoring' || record.status === 'proposed', 'Maintenance no longer admits a proposal');
            if (record.proposalId) {
                ensure(record.proposalId === proposalId, 'Maintenance proposal already bound');
                return;
            }
            record.proposalId = proposalId;
            record.status = 'proposed';
            this.save(record);
        });
    }
    private assertSource(source: RegressionSource): void {
        const job = this.object<VerificationJob>('job', source.failureJobId), { plan } = this.final(job, false);
        ensure(same(source.candidate, plan.candidate)
            && plan.selection.instances.some(i => same(i, source.instance))
            && job.results.some(r => same(r, source.result))
            && regressionRef(job.id, source.instance, source.result) === source.defectRef, 'Original regression evidence differs');
        ensure(source.obligationIds.length > 0
            && source.obligationIds.every(id => source.result.checks.some(c => c.obligationId === id
            && c.verdict === 'failed')), 'Original defect lacks specific failed checks');
        const event = this.db.prepare("SELECT runtime_id,payload FROM runtime_events WHERE seq=? AND kind='repair-appended'").get(source.repairEventSeq);
        ensure(event && event.runtime_id === job.runtimeId, 'Regression repair event absent');
        const request = JSON.parse(String(event.payload));
        ensure(request.failureJobId === job.id && source.obligationIds.every(id => request.failedObligationIds.includes(id)), 'Regression repair authority differs');
    }
    inheritedSources(baseProposalId: string | null): RegressionSource[] {
        const result = new Map<string, RegressionSource>(), seen = new Set<string>();
        let id = baseProposalId;
        while (id) {
            ensure(!seen.has(id) && seen.size < 128, 'Invalid complete regression ancestry');
            seen.add(id);
            const proposal = this.object<Proposal>('proposal', id);
            ensure(proposal.status === 'published', 'Regression ancestor unpublished');
            if (proposal.regressionDigest) {
                ensure(proposal.reviewId, 'Regression ancestor lacks review');
                const stage = this.replayForReview(proposal.reviewId);
                ensure(stage && stage.proposalId === proposal.id, 'Published regression stage missing');
                this.validateReplay(stage, true);
                for (const replay of stage.replays) {
                    assertMaintenanceReplay(replay);
                    this.assertSource(replay.source);
                    const old = result.get(replay.defectRef);
                    ensure(!old || same(old, replay.source), 'Conflicting inherited fault');
                    result.set(replay.defectRef, replay.source);
                }
                break;
            }
            id = new VerificationLineageRepository(this.db).bindingForProposal(proposal.id).base.baseProposalId;
        }
        return [...result.values()].sort((a, b) => a.defectRef.localeCompare(b.defectRef));
    }
    hasRegressionHistory(baseProposalId: string | null): boolean {
        const seen = new Set<string>();
        let id = baseProposalId;
        while (id) {
            ensure(!seen.has(id) && seen.size < 128, 'Invalid regression ancestry');
            seen.add(id);
            if (this.object<Proposal>('proposal', id).regressionDigest)
                return true;
            id = new VerificationLineageRepository(this.db).bindingForProposal(id).base.baseProposalId;
        }
        return false;
    }
    sourcesForTarget(baseProposalId: string | null, contract: TaskContract, transitionIds: string[]): RegressionSource[] {
        return this.inheritedSources(baseProposalId).filter(source => {
            const oldJob = this.object<VerificationJob>('job', source.failureJobId), oldProposal = this.object<Proposal>('proposal', oldJob.proposalId);
            // The immutable original contract is obtained from the published control binding history,
            // not a newer mutable Run contract. Same-contract maintenance never changes criteria.
            const changes = transitionIds.map(id => new VerificationLineageRepository(this.db).transition(id)).flatMap(t => t.changes);
            const affected = source.obligationIds.filter(id => {
                const criterionId = oldProposal.spec.obligations.find(o => o.id === id)!.criterionId;
                return changes.some(c => c.criterionId === criterionId && (c.kind === 'modify' || c.kind === 'retire'));
            });
            if (affected.length) {
                ensure(affected.length === source.obligationIds.length, 'Partial regression retirement requires explicit split');
                return false;
            }
            ensure(source.obligationIds.every(id => contract.criteria.some(c => c.id === oldProposal.spec.obligations.find(o => o.id === id)!.criterionId)), 'Missing regression criterion without authorized transition');
            return true;
        });
    }
    requiredSources(baseProposalId: string | null, target: Proposal['spec'], transitionIds: string[]): RegressionSource[] {
        return this.inheritedSources(baseProposalId).filter(source => {
            const original = this.object<Proposal>('proposal', this.object<VerificationJob>('job', source.failureJobId).proposalId), changed = source.obligationIds.filter(id => !same(original.spec.obligations.find(o => o.id === id), target.obligations.find(o => o.id === id)));
            if (!changed.length)
                return true;
            ensure(changed.length === source.obligationIds.length, 'Partially changed multi-obligation regression requires an explicit split before automatic evolution');
            for (const id of changed) {
                const criterionId = original.spec.obligations.find(o => o.id === id)!.criterionId;
                ensure(transitionIds.some(t => new VerificationLineageRepository(this.db).transition(t).changes.some(c => c.criterionId === criterionId
                    && (c.kind === 'modify'
                    || c.kind === 'retire'))), 'Regression retirement lacks applied contract authority');
            }
            return false;
        });
    }
    sourcesForProposal(proposal: Proposal): {
        basis: Pick<MaintenanceBasis, 'sources' | 'passingCandidate'>;
        plan: MaintenancePlan;
    } | null {
        const binding = new VerificationLineageRepository(this.db).bindingForProposal(proposal.id), required = this.requiredSources(binding.base.baseProposalId, proposal.spec, binding.base.transitionIds);
        if (!proposal.regressionDigest) {
            ensure(!required.length && !proposal.maintenanceId && !this.hasRegressionHistory(binding.base.baseProposalId), 'Required regression binding omitted');
            return null;
        }
        const draftRow = this.db.prepare('SELECT record FROM verification_control_drafts WHERE proposal_id=?').get(proposal.id);
        ensure(draftRow, 'Regression needs actual qualified-v2 draft');
        const draft = JSON.parse(String(draftRow.record)).draft;
        const row = this.db.prepare('SELECT record FROM supervision_jobs WHERE id=?').get(draft.authorBinding.jobId);
        ensure(row, 'Actual regression author missing');
        const job = JSON.parse(String(row.record)) as SupervisionJob;
        const evolution = (expandedAuthorInput(job.input) as {
            context: {
                evolution: {
                    maintenance?: {
                        basis: MaintenanceBasis;
                    };
                    regression?: RegressionContext;
                };
            };
        }).context.evolution;
        const basis = evolution.maintenance?.basis ?? evolution.regression;
        ensure(basis && hash(basis) === proposal.regressionDigest, 'Frozen regression input differs');
        const plan = (job.result as {
            maintenance?: MaintenancePlan;
        })?.maintenance;
        ensure(plan, 'Author result omits regression mappings');
        ensure(required.every(s => basis.sources.some(n => same(n, s))), 'Inherited regression source omitted');
        ensure(basis.passingCandidate.digest === proposal.candidate.digest, 'Regression positive differs from current candidate');
        for (const source of basis.sources)
            this.assertSource(source);
        ensure(same(plan.regressions.map(m => m.defectRef).sort(), basis.sources.map(s => s.defectRef).sort()), 'Every regression needs exact mapping');
        for (const source of basis.sources)
            maintenanceInstance(proposal.spec, plan.regressions.find(m => m.defectRef === source.defectRef)!, source);
        if (proposal.maintenanceId) {
            const record = this.get(proposal.maintenanceId);
            const baseline = this.final(this.object<VerificationJob>('job', record.basis.baselinePassJobId), true);
            ensure(baseline.plan.id === record.basis.baselinePassPlanId
                && same(baseline.plan.candidate, record.basis.passingCandidate)
                && baseline.plan.environmentDigest === record.basis.environmentDigest, 'Original passing baseline changed');
            ensure(record.proposalId === proposal.id
                && record.authorJobId === job.id
                && proposal.maintenanceDigest === record.basisDigest
                && same(basis, record.basis), 'Maintenance binding changed');
            assertMaintenancePlan(record.basis, this.object<Proposal>('proposal', record.basis.base.baseProposalId!).spec, proposal.spec, plan);
        }
        else
            ensure(same(basis.sources, required), 'Author invented an unregistered inherited fault');
        return { basis, plan };
    }
    /** Read-only proof binding; never publication authority. Reloads both original and target objects. */
    executionRegressionSource(source:RegressionSource,proposalId:string,instance:import('../contracts/p4.js').VerificationInstance,side:'bad'|'good'):import('../verification/maintenance-command-evidence.js').OriginalExecutionRegression|undefined {
        const proposal=this.object<Proposal>('proposal',proposalId);
        ensure(side==='bad'||side==='good','Unknown execution regression side');
        ensure(selectInstances(proposal.spec,{mode:'final'}).instances.some(i=>same(i,instance)),'Execution regression instance is not an actual final selection');
        this.assertSource(source);
        const job=this.object<VerificationJob>('job',source.failureJobId),{proposal:old}=this.final(job,false);
        if(!inheritedExecutionRegression(old.spec,proposal.spec,source,instance)
          || source.result.proofFiles?.some(path=>path.includes('/command/'))) return undefined;
        ensure(old.status==='published' && old.reviewId,'Original execution regression lacks published independent approval');
        const review=this.object<VerificationJob>('job',old.reviewId);this.settled(review);
        ensure(review.kind==='review' && review.proposalId===old.id && review.approved,'Original execution definition lacks actual independent approval');
        const database=this.db.prepare('PRAGMA database_list').all().find(row=>row.name==='main');
        ensure(database?.file,'Original execution evidence requires actual database directory');
        const dataDir=this.dataDir??dirname(String(database.file));
        if(old.controlDraftDigest)assertControlQualificationPublication(this.db,{proposalId:old.id,reviewId:review.id},dataDir);
        else assertLegacyControlReviewEvidence({dataDir,proposal:old,review});
        return {proposal:old,job,source,output:join(verificationDirectory(dataDir,job),'candidate',source.instance.id),side};
    }
    replayForReview(reviewId: string): MaintenanceReplayStage | null {
        const row = this.db.prepare('SELECT record FROM control_maintenance_replays WHERE review_id=?').get(reviewId);
        if (!row)
            return null;
        const stage = JSON.parse(String(row.record)) as MaintenanceReplayStage;
        const { digest, ...body } = stage;
        ensure(hash(body) === digest, 'Replay stage digest changed');
        return stage;
    }
    appendReplay(stage: MaintenanceReplayStage): void {
        this.transaction(() => {
            const job = this.object<VerificationJob>('job', stage.reviewId);
            ensure(job.status === 'running', 'Replay needs running actual review');
            this.validateReplay(stage, false);
            const prior = this.replayForReview(stage.reviewId);
            if (prior) {
                ensure(same(prior, stage), 'Conflicting immutable replay');
                return;
            }
            this.db.prepare('INSERT INTO control_maintenance_replays VALUES (?,?,?)').run(stage.reviewId, stage.proposalId, canonical(stage));
        });
    }
    validateReplay(stage: MaintenanceReplayStage, finished: boolean): void {
        const { digest: stageDigest, ...body } = stage;
        ensure(hash(body) === stageDigest, 'Replay stage digest differs');
        const proposal = this.object<Proposal>('proposal', stage.proposalId), source = this.sourcesForProposal(proposal);
        ensure(source, 'Replay proposal lacks bound maintenance');
        const job = this.object<VerificationJob>('job', stage.reviewId);
        ensure(job.kind === 'review' && job.proposalId === proposal.id && job.projectId === proposal.projectId && job.runId === proposal.runId, 'Replay belongs to another review');
        if (finished)
            this.settled(job);
        const expectedRows = stage.replays.flatMap(replay => ['maintenance:' + replay.id + ':bad', 'maintenance:' + replay.id + ':good']).sort();
        ensure(same(job.controls.filter(row => row.id.startsWith('maintenance:')).map(row => row.id).sort(), expectedRows), 'Replay observations contain missing or unrelated operations');
        const reports = Object.keys(job.proofs).filter(path => basename(path) === 'report.json'
            && basename(dirname(path)) === job.id), root = this.dataDir ? verificationDirectory(this.dataDir, job) : reports.length === 1 ? dirname(reports[0]!) : null;
        ensure(root, 'Actual regression job directory missing');
        ensure(stage.replays.length === source.basis.sources.length, 'Replay inventory drops required faults');
        const seen = new Set<string>(), reader = new FrozenReader(this.dataDir);
        for (const replay of stage.replays) {
            const original = source.basis.sources.find(s => s.defectRef === replay.defectRef);
            ensure(original
                && !seen.has(replay.defectRef)
                && same(original, replay.source)
                && same(replay.passingCandidate, source.basis.passingCandidate), 'Replay source changed or duplicated');
            seen.add(replay.defectRef);
            ensure(replay.id === hash({ proposalId: proposal.id, source: original, instance: replay.instance }).slice(0, 40), 'Replay operation identity differs');
            const mapping = source.plan.regressions.find(m => m.defectRef === replay.defectRef)!;
            ensure(same(replay.instance, maintenanceInstance(proposal.spec, mapping, original)), 'Replay detector changed');
            assertMaintenanceReplay(replay);
            reader.candidate(original.candidate);
            reader.candidate(replay.passingCandidate);
            for (const side of ['bad', 'good'] as const) {
                const id = 'maintenance:' + replay.id + ':' + side, rows = job.controls.filter(c => c.id === id);
                ensure(rows.length === 1 && rows[0]!.passed && same(rows[0]!.results, replay[side]), 'Replay is not an actual job observation');
                const output = join(root, 'maintenance-' + replay.id + '-' + side, replay.instance.id);
                reader.candidate({ ...(side === 'bad' ? original.candidate : replay.passingCandidate), tree: join(output, 'candidate') });
                for (const result of replay[side]) {
                    for (const path of result.proofFiles ?? [])
                        ensure(path.startsWith(output + sep) && job.proofs[path], 'Replay proof not in its exact actual job operation');
                    assertMaintenanceCommandEvidence({
                        proposal, job, instance: replay.instance,
                        label: 'maintenance-' + replay.id + '-' + side,
                        output, result, reader, originalExecution:this.executionRegressionSource(original,proposal.id,replay.instance,side),
                    });
                }
            }
        }
        const expectedProofs = [...new Set(stage.replays.flatMap(replay =>
            [...replay.bad, ...replay.good].flatMap(result => result.proofFiles ?? [])))].sort();
        ensure(stage.executionProofs && typeof stage.executionProofs === 'object'
            && !Array.isArray(stage.executionProofs)
            && same(Object.keys(stage.executionProofs).sort(), expectedProofs),
            'Replay immutable execution proof inventory is missing or differs');
        for (const path of expectedProofs) {
            const fixedDigest = stage.executionProofs[path];
            ensure(typeof fixedDigest === 'string' && /^[a-f0-9]{64}$/.test(fixedDigest)
                && job.proofs[path] === fixedDigest
                && digest(reader.read(path, root)) === fixedDigest,
                'Replay immutable execution proof differs from actual bytes or job manifest');
        }
        if (finished) {
            reader.proofs(job.proofs);
            assertRecordedStops(job, reader);
        }
    }
    reviewPayload(proposalId: string, reviewId: string, presentation?:'causal-v1'|'causal-v2'): unknown | null {
        ensure(presentation===undefined||(presentation==='causal-v1'||presentation==='causal-v2'),'Unknown maintenance causal presentation');
        const proposal = this.object<Proposal>('proposal', proposalId), source = this.sourcesForProposal(proposal);
        if (!source)
            return null;
        const stage = this.replayForReview(reviewId);
        ensure(stage, 'Missing actual maintenance stage');
        this.validateReplay(stage, false);
        const draft = JSON.parse(String(this.db.prepare('SELECT record FROM verification_control_drafts WHERE proposal_id=?').get(proposal.id)!.record)).draft;
        const row = this.db.prepare('SELECT record FROM supervision_jobs WHERE id=?').get(draft.authorBinding.jobId)!;
        const author = JSON.parse(String(row.record)) as SupervisionJob;
        const evolution = (expandedAuthorInput(author.input) as {
            context: {
                evolution: {
                    maintenance?: unknown;
                    regression?: unknown;
                };
            };
        }).context.evolution;
        const context = evolution.maintenance ?? evolution.regression;
        const candidate = source.basis.passingCandidate;
        const reader = new FrozenReader(this.dataDir);
        reader.candidate(candidate);
        const passingSourceText: Record<string, {content:string;executable:number}> = {};
        for (const [name, expected] of Object.entries(candidate.files)) {
            const path = join(candidate.tree, name), bytes = reader.read(path);
            const executable = lstatSync(path).mode & 0o111;
            const content = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
            ensure(!content.includes('\0')
                && digest(Buffer.concat([bytes, Buffer.from('\0executable:' + executable)])) === expected,
                'Complete passing source differs');
            passingSourceText[name] = {content,executable};
        }
        reader.candidate(candidate);
        const executionRegressions = stage.replays.filter(replay=>this.executionRegressionSource(replay.source,proposal.id,replay.instance,'bad')).map(replay=>({
            role:'original-execution-regression-v1',defectRef:replay.defectRef,originalFailureJobId:replay.source.failureJobId,originalInstance:replay.source.instance,currentInstance:replay.instance,
            meaning:'Exact already-published single-obligation entry-exit case only; not arbitrary business assertion coverage. Bad actual entry nonzero with no checker, good actual entry zero plus original checker pass.'
        }));
        const legacy = { context, plan: source.plan, replay: stage, passingSourceText, ...(executionRegressions.length?{executionRegressions}:{}) };
        if(presentation===undefined)return legacy;
        const database=this.db.prepare('PRAGMA database_list').all().find(row=>row.name==='main');ensure(database?.file,'Causal evidence requires actual database directory');
        const dataDir=this.dataDir??dirname(String(database.file)),review=this.object<VerificationJob>('job',reviewId),root=verificationDirectory(dataDir,review),operations:MaintenanceCausalOperationInput[]=[];
        for(const replay of stage.replays){
            const original=source.basis.sources.find(s=>s.defectRef===replay.defectRef)!;this.assertSource(original);
            const failure=this.object<VerificationJob>('job',original.failureJobId);
            operations.push({role:'original-failure',defectRef:original.defectRef,job:failure,instance:original.instance,candidateDigest:original.candidate.digest,output:join(verificationDirectory(dataDir,failure),'candidate',original.instance.id),label:'candidate',result:original.result,fixedProofs:failure.proofs});
            for(const side of ['bad','good']as const)operations.push({role:side==='bad'?'bad-replay':'good-replay',defectRef:original.defectRef,job:review,instance:replay.instance,candidateDigest:side==='bad'?original.candidate.digest:replay.passingCandidate.digest,output:join(root,'maintenance-'+replay.id+'-'+side,replay.instance.id),label:'maintenance-'+replay.id+'-'+side,result:replay[side][0]!,fixedProofs:stage.executionProofs});
        }
        const causalEvidence=captureMaintenanceCausalEvidence({proposalId,reviewId,replayStageDigest:stage.digest,operations},new FrozenReader(dataDir));
        if(presentation==='causal-v1')return {...legacy,causalEvidence};
        const eligible=[];
        for(const replay of stage.replays){
            const inherited=this.executionRegressionSource(replay.source,proposal.id,replay.instance,'bad');
            if(!inherited)continue;
            const old=inherited.proposal,oldReview=this.object<VerificationJob>('job',old.reviewId!),definition=proposal.spec.cases.find(c=>c.id===replay.instance.caseId&&c.revision===replay.instance.revision)!;
            ensure(definition.verifier.kind==='command'&&!definition.verifier.build,'Host execution regression supports command/no-build only');
            const files=[];const hostReader=new FrozenReader(dataDir);hostReader.definition(old.spec,old.bundle);hostReader.definition(proposal.spec,proposal.bundle);
            for(const name of definition.verifier.files){
                const originalPath=join(old.bundle.directory,name),currentPath=join(proposal.bundle.directory,name),original=hostReader.read(originalPath),current=hostReader.read(currentPath);
                const originalMode=lstatSync(originalPath).mode&0o111,currentMode=lstatSync(currentPath).mode&0o111;
                ensure(originalMode===0&&currentMode===0&&digest(original)===old.bundle.files[name]&&digest(current)===proposal.bundle.files[name]&&original.equals(current),'Host execution regression checker assets differ');
                files.push({name,originalPath,currentPath,sha256:digest(original),originalCurrentExecutableBits:originalMode,currentExecutableBits:currentMode});
            }
            const reviewPath=join(verificationDirectory(dataDir,oldReview),'definition-review','result.json'),reviewBytes=hostReader.read(reviewPath);
            ensure(digest(reviewBytes)===oldReview.proofs[reviewPath],'Host original independent review proof differs');
            const reviewed=JSON.parse(reviewBytes.toString('utf8'));
            ensure(reviewed.verdict==='passed'&&reviewed.stopConfirmed===true,'Host original independent review lacks passed/stopped result');
            eligible.push({role:'original-execution-regression-v1',defectRef:replay.defectRef,sourceFailureJobId:inherited.job.id,sourcePlanId:inherited.job.planId,
                originalProposalId:old.id,originalPublishedStatus:old.status,originalDefinitionDigest:old.bundle.digest,currentProposalId:proposal.id,currentDefinitionDigest:proposal.bundle.digest,
                originalInstance:replay.source.instance,currentInstance:replay.instance,originalCase:old.spec.cases.find(c=>c.id===replay.source.instance.caseId&&c.revision===replay.source.instance.revision),currentCase:definition,
                originalIndependentReview:{id:oldReview.id,proposalId:oldReview.proposalId,approved:oldReview.approved,usage:oldReview.usage,usageUnknown:oldReview.usageUnknown,stopConfirmed:oldReview.stopConfirmed,config:oldReview.config,proof:{path:reviewPath,sha256:digest(reviewBytes),encoding:'utf8',content:reviewBytes.toString('utf8')}},
                checkerAssets:files,meaning:'Host revalidated exact published independently approved single-obligation/no-build/single-entry inherited case, original normal nonzero/no-checker witness, current bad replay and good entry/checker through existing source/replay guards. Asset mode facts are current reads of frozen original and inherited files; legacy definition digests did not historically bind mode. This role proves that exact execution regression, not arbitrary business assertion coverage or semantic approval.'});
        }
        return {...legacy,causalEvidence,hostEligibility:{schemaVersion:1,kind:'original-execution-regression-host-eligibility',proposalId,reviewId,replayStageDigest:stage.digest,eligible}};
    }
    /** A recorded mandatory gap cannot be bypassed by manually delivering its old baseline. */
    assertDelivery(projectId: string, runId: string, contractDigest: string): void {
        for (const row of this.db.prepare('SELECT record FROM supervision_control_maintenance').all()) {
            const record = JSON.parse(String(row.record)) as MaintenanceRecord;
            if (record.basis.projectId === projectId && record.basis.runId === runId && record.basis.contractDigest === contractDigest)
                ensure(this.get(record.id).status === 'complete', 'Required control maintenance is not fully completed; old passing evidence cannot authorize delivery');
        }
    }
    /** Publication cannot bypass this gate through direct repository calls. */
    assertPublication(proposalId: string, reviewId: string): void {
        const proposal = this.object<Proposal>('proposal', proposalId), base = new VerificationLineageRepository(this.db).bindingForProposal(proposalId).base;
        const source = this.sourcesForProposal(proposal);
        if (!source)
            return;
        const stage = this.replayForReview(reviewId);
        ensure(stage && stage.proposalId === proposalId, 'Required regression replay missing');
        this.validateReplay(stage, true);
        ensure(this.object<VerificationJob>('job', reviewId).approved, 'Maintenance independent review rejected');
        if (proposal.maintenanceId) {
            const record = this.get(proposal.maintenanceId);
            ensure(record.status === 'proposed' || record.status === 'reviewed', 'Failed maintenance cannot publish');
            record.reviewId = reviewId;
            record.status = 'reviewed';
            this.save(record);
        }
    }
    complete(id: string, jobId: string): void {
        this.transaction(() => {
            const record = this.get(id);
            ensure(record.status === 'reviewed' || record.status === 'complete', 'Maintenance is not independently published');
            const job = this.object<VerificationJob>('job', jobId), { proposal } = this.final(job, true);
            ensure(proposal.id === record.proposalId
                && proposal.status === 'published'
                && job.environmentDigest === record.basis.environmentDigest, 'Maintenance final is not its new fully verified definition');
            if (record.finalJobId)
                ensure(record.finalJobId === jobId, 'Conflicting maintenance final');
            record.finalJobId = jobId;
            record.status = 'complete';
            this.save(record);
        });
    }
    fail(loopId: string, reason: string): void {
        this.transaction(() => {
            const record = this.forLoop(loopId);
            if (!record || record.status === 'complete' || record.status === 'failed')
                return;
            record.status = 'failed';
            record.reason = reason;
            this.save(record);
        });
    }
}
