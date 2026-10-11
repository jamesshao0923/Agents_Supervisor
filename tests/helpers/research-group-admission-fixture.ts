import {mkdtemp, mkdir, writeFile, realpath, rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import {SupervisorStore} from '../../packages/persistence/store.js';
import type {GoalProposal, GoalSession} from '../../packages/contracts/p5.js';
import type {GoalResearchConfiguration} from '../../packages/contracts/p8-research-runtime.js';
export function configuration(root = '/tmp/group-admission-input'): GoalResearchConfiguration {
  return {schemaVersion: 1, inputs: [1, 2, 3, 4, 5].map(n => ({id: 'm' + n, kind: 'local' as const, path: join(root, 'm' + n + '.txt')})),
    materialLimits: {maxInputs: 5, parallel: 3, maxItemBytes: 4096, maxTotalBytes: 16384,
      timeoutMs: 1000, maxDurationMs: 5000, maxRedirects: 0},
    researchLimits: {maxContextChars: 150000, maxClaims: 16, maxCitations: 20, maxQuoteChars: 12000},
    reportDirectory: 'research-report', cutoff: null, maxSourceAgeMs: 60000};
}
export function proposal(): GoalProposal {
  return {decision: 'ready', summary: 'Extract all five original materials and then analyze every original question.',
    questions: [], facts: [], constraints: [], style: [],
    criteria: [{id: 'trace', description: 'Trace all five sources including gaps.', kind: 'material',
      target: 'research-report/report.json', checks: ['Keep exact original citations and all gaps.']}],
    steps: [{id: 'analyze', description: 'Analyze all original materials and preserve complete acceptance.', dependencies: [], acceptanceIds: ['trace']}],
    researchGroups: {schemaVersion: 1, groups: [['m1'], ['m2', 'm4'], ['m3'], ['m5']].map((materialIds, i) => ({
      id: 'group' + (i + 1), purpose: 'Extract the exact original evidence for group ' + (i + 1), materialIds, criterionIds: ['trace'],
    }))}};
}
export function session(): GoalSession {
  return {id: 'goal', projectId: 'project', workspace: '/tmp/group-admission', workspaceKind: 'project',
    revision: 1, goal: 'Trace all five materials.', phase: 'ready', messages: [{id: 'message', role: 'user', text: 'Trace all five materials.', createdAt: 'fixture'}],
    jobs: [], proposal: proposal(), runtimeId: null, error: null, createdAt: 'fixture', updatedAt: 'fixture',
    config: {model: 'explicit-nonprovider-fixture', effort: 'low', reservation: 100, timeoutMs: 60000},
    maxContextChars: 200000, research: configuration()};
}
export async function fixture(t: TestContext, tokenLimit = 1000) {
  const root = await realpath(await mkdtemp('/tmp/sv-group-admit-')), data = join(root, 'data'), workspace = join(root, 'workspace');
  await mkdir(workspace);
  for (let i = 1; i <= 5; i++) await writeFile(join(root, 'm' + i + '.txt'), 'Actual frozen material ' + i + ' with source-literal evidence.\n');
  const store = new SupervisorStore(data);
  t.after(async () => {store.close(); await rm(root, {recursive: true, force: true});});
  const started = store.goals.start({type: 'start', commandId: 'start', goal: 'Trace all five materials.', workspace,
    tokenLimit, verificationReserve: 300, model: 'explicit-nonprovider-fixture', effort: 'low', reservation: 100, timeoutMs: 60000,
    maxContextChars: 200000, research: configuration(root)}, workspace, 'project');
  const ready = (p: GoalProposal | null = proposal(), usage: number | null = 7) => store.goals.finish(started.session.id,
    started.session.jobs[0]!.id, job => {
      // Explicit synthetic planning decision/accounting, no provider call or semantic authority.
      job.usage = usage; job.stopConfirmed = true; job.proposal = p;
    });
  const admit = (revision: number, commandId = 'admit') => store.goals.control({type: 'admit', commandId,
    sessionId: started.session.id, expectedRevision: revision});
  return {root, data, workspace, store, started, ready, admit};
}
