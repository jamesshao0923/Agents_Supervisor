import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, win32 } from 'node:path';

export type CheckStatus = 'available' | 'missing' | 'unknown';

export interface EnvironmentCheck {
  id: string;
  status: CheckStatus;
  detail: string;
  executable?: string;
}

export interface EnvironmentReport {
  schemaVersion: 1;
  generatedAt: string;
  platform: string;
  arch: string;
  node: { version: string; executable: string };
  checks: EnvironmentCheck[];
  capabilities: EnvironmentCheck[];
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  failure?: 'spawn' | 'timeout' | 'output-limit' | 'signal';
}

const COMMAND_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 16_384;

/** Pure PATH expansion: never searches the current directory implicitly. */
export function executableCandidates(
  command: string,
  pathValue: string | undefined,
  platform: string,
  pathExt: string | undefined = undefined,
  extras: readonly string[] = [],
): string[] {
  const windows = platform === 'win32';
  const pathApi = windows ? win32 : { isAbsolute, join };
  const extensions = windows
    ? [...new Set((pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase()))]
    : [''];
  const names = windows && /\.[^\\/.]+$/.test(command) ? [command] : extensions.map((ext) => command + ext);
  const directories = (pathValue ?? '').split(windows ? ';' : delimiter).filter((entry) => pathApi.isAbsolute(entry));
  return [...new Set([...directories.flatMap((directory) => names.map((name) => pathApi.join(directory, name))), ...extras])];
}

/** Authentication output is reduced to a label and is never included in a report. */
export function classifyCodexAuth(result: CommandResult): EnvironmentCheck {
  if (result.failure) return { id: 'codex.auth', status: 'unknown', detail: `login-status-${result.failure}; remote API not tested` };
  // A known negative label may legitimately use a nonzero exit status.
  if (/^\s*(?:not logged in|not authenticated)\s*$/im.test(result.output)) {
    return { id: 'codex.auth', status: 'missing', detail: 'not-authenticated; remote API not tested' };
  }
  if (result.exitCode === 0 && /^\s*logged in(?: using\b[^\r\n]*)?\s*$/im.test(result.output)) {
    return { id: 'codex.auth', status: 'available', detail: 'authenticated; remote API not tested' };
  }
  return { id: 'codex.auth', status: 'unknown', detail: 'unrecognized-login-status; remote API not tested' };
}

export async function runBounded(executable: string, args: readonly string[], root: string): Promise<CommandResult> {
  return new Promise((done) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const child = spawn(executable, [...args], {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    });
    const finish = (exitCode: number | null, failure?: CommandResult['failure']): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const result: CommandResult = { exitCode, output: Buffer.concat(chunks).toString('utf8') };
      if (failure) result.failure = failure;
      done(result);
    };
    const timer = setTimeout(() => finish(null, 'timeout'), COMMAND_TIMEOUT_MS);
    const collect = (chunk: Buffer): void => {
      const remaining = OUTPUT_LIMIT_BYTES - bytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT_BYTES) finish(null, 'output-limit');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => finish(null, 'spawn'));
    child.on('close', (code, signal) => finish(code, signal ? 'signal' : undefined));
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function locate(command: string, extras: readonly string[] = []): Promise<{ executable?: string; uncertain: boolean }> {
  let uncertain = false;
  for (const candidate of executableCandidates(command, process.env.PATH, process.platform, process.env.PATHEXT, extras)) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      if ((await stat(candidate)).isFile()) return { executable: candidate, uncertain };
    } catch (error) {
      if (!isMissing(error)) uncertain = true;
    }
  }
  return { uncertain };
}

/** Extract one complete, bounded version token; never retain surrounding CLI output. */
export function parseVersion(output: string): string | undefined {
  const version = output.match(/(?:^|[^a-zA-Z0-9_.+-])[vV]?(\d+(?:\.\d+)+(?:_\d+)?(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?(?:\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?)(?![a-zA-Z0-9_.+-])/)?.[1];
  return version && version.length <= 128 ? version : undefined;
}

function commandCheck(id: string, executable: string, result: CommandResult): EnvironmentCheck {
  if (result.failure || result.exitCode !== 0) {
    return { id, status: 'unknown', executable, detail: result.failure ?? `version-command-exit-${result.exitCode ?? 'unknown'}` };
  }
  // Only extract a bounded numeric version token, never persist arbitrary CLI output.
  const version = parseVersion(result.output);
  return { id, executable, status: version ? 'available' : 'unknown', detail: version ? `installed; version ${version}` : 'version-output-unrecognized' };
}

async function toolCheck(id: string, command: string, args: readonly string[], root: string, extras: readonly string[] = []): Promise<EnvironmentCheck> {
  const found = await locate(command, extras);
  if (!found.executable) return { id, status: found.uncertain ? 'unknown' : 'missing', detail: found.uncertain ? 'executable-discovery-failed' : 'executable-not-found' };
  return commandCheck(id, found.executable, await runBounded(found.executable, args, root));
}

async function accessCheck(id: string, path: string, mode: number): Promise<EnvironmentCheck> {
  try {
    await access(path, mode);
    return { id, status: 'available', detail: `access check succeeded: ${path}` };
  } catch (error) {
    return { id, status: isMissing(error) ? 'missing' : 'unknown', detail: isMissing(error) ? `path-not-found: ${path}` : `access check failed: ${path}` };
  }
}

async function androidSdkCheck(): Promise<{ check: EnvironmentCheck; sdk?: string }> {
  const defaults = process.platform === 'darwin'
    ? [join(homedir(), 'Library', 'Android', 'sdk')]
    : process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk')]
      : [join(homedir(), 'Android', 'Sdk')];
  const candidates = [...new Set([process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME, ...defaults].filter((value): value is string => Boolean(value)))];
  let uncertain = false;
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isDirectory()) { uncertain = true; continue; }
      await access(candidate, constants.R_OK | constants.X_OK);
      return { check: { id: 'android.sdk', status: 'available', detail: `SDK directory present: ${candidate}; build not tested` }, sdk: candidate };
    } catch (error) {
      if (!isMissing(error)) uncertain = true;
    }
  }
  return { check: { id: 'android.sdk', status: uncertain ? 'unknown' : 'missing', detail: uncertain ? 'SDK directory access failed' : 'SDK directory not found' } };
}

async function appleChecks(root: string): Promise<EnvironmentCheck[]> {
  if (process.platform !== 'darwin') {
    return ['xcode.select', 'xcode.build', 'ios.simctl', 'ios.devices'].map((id) => ({ id, status: 'missing', detail: 'requires macOS' }));
  }
  const checks: EnvironmentCheck[] = [];
  const select = await locate('xcode-select', ['/usr/bin/xcode-select']);
  if (select.executable) {
    const result = await runBounded(select.executable, ['-p'], root);
    const path = result.output.trim();
    let valid = false;
    if (!result.failure && result.exitCode === 0 && isAbsolute(path) && !path.includes('\n')) {
      try { valid = (await stat(path)).isDirectory(); } catch { /* Selection cannot be verified. */ }
    }
    checks.push({ id: 'xcode.select', status: valid ? 'available' : 'unknown', executable: select.executable, detail: valid ? 'selected developer directory exists' : 'selected developer directory unverified' });
  } else {
    checks.push({ id: 'xcode.select', status: select.uncertain ? 'unknown' : 'missing', detail: 'xcode-select executable not found' });
  }
  checks.push(await toolCheck('xcode.build', 'xcodebuild', ['-version'], root, ['/usr/bin/xcodebuild']));
  const xcrun = await locate('xcrun', ['/usr/bin/xcrun']);
  if (!xcrun.executable) {
    checks.push(...['ios.simctl', 'ios.devices'].map((id): EnvironmentCheck => ({ id, status: xcrun.uncertain ? 'unknown' : 'missing', detail: 'xcrun executable not found' })));
    return checks;
  }
  const find = await runBounded(xcrun.executable, ['--find', 'simctl'], root);
  const simctl = find.output.trim();
  if (find.failure || find.exitCode !== 0 || !isAbsolute(simctl) || simctl.includes('\n')) {
    checks.push({ id: 'ios.simctl', status: 'unknown', executable: xcrun.executable, detail: 'simctl discovery failed' }, { id: 'ios.devices', status: 'unknown', detail: 'simctl unavailable; Simulator not started' });
    return checks;
  }
  try { await access(simctl, constants.X_OK); } catch {
    checks.push({ id: 'ios.simctl', status: 'unknown', detail: 'simctl executable access failed' }, { id: 'ios.devices', status: 'unknown', detail: 'simctl unavailable; Simulator not started' });
    return checks;
  }
  checks.push({ id: 'ios.simctl', status: 'available', executable: simctl, detail: 'installed; Simulator not started' });
  const list = await runBounded(simctl, ['list', 'devices', 'available', '--json'], root);
  let count: number | undefined;
  if (!list.failure && list.exitCode === 0) {
    try {
      const data: unknown = JSON.parse(list.output);
      if (typeof data === 'object' && data !== null && 'devices' in data && typeof data.devices === 'object' && data.devices !== null) {
        const groups = Object.values(data.devices);
        if (groups.every((group) => Array.isArray(group) && group.every((device: unknown) => typeof device === 'object' && device !== null && 'isAvailable' in device && typeof device.isAvailable === 'boolean'))) {
          count = groups.flat().filter((device) => device.isAvailable).length;
        }
      }
    } catch { /* A successful process exit alone cannot verify the inventory. */ }
  }
  checks.push({ id: 'ios.devices', status: count === undefined ? 'unknown' : count > 0 ? 'available' : 'missing', detail: count === undefined ? 'device inventory unverified; Simulator not started' : `${count} available Simulator devices; Simulator not started` });
  return checks;
}

/** Read-only installation/authentication inventory; does not execute an Agent task or contact service APIs. */
export async function probeEnvironment(root: string): Promise<EnvironmentReport> {
  const projectRoot = resolve(root);
  const checks: EnvironmentCheck[] = [];
  try {
    checks.push({ id: 'project.directory', status: (await stat(projectRoot)).isDirectory() ? 'available' : 'unknown', detail: `project directory: ${projectRoot}` });
  } catch (error) {
    checks.push({ id: 'project.directory', status: isMissing(error) ? 'missing' : 'unknown', detail: `project directory could not be inspected: ${projectRoot}` });
  }
  checks.push(...await Promise.all([
    accessCheck('project.read', projectRoot, constants.R_OK),
    accessCheck('project.write', projectRoot, constants.W_OK),
    accessCheck('project.search', projectRoot, constants.X_OK),
  ]));
  // A missing/invalid project directory must not prevent inventory of the host.
  const commandRoot = checks[0]?.status === 'available' && checks[1]?.status === 'available' && checks[3]?.status === 'available' ? projectRoot : homedir();
  const sdk = await androidSdkCheck();
  const windows = process.platform === 'win32';
  const sdkAdb = sdk.sdk ? [join(sdk.sdk, 'platform-tools', windows ? 'adb.exe' : 'adb')] : [];
  const sdkEmulator = sdk.sdk ? [join(sdk.sdk, 'emulator', windows ? 'emulator.exe' : 'emulator')] : [];
  const codexExtras = process.platform === 'darwin' ? ['/Applications/Codex.app/Contents/Resources/codex', join(homedir(), 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex')] : [];
  const tools = await Promise.all([
    toolCheck('node', 'node', ['--version'], commandRoot, [process.execPath]),
    toolCheck('git', 'git', ['--version'], commandRoot),
    toolCheck('pnpm', 'pnpm', ['--version'], commandRoot),
    toolCheck('codex', 'codex', ['--version'], commandRoot, codexExtras),
    toolCheck('temporal', 'temporal', ['--version'], commandRoot),
    toolCheck('android.java', 'java', ['-version'], commandRoot, process.env.JAVA_HOME ? [join(process.env.JAVA_HOME, 'bin', windows ? 'java.exe' : 'java')] : []),
    toolCheck('android.adb', 'adb', ['version'], commandRoot, sdkAdb),
    toolCheck('android.emulator', 'emulator', ['-version'], commandRoot, sdkEmulator),
  ]);
  checks.push(...tools);
  const codex = tools.find((check) => check.id === 'codex');
  checks.push(codex?.executable
    ? { ...classifyCodexAuth(await runBounded(codex.executable, ['login', 'status'], commandRoot)), executable: codex.executable }
    : { id: 'codex.auth', status: codex?.status === 'missing' ? 'missing' : 'unknown', detail: 'Codex executable unavailable; remote API not tested' });
  checks.push(...await appleChecks(commandRoot), sdk.check);
  const emulator = tools.find((check) => check.id === 'android.emulator');
  if (emulator?.executable) {
    const list = await runBounded(emulator.executable, ['-list-avds'], commandRoot);
    const names = list.output.trim() ? list.output.trim().split(/\r?\n/) : [];
    const valid = !list.failure && list.exitCode === 0 && names.every((name) => /^[a-zA-Z0-9_.-]+$/.test(name));
    checks.push({ id: 'android.avds', status: !valid ? 'unknown' : names.length > 0 ? 'available' : 'missing', executable: emulator.executable, detail: !valid ? 'AVD inventory unverified; emulator not started' : `${names.length} configured AVDs; emulator not started` });
  } else {
    checks.push({ id: 'android.avds', status: emulator?.status === 'missing' ? 'missing' : 'unknown', detail: 'emulator executable unavailable; emulator not started' });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: { version: process.version, executable: process.execPath },
    checks,
    capabilities: [
      { id: 'codex.api', status: 'unknown', detail: 'Real remote API and Agent execution not tested; login status only' },
      { id: 'temporal.service', status: 'unknown', detail: 'Temporal Service/Worker connectivity and workflow execution not tested' },
      { id: 'ios.delivery', status: 'unknown', detail: 'Build, Simulator launch, installation and application behavior not tested' },
      { id: 'android.delivery', status: 'unknown', detail: 'Build, device connectivity, emulator launch and application behavior not tested' },
    ],
  };
}
