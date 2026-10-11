import {SupervisionController} from '../../packages/orchestration/supervision-controller.js';
import {LocalRuntimeAdapter} from '../../packages/runtime/index.js';
import {indexedCodexProtocol} from './indexed-codex-protocol.js';
import {SupervisionReasoningRunner} from '../../packages/orchestration/supervision-reasoning.js';
import {IndexedResearchConsumer} from '../../packages/runtime/indexed-research-consumer.js';
import {runModelReview} from '../../packages/verification/model.js';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, cp } from 'node:fs/promises';
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
        citations: context.index.entries.map(entry=>({id:entry.id==='original'?'quote':'quote-'+entry.id,
            materialId:entry.id,start:0,end:originalQuote.length,quote:originalQuote})),
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
        materials: context.index.entries.map(entry=>({materialId:entry.id,categoryIds:['tool'],
            summary:'Explicit fixture document describing a bounded read-only tool.',
            citationIds:[entry.id==='original'?'quote':'quote-'+entry.id],unresolved:[]})),
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
export async function indexedWorkflowFixture(t: TestContext, fault?: (point: string) => void,
    beforeRuntime?: (store:SupervisorStore,runtime:RuntimeRecord,root:string,workspace:string)=>Promise<void>,
    evidence?: {timestampSyntheticEvents:true;archiveRoot:string;preserveOriginalRoot?:true}) {
    const root = await realpath(await mkdtemp('/tmp/sv-research-host-authority-')), data = join(root, 'data'), workspace = join(root, 'workspace'), source = join(root, 'notes.md');
    await mkdir(workspace);
    await writeFile(source, originalQuote + '\n');
    const inputs=[{id:'original',kind:'local' as const,path:source}];
    for(let i=2;i<=5;i++){const path=join(root,'actual-'+i+'.md');await writeFile(path,originalQuote+'\nExplicit component fixture original '+i+' α😀.\n');inputs.push({id:'document-'+i,kind:'local',path});}
    const reply=join(root,'fixture-reply.json'),oldCodex=process.env.SUPERVISOR_CODEX_PATH,oldHome=process.env.CODEX_HOME;process.env.CODEX_HOME=join(root,'private-codex');await mkdir(process.env.CODEX_HOME);process.env.SUPERVISOR_CODEX_PATH=await indexedCodexProtocol(root,reply);t.after(()=>{if(oldCodex===undefined)delete process.env.SUPERVISOR_CODEX_PATH;else process.env.SUPERVISOR_CODEX_PATH=oldCodex;if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;});
    let supervision:SupervisionController|undefined;
    const store = new SupervisorStore(data, fault ? {
        fault
    } : {}), p4 = new VerificationController(store, data);
    t.after(async () => {
        await supervision?.close();
        await p4.close();
        store.close();
        // Preserve actual component evidence before cleanup, including failed runs.
        if(evidence){await mkdir(evidence.archiveRoot,{recursive:true});await cp(root,join(evidence.archiveRoot,root.split('/').at(-1)!),{recursive:true});}
        if(!evidence?.preserveOriginalRoot)await rm(root, {
            recursive: true,
            force: true
        });
    });
    const originalCheck = 'Report faithfully preserves the original bounded read-only meaning; only deliver after current material, confirmed producer stop, known total Run accounting and complete independent acceptance.';
    const config = {
        model: 'explicit-synthetic-protocol-fixture-no-provider',
        effort: 'low',
        reservation: 300,
        timeoutMs: 30000
    }, research = {
        representation:'indexed-material-v1' as const,
        schemaVersion: 1 as const,
        inputs,
        materialLimits: {
            maxInputs: 5,
            parallel: 2,
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
    await writeFile(reply,JSON.stringify({kind:'producer',value:fixtureProposal(input.package.context)}));
    const manager=new ExecutionManager(store,data);const exec=await manager.startBound(store.runtime.executionInput(op.id,'fixture-owner'),store.runtime.binding(op.id,'fixture-owner'));
    const until=Date.now()+45000;while(!store.executionGet(exec.id).stopConfirmed&&Date.now()<until)await new Promise(r=>setTimeout(r,25));
    const result=store.executionGet(exec.id);assert.equal(result.state,'completed',result.error??'producer incomplete');assert.equal(result.stopConfirmed,true);assert.equal((await inspectProcess(result.identity as import('../../packages/process-control/index.js').ProcessIdentity)).status,'stopped');await manager.close({cancel:false});
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
                    representation:'indexed-material-v1',indexed:actual.input.indexed
                }
            }]
    };
    const verifier: MaterialVerifier = {
        kind: 'material',
        version: 'fixture-material-v1',
        claimFile: 'research-report/report.json',
        binding,
        timeoutMs: 30000
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
    await writeFile(reply,JSON.stringify({kind:'author',value:bundle}));
    const runtimeAdapter=new LocalRuntimeAdapter(store,data);supervision=new SupervisionController(store,data,runtimeAdapter,p4);
    await supervision.initialize();
    const attached=await supervision.dispatch({type:'attach',commandId:'actual-indexed-supervision',runtimeId:runtime.id,config,limits:{maxRepairs:1,maxReasoningCalls:4,maxDurationMs:180000,maxContextChars:200000}}) as {loop:{id:string}};
    const deadline=Date.now()+210000;let loop=store.supervision.get(attached.loop.id);
    while(!['complete','blocked'].includes(loop.phase)&&!loop.stopped&&Date.now()<deadline){await new Promise(r=>setTimeout(r,50));loop=store.supervision.get(loop.id);}
    assert.equal(loop.phase,'complete',JSON.stringify({phase:loop.phase,reason:loop.reason,jobs:store.supervision.jobs(loop.id).map(j=>({error:j.error,result:j.result}))}));
    await supervision.close();
    const final=store.verification.get('job',loop.references.verificationJobId!),plan=store.verification.get('plan',final.planId!),p=store.verification.get('proposal',final.proposalId),author=store.supervision.jobs(loop.id).find(j=>j.purpose==='acceptance-authoring')!,delivery=store.verification.list('delivery',runtime.id)[0]!;
    assert.ok(delivery&&final.approved&&final.kind==='verification'&&plan.selection.mode==='final');
    assert.ok(Object.keys(author.proofs).some(p=>p.endsWith('/indexed-reader/binding.json')));
    return {root,data,workspace,source,store,p4,runtime,proposal:p,plan,final,context,bundle,author,originalCheck,config,delivery};
}
