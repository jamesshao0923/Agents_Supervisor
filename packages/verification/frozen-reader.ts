import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonical, digest, exclusions, type Candidate } from './candidate.js';
import type { Proposal, DefinitionBundle, VerificationJob } from './records.js';
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function ensure(v: unknown, m: string): asserts v {
    if (!v)
        throw Error(m);
}
export class FrozenReader {
    private size = 0;
    private count = 0;
    constructor(private readonly dataDir?: string) {
    }
    read(path: string, root?: string): Buffer {
        ensure(isAbsolute(path), 'Control evidence path must be absolute');
        if (root)
            ensure(resolve(path).startsWith(resolve(root) + sep), 'Control proof escaped its actual job root');
        if (this.dataDir)
            ensure(resolve(path).startsWith(resolve(this.dataDir) + sep), 'Control evidence escaped managed data directory');
        let current = resolve(path);
        const chain: string[] = [];
        const trusted = this.dataDir ? resolve(this.dataDir) : dirname(current);
        ensure(realpathSync(trusted) === trusted, 'Control evidence root must be canonical');
        while (current !== trusted && dirname(current) !== current) {
            chain.push(current);
            current = dirname(current);
        }
        for (const part of chain.reverse())
            ensure(!lstatSync(part).isSymbolicLink(), 'Control evidence contains symlink');
        const info = lstatSync(path);
        ensure(info.isFile(), 'Control evidence is not a regular file');
        this.size += info.size;
        this.count++;
        ensure(this.size <= 512 * 1024 * 1024 && this.count <= 40000, 'Complete control evidence exceeds capacity');
        const bytes = readFileSync(path);
        ensure(bytes.length === info.size, 'Control evidence changed while reading');
        return bytes;
    }
    proofs(proofs: Record<string, string>, root?: string) {
        ensure(Object.keys(proofs).length > 0, 'Control evidence proof manifest is empty');
        for (const [path, hash] of Object.entries(proofs))
            ensure(/^[a-f0-9]{64}$/.test(hash) && digest(this.read(path, root)) === hash, 'Control proof bytes changed');
    }
    candidate(candidate: Candidate) {
        ensure(digest(canonical(candidate.files)) === candidate.digest, 'Frozen control candidate digest changed');
        const actual: Record<string, string> = {};
        const walk = (path: string) => {
            for (const name of readdirSync(path).sort()) {
                if (exclusions.includes(name))
                    continue;
                const file = join(path, name), stat = lstatSync(file);
                ensure(!stat.isSymbolicLink(), 'Frozen control tree contains symlink');
                if (stat.isDirectory())
                    walk(file);
                else {
                    ensure(stat.isFile(), 'Unsupported frozen control file');
                    actual[relative(candidate.tree, file).split(sep).join('/')] = digest(Buffer.concat([this.read(file), Buffer.from('\0executable:' + String(stat.mode & 0o111))]));
                }
            }
        };
        walk(candidate.tree);
        ensure(Object.keys(actual).length > 0 && same(actual, candidate.files), 'Frozen control candidate bytes changed');
    }
    definition(spec: Proposal['spec'], bundle: DefinitionBundle) {
        for (const [name, hash] of Object.entries(bundle.files))
            ensure(digest(this.read(join(bundle.directory, name))) === hash, 'Frozen control detector changed');
        for (const control of bundle.controls)
            this.candidate(control.candidate);
        ensure(digest(canonical({ spec, files: bundle.files, controls: bundle.controls.map(c => ({ id: c.id, digest: c.candidate.digest })) })) === bundle.digest, 'Frozen control definition digest changed');
    }
}
export function assertRecordedStops(job: Pick<VerificationJob, 'intents' | 'identities' | 'proofs'>, reader: FrozenReader): void {
    reader.proofs(job.proofs);
    const records = Object.keys(job.proofs).filter(p => /(?:^|\/)(?:[^/]+\.)?process\.json$/.test(p)).map(p => ({ path: p, record: JSON.parse(reader.read(p).toString()) }));
    ensure(job.identities.length > 0 && job.intents.length === job.identities.length, 'Incomplete actual process inventory');
    for (const identity of job.identities) {
        const intent = job.intents.find(i => i.operationId === identity.operationId && i.ownerToken === identity.ownerToken);
        const match = records.find(r => same(r.record.identity, identity));
        ensure(intent && match, 'Actual stop lacks matching process ownership');
        const result = match.record.result ?? match.record;
        ensure(result.stopped === true
            && (result.stop?.status === 'stopped'
            || result.status === 'stopped')
            && (result.stop?.members ?? result.members)?.length === 0, 'Actual process stop unresolved');
        if (match.record.result)
            ensure(same(match.record.intent, intent), 'Model intent proof differs');
        else {
            const dir = dirname(match.path);
            for (const [name, value] of [['intent.json', intent], ['identity.json', identity]] as const) {
                const path = join(dir, name);
                ensure(job.proofs[path] && same(JSON.parse(reader.read(path).toString()), value), 'Command ownership proof differs');
            }
        }
    }
}
