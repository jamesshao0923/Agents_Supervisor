import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupervisionJob } from '../contracts/p6-supervision.js';
import { authorWireInput, type PresentedAuthorInput } from './author-presentation.js';

const bytesHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export function authorWireReceipt(job: Pick<SupervisionJob, 'id' | 'input' | 'inputDigest' | 'purpose'>) {
  const wire = authorWireInput(job.input as PresentedAuthorInput, job.purpose);
  if (!wire.presented) return null;
  return {
    schemaVersion: 1,
    kind: 'control-evolution-author-wire',
    jobId: job.id,
    inputDigest: job.inputDigest,
    promptDigest: bytesHash(wire.prompt),
    outputSchemaDigest: bytesHash(canonical(wire.outputSchema)),
    wireDigest: bytesHash(canonical({ prompt: wire.prompt, outputSchema: wire.outputSchema })),
  };
}

/** Only new versioned inputs require this proof. Legacy prompts are untouched. */
export function assertAuthorWireProof(
  job: Pick<SupervisionJob, 'id' | 'purpose' | 'input' | 'inputDigest' | 'proofs' | 'config' | 'threadId'>,
  directory: string,
): void {
  const receipt = authorWireReceipt(job);
  if (!receipt) return;
  const wire = authorWireInput(job.input as PresentedAuthorInput, job.purpose);
  const read = (name: string): string => {
    const path = join(directory, name), bytes = readFileSync(path);
    ensure(job.proofs[path] === bytesHash(bytes), 'Author presentation proof bytes changed: ' + name);
    return bytes.toString('utf8');
  };
  ensure(same(JSON.parse(read('author-wire.json')), receipt), 'Author wire receipt differs from complete frozen input');
  const events = read('events.jsonl').trim().split('\n').map(line => JSON.parse(line) as {kind: string; value: any});
  const inputs = events.filter(event => event.kind === 'reasoner-input');
  ensure(inputs.length === 1
    && inputs[0]!.value.id === job.id
    && inputs[0]!.value.prompt === wire.prompt
    && same(inputs[0]!.value.outputSchema, wire.outputSchema)
    && inputs[0]!.value.model === job.config.model
    && inputs[0]!.value.effort === job.config.effort,
  'Actual author request differs from rendered frozen input');
  const turns = events.filter(event => event.kind === 'reasoner-turn-intent');
  ensure(turns.length === 1
    && turns[0]!.value.threadId === job.threadId
    && same(turns[0]!.value.input, [{type: 'text', text: wire.prompt}])
    && turns[0]!.value.model === job.config.model
    && turns[0]!.value.effort === job.config.effort,
  'Actual author turn did not send the complete rendered prompt');
  const started = events.filter(event => event.kind === 'reasoner-turn-started');
  ensure(started.length === 1 && typeof started[0]!.value?.turn?.id === 'string', 'Author actual turn identity missing');
  const completed = events.filter(event => event.kind === 'codex-event' && event.value?.method === 'turn/completed');
  ensure(completed.length === 1
    && completed[0]!.value.threadId === job.threadId
    && completed[0]!.value.raw?.params?.threadId === job.threadId
    && completed[0]!.value.raw?.params?.turn?.id === started[0]!.value.turn.id
    && completed[0]!.value.raw?.params?.turn?.status === 'completed',
  'Author rendered prompt lacks its actual completed turn');
}
