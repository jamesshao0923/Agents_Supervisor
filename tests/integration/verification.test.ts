import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { assertCandidate, captureCandidate, digest, type Candidate } from '../../packages/verification/candidate.js';
import { runCandidateEntry, runCommandVerifier } from '../../packages/verification/command.js';
import { runCandidateBuild } from '../../packages/verification/build.js';
import { executeInstances } from '../../packages/verification/engine.js';
import type { VerificationSpec } from '../../packages/contracts/p4.js';
import type { DefinitionBundle, VerificationJob } from '../../packages/verification/records.js';
import { inspectProcess, type ProcessIdentity, type ProcessResult } from '../../packages/process-control/index.js';

const execute = promisify(execFile), compiler = resolve('node_modules/typescript/bin/tsc');
const correctSource = 'export function discountedPrice(amount: number, percent: number): number { if(!Number.isFinite(amount)||!Number.isFinite(percent)||amount<0||percent<0||percent>100)throw new RangeError("Invalid discount input"); return amount*(1-percent/100); }\n';
const wrongFormula = correctSource.replace('amount*(1-percent/100)', 'amount*percent');
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sv-p4-')), workspace = join(directory, 'project'), bundle = join(directory, 'verifiers'); await mkdir(workspace); await mkdir(bundle);
  await writeFile(join(workspace, 'package.json'), '{"type":"module"}\n'); await mkdir(join(workspace, 'src'));
  await copyFile(fileURLToPath(new URL('../fixtures/p4-price-verifier.js', import.meta.url)), join(bundle, 'price.mjs'));
  await copyFile(fileURLToPath(new URL('../fixtures/p4-process-verifier.js', import.meta.url)), join(bundle, 'process.mjs'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function build(source = correctSource) {
    await writeFile(join(workspace, 'src/price.ts'), source);
    await execute(process.execPath, [compiler, 'src/price.ts', '--target', 'es2022', '--module', 'nodenext', '--strict', '--outDir', 'build', '--types', 'node', '--typeRoots', resolve('node_modules/@types')], { cwd: workspace, timeout: 15_000 });
  }
  async function run(candidate: Candidate, parameters: Record<string, string>, name: string, entry = 'price.mjs', obligationIds = ['normal', 'invalid'], timeoutMs = 5000) {
    return runCommandVerifier({ id: name, bundle, entry, cwd: candidate.tree, parameters, obligationIds, timeoutMs, output: join(directory, name) });
  }
  return { directory, workspace: await realpath(workspace), bundle, build, run };
}

test('verification fixed candidate includes source build binary and lock bytes and detects live or frozen changes', async t => {
  const f = await fixture(t); await f.build(); await writeFile(join(f.workspace, 'app.bin'), Buffer.from([0, 1, 2, 255])); await chmod(join(f.workspace, 'app.bin'), 0o644); await writeFile(join(f.workspace, '__proto__'), 'actual filename, not an inherited object property\n'); await writeFile(join(f.workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'); await mkdir(join(f.workspace, 'node_modules')); await writeFile(join(f.workspace, 'node_modules/installed.txt'), 'explicit excluded dependencies');
  const candidate = await captureCandidate(f.workspace, join(f.directory, 'snapshot')); await assertCandidate(candidate);
  for (const name of ['src/price.ts', 'build/price.js', 'app.bin', '__proto__', 'pnpm-lock.yaml', 'package.json']) assert.ok(Object.hasOwn(candidate.files, name) && typeof candidate.files[name] === 'string', name); assert.equal(candidate.files['node_modules/installed.txt'], undefined); assert.ok(candidate.excluded.includes('node_modules'));
  await writeFile(join(f.workspace, '__proto__'), 'changed filename bytes\n'); await assert.rejects(assertCandidate(candidate), /workspace differs/); await writeFile(join(f.workspace, '__proto__'), 'actual filename, not an inherited object property\n');
  await chmod(join(f.workspace, 'app.bin'), 0o755); await assert.rejects(assertCandidate(candidate), /workspace differs/); await assertCandidate(candidate, false); await chmod(join(f.workspace, 'app.bin'), 0o644); await assertCandidate(candidate);
  await writeFile(join(f.workspace, 'src/price.ts'), wrongFormula); await assert.rejects(assertCandidate(candidate), /workspace differs/); await assertCandidate(candidate, false); assert.equal(await readFile(join(candidate.tree, 'src/price.ts'), 'utf8'), correctSource);
  await writeFile(join(f.workspace, 'src/price.ts'), correctSource); await writeFile(join(f.workspace, 'app.bin'), Buffer.from([0, 1, 2, 254])); await assert.rejects(assertCandidate(candidate), /workspace differs/); await assertCandidate(candidate, false);
  await writeFile(join(f.workspace, 'app.bin'), Buffer.from([0, 1, 2, 255])); await writeFile(join(f.workspace, 'build/price.js'), 'changed built program\n'); await assert.rejects(assertCandidate(candidate), /workspace differs/);
  await writeFile(join(candidate.tree, 'app.bin'), Buffer.from([99])); await assert.rejects(assertCandidate(candidate, false), /snapshot is invalid/);
});

test('verification snapshot refuses symlink deliverables and existing frozen destinations without modifying original bytes', async t => {
  const f = await fixture(t); await f.build(); const outside = join(f.directory, 'outside.txt'); await writeFile(outside, 'external bytes'); await symlink(outside, join(f.workspace, 'linked-source')); await assert.rejects(captureCandidate(f.workspace, join(f.directory, 'with-link')), /symlink/); await rm(join(f.workspace, 'linked-source'));
  const destination = join(f.directory, 'fixed'), candidate = await captureCandidate(f.workspace, destination); const original = await readFile(join(candidate.tree, 'src/price.ts'));
  await f.build(wrongFormula); await assert.rejects(captureCandidate(f.workspace, destination)); assert.deepEqual(await readFile(join(candidate.tree, 'src/price.ts')), original, 'A refused recapture must not rewrite a previously frozen candidate'); await assertCandidate(candidate, false);
  await assert.rejects(captureCandidate(f.workspace, join(f.workspace, 'nested-snapshot')), /outside the candidate/);
});

test('verification actual independent build assertions pass correct program and reject the known formula and illegal-input defects', async t => {
  const f = await fixture(t); const parameters = { amount: '200', percent: '25', expected: '150' }; await f.build(); const good = await captureCandidate(f.workspace, join(f.directory, 'good')); const passed = await f.run(good, parameters, 'good-report');
  assert.equal(passed.executionStatus, 'executed'); assert.equal(passed.stopped, true); assert.deepEqual(passed.checks.map(c => c.verdict), ['passed', 'passed']); await assertCandidate(good);
  async function verifyBuild(candidate: Candidate, name: string) {
    const output = join(f.directory, name), result = await runCandidateBuild({ id: name, candidateTree: candidate.tree, build: { kind: 'typescript', sources: ['src/price.ts'], rootDir: 'src', outputDir: 'build', timeoutMs: 15_000 }, output });
    assert.equal(result.executionStatus, 'executed', result.reason); assert.equal(result.stopped, true, result.reason); assert.ok(result.proofFiles.some(path => path.endsWith('manifest.json')));
    const process = JSON.parse(await readFile(join(output, 'process.json'), 'utf8')) as ProcessResult; assert.equal(process.reason, 'completed'); assert.equal(process.stopped, true); assert.equal((await inspectProcess(process.identity)).status, 'stopped'); await assertCandidate(candidate, false);
    return result;
  }
  const rebuiltGood = await verifyBuild(good, 'source-build-good'); assert.equal(rebuiltGood.passed, true, rebuiltGood.reason);
  // A correct old binary still passes behavioral assertions when the source
  // differs. Rebuilding must detect that mismatch instead of accepting it.
  await writeFile(join(f.workspace, 'src/price.ts'), wrongFormula); const staleBinary = await captureCandidate(f.workspace, join(f.directory, 'stale-binary'));
  const staleChecks = await f.run(staleBinary, parameters, 'stale-binary-report'); assert.equal(staleChecks.executionStatus, 'executed'); assert.ok(staleChecks.checks.every(check => check.verdict === 'passed'));
  const staleBuild = await verifyBuild(staleBinary, 'source-build-stale'); assert.equal(staleBuild.passed, false, 'Wrong source cannot be delivered with an unrelated correct old binary');
  const staleManifest = JSON.parse(await readFile(join(f.directory, 'source-build-stale/manifest.json'), 'utf8')) as { differences: { changed: string[] } }; assert.deepEqual(staleManifest.differences.changed, ['price.js']);
  await f.build(); await writeFile(join(f.workspace, 'build/price.js'), (await readFile(join(f.workspace, 'build/price.js'), 'utf8')) + '// altered deliverable bytes\n'); const changedBinary = await captureCandidate(f.workspace, join(f.directory, 'changed-binary'));
  assert.equal((await verifyBuild(changedBinary, 'source-build-changed-binary')).passed, false, 'Even a behaviorally equivalent altered binary must match the actual source build');
  await f.build(); await writeFile(join(f.workspace, 'src/price.ts'), 'export function discountedPrice(amount:number,percent:number):number{return "not a number";}\n'); const invalidSource = await captureCandidate(f.workspace, join(f.directory, 'invalid-source'));
  const rejectedSource = await verifyBuild(invalidSource, 'source-build-invalid'); assert.equal(rejectedSource.passed, false); assert.match(rejectedSource.reason, /compiler rejected/); assert.match(await readFile(join(f.directory, 'source-build-invalid/stdout.log'), 'utf8'), /TS2322/);
  await f.build(wrongFormula); const bad = await captureCandidate(f.workspace, join(f.directory, 'bad')); const failed = await f.run(bad, parameters, 'bad-report'); assert.equal(failed.executionStatus, 'executed'); assert.equal(failed.checks.find(c => c.obligationId === 'normal')?.verdict, 'failed'); assert.equal(failed.checks.find(c => c.obligationId === 'invalid')?.verdict, 'passed'); await assertCandidate(bad);
  const originalBadBuild = await readFile(join(bad.tree, 'build/price.js')), rewrite = await f.run(bad, { mode: 'rewrite-candidate' }, 'rewrite-report', 'process.mjs', ['normal']); assert.equal(rewrite.executionStatus, 'verifier-error'); assert.equal(rewrite.stopped, true); assert.deepEqual(rewrite.checks, []); assert.match(await readFile(join(f.directory, 'rewrite-report/stderr.log'), 'utf8'), /ERR_ACCESS_DENIED/); assert.deepEqual(await readFile(join(bad.tree, 'build/price.js')), originalBadBuild, 'A checker cannot repair the faulty candidate and pass its modified copy'); await assertCandidate(bad);
  await f.build('export function discountedPrice(amount:number,percent:number):number{return amount*(1-percent/100);}\n'); const illegal = await captureCandidate(f.workspace, join(f.directory, 'illegal')); const fault = await f.run(illegal, parameters, 'illegal-report'); assert.equal(fault.executionStatus, 'executed'); assert.equal(fault.checks.find(c => c.obligationId === 'normal')?.verdict, 'passed'); assert.equal(fault.checks.find(c => c.obligationId === 'invalid')?.verdict, 'failed');
  // Preserve separate counterexamples: each implementation only accepts the
  // formerly omitted -Infinity input in one argument, and rejects all others.
  for (const argument of ['amount', 'percent'] as const) {
    await f.build(correctSource.replace(' { if(', ` { if(${argument}===-Infinity)return 0; if(`));
    const negativeInfinity = await captureCandidate(f.workspace, join(f.directory, 'negative-infinity-' + argument));
    const rejected = await f.run(negativeInfinity, parameters, 'negative-infinity-' + argument + '-report');
    assert.equal(rejected.executionStatus, 'executed', argument + ': ' + rejected.reason); assert.equal(rejected.stopped, true);
    assert.equal(rejected.checks.find(c => c.obligationId === 'normal')?.verdict, 'passed');
    assert.equal(rejected.checks.find(c => c.obligationId === 'invalid')?.verdict, 'failed', 'A checker must reject accepting -Infinity in ' + argument);
    await assertCandidate(negativeInfinity);
  }
  // Each real build preserves all invalid-input guards but wrongly excludes one legal boundary.
  for (const [name, source] of [
    ['amount-zero', correctSource.replace('amount<0', 'amount<=0')],
    ['percent-zero', correctSource.replace('percent<0', 'percent<=0')],
    ['percent-hundred', correctSource.replace('percent>100', 'percent>=100')],
  ] as const) {
    await f.build(source); const boundary = await captureCandidate(f.workspace, join(f.directory, name));
    const rejected = await f.run(boundary, parameters, name + '-report');
    assert.equal(rejected.executionStatus, 'executed', name + ': ' + rejected.reason); assert.equal(rejected.stopped, true);
    assert.equal(rejected.checks.find(c => c.obligationId === 'normal')?.verdict, 'failed', 'Legal inclusive boundary regression: ' + name);
    assert.equal(rejected.checks.find(c => c.obligationId === 'invalid')?.verdict, 'passed', 'This counterexample retains all invalid-input guards');
    await assertCandidate(boundary);
  }
  for (const argument of ['amount', 'percent'] as const) {
    await f.build(correctSource.replace(' { if(', ` { if(typeof ${argument}==='string')${argument}=Number(${argument}); if(`));
    const coercion = await captureCandidate(f.workspace, join(f.directory, 'string-coercion-' + argument));
    const rejected = await f.run(coercion, parameters, 'string-coercion-' + argument + '-report');
    assert.equal(rejected.executionStatus, 'executed', rejected.reason); assert.equal(rejected.stopped, true);
    assert.equal(rejected.checks.find(c => c.obligationId === 'normal')?.verdict, 'passed');
    assert.equal(rejected.checks.find(c => c.obligationId === 'invalid')?.verdict, 'failed', 'Nonnumber coercion must be rejected in ' + argument);
    await assertCandidate(coercion);
  }
  assert.equal(await readFile(join(good.tree, 'src/price.ts'), 'utf8'), correctSource); assert.ok(passed.proofFiles.some(path => path.endsWith('report.json'))); assert.ok(failed.proofFiles.some(path => path.endsWith('stderr.log')));
});

test('verification real crash missing report conflicting exit timeout and cancellation remain verifier errors with actual stopped process evidence', async t => {
  const f = await fixture(t); await f.build(); const candidate = await captureCandidate(f.workspace, join(f.directory, 'candidate'));
  for (const mode of ['crash', 'missing', 'passed-exit-one', 'failed-exit-zero', 'hang']) {
    const result = await f.run(candidate, { mode }, 'process-' + mode, 'process.mjs', ['normal'], mode === 'hang' ? 300 : 5000); assert.equal(result.executionStatus, 'verifier-error', mode + ': ' + result.reason); assert.equal(result.stopped, true); assert.deepEqual(result.checks, []); assert.ok(result.reason);
    const identity = JSON.parse(await readFile(join(f.directory, 'process-' + mode, 'identity.json'), 'utf8')) as ProcessIdentity; assert.equal((await inspectProcess(identity)).status, 'stopped', mode); assert.ok(result.proofFiles.some(path => path.endsWith('process.json')));
  }
  const unknown = await f.run(candidate, { mode: 'unknown-exit-one' }, 'unknown-report', 'process.mjs', ['normal']); assert.equal(unknown.executionStatus, 'executed'); assert.equal(unknown.checks[0]?.verdict, 'unknown');
  const unavailable = await f.run(candidate, {}, 'missing-entry', 'not-installed.mjs', ['normal']); assert.equal(unavailable.executionStatus, 'environment-blocked'); assert.equal(unavailable.stopped, true);
  for (const point of ['before-dispatch', 'after-intent', 'after-identity'] as const) {
    const cancellation = new AbortController(); if (point === 'before-dispatch') cancellation.abort();
    const output = join(f.directory, 'cancel-' + point), result = await runCommandVerifier({ id: 'cancel-' + point, bundle: f.bundle, entry: 'process.mjs', cwd: candidate.tree, parameters: { mode: 'effect' }, obligationIds: ['normal'], timeoutMs: 5000, output, signal: cancellation.signal,
      onIntent: () => { if (point === 'after-intent') cancellation.abort(); }, onIdentity: () => { if (point === 'after-identity') cancellation.abort(); } });
    assert.equal(result.executionStatus, 'verifier-error', point + ': ' + result.reason); assert.equal(result.stopped, true, point); assert.deepEqual(result.checks, []); assert.match(result.reason, /cancelled/);
    await assert.rejects(readFile(join(output, 'forbidden-effect')), { code: 'ENOENT' });
    if (point === 'after-identity') { const identity = JSON.parse(await readFile(join(output, 'identity.json'), 'utf8')) as ProcessIdentity; assert.equal((await inspectProcess(identity)).status, 'stopped'); }
    else assert.ok(result.proofFiles.some(path => path.endsWith('not-started.json')));
  }
  const cancellation = new AbortController(), output = join(f.directory, 'cancel-started');
  const running = runCommandVerifier({ id: 'cancel-started', bundle: f.bundle, entry: 'process.mjs', cwd: candidate.tree, parameters: { mode: 'cancel-effect' }, obligationIds: ['normal'], timeoutMs: 5000, output, signal: cancellation.signal });
  const end = Date.now() + 4000; let actualStarted = false;
  while (Date.now() < end) { try { actualStarted = (await readFile(join(output, 'verifier-started'), 'utf8')).includes('Actual target started'); if (actualStarted) break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } await delay(30); }
  cancellation.abort(); const cancelled = await running; assert.equal(actualStarted, true, cancelled.reason); assert.equal(cancelled.executionStatus, 'verifier-error'); assert.equal(cancelled.stopped, true); assert.deepEqual(cancelled.checks, []); await assert.rejects(readFile(join(output, 'forbidden-effect')), { code: 'ENOENT' });
  const stopped = JSON.parse(await readFile(join(output, 'identity.json'), 'utf8')) as ProcessIdentity; assert.equal((await inspectProcess(stopped)).status, 'stopped');
});

test('verification actual parameter instances execute independently and a later pass preserves the earlier failed report', async t => {
  const f = await fixture(t); await f.build(); const candidate = await captureCandidate(f.workspace, join(f.directory, 'candidate')); const inputs = [{ amount: '200', percent: '25', expected: '149' }, { amount: '80', percent: '0', expected: '80' }];
  const first = await f.run(candidate, inputs[0]!, 'parameter-one'), second = await f.run(candidate, inputs[1]!, 'parameter-two'); assert.equal(first.executionStatus, 'executed'); assert.equal(second.executionStatus, 'executed'); assert.equal(first.checks[0]?.verdict, 'failed'); assert.equal(second.checks[0]?.verdict, 'passed');
  const reportOne = JSON.parse(await readFile(join(f.directory, 'parameter-one/report.json'), 'utf8')) as { checks: { verdict: string; reason: string }[] }; const reportTwo = JSON.parse(await readFile(join(f.directory, 'parameter-two/report.json'), 'utf8')) as { checks: { verdict: string; reason: string }[] };
  assert.equal(reportOne.checks[0]?.verdict, 'failed'); assert.match(reportTwo.checks[0]!.reason, /"amount":"80"/); assert.notEqual(await readFile(join(f.directory, 'parameter-one/identity.json'), 'utf8'), await readFile(join(f.directory, 'parameter-two/identity.json'), 'utf8')); await assertCandidate(candidate);
  // A checker cannot substitute inspection or an unconditional passed report
  // for executing the declared candidate CLI entries.
  const scripts:Record<string,string>={
    'good.mjs':'import assert from "node:assert/strict"; assert.equal(process.env.SUPERVISOR_VERIFY_REPORT,undefined); assert.equal(process.env.SUPERVISOR_VERIFY_TYPESCRIPT_MODULE,undefined); console.log("actual candidate stdout"); console.error("actual candidate stderr");',
    'good-again.cjs':'console.log("actual second candidate");',
    'bad.cjs':'console.log("actual bad candidate"); process.exit(3);',
    'rewrite.mjs':'import {writeFileSync} from "node:fs"; writeFileSync(new URL("./good.mjs",import.meta.url),"changed");',
    'spawn.mjs':'import {spawnSync} from "node:child_process"; spawnSync(process.execPath,["-e","process.exit(0)"]);',
    'network.mjs':'import net from "node:net"; net.createServer().listen(0);',
    'dns.mjs':'import dns from "node:dns"; dns.lookup("example.org",()=>{});',
    'hang.mjs':'setInterval(()=>{},1000);',
  };
  for(const [name,source]of Object.entries(scripts))await writeFile(join(f.workspace,name),source);
  const entries=await captureCandidate(f.workspace,join(f.directory,'entry-candidate'));
  const evidenceAlias=join(f.directory,'candidate-evidence-alias');await symlink(entries.tree,evidenceAlias);
  for(const [id,output]of [['candidate-evidence-root',entries.tree],['candidate-evidence-symlink',evidenceAlias],['candidate-evidence-symlink-child',join(evidenceAlias,'forbidden-evidence-directory')]] as const){
    let rejectedIntents=0;const rejected=await runCandidateEntry({id,cwd:entries.tree,entry:'good.mjs',timeoutMs:5000,output,onIntent:()=>{rejectedIntents++;}});
    assert.equal(rejected.executionStatus,'verifier-error');assert.equal(rejected.stopped,true);assert.deepEqual(rejected.proofFiles,[]);assert.match(rejected.reason,/outside the candidate|inside the candidate/);assert.equal(rejectedIntents,0);await assertCandidate(entries);
    await assert.rejects(readFile(join(entries.tree,'not-started.json')),{code:'ENOENT'});await assert.rejects(realpath(join(entries.tree,'forbidden-evidence-directory')),{code:'ENOENT'});
  }
  const inheritedParser=process.env.SUPERVISOR_VERIFY_TYPESCRIPT_MODULE;process.env.SUPERVISOR_VERIFY_TYPESCRIPT_MODULE='candidate-must-not-inherit-parser';
  let good:Awaited<ReturnType<typeof runCandidateEntry>>;
  try { good=await runCandidateEntry({id:'direct-good',cwd:entries.tree,entry:'good.mjs',timeoutMs:5000,output:join(f.directory,'direct-good')}); }
  finally { if(inheritedParser===undefined)delete process.env.SUPERVISOR_VERIFY_TYPESCRIPT_MODULE;else process.env.SUPERVISOR_VERIFY_TYPESCRIPT_MODULE=inheritedParser; }
  assert.equal(good.executionStatus,'executed',good.reason);assert.equal(good.passed,true);assert.equal(good.stopped,true);assert.equal(good.exitCode,0);
  assert.match(await readFile(join(f.directory,'direct-good/stdout.log'),'utf8'),/actual candidate stdout/);assert.match(await readFile(join(f.directory,'direct-good/stderr.log'),'utf8'),/actual candidate stderr/);
  const config=JSON.parse(await readFile(join(f.directory,'direct-good/configuration.json'),'utf8')) as {entry:string;entryDigest:string;permissions:{write:string[]}};
  assert.equal(config.entry,'good.mjs');assert.equal(config.entryDigest,digest(await readFile(join(entries.tree,'good.mjs'))));assert.deepEqual(config.permissions.write,[]);
  for(const entry of ['bad.cjs','rewrite.mjs','spawn.mjs','network.mjs','dns.mjs']){
    const output=join(f.directory,'direct-'+entry),result=await runCandidateEntry({id:'direct-'+entry,cwd:entries.tree,entry,timeoutMs:5000,output});
    assert.equal(result.executionStatus,'executed',result.reason);assert.equal(result.passed,false);assert.equal(result.stopped,true);assert.notEqual(result.exitCode,0);
    const identity=JSON.parse(await readFile(join(output,'identity.json'),'utf8')) as ProcessIdentity;assert.equal((await inspectProcess(identity)).status,'stopped');await assertCandidate(entries);
  }
  const missing=await runCandidateEntry({id:'direct-missing',cwd:entries.tree,entry:'missing.mjs',timeoutMs:5000,output:join(f.directory,'direct-missing')});assert.equal(missing.executionStatus,'verifier-error');assert.equal(missing.passed,false);assert.ok(missing.proofFiles.some(p=>p.endsWith('not-started.json')));
  const timeout=await runCandidateEntry({id:'direct-timeout',cwd:entries.tree,entry:'hang.mjs',timeoutMs:300,output:join(f.directory,'direct-timeout')});assert.equal(timeout.executionStatus,'verifier-error');assert.equal(timeout.stopped,true);
  const cancelled=new AbortController();const cancel=await runCandidateEntry({id:'direct-cancel',cwd:entries.tree,entry:'good.mjs',timeoutMs:5000,output:join(f.directory,'direct-cancel'),signal:cancelled.signal,onIdentity:()=>cancelled.abort()});assert.equal(cancel.executionStatus,'verifier-error');assert.equal(cancel.stopped,true);assert.match(cancel.reason,/cancelled/);
  const checker=`import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const {default:ts}=await import(pathToFileURL(process.env.SUPERVISOR_VERIFY_TYPESCRIPT_MODULE).href);assert.equal(ts.version,'6.0.3');
const facts=[];for(const text of ["import/*comment*/'node:fs';","if(false)import /*comment*/ ('node:fs');","export/*comment*/{readFile}from/*comment*/'node:fs';"]){const source=ts.createSourceFile('scope.mjs',text,ts.ScriptTarget.ESNext,true,ts.ScriptKind.JS);assert.equal(source.parseDiagnostics.length,0);function walk(node){if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)facts.push({kind:ts.SyntaxKind[node.kind],decoded:node.moduleSpecifier.text});if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)facts.push({kind:'DynamicImport'});ts.forEachChild(node,walk);}walk(source);}
assert.deepEqual(facts,[{kind:'ImportDeclaration',decoded:'node:fs'},{kind:'DynamicImport'},{kind:'ExportDeclaration',decoded:'node:fs'}]);
writeFileSync(process.env.SUPERVISOR_VERIFY_REPORT,JSON.stringify({schemaVersion:1,checks:[{obligationId:'entry',verdict:'passed',reason:'checker deliberately passes candidate while actual parser '+ts.version+' recognizes '+JSON.stringify(facts)}]}));`;
  await writeFile(join(f.bundle,'always.mjs'),checker);
  const spec:VerificationSpec={schemaVersion:1,contractVersion:1,standardsVersion:'direct-entry-v1',obligations:[{id:'entry',criterionId:'entry',expectation:'Declared CLI exits zero',required:true,applicable:true}],cases:[{id:'cli',revision:1,obligationIds:['entry'],parameters:[{}],modules:[],replaces:[],defectRefs:[],verifier:{kind:'command',version:'1',entry:'always.mjs',files:['always.mjs'],timeoutMs:5000,candidateEntries:['bad.cjs','good.mjs']}}],controls:[{id:'good',workspace:f.workspace,expect:'passed',mustFail:[]},{id:'bad',workspace:f.workspace,expect:'failed',mustFail:['entry']}],moduleDependencies:{}};
  const job:VerificationJob={id:'direct-engine',runtimeId:'runtime',projectId:'project',runId:'run',workspace:f.workspace,kind:'verification',proposalId:'proposal',planId:'plan',request:{},status:'running',attemptId:'attempt',environmentDigest:'real-node',config:{model:'unused',effort:'low',reservation:100,timeoutMs:5000},startedAt:new Date().toISOString(),finishedAt:null,intents:[],identities:[],usage:0,modelStarted:false,usageUnknown:false,results:[],controls:[],evaluation:null,approved:false,stopConfirmed:false,error:null,proofs:{},sources:[]};
  const bundle:DefinitionBundle={root:f.bundle,directory:f.bundle,specPath:'unused',specDigest:'unused',files:{'always.mjs':digest(checker)},digest:'unused',controls:[]};
  const engine=await executeInstances({job,signal:new AbortController().signal,save:()=>writeFileSync(join(f.directory,'entry-engine-ledger.json'),JSON.stringify(job)),eligible:()=>{},output:join(f.directory,'entry-engine')},spec,bundle,entries,[{id:'cli-instance',caseId:'cli',revision:1,parameters:{},obligationIds:['entry'],required:true}],'actual');
  assert.equal(engine[0]?.executionStatus,'executed');assert.equal(engine[0]?.checks[0]?.verdict,'failed','Actual nonzero candidate exit fails before an unconditional custom checker can pass');assert.match(engine[0]!.reason,/bad.cjs: exit 3, stopped true/);
  assert.equal(job.identities.length,1,'Nonzero candidate exit prevents the remaining entry and custom checker from starting');assert.equal(job.intents.length,1);
  assert.ok(engine[0]!.proofFiles!.some(path=>path.endsWith('/candidate-entries/entry-1/process.json')));assert.ok(!engine[0]!.proofFiles!.some(path=>path.includes('/command/')));
  await assert.rejects(readFile(join(f.directory,'entry-engine/actual/cli-instance/command/report.json')),{code:'ENOENT'});
  if(spec.cases[0]!.verifier.kind==='command')spec.cases[0]!.verifier.candidateEntries=['good.mjs','good-again.cjs'];
  const positive=await executeInstances({job,signal:new AbortController().signal,save:()=>writeFileSync(join(f.directory,'entry-engine-ledger.json'),JSON.stringify(job)),eligible:()=>{},output:join(f.directory,'entry-engine')},spec,bundle,entries,[{id:'cli-instance',caseId:'cli',revision:1,parameters:{},obligationIds:['entry'],required:true}],'positive');
  assert.equal(positive[0]?.executionStatus,'executed',positive[0]?.reason);assert.equal(positive[0]?.checks[0]?.verdict,'passed');assert.match(positive[0]!.reason,/good.mjs: exit 0, stopped true/);assert.match(positive[0]!.reason,/good-again.cjs: exit 0, stopped true/);
  assert.equal(job.identities.length,4,'Both successful entries and the separate checker each use a managed process');assert.equal(job.intents.length,4);
  const checkerReport=positive[0]!.proofFiles!.find(path=>path.endsWith('/command/report.json'))!;assert.equal((JSON.parse(await readFile(checkerReport,'utf8')) as {checks:{verdict:string}[]}).checks[0]?.verdict,'passed');
  const parserProof=positive[0]!.proofFiles!.find(path=>path.endsWith('/command/parser-runtime.json'))!;
  const parser=JSON.parse(await readFile(parserProof,'utf8')) as {version:string;module:string;moduleDigest:string;grant:string};assert.equal(parser.version,'6.0.3');assert.equal(parser.grant,'read-only');assert.equal(parser.moduleDigest,digest(await readFile(parser.module)));
  const checkerIntent=JSON.parse(await readFile(positive[0]!.proofFiles!.find(path=>path.endsWith('/command/intent.json'))!,'utf8')) as {args:string[]};assert.ok(checkerIntent.args.some(arg=>arg.startsWith('--allow-fs-read=')&&arg.endsWith('/typescript')));
  const directIntent=JSON.parse(await readFile(positive[0]!.proofFiles!.find(path=>path.endsWith('/candidate-entries/entry-1/intent.json'))!,'utf8')) as {args:string[]};assert.ok(!directIntent.args.some(arg=>arg.includes('typescript')),'Candidate CLI does not acquire parser library read access');
  assert.ok(positive[0]!.checks[0]!.reason.includes('actual parser 6.0.3'));assert.ok(positive[0]!.proofFiles!.some(path=>path.endsWith('/candidate-entries/entry-2/process.json')));await assertCandidate(entries);
});
