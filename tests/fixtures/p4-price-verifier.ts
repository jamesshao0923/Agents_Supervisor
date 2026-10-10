import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const candidate = process.argv[2]!;
const parameters = JSON.parse(process.argv[3]!) as { amount: string; percent: string; expected: string };
const module = await import(pathToFileURL(join(candidate, 'build/price.js')).href) as { discountedPrice(amount: unknown, percent: unknown): number };
const checks: { obligationId: string; verdict: 'passed' | 'failed'; reason: string }[] = [];
for (const [obligationId, check] of [
  ['normal', () => {
    assert.equal(module.discountedPrice(Number(parameters.amount), Number(parameters.percent)), Number(parameters.expected));
    // Preserve the full inclusive numeric domain, including legal zero amounts.
    assert.ok(module.discountedPrice(-0, 25) === 0, 'Legal negative zero must be accepted without requiring a particular zero sign');
    for (const [amount, percent, expected] of [[0, 0, 0], [0, 25, 0], [0, 100, 0], [200, -0, 200], [200, 0, 200], [200, 100, 0], [0.5, 50, 0.25], [Number.MIN_VALUE, 0, Number.MIN_VALUE], [Number.MAX_VALUE, 0, Number.MAX_VALUE]] as const) {
      assert.equal(module.discountedPrice(amount, percent), expected, 'Legal finite boundary must be accepted');
    }
  }],
  ['invalid', () => {
    for (const [amount, percent] of [[-1, 5], [-Number.MIN_VALUE, 5], [1, -1], [1, -Number.MIN_VALUE], [1, 101], [1, 100 + Number.EPSILON * 128]] as const) assert.throws(() => module.discountedPrice(amount, percent), RangeError);
    // The function accepts finite numbers themselves, never coercible nonnumbers.
    for (const value of [NaN, Infinity, -Infinity, '1', '', undefined, null, true, false, [], {}, new Number(1), 1n, Symbol('not-number')]) {
      assert.throws(() => module.discountedPrice(value, 5), RangeError, 'Invalid amount must raise RangeError');
      assert.throws(() => module.discountedPrice(1, value), RangeError, 'Invalid percentage must raise RangeError');
    }
  }],
] as const) {
  try { check(); checks.push({ obligationId, verdict: 'passed', reason: 'Actual price assertion passed for parameters ' + JSON.stringify(parameters) }); }
  catch (error) { checks.push({ obligationId, verdict: 'failed', reason: 'Actual price assertion failed: ' + String(error) }); }
}
await writeFile(process.env.SUPERVISOR_VERIFY_REPORT!, JSON.stringify({ schemaVersion: 1, checks }));
process.exitCode = checks.some(check => check.verdict === 'failed') ? 1 : 0;
