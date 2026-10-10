import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateSuite, parseManifest, type StageManifest, type SuiteSpec, type TestReport } from '../../tools/p0/contracts.js';

const spec: SuiteSpec = {
  id: 'contracts-unit', layer: 'unit', file: 'dist/tests/unit/contracts.test.js',
  required: true, expectedTests: ['first behavior', 'second behavior'], timeoutMs: 1000,
};
const execution: Parameters<typeof evaluateSuite>[2] = { runId: 'run-current', exitCode: 0, signal: null, timedOut: false };

function manifest(): StageManifest {
  return { schemaVersion: 1, stage: 'P0', revision: 'p0-v1', suites: [{ ...spec, expectedTests: [...spec.expectedTests] }] };
}

function report(): TestReport {
  return {
    schemaVersion: 1, runId: execution.runId, suiteId: spec.id, complete: true,
    tests: spec.expectedTests.map((name) => ({ name, status: 'passed', durationMs: 0.25 })),
    summary: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
  };
}

function fails(value: unknown, pattern: RegExp, run = execution): void {
  const result = evaluateSuite(spec, value, run);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => pattern.test(issue)), result.issues.join('\n'));
}

test('manifest accepts valid required suites and returns an independent copy', () => {
  const input = manifest();
  const parsed = parseManifest(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed.suites, input.suites);
  assert.notEqual(parsed.suites[0]?.expectedTests, input.suites[0]?.expectedTests);
});

test('manifest accepts both layers and inclusive timeout limits', () => {
  const value = manifest();
  value.suites[0]!.timeoutMs = 1;
  value.suites.push({ ...spec, id: 'integration-suite', layer: 'integration', timeoutMs: 300_000 });
  assert.equal(parseManifest(value).suites.length, 2);
  const live = parseManifest({ ...value, stage: 'P2', suites: [{ ...spec, id: 'live-suite', layer: 'live', file: 'dist/tests/live/execution.test.js', timeoutMs: 600_000 }] });
  assert.equal(live.stage, 'P2'); assert.equal(live.suites[0]!.layer, 'live');
});

test('manifest rejects nonobject inputs and serialized JSON', () => {
  for (const input of [null, undefined, [], 1, JSON.stringify(manifest())]) {
    assert.throws(() => parseManifest(input), /manifest must be an object/);
  }
});

test('manifest rejects invalid schema stage and revision', () => {
  for (const schemaVersion of [undefined, 0, 2, '1']) {
    assert.throws(() => parseManifest({ ...manifest(), schemaVersion }), /schemaVersion/);
  }
  assert.throws(() => parseManifest({ ...manifest(), stage: 'P3' }), /stage/);
  for (const revision of ['', ' ', 'with space', '\nHEAD', 1, null]) {
    assert.throws(() => parseManifest({ ...manifest(), revision }), /revision/);
  }
});

test('manifest rejects missing empty and malformed suites', () => {
  for (const suites of [undefined, [], {}, [null]]) {
    assert.throws(() => parseManifest({ ...manifest(), suites }), /suites/);
  }
});

test('manifest rejects unsafe and duplicate suite identifiers', () => {
  for (const id of ['', ' ', '../other', 'UPPER', 'with_space', '1first', null]) {
    assert.throws(() => parseManifest({ ...manifest(), suites: [{ ...spec, id }] }), /\.id/);
  }
  assert.throws(() => parseManifest({ ...manifest(), suites: [spec, spec] }), /duplicates suite id/);
});

test('manifest rejects invalid layer and optional suites', () => {
  for (const layer of ['system', '', null, undefined]) {
    assert.throws(() => parseManifest({ ...manifest(), suites: [{ ...spec, layer }] }), /\.layer/);
  }
  for (const required of [false, undefined, 1, 'true']) {
    assert.throws(() => parseManifest({ ...manifest(), suites: [{ ...spec, required }] }), /\.required/);
  }
});

test('manifest rejects escaping absolute encoded and nonjavascript paths', () => {
  const files = [
    '/dist/tests/test.js', 'C:/dist/tests/test.js', 'dist/tests/../test.js',
    'dist/tests/unit/../../test.js', 'dist\\tests\\test.js', 'tests/test.js',
    'dist/tests/test.ts', 'dist/tests/.js', 'dist/tests//test.js', 'dist/tests/./test.js',
    'https://example.com/dist/tests/test.js', 'dist/tests/%2e%2e/test.js',
    'dist/tests/%2ftest.js', 'dist/tests/test.js?query.js', 'dist/tests/test\u0000.js',
  ];
  for (const file of files) {
    assert.throws(() => parseManifest({ ...manifest(), suites: [{ ...spec, file }] }), /\.file/, file);
  }
});

test('manifest rejects empty malformed and duplicate expected names', () => {
  for (const expectedTests of [[], undefined, 'test', [''], [' '], [null], ['same', 'same']]) {
    assert.throws(() => parseManifest({ ...manifest(), suites: [{ ...spec, expectedTests }] }), /expectedTests/);
  }
});

test('manifest permits the same expected name across different suites', () => {
  assert.equal(parseManifest({ ...manifest(), suites: [spec, { ...spec, id: 'other-suite' }] }).suites.length, 2);
});

test('manifest rejects noninteger nonfinite and out of range timeouts', () => {
  for (const timeoutMs of [0, -1, 300_001, 1.5, Number.NaN, Infinity, '1000', undefined]) {
    assert.throws(() => parseManifest({ ...manifest(), suites: [{ ...spec, timeoutMs }] }), /timeoutMs/);
  }
  assert.throws(() => parseManifest({ ...manifest(), stage: 'P2', suites: [{ ...spec, layer: 'live', timeoutMs: 600_001 }] }), /timeoutMs/);
});

test('manifest rejects sparse suite and expected name arrays', () => {
  assert.throws(() => parseManifest({ ...manifest(), suites: new Array(1) }), /must be an object/);
  assert.throws(() => parseManifest({ ...manifest(), suites: [{ ...spec, expectedTests: new Array(1) }] }), /must be a nonempty string/);
});

test('suite accepts only a complete matching successful report', () => {
  const input = report();
  const result = evaluateSuite(spec, input, execution);
  assert.deepEqual(result, { passed: true, issues: [], tests: input.tests });
  assert.notEqual(result.tests[0], input.tests[0]);
});

test('suite matches expected names regardless of result ordering', () => {
  const value = report();
  value.tests.reverse();
  assert.equal(evaluateSuite(spec, value, execution).passed, true);
});

test('suite rejects missing malformed and serialized reports without throwing', () => {
  for (const value of [undefined, null, [], 'broken JSON', JSON.stringify(report()), 0, false]) {
    fails(value, /missing or malformed/);
  }
});

test('suite rejects unsupported report schemas', () => {
  for (const schemaVersion of [undefined, 2, '1']) fails({ ...report(), schemaVersion }, /schemaVersion/);
});

test('suite rejects stale missing and invalid run identifiers', () => {
  for (const runId of ['old-run', '', undefined, 1]) fails({ ...report(), runId }, /runId/);
});

test('suite rejects reports from another suite', () => {
  for (const suiteId of ['other-suite', undefined, 1]) fails({ ...report(), suiteId }, /suiteId/);
});

test('suite rejects incomplete and truthy nonboolean completion', () => {
  for (const complete of [false, undefined, 1, 'true']) fails({ ...report(), complete }, /complete/);
});

test('suite rejects absent malformed and zero actual tests', () => {
  for (const tests of [undefined, {}, 'tests']) fails({ ...report(), tests }, /tests must be an array/);
  fails({ ...report(), tests: [], summary: { ...report().summary, tests: 0, passed: 0 } }, /zero tests/);
});

test('suite never passes a spec with zero expected tests', () => {
  const value = report();
  value.tests = [];
  value.summary.tests = 0;
  value.summary.passed = 0;
  assert.equal(evaluateSuite({ ...spec, expectedTests: [] }, value, execution).passed, false);
});

test('suite rejects missing duplicate and extra actual test names', () => {
  const missing = report();
  missing.tests.pop();
  missing.summary.tests = 1;
  missing.summary.passed = 1;
  fails(missing, /missing expected test/);
  const duplicate = report();
  duplicate.tests[1]!.name = duplicate.tests[0]!.name;
  fails(duplicate, /duplicates test name/);
  const extra = report();
  extra.tests.push({ name: 'unexpected behavior', status: 'passed', durationMs: 0 });
  extra.summary.tests = 3;
  extra.summary.passed = 3;
  fails(extra, /unexpected test name/);
});

test('suite rejects failed skipped and todo tests despite reconciled summaries', () => {
  for (const status of ['failed', 'skipped', 'todo'] as const) {
    const value = report();
    value.tests[0]!.status = status;
    value.summary.passed = 1;
    value.summary[status] = 1;
    fails(value, new RegExp(`did not pass: ${status}`));
  }
});

test('suite rejects unknown statuses and malformed test objects', () => {
  fails({ ...report(), tests: [null, report().tests[1]] }, /must be an object/);
  for (const status of [undefined, 'cancelled', 'PASS', true]) {
    fails({ ...report(), tests: [{ ...report().tests[0], status }, report().tests[1]] }, /status is invalid/);
  }
  for (const name of [undefined, '', ' ', 2]) {
    fails({ ...report(), tests: [{ ...report().tests[0], name }, report().tests[1]] }, /name must be a nonempty string/);
  }
});

test('suite rejects negative nonfinite and nonnumeric durations', () => {
  for (const durationMs of [-1, Number.NaN, Infinity, -Infinity, '0', undefined]) {
    fails({ ...report(), tests: [{ ...report().tests[0], durationMs }, report().tests[1]] }, /durationMs/);
  }
  const value = report();
  value.tests[0]!.durationMs = 0;
  assert.equal(evaluateSuite(spec, value, execution).passed, true);
});

test('suite validates optional diagnostic messages', () => {
  const value = report();
  value.tests[0]!.message = 'diagnostic';
  assert.equal(evaluateSuite(spec, value, execution).passed, true);
  fails({ ...value, tests: [{ ...value.tests[0], message: null }, value.tests[1]] }, /message/);
});

test('suite rejects missing malformed and unreconciled summary totals', () => {
  for (const summary of [undefined, null, [], 'summary']) fails({ ...report(), summary }, /summary must be an object/);
  for (const key of ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'] as const) {
    const value = report();
    value.summary[key] += 1;
    fails(value, new RegExp(`summary\\.${key} does not match`));
  }
});

test('suite rejects noninteger negative missing and nonfinite summary fields', () => {
  for (const key of ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'] as const) {
    for (const count of [undefined, -1, 0.5, Number.NaN, Infinity, '0']) {
      fails({ ...report(), summary: { ...report().summary, [key]: count } }, new RegExp(`summary\\.${key} must be`));
    }
  }
});

test('suite rejects nonzero and absent execution exit codes', () => {
  for (const exitCode of [1, -1, null]) fails(report(), /exitCode/, { ...execution, exitCode });
});

test('suite rejects signalled and timed out executions', () => {
  fails(report(), /signal/, { ...execution, signal: 'SIGTERM' });
  fails(report(), /timed out/, { ...execution, timedOut: true });
});

test('suite retains execution failures when the report is missing', () => {
  const result = evaluateSuite(spec, null, { ...execution, exitCode: 1, signal: 'SIGKILL', timedOut: true });
  assert.equal(result.passed, false);
  assert.equal(result.issues.length, 4);
});

test('suite rejects throwing report accessors without propagating errors', () => {
  const value = { get schemaVersion(): number { throw new Error('unreadable schema'); } };
  fails(value, /malformed.*unreadable schema/);
});

test('suite rejects sparse actual test arrays', () => {
  const tests = new Array(2);
  tests[0] = report().tests[0];
  const result = evaluateSuite({ ...spec, expectedTests: ['first behavior'] }, {
    ...report(), tests, summary: { ...report().summary, passed: 1 },
  }, execution);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => /tests\[1\] must be an object/.test(issue)));
});
