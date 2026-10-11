import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SupervisorStore } from '../../packages/persistence/store.js';
import { ResearchRuntimeActivity } from '../../packages/runtime/research-activity.js';
import { ExecutionManager } from '../../packages/execution/manager.js';
import { spawnManagedProcess, inspectProcess } from '../../packages/process-control/index.js';
import { captureCandidate, canonical, digest, environmentFingerprint } from '../../packages/verification/candidate.js';
import { captureMaterialBinding, readMaterialBinding, acquireMaterialEvidence } from '../../packages/verification/material.js';
import { createEnvironmentScope, verificationDirectory } from '../../packages/verification/scoped-environment.js';
import { VerificationController } from '../../packages/verification/controller.js';
import { acceptanceAuthoringSchema, acceptanceAuthoringContextDigest, buildAcceptanceAuthoringPrompt, materializeAcceptanceBundle, type AcceptanceAuthoringContext, type AcceptanceBundle } from '../../packages/orchestration/acceptance-authoring.js';
import { definitionReviewPrompt } from '../../packages/verification/engine.js';
import { legacyControlQualified } from '../../packages/verification/control-qualification-gates.js';
import { evaluateVerification, selectInstances } from '../../packages/verification/rules.js';
import { RESEARCH_HOST_GATES } from '../../packages/verification/research-workflow.js';
import type { RuntimeRecord } from '../../packages/contracts/p3.js';
import type { GoalProposal } from '../../packages/contracts/p5.js';
import type { ResearchProposal, ResearchEvidenceContext } from '../../packages/contracts/p8-research.js';
import type { VerificationJob, Proposal, FrozenPlan } from '../../packages/verification/records.js';
import type { MaterialVerifier } from '../../packages/contracts/p4-material.js';
/** Real component/Node/FS/SQLite fixture. P5/P2/semantic-model protocol values and
 * token counts are explicitly synthetic; never actual supplier/model evidence.
 * No production gate, parser, report inventory or process-stop check is replaced. */
export const originalQuote = 'The original document describes a bounded read-only tool.';
export function fixtureProposal(context: ResearchEvidenceContext): ResearchProposal {
    return {
        schemaVersion: 1,
        contextDigest: context.digest,
        categories: [{
                id: 'tool',
                description: 'Tool documentation'
            }],
        citations: [{
                id: 'quote',
                materialId: 'original',
                start: 0,
                end: originalQuote.length,
                quote: originalQuote
            }],
        claims: [{
                id: 'claim',
                criterionIds: ['meaning'],
                kind: 'fact',
                text: 'The document describes a bounded read-only tool.',
                supportCitationIds: ['quote'],
                counterCitationIds: [],
                limitations: []
            }],
        questions: [{
                criterionId: 'meaning',
                status: 'proposed-answer',
                claimIds: ['claim'],
                unresolved: []
            }],
        materials: [{
                materialId: 'original',
                categoryIds: ['tool'],
                summary: 'A bounded read-only tool.',
                citationIds: ['quote'],
                unresolved: []
            }],
        conflicts: [],
        followups: []
    };
}
async function hashes(dir: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    async function visit(p: string) {
        for (const e of await readdir(p, {
            withFileTypes: true
        })) {
            const path = join(p, e.name);
            if (e.isDirectory())
                await visit(path);
            else
                files[path] = digest(await readFile(path));
        }
    }
    await visit(dir);
    return files;
}
export async function researchWorkflowFixture(t: TestContext, fault?: (point: string) => void,
    beforeRuntime?: (store:SupervisorStore,runtime:RuntimeRecord,root:string,workspace:string)=>Promise<void>) {
    const root = await realpath(await mkdtemp('/tmp/sv-research-host-authority-')), data = join(root, 'data'), workspace = join(root, 'workspace'), source = join(root, 'notes.md');
    await mkdir(workspace);
    await writeFile(source, originalQuote + '\n');
    const store = new SupervisorStore(data, fault ? {
        fault
    } : {}), p4 = new VerificationController(store, data);
    t.after(async () => {
        await p4.close();
        store.close();
        await rm(root, {
            recursive: true,
            force: true
        });
    });
    const originalCheck = 'Report faithfully preserves the original bounded read-only meaning; only deliver after current material, confirmed producer stop, known total Run accounting and complete independent acceptance.';
    const config = {
        model: 'explicit-synthetic-protocol-fixture-no-provider',
        effort: 'low',
        reservation: 300,
        timeoutMs: 5000
    }, research = {
        schemaVersion: 1 as const,
        inputs: [{
                id: 'original',
                kind: 'local' as const,
                path: source
            }],
        materialLimits: {
            maxInputs: 1,
            parallel: 1,
            maxItemBytes: 4096,
            maxTotalBytes: 8192,
            timeoutMs: 1000,
            maxDurationMs: 3000,
            maxRedirects: 0
        },
        researchLimits: {
            maxContextChars: 100000,
            maxClaims: 8,
            maxCitations: 8,
            maxQuoteChars: 12000
        },
        reportDirectory: 'research-report',
        cutoff: null,
        maxSourceAgeMs: 600000
    };
    const started = store.goals.start({
        type: 'start',
        commandId: 'fixture-goal',
        goal: originalCheck,
        tokenLimit: 10000,
        verificationReserve: 1000,
        ...config,
        research
    }, workspace, 'project');
    const proposal: GoalProposal = {
        decision: 'ready',
        summary: 'Explicit P5 protocol mechanism fixture, no provider approval',
        questions: [],
        facts: [{
                text: originalCheck,
                origin: 'explicit',
                sourceId: started.session.messages[0]!.id
            }],
        constraints: [],
        style: [],
        criteria: [{
                id: 'meaning',
                description: 'Faithful source-bound report and actual sealed process',
                kind: 'material',
                target: 'research-report/report.json',
                checks: [originalCheck]
            }],
        steps: [{
                id: 'analyze',
                description: 'Classify the actual original source',
                dependencies: [],
                acceptanceIds: ['meaning']
            }]
    };
    const ready = store.goals.finish(started.session.id, started.session.jobs[0]!.id, j => {
        j.usage = 0;
        j.stopConfirmed = true;
        j.proposal = proposal;
    });
    const admitted = store.goals.control({
        type: 'admit',
        commandId: 'fixture-admit',
        sessionId: ready.session.id,
        expectedRevision: ready.session.revision
    });
    let runtime = store.runtime.get(admitted.session.runtimeId!);
    if(beforeRuntime){
        await beforeRuntime(store,runtime,root,workspace);
        runtime=store.runtime.get(runtime.id);
    }
    const activity = new ResearchRuntimeActivity(store, data), acquire = store.runtime.claim(runtime.id, 'fixture-owner')!;
    await activity.acquire(acquire, 'fixture-owner');
    const op = store.runtime.claim(runtime.id, 'fixture-owner')!;
    await activity.prepare(op.id, 'fixture-owner');
    const input = store.runtime.researchInput(op.id)!;
    store.runtime.markStarted(op.id, 'fixture-owner');
    const exec = store.executionCreate({
        ...store.runtime.executionInput(op.id, 'fixture-owner'),
        workspace,
        workspaceKind: 'project'
    }, store.runtime.binding(op.id, 'fixture-owner')).record;
    const process = await spawnManagedProcess({
        operationId: exec.id,
        command: globalThis.process.execPath,
        args: ['-e', 'process.stdout.write("actual protocol fixture producer\\n")'],
        cwd: workspace,
        timeoutMs: 3000,
        onBeforeSpawn: intent => {
            store.executionUpdate(exec.id, {}, 'process-intent', intent);
        },
        onIdentity: identity => {
            store.executionUpdate(exec.id, {
                identity,
                pid: identity.pid
            }, 'process-identity', identity);
        }
    });
    assert.equal((await process.completion).exitCode, 0);
    const stop = await process.terminate();
    assert.equal(stop.stopped, true);
    const text = JSON.stringify(fixtureProposal(input.package.context)), threadId = 'explicit-synthetic-thread', turnId = 'explicit-synthetic-turn';
    store.executionUpdate(exec.id, {
        threadId,
        turnId,
        turnIntent: true,
        terminalStatus: 'completed',
        message: text,
        usageStatus: 'reported',
        usage: {
            inputTokens: 5,
            cachedInputTokens: 0,
            outputTokens: 2,
            reasoningOutputTokens: 0,
            totalTokens: 7
        }
    }, 'explicit-synthetic-accounting', {
        notProvider: true
    });
    for (const event of [{
            kind: 'message',
            method: 'item/completed',
            threadId,
            turnId,
            text,
            raw: {
                method: 'item/completed',
                params: {
                    threadId,
                    turnId,
                    item: {
                        type: 'agentMessage',
                        text
                    }
                }
            }
        }, {
            kind: 'turn-status',
            method: 'turn/completed',
            terminal: true,
            status: 'completed',
            threadId,
            turnId,
            raw: {
                method: 'turn/completed',
                params: {
                    threadId,
                    turn: {
                        id: turnId,
                        status: 'completed',
                        error: null
                    }
                }
            }
        }])
        store.executionUpdate(exec.id, {}, 'codex-event', event);
    const manager = new ExecutionManager(store, data);
    await (manager as unknown as {
        finalize(id: string, state: 'completed', stopped: boolean, evidence: unknown, launched: boolean, authoritative: boolean): Promise<void>;
    }).finalize(exec.id, 'completed', true, stop, true, true);
    await manager.close({
        cancel: false
    });
    assert.equal(store.executionGet(exec.id).state, 'completed');
    store.runtime.report(op.id, 'fixture-owner', {
        messageId: 'producer-receipt',
        outcome: 'confirmed',
        result: {
            executionId: exec.id
        }
    });
    const binding = await captureMaterialBinding(store, data, op.id), actual = await readMaterialBinding(binding), candidate = await captureCandidate(workspace, join(root, 'author-candidate')), environmentScope = await createEnvironmentScope(data, runtime), criteria = proposal.criteria, context: AcceptanceAuthoringContext = {
        workflowMode: 'native-host-v1',
        contract: store.runtime.inspect(runtime.id).run.contract,
        criteria,
        candidate: {
            workspace,
            digest: candidate.digest,
            files: await Promise.all(Object.keys(candidate.files).map(async (path) => {
                const bytes = await readFile(join(candidate.tree, path));
                return {
                    path,
                    content: bytes.toString(),
                    sha256: digest(bytes)
                };
            }))
        },
        environment: {
            ...await environmentFingerprint(environmentScope),
            scope: environmentScope
        },
        failureContext: null,
        previousSpec: null,
        materials: [{
                target: 'research-report/report.json',
                binding,
                evidence: {
                    context: actual.input.context,
                    sources: actual.input.context.sources
                }
            }]
    };
    const verifier: MaterialVerifier = {
        kind: 'material',
        version: 'fixture-material-v1',
        claimFile: 'research-report/report.json',
        binding,
        timeoutMs: 5000
    }, baseFiles = context.candidate.files.map(({ path, content }) => ({
        path,
        content
    })), badFiles = structuredClone(baseFiles);
    badFiles.find(f => f.path === 'research-report/report.json')!.content = JSON.stringify({
        ...fixtureProposal(input.package.context),
        claims: [{
                ...fixtureProposal(input.package.context).claims[0]!,
                text: 'The document requires unbounded write access.'
            }]
    });
    const bundle: AcceptanceBundle = {
        contextDigest: acceptanceAuthoringContextDigest(context),
        researchWorkflow: {
            schemaVersion: 1,
            mappings: [{
                    criterionId: 'meaning',
                    checkIndex: 0,
                    artifactObligationIds: ['faithful-meaning'],
                    hostGates: [...RESEARCH_HOST_GATES]
                }]
        },
        spec: {
            schemaVersion: 1,
            contractVersion: context.contract.version,
            standardsVersion: 'native-workflow-fixture-v1',
            obligations: [{
                    id: 'faithful-meaning',
                    criterionId: 'meaning',
                    expectation: 'Original source describes a bounded read-only tool, not unbounded write access.',
                    required: true,
                    applicable: true
                }],
            cases: [{
                    id: 'meaning',
                    revision: 1,
                    obligationIds: ['faithful-meaning'],
                    parameters: [{}],
                    modules: ['meaning'],
                    replaces: [],
                    defectRefs: ['inverted-meaning'],
                    status: 'active',
                    verifier
                }],
            controls: [{
                    id: 'good',
                    workspace: 'good',
                    expect: 'passed',
                    mustFail: []
                }, {
                    id: 'bad',
                    workspace: 'bad',
                    expect: 'failed',
                    mustFail: ['faithful-meaning']
                }],
            moduleDependencies: {
                meaning: []
            }
        },
        verifierFiles: [],
        controls: [{
                id: 'good',
                files: baseFiles
            }, {
                id: 'bad',
                files: badFiles
            }],
        coverageExplanation: [{
                criterionId: 'meaning',
                check: originalCheck,
                caseIds: ['meaning'],
                explanation: 'Artifact meaning is independently examined; every listed native process gate is separately required in the same original check, never a semantic exemption.'
            }]
    };
    const loop = store.supervision.attach({
        commandId: 'fixture-loop',
        runtimeId: runtime.id,
        config,
        limits: {
            maxRepairs: 1,
            maxReasoningCalls: 4,
            maxDurationMs: 600000,
            maxContextChars: 200000
        }
    }), author = store.supervision.beginJob({
        commandId: 'fixture-author',
        loopId: loop.id,
        expectedRevision: loop.revision,
        purpose: 'acceptance-authoring',
        context: {
            prompt: buildAcceptanceAuthoringPrompt(context),
            outputSchema: acceptanceAuthoringSchema(context),
            context: {
                acceptance: context,
                candidate
            }
        }
    });
    const authorRoot = join(data, 'supervision-reasoning', digest(author.id));
    await mkdir(authorRoot, {
        recursive: true
    });
    const authorNode = await spawnManagedProcess({
        operationId: author.id,
        command: globalThis.process.execPath,
        args: ['-e', 'process.stdout.write("explicit synthetic author protocol fixture\\n")'],
        cwd: authorRoot,
        timeoutMs: 3000,
        onBeforeSpawn: intent => {
            store.supervision.observeJob(author.id, {
                intents: [intent]
            });
        },
        onIdentity: identity => {
            store.supervision.observeJob(author.id, {
                identities: [identity]
            });
        }
    });
    assert.equal((await authorNode.completion).exitCode, 0);
    await authorNode.terminate();
    store.supervision.observeJob(author.id, {
        modelStarted: true,
        observedUsage: 1
    });
    await writeFile(join(authorRoot, 'output.json'), JSON.stringify(bundle));
    store.supervision.finishJob(author.id, {
        usage: 1,
        stopConfirmed: true,
        error: null,
        proofs: await hashes(authorRoot),
        threadId: 'explicit-synthetic-author',
        result: bundle
    });
    const assets = await materializeAcceptanceBundle({
        privateRoot: join(data, 'supervision', 'authoring'),
        jobId: author.id,
        context,
        bundle
    });
    const p = await p4.dispatch({
        type: 'propose',
        commandId: 'fixture-native-proposal',
        runtimeId: runtime.id,
        specPath: assets.specPath,
        researchAuthorJobId: author.id
    }) as Proposal;
    async function modelFixture(job: VerificationJob, outputRoot: string, prompt: string, passed = true) {
        await mkdir(outputRoot, {
            recursive: true
        });
        const child = await spawnManagedProcess({
            operationId: 'fixture-semantic-' + digest(outputRoot).slice(0, 24),
            command: globalThis.process.execPath,
            args: ['-e', 'process.stdout.write("explicit synthetic semantic protocol fixture\\n")'],
            cwd: workspace,
            timeoutMs: 3000,
            onBeforeSpawn: intent => {
                job.intents.push(intent);
                store.verification.update('job', job);
            },
            onIdentity: identity => {
                job.identities.push(identity);
                store.verification.update('job', job);
            }
        });
        const actualProcessResult=await child.completion;
        assert.equal(actualProcessResult.exitCode, 0);
        await child.terminate();
        const processPath=join(outputRoot,'model.process.json');
        await writeFile(processPath,JSON.stringify({intent:job.intents.at(-1),identity:child.identity,result:actualProcessResult}));
        assert.equal((await inspectProcess(child.identity)).status, 'stopped');
        const result = {
            verdict: passed ? 'passed' : 'failed',
            reason: 'Explicit synthetic finite protocol fixture; not provider semantic approval',
            observations: [],
            usage: 1,
            threadId: 'synthetic-' + digest(outputRoot).slice(0, 12),
            turnId: 'synthetic-turn',
            proofFiles: [join(outputRoot, 'result.json'), join(outputRoot, 'output.txt'), join(outputRoot, 'events.jsonl'),processPath],
            stopConfirmed: true,
            modelStarted: true
        };
        await writeFile(result.proofFiles[0]!, JSON.stringify(result));
        await writeFile(result.proofFiles[1]!, JSON.stringify({
            verdict: result.verdict,
            reason: result.reason,
            observations: []
        }));
        await writeFile(result.proofFiles[2]!, [{
                kind: 'review-input',
                value: {
                    prompt,
                    cwd: workspace,
                    model: job.config.model,
                    effort: job.config.effort
                }
            }, {
                kind: 'codex-event',
                value: {
                    kind: 'message',
                    method: 'item/completed',
                    threadId: result.threadId,
                    turnId: result.turnId,
                    text: JSON.stringify({
                        verdict: result.verdict,
                        reason: result.reason,
                        observations: []
                    }),
                    raw: {
                        params: {
                            threadId: result.threadId,
                            turnId: result.turnId,
                            item: {
                                type: 'agentMessage',
                                text: JSON.stringify({
                                    verdict: result.verdict,
                                    reason: result.reason,
                                    observations: []
                                })
                            }
                        }
                    }
                }
            }, {
                kind: 'codex-event',
                value: {
                    kind: 'token-usage',
                    threadId: result.threadId,
                    turnId: result.turnId,
                    tokenUsage: {
                        total: {
                            totalTokens: 1
                        }
                    }
                }
            }, {
                kind: 'codex-event',
                value: {
                    kind: 'turn-status',
                    terminal: true,
                    status: 'completed',
                    threadId: result.threadId,
                    turnId: result.turnId,
                    method: 'turn/completed',
                    raw: {
                        params: {
                            threadId: result.threadId,
                            turn: {
                                id: result.turnId,
                                status: 'completed',
                                error: null
                            }
                        }
                    }
                }
            }].map(e => JSON.stringify(e)).join('\n'));
        job.usage++;
        job.modelStarted = true;
        return result;
    }
    async function begin(kind: 'review' | 'verification', plan: FrozenPlan | null) {
        const id = 'fixture-' + kind, run = store.runtime.inspect(runtime.id).run, job: VerificationJob = {
            id,
            environmentScope: p.environmentScope!,
            researchProofPlanDigest: p.researchProofPlanDigest!,
            ...(kind === 'verification' ? {
                approvalScope: 'research-artifact' as const
            } : {}),
            runtimeId: runtime.id,
            projectId: runtime.projectId,
            runId: runtime.runId,
            workspace,
            kind,
            proposalId: p.id,
            planId: plan?.id ?? null,
            request: {
                scope: 'Explicit synthetic semantics and tokens, actual Node/SQLite/FS component fixture'
            },
            status: 'running',
            attemptId: id,
            environmentDigest: (await environmentFingerprint(p.environmentScope)).digest,
            config,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            intents: [],
            identities: [],
            usage: 0,
            modelStarted: false,
            usageUnknown: false,
            results: [],
            controls: [],
            evaluation: null,
            approved: false,
            stopConfirmed: false,
            error: null,
            proofs: {},
            sources: [],
            materials: []
        };
        store.verification.transaction(() => {
            store.verification.act(run.projectId, run.id, {
                type: 'startAttempt',
                attemptId: id,
                nodeId: run.nodes.at(-1)!.id,
                contractVersion: run.contract.version,
                purpose: 'verification',
                reservation: config.reservation,
                resources: []
            });
            store.verification.insert('job', job);
        });
        return job;
    }
    async function materialResult(job: VerificationJob, controlRoot: string, tree: string) {
        const evidence = await acquireMaterialEvidence(verifier, tree, join(controlRoot, 'materials'), new AbortController().signal), report = evidence.payload.proposed.proposal, pass = report.claims[0]!.text === 'The document describes a bounded read-only tool.';
        job.materials!.push(evidence.observation);
        const raw = await modelFixture(job, join(controlRoot, 'model'), JSON.stringify(evidence.payload), pass);
        return {
            instanceId: selectInstances(p.spec, {
                mode: 'final'
            }).instances[0]!.id,
            executionStatus: 'executed' as const,
            checks: [{
                    obligationId: 'faithful-meaning',
                    verdict: raw.verdict as 'passed' | 'failed',
                    reason: raw.reason
                }],
            reason: raw.reason,
            proofFiles: [...evidence.proofFiles, ...raw.proofFiles]
        };
    }
    async function finish(job: VerificationJob) {
        job.stopConfirmed = true;
        job.approved = true;
        job.status = 'finished';
        job.finishedAt = new Date().toISOString();
        const output = verificationDirectory(data, job);
        await writeFile(join(output, 'report.json'), JSON.stringify({
            controls: job.controls,
            results: job.results,
            evaluation: job.evaluation,
            error: job.error
        }));
        job.proofs = await hashes(output);
        store.verification.transaction(() => {
            store.verification.act(job.projectId, job.runId, {
                type: 'finishAttempt',
                attemptId: job.id,
                outcome: 'succeeded'
            });
            store.verification.act(job.projectId, job.runId, {
                type: 'settleAttempt',
                attemptId: job.id,
                actual: job.usage
            });
            store.verification.update('job', job);
        });
    }
    const review = await begin('review', null);
    for (const control of p.bundle.controls) {
        const result = await materialResult(review, join(verificationDirectory(data, review), 'control-' + digest(control.id),selectInstances(p.spec,{mode:'final'}).instances[0]!.id), control.candidate.tree);
        review.controls.push({
            id: control.id,
            results: [result],
            passed: legacyControlQualified(p.spec, control.id, [result])
        });
        store.verification.update('job', review);
    }
    const mapping = store.researchWorkflow.proposal(p.id).proofPlan;
    await modelFixture(review, join(verificationDirectory(data, review), 'definition-review'), await definitionReviewPrompt(p.spec, p.bundle, null, context.contract, review.controls, mapping));
    await finish(review);
    await p4.dispatch({
        type: 'publish',
        commandId: 'fixture-native-publish',
        proposalId: p.id,
        reviewId: review.id
    });
    const plan = await p4.dispatch({
        type: 'freeze',
        commandId: 'fixture-native-freeze',
        runtimeId: runtime.id,
        mode: 'final'
    }) as FrozenPlan, final = await begin('verification', plan);
    final.results = [await materialResult(final, join(verificationDirectory(data, final), 'candidate'), plan.candidate.tree)];
    final.evaluation = evaluateVerification(p.spec, plan.selection, final.results);
    await finish(final);
    return {
        root,
        data,
        workspace,
        source,
        store,
        p4,
        runtime,
        proposal: store.verification.get('proposal', p.id),
        plan,
        final,
        context,
        bundle,
        author,
        originalCheck,
        config
    };
}
