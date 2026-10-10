export type TestLayer = 'unit' | 'integration' | 'live';
export type ImplementedStage = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8';

export interface SuiteSpec {
  id: string;
  layer: TestLayer;
  file: string;
  required: true;
  expectedTests: string[];
  timeoutMs: number;
}

export interface StageManifest {
  schemaVersion: 1;
  stage: ImplementedStage;
  revision: string;
  suites: SuiteSpec[];
}

export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'todo';
  durationMs: number;
  message?: string;
}

export interface TestReport {
  schemaVersion: 1;
  runId: string;
  suiteId: string;
  complete: boolean;
  tests: TestResult[];
  summary: {
    tests: number;
    passed: number;
    failed: number;
    cancelled: number;
    skipped: number;
    todo: number;
  };
}

export interface SuiteEvaluation {
  passed: boolean;
  issues: string[];
  tests: TestResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function manifestError(path: string, detail: string): never {
  throw new Error(`Invalid stage manifest: ${path} ${detail}`);
}

export function parseManifest(value: unknown): StageManifest {
  if (!isRecord(value)) manifestError('manifest', 'must be an object');
  if (value.schemaVersion !== 1) manifestError('schemaVersion', 'must equal 1');
  if (value.stage !== 'P0' && value.stage !== 'P1' && value.stage !== 'P2' && value.stage !== 'P3' && value.stage !== 'P4' && value.stage !== 'P5' && value.stage !== 'P6' && value.stage !== 'P7' && value.stage !== 'P8') manifestError('stage', 'must equal P0, P1, P2, P3, P4, P5, P6, P7 or P8');
  if (!nonemptyString(value.revision) || /\s/.test(value.revision)) {
    manifestError('revision', 'must be a nonempty string without whitespace');
  }
  if (!Array.isArray(value.suites) || value.suites.length === 0) {
    manifestError('suites', 'must be a nonempty array');
  }
  const ids = new Set<string>();
  const suites: SuiteSpec[] = Array.from(value.suites).map((entry: unknown, index: number) => {
    const path = `suites[${index}]`;
    if (!isRecord(entry)) manifestError(path, 'must be an object');
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.id)) {
      manifestError(`${path}.id`, 'must match /^[a-z][a-z0-9-]*$/');
    }
    if (ids.has(entry.id)) manifestError(`${path}.id`, `duplicates suite id ${entry.id}`);
    ids.add(entry.id);
    if (entry.layer !== 'unit' && entry.layer !== 'integration' && entry.layer !== 'live') {
      manifestError(`${path}.layer`, 'must equal unit, integration or live');
    }
    // Only local, unencoded paths are allowed; the runner also verifies realpath.
    if (typeof entry.file !== 'string'
      || !/^dist\/tests\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/.test(entry.file)
      || entry.file.includes('..')) {
      manifestError(`${path}.file`, 'must be a relative dist/tests/*.js path without traversal, URLs, encoding, or backslashes');
    }
    if (entry.required !== true) manifestError(`${path}.required`, 'must equal true');
    if (!Array.isArray(entry.expectedTests) || entry.expectedTests.length === 0) {
      manifestError(`${path}.expectedTests`, 'must be a nonempty array');
    }
    const names = new Set<string>();
    const expectedTests = Array.from(entry.expectedTests).map((name: unknown, testIndex: number) => {
      if (!nonemptyString(name)) {
        manifestError(`${path}.expectedTests[${testIndex}]`, 'must be a nonempty string');
      }
      if (names.has(name)) {
        manifestError(`${path}.expectedTests[${testIndex}]`, `duplicates test name ${name}`);
      }
      names.add(name);
      return name;
    });
    // Live tests may observe sequential real planning/execution/supervision limits
    // plus owned-process cleanup, within this 60-minute harness ceiling. This
    // changes no product budget/deadline; each frozen suite declares its timeout.
    const maxTimeoutMs = entry.layer === 'live' ? 3_600_000 : 300_000;
    if (typeof entry.timeoutMs !== 'number' || !Number.isInteger(entry.timeoutMs)
      || entry.timeoutMs < 1 || entry.timeoutMs > maxTimeoutMs) {
      manifestError(`${path}.timeoutMs`, `must be an integer between 1 and ${maxTimeoutMs}`);
    }
    return {
      id: entry.id,
      layer: entry.layer,
      file: entry.file,
      required: true,
      expectedTests,
      timeoutMs: entry.timeoutMs,
    };
  });
  return { schemaVersion: 1, stage: value.stage, revision: value.revision, suites };
}

export function evaluateSuite(
  spec: SuiteSpec,
  report: unknown,
  execution: { runId: string; exitCode: number | null; signal: string | null; timedOut: boolean },
): SuiteEvaluation {
  const issues: string[] = [];
  const tests: TestResult[] = [];
  if (execution.exitCode !== 0) issues.push(`Execution exitCode must be 0; received ${execution.exitCode}`);
  if (execution.signal !== null) issues.push(`Execution terminated with signal ${execution.signal}`);
  if (execution.timedOut) issues.push('Execution timed out');
  if (!isRecord(report)) {
    issues.push('Report is missing or malformed: expected an object');
    return { passed: false, issues, tests };
  }
  // Malformed objects, including throwing accessors, fail the gate instead of crashing it.
  try {
    if (report.schemaVersion !== 1) issues.push('Report schemaVersion must equal 1');
    if (!nonemptyString(report.runId) || report.runId !== execution.runId) issues.push('Report runId does not match this execution');
    if (report.suiteId !== spec.id) issues.push(`Report suiteId does not match ${spec.id}`);
    if (report.complete !== true) issues.push('Report complete must equal true');
    if (!Array.isArray(report.tests)) {
      issues.push('Report tests must be an array');
      return { passed: false, issues, tests };
    }
    if (report.tests.length === 0) issues.push('Report contains zero tests');
    const actualNames = new Set<string>();
    const expectedNames = new Set(spec.expectedTests);
    const counts = { tests: report.tests.length, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
    Array.from(report.tests).forEach((entry: unknown, index: number) => {
      const path = `Report tests[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${path} must be an object`);
        return;
      }
      let valid = true;
      if (!nonemptyString(entry.name)) {
        issues.push(`${path}.name must be a nonempty string`);
        valid = false;
      } else {
        if (actualNames.has(entry.name)) issues.push(`${path} duplicates test name ${entry.name}`);
        actualNames.add(entry.name);
        if (!expectedNames.has(entry.name)) issues.push(`${path} has unexpected test name ${entry.name}`);
      }
      const status = entry.status;
      if (status !== 'passed' && status !== 'failed' && status !== 'skipped' && status !== 'todo') {
        issues.push(`${path}.status is invalid`);
        valid = false;
      } else {
        counts[status] += 1;
        if (status !== 'passed') issues.push(`${path} did not pass: ${status}`);
      }
      if (typeof entry.durationMs !== 'number' || !Number.isFinite(entry.durationMs) || entry.durationMs < 0) {
        issues.push(`${path}.durationMs must be a finite nonnegative number`);
        valid = false;
      }
      if (entry.message !== undefined && typeof entry.message !== 'string') {
        issues.push(`${path}.message must be a string when present`);
        valid = false;
      }
      if (valid) {
        const result: TestResult = {
          name: entry.name as string,
          status: status as TestResult['status'],
          durationMs: entry.durationMs as number,
        };
        if (entry.message !== undefined) result.message = entry.message as string;
        tests.push(result);
      }
    });
    for (const name of expectedNames) {
      if (!actualNames.has(name)) issues.push(`Report is missing expected test ${name}`);
    }
    if (spec.expectedTests.length === 0) issues.push('Suite has zero expected tests');
    if (!isRecord(report.summary)) {
      issues.push('Report summary must be an object');
    } else {
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
        const value = report.summary[key];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          issues.push(`Report summary.${key} must be a nonnegative integer`);
        } else if (value !== counts[key]) {
          issues.push(`Report summary.${key} does not match actual tests: expected ${counts[key]}, received ${value}`);
        }
      }
    }
  } catch (error) {
    issues.push(`Report is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { passed: issues.length === 0, issues, tests };
}
