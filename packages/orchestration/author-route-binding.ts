import {tokenCapacity} from '../contracts/token-policy.js';
import { assertProviderReasonerSchemaProof } from './reasoner-schema.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthorRouteReceipt, AuthorRouteReceiptV2 } from '../contracts/p6-author-routing.js';
import type { SupervisionJob, SupervisionRecord } from '../contracts/p6-supervision.js';
import { expectedAuthorRouteConfig } from './acceptance-authoring-route.js';
import { authorWireInput, type PresentedAuthorInput } from './author-presentation.js';
// Same canonical ordering as persisted runtime receipts, without repository imports.
export function authorRouteCanonical(v: unknown): string {
    if (Array.isArray(v))
        return '[' + v.map(authorRouteCanonical).join(',') + ']';
    if (v && typeof v === 'object')
        return '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => JSON.stringify(k) + ':' + authorRouteCanonical(x)).join(',') + '}';
    return JSON.stringify(v);
}
export const authorRouteDigest = (v: unknown): string => createHash('sha256').update(authorRouteCanonical(v)).digest('hex');
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const same = (a: unknown, b: unknown) => authorRouteCanonical(a) === authorRouteCanonical(b);
function ensure(v: unknown, m: string): asserts v { if (!v)
    throw Error(m); }
function exact(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
    ensure(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(','), 'Invalid author route fields');
}
function integer(v: unknown, min = 0): asserts v is number { ensure(Number.isSafeInteger(v) && Number(v) >= min, 'Invalid author route number'); }
export function parseAuthorRouteReceipt(value: unknown): AuthorRouteReceipt {
    ensure(value && typeof value === 'object' && !Array.isArray(value), 'Invalid author route receipt');
    const r = value as AuthorRouteReceipt;
    ensure(r.schemaVersion === 1 || r.schemaVersion === 2, 'Unknown author route receipt version');
    // V1 keeps its historical structure/selection; never upgrade it while reading.
    if (r.schemaVersion === 1)
        return r;
    exact(r, ['schemaVersion', 'id', 'commandId', 'loopId', 'contractDigest', 'rejection', 'policy', 'policyDigest', 'capabilities', 'baseline', 'selected', 'nextInputDigest', 'nextJobId', 'createdAt', 'authorization']);
    exact(r.policy, ['schemaVersion', 'version', 'preference', 'models', 'minimumEffort', 'capabilityMaxAgeMs']);
    integer(r.policy.capabilityMaxAgeMs, 1);
    ensure(authorRouteDigest(r.policy) === r.policyDigest, 'Author route policy digest changed');
    exact(r.authorization, ['observedAt', 'loopCreatedAt', 'absoluteDeadlineMs', 'loopRevision', 'runRevision', 'originalTimeoutMs', 'budget', 'maxContextChars', 'storedChars', 'wireChars', 'inputDigest', 'wireDigest', ...(Object.hasOwn(r.authorization,'authorSession')?['authorSession']:[])]);
    const a = r.authorization;
    if (Object.hasOwn(a,'authorSession')) {
        const session=a.authorSession;
        exact(session,['schemaVersion','sessionId','rootJobId','ceiling','spent','remaining','jobs']);
        ensure(session.schemaVersion===1&&typeof session.sessionId==='string'&&session.sessionId.length>0
            &&typeof session.rootJobId==='string'&&session.rootJobId.length>0,'Invalid author session identity');
        if(session.ceiling!==null)integer(session.ceiling,1);integer(session.spent);integer(session.remaining,1);
        ensure(session.ceiling===null||session.ceiling-session.spent===session.remaining,'Author session arithmetic changed');
        ensure(Array.isArray(session.jobs)&&session.jobs.length>=3&&session.jobs.length<=6,'Invalid author session inventory');
        const ids=new Set<string>();let spent=0;
        for(const job of session.jobs) {
            exact(job,['jobId','inputDigest','completionDigest','proofsDigest','usage']);
            ensure(typeof job.jobId==='string'&&job.jobId.length>0&&!ids.has(job.jobId),'Duplicate author session job');
            ids.add(job.jobId);integer(job.usage);spent+=job.usage;
            for(const key of ['inputDigest','completionDigest','proofsDigest'] as const)ensure(typeof job[key]==='string'&&/^[a-f0-9]{64}$/.test(job[key] as string),'Invalid author session digest');
        }
        ensure(Number.isSafeInteger(spent)&&spent===session.spent&&session.jobs[0]!.jobId===session.rootJobId
            &&session.jobs.at(-1)!.jobId===r.rejection.previousJobId,'Author session source inventory changed');
    }
    integer(a.loopRevision);
    integer(a.runRevision);
    integer(a.maxContextChars, 8000);
    integer(a.storedChars, 1);
    integer(a.wireChars, 1);
    ensure(a.maxContextChars <= 200000 && a.storedChars + 6000 <= a.maxContextChars && a.wireChars + 6000 <= a.maxContextChars, 'Author route capacity changed');
    exact(a.budget, ['limit', 'spent', 'reserved', 'protected']);
    for (const [key,n] of Object.entries(a.budget))
        if(key!=='limit'||n!==null)integer(n);
    if(a.authorSession)ensure((a.authorSession.ceiling===null)===(a.budget.limit===null),'Author session differs from original Run token policy');
    ensure(a.budget.spent + a.budget.reserved + a.budget.protected + r.selected.reservation <= tokenCapacity(a.budget.limit), 'Author route budget unavailable');
    ensure(r.createdAt === a.observedAt && a.inputDigest === r.nextInputDigest, 'Author route input/time changed');
    ensure(same(r.selected, expectedAuthorRouteConfig(r)), 'Author route selection changed');
    return r;
}
export function assertAuthorRouteJob(receipt: AuthorRouteReceipt, job: SupervisionJob, loop: SupervisionRecord): void {
    const r = parseAuthorRouteReceipt(receipt);
    ensure(r.nextJobId === job.id && r.loopId === job.loopId && r.contractDigest === job.contractDigest && r.nextInputDigest === job.inputDigest && same(r.selected, job.config), 'Author route job differs');
    if (r.schemaVersion === 1)
        return;
    const a = r.authorization, wire = authorWireInput(job.input as PresentedAuthorInput, job.purpose);
    ensure(job.purpose === 'acceptance-authoring' && loop.id === r.loopId && loop.createdAt === a.loopCreatedAt && Date.parse(loop.createdAt) + loop.limits.maxDurationMs === a.absoluteDeadlineMs && loop.limits.maxContextChars === a.maxContextChars, 'Author route deadline/scope changed');
    ensure(authorRouteCanonical(job.input).length === a.storedChars && authorRouteDigest(job.input) === a.inputDigest && wire.prompt.length + JSON.stringify(wire.outputSchema).length === a.wireChars && authorRouteDigest({ prompt: wire.prompt, outputSchema: wire.outputSchema }) === a.wireDigest, 'Author route complete wire changed');
}
export interface AuthorRouteDispatch {
    schemaVersion: 1;
    routeId: string;
    routeDigest: string;
    jobId: string;
    inputDigest: string;
    dispatchedAt: string;
    absoluteDeadlineMs: number;
    timeoutMs: number;
}
export function authorRouteDispatch(receipt: AuthorRouteReceiptV2, job: SupervisionJob, now = Date.now()): AuthorRouteDispatch {
    ensure(Number.isSafeInteger(now) && now >= Date.parse(receipt.authorization.observedAt), 'Author dispatch clock moved backwards');
    const timeoutMs = Math.min(job.config.timeoutMs, receipt.authorization.absoluteDeadlineMs - now);
    ensure(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Author route deadline exhausted before dispatch');
    return { schemaVersion: 1, routeId: receipt.id, routeDigest: authorRouteDigest(receipt), jobId: job.id, inputDigest: job.inputDigest, dispatchedAt: new Date(now).toISOString(), absoluteDeadlineMs: receipt.authorization.absoluteDeadlineMs, timeoutMs };
}
export function assertAuthorRouteProof(receipt: AuthorRouteReceipt, job: SupervisionJob, directory: string): void {
    if (receipt.schemaVersion === 1)
        return;
    const read = (name: string) => { const path = join(directory, name), bytes = readFileSync(path); ensure(job.proofs[path] === sha(bytes), 'Author route proof bytes changed'); return bytes.toString('utf8'); };
    const dispatch = JSON.parse(read('author-route-dispatch.json')) as AuthorRouteDispatch;
    ensure(same(dispatch, authorRouteDispatch(receipt, job, Date.parse(dispatch.dispatchedAt))), 'Author route dispatch changed');
    const events = read('events.jsonl').trim().split('\n').map(line => JSON.parse(line));
    assertProviderReasonerSchemaProof(events);
    const requests = events.filter(e => e.kind === 'reasoner-input');
    ensure(requests.length === 1 && requests[0].value.id === job.id && requests[0].value.timeoutMs === dispatch.timeoutMs && requests[0].value.absoluteDeadlineMs === dispatch.absoluteDeadlineMs && requests[0].value.model === job.config.model && requests[0].value.effort === job.config.effort, 'Author actual request deadline/config differs');
}
