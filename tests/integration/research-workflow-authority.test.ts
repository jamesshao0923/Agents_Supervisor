import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { spawnManagedProcess } from '../../packages/process-control/index.js';
import { VerificationController } from '../../packages/verification/controller.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { researchWorkflowFixture } from '../helpers/research-workflow-fixture.js';
import { VerificationProofReader } from '../../packages/verification/proof-reader.js';
import { prepareResearchProofPlan, evaluateResearchWorkflow } from '../../packages/verification/research-workflow.js';
import { parseReasonerOutput } from '../../packages/orchestration/reasoner-schema.js';
import { acceptanceAuthoringSchema } from '../../packages/orchestration/acceptance-authoring.js';
import { canonical, digest } from '../../packages/verification/candidate.js';
import { verificationDirectory } from '../../packages/verification/scoped-environment.js';
import type { Delivery } from '../../packages/verification/records.js';
function delivery(f: Awaited<ReturnType<typeof researchWorkflowFixture>>, id: string): Delivery {
    return {
        id,
        jobId: f.final.id,
        planId: f.plan.id,
        runtimeId: f.runtime.id,
        projectId: f.runtime.projectId,
        runId: f.runtime.runId,
        candidateDigest: f.plan.candidate.digest,
        definitionDigest: f.plan.definitionDigest,
        researchProofPlanDigest: f.proposal.researchProofPlanDigest!,
        createdAt: new Date().toISOString(),
        path: join(verificationDirectory(f.data, f.final), 'delivery.json')
    };
}
const request = (f: Awaited<ReturnType<typeof researchWorkflowFixture>>, commandId = 'host-deliver') => ({
    type: 'deliver' as const,
    commandId,
    jobId: f.final.id
});
test('P8-HOSTAUTH-I01 actual source P2 author schema and complete original mapping reject omissions false host verdicts and borrowed artifact obligations', async (t) => {
    const f = await researchWorkflowFixture(t), schema = acceptanceAuthoringSchema(f.context);
    parseReasonerOutput(JSON.stringify(f.bundle), schema);
    const declared = f.bundle.researchWorkflow!;
    for (const bad of [{
            ...declared,
            mappings: []
        }, {
            ...declared,
            mappings: declared.mappings.map(m => ({
                ...m,
                hostGates: ['invented-permission']
            }))
        }, {
            ...declared,
            mappings: declared.mappings.map(m => ({
                ...m,
                hostPassed: true
            }))
        }])
        assert.throws(() => parseReasonerOutput(JSON.stringify({
            ...f.bundle,
            researchWorkflow: bad
        }), schema));
    assert.throws(() => prepareResearchProofPlan(f.context.criteria, f.context.contract, f.bundle.spec, {
        ...declared,
        mappings: declared.mappings.map(m => ({
            ...m,
            artifactObligationIds: ['borrowed']
        }))
    }), /not owned/);
    const plan = f.store.researchWorkflow.proposal(f.proposal.id).proofPlan, artifact = await f.store.researchWorkflow.captureArtifact(f.final.id);
    assert.equal(evaluateResearchWorkflow({
        plan,
        original: plan.originalChecks.map(({ criterionId, checkIndex, text }) => ({
            criterionId,
            checkIndex,
            text
        })),
        binding: artifact.binding,
        phase: 'final-settled',
        artifactResults: [{
                obligationId: 'faithful-meaning',
                verdict: 'passed'
            }],
        hostFacts: artifact.hostFacts
    }).complete, false, 'Future delivery facts must remain pending until real insertion');
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.status, 'ready');
});
test('P8-HOSTAUTH-I02 actual runtime P2 P4 full artifact and real insert seal complete commit are externally invisible until commit and exact once', async (t) => {
    let observer: DatabaseSync | undefined, atCommit = 0;
    const f = await researchWorkflowFixture(t, point => {
        if (point === 'researchBeforeCommit') {
            atCommit++;
            assert.equal(observer!.prepare("SELECT COUNT(*) count FROM verification_records WHERE kind='delivery'").get()!.count, 0);
        }
    });
    observer = new DatabaseSync(join(f.data, 'supervisor.sqlite'), {
        readOnly: true
    });
    t.after(() => observer!.close());
    const before = f.store.runtime.inspect(f.runtime.id).run.budget.spent, d = await f.p4.dispatch(request(f)) as Delivery, committed = f.store.researchWorkflow.committed('host-deliver', request(f))!;
    assert.equal(atCommit, 1);
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.status, 'succeeded');
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, before);
    assert.equal(committed.delivery.id, d.id);
    assert.equal(committed.seal.combined.complete, true);
    assert.equal(committed.seal.hostFacts.find(f => f.gate === 'delivery-receipted')!.phase, 'delivery-inserted');
    assert.deepEqual(await f.p4.dispatch(request(f)), d);
    assert.equal(f.store.verification.list('delivery', f.runtime.id).length, 1);
    assert.deepEqual(JSON.parse(await readFile(d.path, 'utf8')), d);
});
test('P8-HOSTAUTH-I03 faults after actual insert and complete plus enclosing parent rollback preserve every original ledger and leave no seal receipt or export', async (t) => {
    let fail: string | null = null;
    const f = await researchWorkflowFixture(t, point => {
        if (point === fail)
            throw Error('injected ' + point);
    });
    await f.store.researchWorkflow.captureArtifact(f.final.id);
    const before = f.store.runtime.inspect(f.runtime.id).run;
    for (const point of ['researchAfterInsert', 'researchAfterComplete']) {
        fail = point;
        const r = request(f, point);
        await assert.rejects(f.p4.dispatch(r), /injected/);
        assert.deepEqual(f.store.runtime.inspect(f.runtime.id).run, before);
        assert.equal(f.store.verification.list('delivery', f.runtime.id).length, 0);
        assert.equal(f.store.researchWorkflow.committed(r.commandId, r), null);
        await assert.rejects(readFile(join(verificationDirectory(f.data, f.final), 'delivery.json')), /ENOENT/);
    }
    fail = null;
    const r = request(f, 'parent-rollback');
    assert.throws(() => f.store.verification.transaction(() => {
        f.store.researchWorkflow.sealDelivery({
            commandId: r.commandId,
            request: r,
            jobId: f.final.id,
            delivery: delivery(f, 'parent-insert')
        });
        assert.throws(() => f.store.researchWorkflow.committed(r.commandId, r), /open transaction/);
        throw Error('parent rollback');
    }), /parent rollback/);
    assert.deepEqual(f.store.runtime.inspect(f.runtime.id).run, before);
    assert.equal(f.store.verification.list('delivery', f.runtime.id).length, 0);
});
test('P8-HOSTAUTH-I04 an already committed row cannot become a this-transaction insertion fact and missing typed role cannot use ordinary finalJob', async (t) => {
    const f = await researchWorkflowFixture(t);
    await f.store.researchWorkflow.captureArtifact(f.final.id);
    const d = delivery(f, 'already-inserted');
    f.store.verification.transaction(() => f.store.verification.insert('delivery', d));
    const r = request(f, 'same-row');
    assert.throws(() => f.store.verification.transaction(() => f.store.researchWorkflow.sealDelivery({
        commandId: r.commandId,
        request: r,
        jobId: f.final.id,
        delivery: d
    })), /existing row cannot prove insertion/);
    const reader = new VerificationProofReader(f.store);
    await assert.rejects(reader.finalJob(f.final.id), /Artifact-only/);
    const { approvalScope: _, ...lost } = f.final;
    f.store.verification.update('job', lost);
    await assert.rejects(reader.finalJob(lost.id), /Host frozen research role/);
    await assert.rejects(f.p4.dispatch(request(f, 'missing-role')), /Native research cannot use ordinary delivery/);
    const {researchProofPlanDigest: droppedDigest, ...lostProposal} = f.proposal;
    f.store.verification.update('proposal', lostProposal);
    await assert.rejects(reader.finalJob(lost.id), /Host frozen research role/);
    await assert.rejects(f.p4.dispatch(request(f, 'both-markers-missing')), /Native research cannot use ordinary delivery/);
    assert.notEqual(f.store.runtime.inspect(f.runtime.id).run.status, 'succeeded');
});
test('P8-HOSTAUTH-I05 changed independent mapping review raw context cannot grant fresh freeze or publication even with recomputed file hashes', async (t) => {
    const f = await researchWorkflowFixture(t), review = f.store.verification.get('job', f.proposal.reviewId!), path = join(verificationDirectory(f.data, review), 'definition-review', 'events.jsonl'), events = (await readFile(path, 'utf8')).split('\n').map(line => JSON.parse(line));
    const input = events.find(e => e.kind === 'review-input')!, prompt = input.value.prompt as string, newline = prompt.indexOf('\n'), context = JSON.parse(prompt.slice(newline + 1));
    delete context.researchProofPlan;
    input.value.prompt = prompt.slice(0, newline + 1) + JSON.stringify(context);
    await writeFile(path, events.map(e => JSON.stringify(e)).join('\n'));
    review.proofs[path] = digest(await readFile(path));
    f.store.verification.update('job', review);
    assert.throws(() => f.store.researchWorkflow.assertMappingReview(f.proposal, review), /exact complete mapping/);
    await assert.rejects(f.p4.dispatch({
        type: 'freeze',
        commandId: 'invalid-mapping',
        runtimeId: f.runtime.id,
        mode: 'final'
    }), /exact complete mapping/);
    assert.equal(f.store.verification.list('delivery', f.runtime.id).length, 0);
});
test('P8-HOSTAUTH-I06 late local source changes pause unknown usage and stop refusals retain costs and original snapshots without granting a seal', async (t) => {
    const f = await researchWorkflowFixture(t);
    await f.store.researchWorkflow.captureArtifact(f.final.id);
    const before = f.store.runtime.inspect(f.runtime.id).run.budget.spent, old = await readFile(f.source);
    await writeFile(f.source, 'Changed original source after actual preflight');
    const r = request(f, 'late-local-change');
    assert.throws(() => f.store.verification.transaction(() => f.store.researchWorkflow.sealDelivery({
        commandId: r.commandId,
        request: r,
        jobId: f.final.id,
        delivery: delivery(f, 'local-changed')
    })), /bytes changed/);
    await writeFile(f.source, old);
    f.store.runtime.control({
        type: 'pause',
        runtimeId: f.runtime.id,
        commandId: 'late-pause'
    });
    await assert.rejects(f.p4.dispatch(request(f, 'paused')), /paused|pause|unresolved runtime/);
    f.store.runtime.control({
        type: 'resume',
        runtimeId: f.runtime.id,
        commandId: 'resume'
    });
    for (const changed of [{
            ...f.final,
            usageUnknown: true
        }, {
            ...f.final,
            stopConfirmed: false
        }, {
            ...f.final,
            approved: false
        }]) {
        f.store.verification.update('job', changed);
        await assert.rejects(f.p4.dispatch(request(f, 'rejected-' + JSON.stringify(changed).length)));
        assert.equal(f.store.verification.list('delivery', f.runtime.id).length, 0);
    }
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, before);
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.evidence.length, 0);
});
test('P8-HOSTAUTH-I07 postcommit export conflict is visible and exact command replay reuses sealed receipt after reopening without new accounting', async (t) => {
    const f = await researchWorkflowFixture(t), path = join(verificationDirectory(f.data, f.final), 'delivery.json');
    await writeFile(path, 'foreign export');
    const before = f.store.runtime.inspect(f.runtime.id).run.budget.spent;
    await assert.rejects(f.p4.dispatch(request(f)), /export conflicts/);
    const committed = f.store.researchWorkflow.committed('host-deliver', request(f))!;
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.status, 'succeeded');
    assert.ok(committed.seal.combined.complete);
    assert.equal(await readFile(path, 'utf8'), 'foreign export');
    await rm(path);
    const reopened = new SupervisorStore(f.data), p4 = new VerificationController(reopened, f.data);
    try {
        assert.deepEqual(await p4.dispatch(request(f)), committed.delivery);
        assert.equal(reopened.verification.list('delivery', f.runtime.id).length, 1);
        assert.equal((await p4.status(f.runtime.id) as {
            currentDelivery: {
                current: boolean;
            };
        }).currentDelivery.current, true);
    }
    finally {
        await p4.close();
        reopened.close();
    }
    assert.equal(f.store.verification.list('delivery', f.runtime.id).length, 1);
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, before);
    await assert.rejects(f.p4.dispatch({
        ...request(f),
        jobId: 'other'
    }), /conflicts/);
    const sourceBefore = await readFile(f.source);
    await writeFile(f.source, 'Source changed after the committed delivery');
    await assert.rejects(f.p4.dispatch(request(f)), /currentness|changed/);
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.status, 'succeeded');
    assert.deepEqual(f.store.researchWorkflow.committed('host-deliver', request(f))!.delivery, committed.delivery);
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, before);
    await writeFile(f.source, sourceBefore);
    // Actual SQLite reservation and unknown outbox; stopped is an explicit host
    // test projection. No provider turn or known cost settlement is fabricated.
    const other = f.store.executionCreate({
        type:'start',commandId:'unknown-neighbor',workspace:f.workspace,workspaceKind:'project',
        prompt:'Unknown-ledger fault fixture; no supplier dispatch',
        model:'synthetic-no-dispatch',effort:'low',timeoutMs:5000,
        tokenLimit:1000,reservation:200,verificationReserve:100
    }).record;
    f.store.executionUpdate(other.id,{state:'interrupted',stopConfirmed:true},
        'explicit-synthetic-stop-projection',{notProvider:true});
    const unknown=f.store.verification.run(other.projectId,other.runId);
    await assert.rejects(f.p4.dispatch(request(f)),/unknown execution accounting|unresolved ledger/);
    assert.deepEqual(f.store.verification.run(other.projectId,other.runId),unknown);
    assert.equal(f.store.executionGet(other.id).usageStatus,'unknown');
    assert.equal(f.store.executionGet(other.id).reservation,200);
    assert.deepEqual(f.store.researchWorkflow.committed('host-deliver',request(f))!.delivery,committed.delivery);


});
test('P8-HOSTAUTH-I08 an actual live producer identity despite stopped metadata plus late user intent and cancellation cannot seal and never clears accounting', async (t) => {
    const f = await researchWorkflowFixture(t);
    await f.store.researchWorkflow.captureArtifact(f.final.id);
    const spent = f.store.runtime.inspect(f.runtime.id).run.budget.spent, producer = f.store.executionList().find(e => e.runtimeBinding?.runtimeId === f.runtime.id)!;
    const child = await spawnManagedProcess({
        operationId: 'actual-late-owned-writer',
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: f.workspace,
        timeoutMs: 5000,
        onBeforeSpawn: intent => { f.store.executionUpdate(producer.id, {}, 'explicit-host-test-late-process-intent', intent); }
    });
    try {
        f.store.executionUpdate(producer.id, {
            identity: child.identity,
            pid: child.identity.pid
        }, 'explicit-host-test-late-writer', {
            syntheticPriorProtocol: true
        });
        await assert.rejects(f.store.researchWorkflow.captureArtifact(f.final.id), /writer is still active|Old execution process/);
        assert.equal(f.store.executionGet(producer.id).stopConfirmed, true, 'Actual physical check must override stale stopped metadata');
    }
    finally {
        await child.terminate();
        await child.completion;
    }
    const conversation = f.store.conversations.ensureForGoal(f.runtime.runId);
    f.store.conversations.receive({
        conversationId: conversation.id,
        commandId: 'late-user-change',
        kind: 'change',
        source: 'user',
        text: 'Add explicit unresolved gaps to the report while preserving every original required meaning'
    });
    const r = request(f, 'late-user-intent');
    assert.throws(() => f.store.verification.transaction(() => f.store.researchWorkflow.sealDelivery({
        commandId: r.commandId,
        request: r,
        jobId: f.final.id,
        delivery: delivery(f, 'late-user-row')
    })), /pending user message/);
    f.store.runtime.control({
        type: 'cancel',
        runtimeId: f.runtime.id,
        commandId: 'late-run-cancel'
    });
    assert.throws(() => f.store.verification.transaction(() => f.store.researchWorkflow.sealDelivery({
        commandId: 'late-cancel',
        request: request(f, 'late-cancel'),
        jobId: f.final.id,
        delivery: delivery(f, 'cancel-row')
    })), /cancel|terminal boundary/);
    assert.equal(f.store.verification.list('delivery', f.runtime.id).length, 0);
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, spent);
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.status, 'cancelled');
});
test('P8-HOSTAUTH-I09 actual controller close arriving after full async preflight prevents insertion and preserves artifact proof and known charges', async (t) => {
    let stopAfterCapture = false, closing: Promise<void> | undefined;
    const f = await researchWorkflowFixture(t, point => {
        if (stopAfterCapture
            && point === 'researchAfterArtifactCapture')
            closing = f.p4.close();
    });
    const spent = f.store.runtime.inspect(f.runtime.id).run.budget.spent;
    stopAfterCapture = true;
    await assert.rejects(f.p4.dispatch(request(f)), /closed during preflight/);
    await closing;
    assert.equal(f.store.verification.list('delivery', f.runtime.id).length, 0);
    assert.equal(f.store.researchWorkflow.committed('host-deliver', request(f)), null);
    assert.equal(f.store.runtime.inspect(f.runtime.id).run.budget.spent, spent);
    assert.equal(f.store.verification.get('job', f.final.id).approved, true, 'The actual artifact-only approval remains historical evidence, not delivery');
});
