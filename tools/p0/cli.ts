import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ImplementedStage, TestLayer } from './contracts.js';
import { loadSelection } from './catalog.js';
import { checkRun, runStage } from './runner.js';
import { probeEnvironment } from './environment.js';
import { checkBoundaries } from './boundaries.js';

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!flag || !['--root', '--run', '--stage', '--layer', '--modules', '--reason'].includes(flag) || !value || value.startsWith('--') || options[flag] !== undefined) throw new Error('Invalid or duplicate arguments');
    options[flag] = value;
  }
  const allowed: Record<string, string[]> = {
    run: ['--root', '--stage', '--layer', '--modules', '--reason'], check: ['--root', '--run'], doctor: ['--root'], boundaries: ['--root'],
  };
  if (!command || !allowed[command] || Object.keys(options).some(key => !allowed[command]!.includes(key))) throw new Error('Usage: cli.js run [--stage P0|P1|P2|P3] [--layer unit|integration|live] [--modules module,tag] [--reason text], check --run path, doctor, boundaries');
  const root = resolve(options['--root'] ?? process.cwd());
  if (command === 'doctor') {
    const report = await probeEnvironment(root);
    const dir = join(root, '.supervisor-dev', 'environment');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${randomUUID()}.json`);
    await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    for (const item of [...report.checks, ...report.capabilities]) console.log(`${item.status.padEnd(10)} ${item.id}: ${item.detail}`);
    console.log(`Environment report: ${path}`);
    // Installing a tool or checking a local login is not a live API/target-platform acceptance.
    if (report.checks.some(c => ['node', 'project.read', 'project.write', 'project.search'].includes(c.id) && c.status !== 'available')) process.exitCode = 1;
    return;
  }
  if (command === 'boundaries') {
    const issues = await checkBoundaries(root);
    console.log(issues.length ? issues.join('\n') : 'Module boundaries: PASS');
    process.exitCode = issues.length ? 1 : 0;
    return;
  }
  if (command === 'check') {
    if (!options['--run']) throw new Error('check requires --run');
    const dir = resolve(options['--run']);
    const result = await checkRun(root, dir);
    const checks = join(dir, 'checks');
    await mkdir(checks, { recursive: true });
    await writeFile(join(checks, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
    return;
  }
  if (options['--stage'] && !['P0', 'P1', 'P2', 'P3'].includes(options['--stage'])) throw new Error('Only P0, P1, P2 and P3 are supported; later stages are NOT PASSED');
  if (options['--layer'] && !['unit', 'integration', 'live'].includes(options['--layer'])) throw new Error('Invalid test layer');
  const layer = options['--layer'] as TestLayer | undefined;
  const stage = (options['--stage'] ?? 'P3') as ImplementedStage;
  const modules = options['--modules']?.split(',').map(value => value.trim());
  const plan = await loadSelection(root, stage, { ...(layer ? { layer } : {}), ...(modules ? { modules } : {}) });
  const { dir, result } = await runStage(root, plan.manifest, { selection: plan.selection, reason: options['--reason'] ?? 'Explicit developer invocation; no automatic retries' });
  console.log(`${result.scope} automated checks: ${result.passed ? 'PASS' : 'FAIL'}`);
  for (const suite of result.suites) console.log(`${suite.passed ? 'PASS' : 'FAIL'} ${suite.id}: ${suite.tests.length} tests${suite.issues.length ? '; ' + suite.issues.join('; ') : ''}`);
  for (const issue of result.issues) console.error(issue);
  console.log(`Evidence: ${dir}\nReport: ${join(dir, 'summary.html')}`);
  process.exitCode = result.passed ? 0 : 1;
}

main().catch(error => { console.error(`NOT PASSED: ${(error as Error).message}`); process.exitCode = 1; });
