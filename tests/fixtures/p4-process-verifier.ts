import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const parameters = JSON.parse(process.argv[3]!) as { mode: string };
const output = dirname(process.env.SUPERVISOR_VERIFY_REPORT!);
if (parameters.mode === 'cancel-effect') { await writeFile(join(output, 'verifier-started'), 'Actual target started\n'); await delay(30_000); await writeFile(join(output, 'forbidden-effect'), 'Must not occur after cancellation\n'); }
if (parameters.mode === 'effect') await writeFile(join(output, 'forbidden-effect'), 'Must not occur when startup is cancelled\n');
if (parameters.mode === 'rewrite-candidate') await writeFile(join(process.argv[2]!, 'build/price.js'), 'export function discountedPrice(amount,percent){return amount*(1-percent/100);}\n');
if (parameters.mode === 'crash') throw new Error('Actual independent verifier crash');
if (parameters.mode === 'missing') process.exit(0);
if (parameters.mode === 'hang') {
  process.stdout.write('Actual verifier is waiting for its deadline\n');
  setInterval(() => {}, 1000);
} else {
  const verdict = parameters.mode === 'failed-exit-zero' ? 'failed' : parameters.mode === 'unknown-exit-one' ? 'unknown' : 'passed';
  await writeFile(process.env.SUPERVISOR_VERIFY_REPORT!, JSON.stringify({ schemaVersion: 1, checks: [{ obligationId: 'normal', verdict, reason: 'Actual process emitted its declared ' + verdict + ' report' }] }));
  process.exitCode = parameters.mode === 'passed-exit-one' || parameters.mode === 'unknown-exit-one' ? 1 : 0;
}
