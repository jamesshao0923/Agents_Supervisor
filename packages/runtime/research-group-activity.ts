import {writeFile, lstat, realpath, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {SupervisorStore} from '../persistence/store.js';
import type {ExecutionRecord} from '../contracts/p2.js';
import type {ResearchGroupCompletion} from '../contracts/p8-research-group-output.js';
import {inspectProcess, type ProcessIdentity} from '../process-control/index.js';
import {MaterialIntake} from '../workspace/material-intake.js';
import {bytesDigest, privateDirectory, readBounded, exclusiveJSON, researchCompletionEvents} from '../workspace/research-runtime-files.js';
import {canonical} from '../verification/candidate.js';
import {researchDigest} from '../workspace/research-materials.js';
import {researchGroupOutputSchema, validateResearchGroupOutput} from '../orchestration/research-group-output.js';
function ensure(value: unknown, message: string): asserts value {if (!value) throw Error('Research group activity: ' + message);}
/** Uses existing scheduled P2 transport. No scheduler/model/fee ledger of its own. */
export class ResearchGroupActivity {
  constructor(private readonly store: SupervisorStore, private readonly dataRoot: string) {}
  inputForExecution(record: ExecutionRecord): {digest: string; outputSchema: Record<string, unknown>} | null {
    if (!record.scheduledBinding) return null;
    const claim = this.store.scheduler.claimGet(record.scheduledBinding.claimId);
    const input = this.store.researchGroups.inputForClaim(claim);
    if (!input) return null;
    ensure(record.id === claim.attemptId && record.scheduledBinding.operationId === claim.operationId &&
      record.projectId === claim.projectId && record.runId === claim.runId && record.workspace === claim.workspace &&
      record.prompt === this.store.scheduler.executionInput(claim.id).prompt, 'actual frozen group P2 input differs');
    return {digest: input.digest, outputSchema: researchGroupOutputSchema(input)};
  }
  private boundary(record: ExecutionRecord) {
    ensure(record.scheduledBinding, 'actual scheduled binding required');
    const claim = this.store.scheduler.claimGet(record.scheduledBinding.claimId), input = this.store.researchGroups.inputForClaim(claim);
    ensure(input, 'actual group input missing');
    this.inputForExecution(record);
    const scheduler = this.store.scheduler.get(claim.schedulerId), runtime = this.store.runtime.get(claim.runtimeId);
    ensure(!runtime.paused && !runtime.cancelled && scheduler.state === 'active' && scheduler.fence === 'held', 'group publication paused/cancelled/closed');
    ensure(record.identity && record.terminalStatus === 'completed' && record.turnIntent &&
      record.usageStatus === 'reported' && record.usage && record.usage.totalTokens <= claim.reservation && !record.cancelRequested,
      'actual physical stop and known bounded same-turn usage required');
    const events = researchCompletionEvents(record, after => this.store.executionEvents(record.id, after));
    return {claim, input, events};
  }
  async materialize(id: string): Promise<ResearchGroupCompletion> {
    let record = this.store.executionGet(id);
    const before = this.boundary(record);
    ensure((await inspectProcess(record.identity as ProcessIdentity)).status === 'stopped', 'physical group writer unresolved');
    const draft = await validateResearchGroupOutput({intake: new MaterialIntake(this.dataRoot), input: before.input, output: record.message});
    const current = this.store.executionGet(id), after = this.boundary(current);
    ensure(after.input.digest === before.input.digest && current.message === record.message &&
      canonical(current.usage) === canonical(record.usage) && current.threadId === record.threadId && current.turnId === record.turnId,
      'actual group completion changed during host validation');
    record = current;
    const contents = canonical(draft), files = {'extraction.json': bytesDigest(contents)};
    ensure((await realpath(record.workspace)) === record.workspace && !(await lstat(record.workspace)).isSymbolicLink(), 'group workspace alias');
    ensure((await readdir(record.workspace)).every(path => path === 'extraction.json'), 'unowned model-written bytes retained; no partial overwrite');
    const path = join(record.workspace, 'extraction.json');
    try { await writeFile(path, contents, {flag: 'wx', mode: 0o600}); }
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      ensure(bytesDigest(readBounded(path)) === files['extraction.json'], 'partial/conflicting extraction retained');}
    const directory = await privateDirectory(this.dataRoot, 'research-group-completions', id);
    const receiptPath = join(directory, 'receipt.json');
    let prior: ResearchGroupCompletion | null = null;
    try {prior = JSON.parse(readBounded(receiptPath).toString('utf8')) as ResearchGroupCompletion;}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    const body = {schemaVersion: 1 as const, executionId: record.id, claimId: before.claim.id, inputDigest: before.input.digest,
      threadId: record.threadId!, turnId: record.turnId!, rawOutputDigest: bytesDigest(record.message),
      eventPrefixSeq: record.lastEventSeq, completionEvents: after.events, draft, files};
    let receipt: ResearchGroupCompletion = {...body, digest: researchDigest(body)};
    if (prior) {
      ensure(Number.isSafeInteger(prior.eventPrefixSeq) && prior.eventPrefixSeq <= record.lastEventSeq,
        'prior completion prefix is not actual');
      const originalEvents = researchCompletionEvents({...record, lastEventSeq: prior.eventPrefixSeq},
        after => this.store.executionEvents(record.id, after));
      const expected = {...body, eventPrefixSeq: prior.eventPrefixSeq, completionEvents: originalEvents};
      ensure(canonical(prior) === canonical({...expected, digest: researchDigest(expected)}),
        'conflicting prior completion retained; no overwrite or turn replay');
      receipt = prior;
    }
    const final = this.store.executionGet(id), checked = this.boundary(final);
    ensure(final.lastEventSeq === record.lastEventSeq && checked.input.digest === before.input.digest &&
      bytesDigest(readBounded(path)) === files['extraction.json'], 'late group boundary or output changed');
    await exclusiveJSON(receiptPath, receipt);
    const published = this.store.executionGet(id), publishedBoundary = this.boundary(published);
    ensure(published.lastEventSeq === final.lastEventSeq && publishedBoundary.input.digest === before.input.digest &&
      bytesDigest(readBounded(path)) === files['extraction.json'] &&
      canonical(JSON.parse(readBounded(receiptPath).toString('utf8'))) === canonical(receipt),
      'late group boundary or receipt changed after exclusive publication');
    return receipt;
  }
  /** Existing worker invokes this before original analysis claim. Failures are
   * durable blocked states, never silently retried or unbounded waiting. */
  advance(runtimeId: string): void {
    const record = this.store.researchGroups.byRuntime(runtimeId);
    if (!record || record.state === 'installed' || record.state === 'blocked') return;
    const runtime = this.store.runtime.get(runtimeId);
    if (runtime.cancelled || runtime.paused || runtime.cursor === 0) return;
    try {
      this.store.researchGroups.prepare(record.id);
      const run = this.store.runtime.inspect(runtimeId).run;
      this.store.researchGroups.install({commandId: 'research-group-auto-install:' + record.id, id: record.id,
        expectedRunRevision: run.revision, expectedResultRevision: this.store.taskResults.inspect({projectId: run.projectId, runId: run.id}).revision});
    } catch (error) {
      const reason = 'Research groups installation blocked: ' + String(error);
      this.store.researchGroups.block(record.id, reason); this.store.runtime.block(runtimeId, reason);
      throw error;
    }
  }
}
