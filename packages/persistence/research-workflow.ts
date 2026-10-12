import {tokenCapacity} from '../contracts/token-policy.js';
import {expandedAuthorInput} from '../orchestration/indexed-history-presentation.js';
import {prepareResearchWorkflowEvolution} from '../verification/research-evolution.js';
import { assertResearchMappingApproval } from '../verification/research-mapping-proof.js';
import type { DatabaseSync } from 'node:sqlite';
import { join, relative, sep } from 'node:path';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import type { SupervisorStore } from './store.js';
import type { Delivery, Proposal, VerificationJob } from '../verification/records.js';
import type { ResearchProofPlan, ResearchWorkflowProposal, ResearchArtifactEvidence, ResearchWorkflowBinding, ResearchHostFact, ResearchDeliverySeal, ResearchHostGate } from '../contracts/p4-research-workflow.js';
import { canonical, digest, exclusions, type Candidate } from '../verification/candidate.js';
import { verificationDirectory } from '../verification/scoped-environment.js';
import { prepareResearchProofPlan, originalResearchChecks, evaluateResearchWorkflow, RESEARCH_HOST_GATES, requiredPhase } from '../verification/research-workflow.js';
import { VerificationProofReader } from '../verification/proof-reader.js';
import { assertLegacyControlReviewEvidence } from '../verification/legacy-review-evidence.js';
import { captureMaterialBinding, readMaterialBinding } from '../verification/material.js';
import { readBounded } from '../workspace/research-runtime-files.js';
import { evaluateVerification, selectInstances,currentVerificationCases } from '../verification/rules.js';
import { safeControlJSON } from '../contracts/p4-controls.js';
function ensure(v: unknown, m: string): asserts v {
    if (!v)
        throw Error('Research workflow authority: ' + m);
}
const overlap = (a: string, b: string) => a === b
    || a.startsWith(b + sep)
    || b.startsWith(a + sep);
const bodyDigest = (v: object) => {
    const { digest: _, ...body } = v as Record<string, unknown>;
    return digest(canonical(body));
};
export class ResearchWorkflowRepository {
    constructor(private readonly db: DatabaseSync, private readonly storeOf: () => SupervisorStore, private readonly fault?: (point: string) => void) {
    }
    private get store() {
        return this.storeOf();
    }
    private get repo() {
        return this.store.verification;
    }
    isTransaction(): boolean {
        return this.db.isTransaction;
    }
    private goal(runtimeId: string) {
        const runtime = this.store.runtime.get(runtimeId), sessions = this.store.goals.list().filter(s => s.runtimeId === runtimeId
            && s.id === runtime.runId
            && s.projectId === runtime.projectId);
        ensure(sessions.length === 1
            && sessions[0]!.research
            && sessions[0]!.proposal?.decision === 'ready', 'actual admitted research GoalSession required');
        const session = sessions[0]!;
        originalResearchChecks(session.proposal!.criteria, this.repo.run(runtime.projectId, runtime.runId).contract);
        return session;
    }
    requires(runtimeId: string): boolean {
        return this.store.goals.list().some(s => s.runtimeId === runtimeId
            && s.research);
    }
    proposal(proposalId: string): ResearchWorkflowProposal {
        const row = this.db.prepare('SELECT record FROM research_workflow_plans WHERE proposal_id=?').get(proposalId);
        ensure(row, 'frozen native proof plan missing');
        const value = JSON.parse(String(row.record)) as ResearchWorkflowProposal;
        ensure(value.digest === bodyDigest(value), 'native plan envelope changed');
        return value;
    }
    bindProposal(input: {
        proposalId: string;
        authorJobId: string;
        proofPlan: ResearchProofPlan;
    }): void {
        ensure(this.db.isTransaction, 'proposal binding needs parent transaction');
        safeControlJSON(input);
        const p = this.repo.get('proposal', input.proposalId), goal = this.goal(p.runtimeId), author = this.store.supervision.job(input.authorJobId), run = this.repo.run(p.projectId, p.runId);
        ensure(p.status === 'proposed','native plan requires an unpublished exact proposal');
        const qualified=this.store.verificationLineage.bindingForProposal(p.id).definitionFormat==='qualified-v2';
        ensure(qualified?!!p.controlDraftDigest:p.baseVersion===0&&!p.controlDraftDigest,
            'native historical definitions require exact qualified V2 protocol');
        ensure(author.purpose === 'acceptance-authoring'
            && author.status === 'finished'
            && !author.error
            && author.stopConfirmed
            && author.usage !== null
            && author.projectId === p.projectId
            && author.runId === p.runId
            && author.runtimeId === p.runtimeId, 'actual completed same-Run author required');
        const attempt = run.attempts.find(a => a.id === author.attemptId);
        ensure(attempt?.settled
            && attempt.actual === author.usage, 'author accounting differs');
        const frozen = expandedAuthorInput(author.input) as {
            context: {
                acceptance: {
                    criteria: import('../contracts/p5.js').AcceptanceItem[];
                    contract: typeof run.contract;
                    workflowMode?: string;
                };
            };
        }, output = author.result as {
            researchWorkflow?: Parameters<typeof prepareResearchProofPlan>[3];
        };
        ensure(frozen.context.acceptance.workflowMode === 'native-host-v1'
            && canonical(frozen.context.acceptance.criteria) === canonical(goal.proposal!.criteria)
            && canonical(frozen.context.acceptance.contract) === canonical(run.contract)
            && (qualified?(author.result as import('../orchestration/acceptance-authoring-v2.js').ControlEvolutionBundle).assets.researchWorkflow:output.researchWorkflow), 'author did not freeze complete native criteria');
        const declaration=qualified?(author.result as import('../orchestration/acceptance-authoring-v2.js').ControlEvolutionBundle).assets.researchWorkflow:output.researchWorkflow;
        ensure(declaration,'native complete mapping declaration missing');
        const expected = prepareResearchProofPlan(goal.proposal!.criteria, run.contract, p.spec, declaration);
        ensure(canonical(expected) === canonical(input.proofPlan)
            && p.researchProofPlanDigest === expected.digest, 'host plan differs from actual author/current criteria');
        let evolution:import('../contracts/p4-research-workflow.js').ResearchWorkflowEvolution|undefined;
        if(qualified){
            const draft=this.store.controlQualification.draftForProposal(p.id).draft;
            ensure(draft.authorBinding.jobId===author.id
                &&draft.authorBinding.inputDigest===author.inputDigest
                &&draft.authorBinding.resultDigest===digest(canonical(author.result)),
                'native evolution author differs from actual control draft');
            ensure(draft.base.baseProposalId,'native evolution predecessor missing');
            const previous=this.repo.get('proposal',draft.base.baseProposalId);
            ensure(previous.status==='published'&&previous.reviewId,'native predecessor is not published');
            this.assertMappingReview(previous,this.repo.get('job',previous.reviewId));
            evolution=prepareResearchWorkflowEvolution({previous:this.proposal(previous.id),
                previousSpec:previous.spec,currentPlan:expected,currentSpec:p.spec,currentContract:run.contract,
                base:draft.base,transitions:draft.transitions,...(draft.sourceRefresh?{refresh:draft.sourceRefresh}:{})});
        }
        const body = {
            ...(evolution?{evolution}:{}),
            schemaVersion: 1 as const,
            proposalId: p.id,
            proofPlan: expected,
            authorJobId: author.id
        }, value = {
            ...body,
            digest: digest(canonical(body))
        };
        const old = this.db.prepare('SELECT record FROM research_workflow_plans WHERE proposal_id=?').get(p.id);
        if (old) {
            ensure(old.record === canonical(value), 'conflicting immutable native plan');
            return;
        }
        this.db.prepare('INSERT INTO research_workflow_plans(proposal_id,record) VALUES (?,?)').run(p.id, canonical(value));
    }
    assertMappingReview(p: Proposal, j: VerificationJob): void {
        assertResearchMappingApproval(this.db, p, j);
    }
    qualificationReviewContext(proposalId:string):{
        current:ResearchWorkflowProposal;previous:ResearchWorkflowProposal;
        contract:import('../contracts/p1.js').TaskContract;
    } {
        const current=this.proposal(proposalId);
        ensure(current.evolution,'native V2 mapping lacks exact evolution binding');
        const proposal=this.repo.get('proposal',proposalId),draft=this.store.controlQualification.draftForProposal(proposalId).draft;
        const previous=this.proposal(current.evolution.predecessorProposalId);
        const contract=this.repo.run(proposal.projectId,proposal.runId).contract;
        const expected=prepareResearchWorkflowEvolution({previous,
            previousSpec:this.repo.get('proposal',previous.proposalId).spec,
            currentPlan:current.proofPlan,currentSpec:proposal.spec,currentContract:contract,
            base:draft.base,transitions:draft.transitions,...(draft.sourceRefresh?{refresh:draft.sourceRefresh}:{})});
        ensure(canonical(expected)===canonical(current.evolution),'actual native evolution changed');
        return {current,previous,contract};
    }
    private snapshot(jobId: string) {
        const job = this.repo.get('job', jobId);
        ensure(job.planId, 'final plan missing');
        const plan = this.repo.get('plan', job.planId);
        const proposal = this.repo.get('proposal', plan.proposalId);
        ensure(proposal.reviewId, 'review missing');
        const review = this.repo.get('job', proposal.reviewId);
        const runtime = this.store.runtime.get(job.runtimeId);
        const run = this.repo.run(job.projectId, job.runId);
        const goal = this.goal(runtime.id);
        const native = this.proposal(proposal.id);
        // Monitoring health/revision grants no permission. Actual pause/stop,
        // contract and total deadline remain in the delivery boundary.
        const record = this.store.supervision.forRuntime(runtime.id);
        const loop = record ? {
            id: record.id, paused: record.paused, stopped: record.stopped,
            createdAt: record.createdAt, limits: record.limits,
            contractDigest: record.contractDigest, contractVersion: record.contractVersion
        } : null;
        const runtimes = this.store.runtime.list().filter(r => overlap(r.workspace, runtime.workspace));
        const executions = this.store.executionList().filter(e => overlap(e.workspace, runtime.workspace));
        const jobs = this.repo.list('job').filter(j => overlap(j.workspace, runtime.workspace));
        // Collect actual sibling ledgers, not just terminal/stopped projection flags.
        const runRecords = new Map<string, typeof run>();
        for (const item of [...runtimes, ...executions, ...jobs]) {
            const key = canonical([item.projectId, item.runId]);
            if (!runRecords.has(key)) runRecords.set(key, this.repo.run(item.projectId, item.runId));
        }
        return {
            job, plan, proposal, review, runtime, run, goal, native, loop,
            conversation: this.store.conversations.forRun(run.projectId, run.id),
            operations: this.store.runtime.currentOperations(runtime.id),
            siblings: {runtimes, executions, jobs, runs: [...runRecords.values()]}
        };
    }
    private assertBoundary(s: ReturnType<ResearchWorkflowRepository['snapshot']>): void {
        const { job, plan, proposal, review, runtime, run, native, loop } = s;
        ensure(!runtime.paused
            && !runtime.cancelled
            && (!loop
            || !loop.paused
            && !loop.stopped)
            && !['paused', 'cancelled', 'succeeded'].includes(run.status), 'pause/stop/cancel/terminal boundary');
        if (loop)
            ensure(Date.now() - Date.parse(loop.createdAt) <= loop.limits.maxDurationMs, 'supervision total duration exceeded');
        ensure(!this.store.conversations.hasPendingForRun(run.projectId, run.id), 'pending user message');
        ensure(run.attempts.every(a => a.settled
            && a.status !== 'running')
            && run.operations.every(o => o.status === 'confirmed')
            && run.leases.every(l => l.released)
            && run.budget.spent <= tokenCapacity(run.budget.limit), 'unknown effects/cost/resources or total Run budget exceeded');
        ensure(s.siblings.runtimes.every(r => ['cancelled', 'awaiting-verification'].includes(r.phase)
            && !this.store.conversations.hasPendingForRun(r.projectId, r.runId))
            && s.siblings.executions.every(e => e.stopConfirmed
            && e.usageStatus === 'reported'
            && e.usage !== null
            && ['completed', 'failed', 'cancelled'].includes(e.state))
            && s.siblings.jobs.every(j => j.status === 'finished'
            && j.stopConfirmed
            && !j.usageUnknown), 'overlapping unresolved workspace writer');
        ensure(s.siblings.runs.every(other =>
            other.attempts.every(a => a.settled && a.status !== 'running')
            && other.operations.every(o => o.status === 'confirmed')
            && other.leases.every(l => l.released)), 'overlapping ledger has unresolved cost/effects/resources');
        ensure(run.artifact?.id === plan.id
            && this.repo.headForRun(run.projectId, run.id)?.id === proposal.id
            && plan.contractDigest === digest(canonical(run.contract))
            && proposal.contractDigest === plan.contractDigest, 'artifact/head/contract changed');
        ensure(job.approvalScope === 'research-artifact'
            && job.researchProofPlanDigest === native.proofPlan.digest
            && job.approved
            && !job.error
            && job.status === 'finished'
            && job.stopConfirmed
            && !job.usageUnknown, 'native final artifact not qualified');
        ensure(run.attempts.find(a => a.id === job.attemptId)?.actual === job.usage, 'final actual accounting differs');
        const reportPath = join(verificationDirectory(this.repo.dataDirectory(), job), 'report.json');
        ensure(job.proofs[reportPath]
            && digest(readBounded(reportPath, 32 * 1024 * 1024)) === job.proofs[reportPath], 'exact final job report missing/changed');
        const report = JSON.parse(readBounded(reportPath, 32 * 1024 * 1024).toString());
        ensure(canonical(report.results) === canonical(job.results)
            && canonical(report.controls) === canonical(job.controls)
            && canonical(report.evaluation) === canonical(job.evaluation)
            && report.error === job.error, 'final job observations differ from actual report');
        ensure(canonical(plan.selection) === canonical(selectInstances(proposal.spec, {
            mode: 'final'
        }))
            && evaluateVerification(proposal.spec, plan.selection, job.results).complete
            && canonical(job.evaluation) === canonical(evaluateVerification(proposal.spec, plan.selection, job.results)), 'exact full artifact selection failed');
        if(this.store.verificationLineage.bindingForProposal(proposal.id).definitionFormat==='qualified-v2')
            this.store.controlQualification.assertPublicationBinding({proposalId:proposal.id,reviewId:review.id});
        else assertLegacyControlReviewEvidence({
            dataDir: this.repo.dataDirectory(),
            proposal,
            review
        });
        this.assertMappingReview(proposal, review);
    }
    private binding(s: ReturnType<ResearchWorkflowRepository['snapshot']>): ResearchWorkflowBinding {
        return {
            runtimeId: s.runtime.id,
            projectId: s.run.projectId,
            runId: s.run.id,
            proposalId: s.proposal.id,
            planId: s.plan.id,
            jobId: s.job.id,
            candidateDigest: s.plan.candidate.digest,
            definitionDigest: s.plan.definitionDigest,
            contractDigest: s.plan.contractDigest
        };
    }
    private facts(
        s: ReturnType<ResearchWorkflowRepository['snapshot']>,
        binding: ResearchWorkflowBinding,
        delivery?: Delivery
    ): ResearchHostFact[] {
        const ref = (kind: string, id: string, value: unknown) => ({kind, id, digest: digest(canonical(value))});
        const common = [
            ref('run', s.run.id, s.run),
            ref('goal', s.goal.id, s.goal),
            ref('artifact-job', s.job.id, s.job),
            ref('definition-review', s.review.id, s.review),
            {kind: 'native-plan', id: s.proposal.id, digest: s.native.digest}
        ];
        const producer = currentVerificationCases(s.proposal.spec).filter(c=>(c.status??'active')==='active').flatMap(c => {
            if (c.verifier.kind !== 'material') return [];
            const nativeBinding = c.verifier.binding;
            const operation = s.operations.find(o => o.id === nativeBinding.operationId);
            const execution = s.siblings.executions.find(e => e.id === nativeBinding.executionId);
            ensure(operation && execution, 'actual producer record is absent');
            return [
                ref('runtime-operation', operation.id, operation),
                ref('execution', execution.id, execution),
                {kind: 'material-input', id: operation.id, digest: c.verifier.binding.inputDigest},
                {kind: 'material-completion', id: execution.id, digest: c.verifier.binding.completionDigest}
            ];
        });
        const byGate: Partial<Record<ResearchHostGate, typeof common>> = {
            'admitted-research-scope': [ref('goal', s.goal.id, s.goal), ...producer],
            'producer-authoritative-stop': producer,
            'same-run-known-accounting': s.siblings.runs.map(run => ref('run-ledger', run.id, run)),
            'material-current': (s.job.materials ?? []).map(m => ({kind: 'material-proof', id: m.proofPath, digest: m.proofDigest})),
            'controls-qualified': [ref('actual-controls', s.review.id, s.review.controls)],
            'definition-approved': [ref('definition-review', s.review.id, s.review)],
            'full-final-qualified': [ref('final-plan', s.plan.id, s.plan), ref('final-results', s.job.id, s.job.results)],
            'delivery-authorized': [ref('runtime', s.runtime.id, s.runtime), ref('conversation-boundary', s.run.id, s.conversation), ...common],
            'delivery-receipted': delivery ? [ref('delivery', delivery.id, delivery)] : []
        };
        return RESEARCH_HOST_GATES.map(gate => ({
            gate,
            phase: requiredPhase[gate],
            status: requiredPhase[gate] === 'delivery-inserted' && !delivery ? 'pending-phase' : 'satisfied',
            binding,
            recordRefs: byGate[gate] ?? common,
            reasons: [gate === 'delivery-receipted' && delivery
                ? 'This host function inserted and reread this exact new delivery row; commit not claimed'
                : 'Actual closed host boundary validated against current persisted facts']
        }));
    }
    private candidateSync(c: Candidate): void {
        ensure(digest(canonical(c.files)) === c.digest, 'candidate inventory digest changed');
        let bytes = 0;
        const scan: Record<string, string> = {};
        const walk = (dir: string) => {
            for (const name of readdirSync(dir).sort()) {
                if (exclusions.includes(name))
                    continue;
                const path = join(dir, name), st = lstatSync(path);
                ensure(!st.isSymbolicLink(), 'candidate alias');
                if (st.isDirectory())
                    walk(path);
                else {
                    ensure(st.isFile()
                        && Object.keys(scan).length < 10000
                        && (bytes += st.size) <= 256 * 1024 * 1024, 'candidate capacity/type');
                    scan[relative(c.root, path).split(sep).join('/')] = digest(Buffer.concat([readBounded(path, 256 * 1024 * 1024), Buffer.from('\0executable:' + String(st.mode & 0o111))]));
                }
            }
        };
        ensure(realpathSync(c.root) === c.root, 'candidate root alias');
        walk(c.root);
        ensure(canonical(scan) === canonical(c.files), 'current candidate changed after artifact verification');
    }
    async captureArtifact(jobId: string): Promise<ResearchArtifactEvidence> {
        ensure(!this.db.isTransaction, 'async preflight cannot run inside a parent transaction');
        await new VerificationProofReader(this.store).researchArtifactJob(jobId, true);
        const s = this.snapshot(jobId);
        this.assertBoundary(s);
        const files: Record<string, string> = {
            ...s.job.proofs,
            ...s.review.proofs
        };
        const collect = (path: string, expected?: string) => {
            const hash = digest(readBounded(path, 256 * 1024 * 1024));
            ensure(!expected
                || hash === expected, 'frozen source/implementation bytes changed during capture');
            files[path] = hash;
        };
        for (const c of s.proposal.bundle.controls) {
            this.candidateSync({
                ...c.candidate,
                root: c.candidate.tree
            });
            for (const name of Object.keys(c.candidate.files))
                collect(join(c.candidate.tree, name));
        }
        for (const [name, hash] of Object.entries(s.proposal.bundle.files))
            collect(join(s.proposal.bundle.directory, name), hash);
        const materialCases = currentVerificationCases(s.proposal.spec).filter(c => (c.status??'active')==='active'&&c.verifier.kind === 'material');
        ensure(materialCases.length > 0, 'native material producer evidence missing');
        for (const c of materialCases) {
            if (c.verifier.kind !== 'material')
                continue;
            const binding = await captureMaterialBinding(this.store, this.repo.dataDirectory(), c.verifier.binding.operationId);
            ensure(canonical(binding) === canonical(c.verifier.binding), 'current material producer changed');
            const { input, completion } = await readMaterialBinding(binding);
            ensure(canonical(JSON.parse(readBounded(binding.inputPath).toString())) === canonical(input)
                && canonical(JSON.parse(readBounded(binding.completionPath).toString())) === canonical(completion), 'frozen material metadata changed during capture');
            for (const path of [binding.inputPath, binding.completionPath, join(input.context.material.directory, 'index.json'), join(input.context.material.directory, 'owner.json')])
                collect(path);
            for (const entry of input.context.index.entries) {
                if (entry.raw)
                    collect(join(input.context.material.directory, entry.raw.path), entry.raw.sha256);
                if (entry.text)
                    collect(join(input.context.material.directory, entry.text.path), entry.text.sha256);
                if (entry.input.kind === 'local'
                    && entry.raw?.complete)
                    collect(entry.input.path, entry.raw.sha256);
            }
        }
        const evidence = this.repo.transaction(() => {
            const current = this.snapshot(jobId);
            ensure(canonical(current) === canonical(s), 'preflight DB boundary changed');
            this.assertBoundary(current);
            this.candidateSync(current.plan.candidate);
            for (const [path, hash] of Object.entries(files))
                ensure(digest(readBounded(path, 256 * 1024 * 1024)) === hash, 'capture files changed before persistence');
            const binding = this.binding(current), body = {
                schemaVersion: 1 as const,
                binding,
                proofPlanDigest: current.native.proofPlan.digest,
                jobDigest: digest(canonical(current.job)),
                resultsDigest: digest(canonical(current.job.results)),
                boundaryDigest: digest(canonical(current)),
                boundary: current,
                files,
                hostFacts: this.facts(current, binding),
                capturedAt: new Date().toISOString()
            }, value = {
                ...body,
                digest: digest(canonical(body))
            };
            const old = this.db.prepare('SELECT record FROM research_artifact_evidence WHERE job_id=?').get(jobId);
            if (old) {
                const existing = JSON.parse(String(old.record)) as ResearchArtifactEvidence;
                ensure(existing.digest === bodyDigest(existing)
                    && existing.boundaryDigest === value.boundaryDigest
                    && canonical(existing.files) === canonical(files), 'immutable artifact capture changed; new verification required');
                return existing;
            }
            this.db.prepare('INSERT INTO research_artifact_evidence(job_id,record) VALUES (?,?)').run(jobId, canonical(value));
            return value;
        });
        this.fault?.('researchAfterArtifactCapture');
        return evidence;
    }
    /** Only this function inserts the row and derives its delivery-inserted fact. */
    sealDelivery(input: {
        commandId: string;
        request: unknown;
        jobId: string;
        delivery: Delivery;
    }): {
        delivery: Delivery;
        seal: ResearchDeliverySeal;
    } {
        ensure(this.db.isTransaction, 'sealing requires actual parent delivery transaction');
        ensure(this.repo.receipt(input.commandId, input.request) === undefined, 'committed-command reuse is a separate read path');
        const s = this.snapshot(input.jobId);
        this.assertBoundary(s);
        const row = this.db.prepare('SELECT record FROM research_artifact_evidence WHERE job_id=?').get(input.jobId);
        ensure(row, 'host artifact capture missing');
        const artifact = JSON.parse(String(row.record)) as ResearchArtifactEvidence;
        ensure(artifact.digest === bodyDigest(artifact)
            && artifact.boundaryDigest === digest(canonical(s))
            && artifact.jobDigest === digest(canonical(s.job))
            && artifact.proofPlanDigest === s.native.proofPlan.digest, 'captured host boundary changed');
        for (const [path, hash] of Object.entries(artifact.files))
            ensure(digest(readBounded(path, 256 * 1024 * 1024)) === hash, 'actual artifact/source/proof bytes changed');
        this.candidateSync(s.plan.candidate);
        this.candidateSync({
            ...s.plan.candidate,
            root: s.plan.candidate.tree
        });
        for (const c of s.proposal.bundle.controls)
            this.candidateSync({
                ...c.candidate,
                root: c.candidate.tree
            });
        for (const observation of s.job.materials ?? [])
            ensure(Date.now() - Date.parse(observation.sourceAcquiredAt) <= observation.maxAgeMs, 'material currentness expired before seal');
        for (const source of s.job.sources)
            ensure(Date.now() - Date.parse(source.acquiredAt) <= source.maxAgeMs, 'source currentness expired before seal');
        const d = input.delivery, binding = this.binding(s);
        ensure(canonical(input.request) === canonical({
            type: 'deliver',
            commandId: input.commandId,
            jobId: input.jobId
        }), 'native delivery command/request differs');
        ensure(Number.isFinite(Date.parse(d.createdAt))
            && Date.parse(d.createdAt) >= Date.parse(s.job.finishedAt!)
            && Date.parse(d.createdAt) <= Date.now(), 'delivery timestamp was not derived after actual final settlement');
        ensure(d.researchProofPlanDigest === s.native.proofPlan.digest
            && d.jobId === s.job.id
            && d.planId === s.plan.id
            && d.projectId === s.run.projectId
            && d.runId === s.run.id
            && d.runtimeId === s.runtime.id
            && d.candidateDigest === binding.candidateDigest
            && d.definitionDigest === binding.definitionDigest
            && d.path === join(verificationDirectory(this.repo.dataDirectory(), s.job), 'delivery.json'), 'delivery core differs from host boundary');
        ensure(!this.db.prepare("SELECT 1 FROM verification_records WHERE kind='delivery' AND id=?").get(d.id), 'existing row cannot prove insertion in this transaction');
        this.repo.insert('delivery', d);
        this.fault?.('researchAfterInsert');
        const inserted = this.repo.get('delivery', d.id);
        ensure(canonical(inserted) === canonical(d), 'actual insert differs');
        const hostFacts = this.facts(s, binding, inserted), artifactResults = s.proposal.spec.obligations.filter(o => o.required
            && o.applicable).map(o => ({
            obligationId: o.id,
            verdict: 'passed' as const
        })), combined = evaluateResearchWorkflow({
            plan: s.native.proofPlan,
            original: originalResearchChecks(s.goal.proposal!.criteria, s.run.contract),
            binding,
            phase: 'delivery-inserted',
            artifactResults,
            hostFacts
        });
        ensure(combined.complete
            && hostFacts.every(f => f.status === 'satisfied'), 'full original checks and closed host gates not sealed');
        const body = {
            schemaVersion: 1 as const,
            deliveryId: d.id,
            commandId: input.commandId,
            receiptCoreDigest: digest(canonical(inserted)),
            proofPlanDigest: s.native.proofPlan.digest,
            artifactEvidenceDigest: artifact.digest,
            binding,
            hostFacts,
            combined
        }, seal = {
            ...body,
            digest: digest(canonical(body))
        };
        this.db.prepare('INSERT INTO research_delivery_seals(delivery_id,command_id,record) VALUES (?,?,?)').run(d.id, input.commandId, canonical(seal));
        for (const criterion of s.run.contract.criteria.filter(c => c.required))
            this.repo.act(s.run.projectId, s.run.id, {
                type: 'recordEvidence',
                evidence: {
                    id: d.id + ':' + criterion.id,
                    criterionId: criterion.id,
                    contractVersion: s.run.contract.version,
                    artifactDigest: s.run.artifact!.digest,
                    verdict: 'passed',
                    verifierVersion: 'p4:' + s.plan.definitionDigest
                }
            });
        this.repo.act(s.run.projectId, s.run.id, {
            type: 'complete'
        });
        this.fault?.('researchAfterComplete');
        this.repo.remember(input.commandId, input.request, d);
        this.fault?.('researchBeforeCommit');
        return {
            delivery: inserted,
            seal
        };
    }
    /** Validate immutable sealed authority without treating historical commit as fresh currentness. */
    assertCommittedDelivery(delivery: Delivery): ResearchDeliverySeal {
        const row = this.db.prepare('SELECT record FROM research_delivery_seals WHERE delivery_id=?').get(delivery.id);
        ensure(row, 'native committed seal missing');
        const seal = JSON.parse(String(row.record)) as ResearchDeliverySeal;
        const plan = this.repo.get('plan', delivery.planId), proposal = this.repo.get('proposal', plan.proposalId), native = this.proposal(proposal.id), job = this.repo.get('job', delivery.jobId), captured = this.db.prepare('SELECT record FROM research_artifact_evidence WHERE job_id=?').get(job.id);
        ensure(captured, 'sealed artifact capture missing');
        const artifact = JSON.parse(String(captured.record)) as ResearchArtifactEvidence;
        ensure(seal.digest === bodyDigest(seal)
            && artifact.digest === bodyDigest(artifact)
            && artifact.boundaryDigest === digest(canonical(artifact.boundary))
            && seal.receiptCoreDigest === digest(canonical(delivery))
            && seal.deliveryId === delivery.id
            && seal.artifactEvidenceDigest === artifact.digest
            && seal.proofPlanDigest === native.proofPlan.digest
            && delivery.researchProofPlanDigest === native.proofPlan.digest
            && canonical(seal.binding) === canonical(artifact.binding), 'native committed receipt/seal differs');
        const receipt = this.db.prepare('SELECT request,result FROM verification_product_receipts WHERE command_id=?').get(seal.commandId);
        ensure(receipt
            && canonical(JSON.parse(String(receipt.request))) === canonical({
            type: 'deliver',
            commandId: seal.commandId,
            jobId: job.id
        })
            && canonical(JSON.parse(String(receipt.result))) === canonical(delivery), 'sealed exact committed command receipt missing/differs');
        const actualRun = this.repo.run(delivery.projectId, delivery.runId);
        ensure(actualRun.status === 'succeeded'
            && actualRun.contract.version === proposal.spec.contractVersion
            && actualRun.contract.criteria.filter(c => c.required).every(c => actualRun.evidence.some(e => e.id === delivery.id + ':' + c.id
            && e.criterionId === c.id
            && e.contractVersion === actualRun.contract.version
            && e.artifactDigest === actualRun.artifact?.digest
            && e.verdict === 'passed'
            && e.verifierVersion === 'p4:' + plan.definitionDigest)), 'sealed actual Run completion/original criterion evidence missing');
        const expected: ResearchWorkflowBinding = {
            runtimeId: delivery.runtimeId,
            projectId: delivery.projectId,
            runId: delivery.runId,
            proposalId: proposal.id,
            planId: plan.id,
            jobId: job.id,
            candidateDigest: plan.candidate.digest,
            definitionDigest: plan.definitionDigest,
            contractDigest: plan.contractDigest
        };
        ensure(canonical(expected) === canonical(seal.binding)
            && artifact.jobDigest === digest(canonical(job))
            && artifact.resultsDigest === digest(canonical(job.results))
            && job.approvalScope === 'research-artifact'
            && job.researchProofPlanDigest === native.proofPlan.digest
            && job.approved
            && !job.error
            && !job.usageUnknown
            && job.stopConfirmed, 'sealed actual artifact/job differs');
        ensure(canonical(plan.selection) === canonical(selectInstances(proposal.spec, {
            mode: 'final'
        }))
            && evaluateVerification(proposal.spec, plan.selection, job.results).complete, 'sealed full artifact inventory differs');
        ensure(seal.hostFacts.length === RESEARCH_HOST_GATES.length
            && RESEARCH_HOST_GATES.every(gate => seal.hostFacts.some(f => f.gate === gate
            && f.status === 'satisfied')), 'sealed host gate inventory incomplete');
        const deliveryFact = seal.hostFacts.find(f => f.gate === 'delivery-receipted')!;
        ensure(canonical(deliveryFact.recordRefs) === canonical([{
                kind: 'delivery',
                id: delivery.id,
                digest: digest(canonical(delivery))
            }]), 'sealed exact receipt fact differs');
        const boundary = artifact.boundary as ReturnType<ResearchWorkflowRepository['snapshot']>;
        ensure(canonical(boundary.job) === canonical(job)
            && canonical(boundary.native) === canonical(native)
            && canonical(this.facts(boundary, seal.binding, delivery)) === canonical(seal.hostFacts), 'sealed host facts differ from actual frozen boundary');
        const artifactResults = proposal.spec.obligations.filter(o => o.required
            && o.applicable).map(o => ({
            obligationId: o.id,
            verdict: 'passed' as const
        })), combined = evaluateResearchWorkflow({
            plan: native.proofPlan,
            original: originalResearchChecks(boundary.goal.proposal!.criteria, boundary.run.contract),
            binding: seal.binding,
            phase: 'delivery-inserted',
            artifactResults,
            hostFacts: seal.hostFacts
        });
        ensure(combined.complete
            && canonical(combined) === canonical(seal.combined), 'sealed original ALL-OF checks differ');
        return seal;
    }
    /** Recovery/export is a fresh current evidence observation. The committed
     * historical seal is retained even when this fresh observation refuses. */
    async assertCommittedCurrent(delivery: Delivery): Promise<void> {
        ensure(!this.db.isTransaction, 'async committed currentness cannot join an open transaction');
        this.assertCommittedDelivery(delivery);
        await new VerificationProofReader(this.store).researchArtifactJob(delivery.jobId, true);
        const row = this.db.prepare('SELECT record FROM research_artifact_evidence WHERE job_id=?').get(delivery.jobId);
        ensure(row, 'committed artifact capture missing');
        const artifact = JSON.parse(String(row.record)) as ResearchArtifactEvidence;
        for (const [path, hash] of Object.entries(artifact.files)) {
            ensure(digest(readBounded(path, 256 * 1024 * 1024)) === hash,
                'committed artifact/source/proof bytes changed; original receipt retained');
        }
        const runtime = this.store.runtime.get(delivery.runtimeId);
        const run = this.repo.run(delivery.projectId, delivery.runId);
        ensure(!runtime.paused && !runtime.cancelled
            && !this.store.conversations.hasPendingForRun(run.projectId, run.id)
            && run.attempts.every(a => a.settled && a.status !== 'running')
            && run.operations.every(o => o.status === 'confirmed')
            && run.leases.every(l => l.released)
            && run.budget.spent <= tokenCapacity(run.budget.limit), 'committed export current boundary is unresolved');
        const neighbors = [
            ...this.store.runtime.list().filter(r => overlap(r.workspace, runtime.workspace)),
            ...this.store.executionList().filter(e => overlap(e.workspace, runtime.workspace)),
            ...this.repo.list('job').filter(j => overlap(j.workspace, runtime.workspace))
        ];
        const executions = this.store.executionList().filter(e => overlap(e.workspace, runtime.workspace));
        ensure(executions.every(e => e.stopConfirmed && e.usageStatus === 'reported' && e.usage !== null),
            'committed export overlaps unknown execution accounting or stop');
        for (const item of neighbors) {
            const other = this.repo.run(item.projectId, item.runId);
            ensure(other.attempts.every(a => a.settled && a.status !== 'running')
                && other.operations.every(o => o.status === 'confirmed')
                && other.leases.every(l => l.released),
                'committed export overlaps unresolved ledger cost/effects/resources');
        }
        const plan = this.repo.get('plan', delivery.planId);
        const proposal = this.repo.get('proposal', plan.proposalId);
        this.candidateSync(plan.candidate);
        this.candidateSync({...plan.candidate, root: plan.candidate.tree});
        for (const control of proposal.bundle.controls) {
            this.candidateSync({...control.candidate, root: control.candidate.tree});
        }
        this.assertCommittedDelivery(delivery);
    }
    committed(commandId: string, request: unknown): {
        delivery: Delivery;
        seal: ResearchDeliverySeal;
    } | null {
        ensure(!this.db.isTransaction, 'committed receipt cannot be claimed in an open transaction');
        const prior = this.repo.receipt(commandId, request);
        if (prior === undefined)
            return null;
        const delivery = this.repo.get('delivery', (prior as Delivery).id), seal = this.assertCommittedDelivery(delivery);
        ensure(seal.commandId === commandId, 'sealed command differs');
        return {
            delivery,
            seal
        };
    }
}
