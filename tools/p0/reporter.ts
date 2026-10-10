import type { TestReport, TestResult } from './contracts.js';

// Runs in Node's reporter process, independently of the tested module.
export default async function* reporter(source: AsyncIterable<{ type: string; data: Record<string, any> }>) {
  const tests: TestResult[] = [];
  let summary: TestReport['summary'] = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
  let completed = 0;
  for await (const event of source) {
    const d = event.data;
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      tests.push({
        name: d.name,
        status: d.skip ? 'skipped' : d.todo ? 'todo' : event.type === 'test:pass' ? 'passed' : 'failed',
        durationMs: d.details?.duration_ms,
        ...(d.details?.error ? { message: String(d.details.error.stack ?? d.details.error.message ?? d.details.error) } : {}),
      });
    }
    if (event.type === 'test:summary' && !d.file) {
      completed++;
      summary = d.counts;
    }
  }
  yield JSON.stringify({
    schemaVersion: 1,
    runId: process.env.SUPERVISOR_VERIFY_RUN_ID ?? '',
    suiteId: process.env.SUPERVISOR_VERIFY_SUITE_ID ?? '',
    complete: completed === 1,
    tests,
    summary,
  } satisfies TestReport) + '\n';
}
