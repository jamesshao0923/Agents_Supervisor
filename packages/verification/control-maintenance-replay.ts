import { lstat, readFile } from 'node:fs/promises';
import type { MaintenanceBasis, RegressionContext, MaintenanceContext, MaintenancePlan, MaintenanceReplay, MaintenanceReplayStage } from '../contracts/p6-control-maintenance.js';
import type { EngineContext } from './engine.js';
import { executeInstances } from './engine.js';
import type { Proposal } from './records.js';
import { assertCandidate, canonical, digest, relativeFile } from './candidate.js';
import { maintenanceEnsure as ensure, maintenanceDigest as hash, maintenanceInstance, assertMaintenanceReplay } from './control-maintenance-rules.js';
export async function captureRegressionContext(input: Pick<RegressionContext, 'sources' | 'passingCandidate'>): Promise<RegressionContext> {
    const basis = input;
    const sourceText: MaintenanceContext['sourceText'] = {};
    let size = 0;
    for (const source of basis.sources) {
        await assertCandidate(source.candidate, false);
        const files: MaintenanceContext['sourceText'][string] = {};
        for (const name of Object.keys(source.candidate.files)) {
            const path = await relativeFile(source.candidate.tree, name), bytes = await readFile(path), content = new TextDecoder('utf-8', { fatal: true }).decode(bytes), executable = (await lstat(path)).mode & 0o111;
            size += bytes.length;
            ensure(size <= 768000 && !content.includes('\0'), 'Complete regression source exceeds supported UTF8 capacity');
            ensure(digest(Buffer.concat([bytes, Buffer.from('\0executable:' + executable)])) === source.candidate.files[name], 'Regression bytes changed');
            files[name] = { content, executable };
        }
        sourceText[source.defectRef] = files;
        await assertCandidate(source.candidate, false);
    }
    return { ...structuredClone(input), sourceText };
}
export async function captureMaintenanceContext(basis: MaintenanceBasis): Promise<MaintenanceContext> {
    const regression = await captureRegressionContext(basis);
    return { basis, sourceText: regression.sourceText };
}
export function assertMaintenanceContext(context: MaintenanceContext): void {
    ensure(context.basis.schemaVersion === 1
        && context.basis.policy === 'same-contract-regression-v1'
        && context.basis.necessity === 'required-regression', 'Unknown maintenance authority');
    assertRegressionContext({ sources: context.basis.sources, passingCandidate: context.basis.passingCandidate, sourceText: context.sourceText });
}
export function assertRegressionContext(context: RegressionContext): void {
    ensure(context.sources.length <= 16, 'Regression capacity exceeded');
    ensure(canonical(Object.keys(context.sourceText).sort()) === canonical(context.sources.map(s => s.defectRef).sort()), 'Complete regression source inventory missing');
    for (const source of context.sources) {
        const files = context.sourceText[source.defectRef]!;
        ensure(canonical(Object.keys(files).sort()) === canonical(Object.keys(source.candidate.files).sort()), 'Regression file inventory changed');
        for (const [path, file] of Object.entries(files))
            ensure(Number.isInteger(file.executable)
                && (file.executable & 0o111) === file.executable
                && digest(Buffer.concat([Buffer.from(file.content), Buffer.from('\0executable:' + file.executable)])) === source.candidate.files[path], 'Regression source text or mode differs');
    }
}
/** Actual pairs belong to one existing P4 job. Never append them to legacy spec.controls. */
export async function executeMaintenanceReplay(context: EngineContext, proposal: Proposal, basis: Pick<MaintenanceBasis, 'sources' | 'passingCandidate'>, plan: MaintenancePlan): Promise<MaintenanceReplayStage> {
    const replays: MaintenanceReplay[] = [];
    ensure(basis.sources.length <= 16, 'Regression pair capacity exceeded');
    for (const source of basis.sources) {
        context.eligible();
        const instance = maintenanceInstance(proposal.spec, plan.regressions.find(m => m.defectRef === source.defectRef)!, source), id = hash({ proposalId: proposal.id, source, instance }).slice(0, 40);
        const results: {
            bad: MaintenanceReplay['bad'];
            good: MaintenanceReplay['good'];
        } = { bad: [], good: [] };
        for (const side of ['bad', 'good'] as const) {
            const key = 'maintenance:' + id + ':' + side;
            ensure(!context.job.controls.some(c => c.id === key), 'Observed regression pair must not be replayed in the same job');
            const candidate = side === 'bad' ? source.candidate : basis.passingCandidate;
            await assertCandidate(candidate, side === 'good');
            // Persist intent before executing, so a crash before result cannot silently replay.
            context.job.controls.push({ id: key, passed: false, results: [] });
            context.save();
            results[side] = await executeInstances(context, proposal.spec, proposal.bundle, candidate, [instance], 'maintenance-' + id + '-' + side);
            await assertCandidate(candidate, side === 'good');
            const row = context.job.controls.find(c => c.id === key)!;
            row.results = results[side];
            for (const result of results[side])
                for (const path of result.proofFiles ?? [])
                    context.job.proofs[path] = digest(await readFile(path));
            const expected = side === 'bad' ? 'failed' : 'passed';
            row.passed = results[side].length === 1
                && results[side][0]!.executionStatus === 'executed'
                && source.obligationIds.every(o => results[side][0]!.checks.some(c => c.obligationId === o
                && c.verdict === expected))
                && (side === 'bad'
                || instance.obligationIds.every(o => results[side][0]!.checks.some(c => c.obligationId === o
                && c.verdict === 'passed')));
            context.save();
            ensure(row.passed, 'Actual regression ' + side + ' did not satisfy its specific business checks');
        }
        const replay: MaintenanceReplay = { id, defectRef: source.defectRef, source, instance, passingCandidate: basis.passingCandidate, ...results };
        assertMaintenanceReplay(replay);
        replays.push(replay);
    }
    const executionProofs: Record<string, string> = {};
    for (const replay of replays) {
        for (const result of [...replay.bad, ...replay.good]) {
            for (const path of result.proofFiles ?? []) {
                const hash = digest(await readFile(path));
                ensure(context.job.proofs[path] === hash,
                    'Actual replay artifact changed before immutable stage capture');
                executionProofs[path] = hash;
            }
        }
    }
    const body = { schemaVersion: 1 as const, proposalId: proposal.id, reviewId: context.job.id, replays, executionProofs };
    return { ...body, digest: hash(body) };
}
