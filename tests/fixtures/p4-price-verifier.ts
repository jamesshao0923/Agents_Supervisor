import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const candidate = process.argv[2]!;
const parameters = JSON.parse(process.argv[3]!) as { amount: string; percent: string; expected: string };
const module = await import(pathToFileURL(join(candidate, 'build/price.js')).href) as { discountedPrice(amount: number, percent: number): number };
const checks: { obligationId: string; verdict: 'passed' | 'failed'; reason: string }[] = [];
for (const [obligationId, check] of [
  ['normal', () => assert.equal(module.discountedPrice(Number(parameters.amount), Number(parameters.percent)), Number(parameters.expected))],
  ['invalid', () => { for (const [amount, percent] of [[-1, 5], [1, -1], [1, 101], [NaN, 5], [Infinity, 5], [-Infinity, 5], [1, NaN], [1, Infinity], [1, -Infinity]] as const) assert.throws(() => module.discountedPrice(amount, percent), RangeError); }],
] as const) {
  try { check(); checks.push({ obligationId, verdict: 'passed', reason: 'Actual price assertion passed for parameters ' + JSON.stringify(parameters) }); }
  catch (error) { checks.push({ obligationId, verdict: 'failed', reason: 'Actual price assertion failed: ' + String(error) }); }
}
await writeFile(process.env.SUPERVISOR_VERIFY_REPORT!, JSON.stringify({ schemaVersion: 1, checks }));
process.exitCode = checks.some(check => check.verdict === 'failed') ? 1 : 0;
