import {scopedConfiguration,type VerificationEnvironmentScope} from './scoped-environment.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export interface Candidate { root: string; tree: string; digest: string; files: Record<string, string>; excluded: string[]; createdAt: string }
// Runtime control files and dependency installations are not deliverable source.
// Their exclusion is explicit in every snapshot; lockfiles and built binaries remain included.
export const exclusions = ['.git', '.supervisor', '.supervisor-dev', 'node_modules'];
export async function scanCandidate(directory: string): Promise<Record<string, string>> {
  const root = await realpath(directory), files: Record<string, string> = Object.create(null) as Record<string,string>; let bytes = 0;
  async function walk(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      if (exclusions.includes(name)) continue;
      const absolute = join(path, name), info = await lstat(absolute), local = relative(root, absolute).split(sep).join('/');
      if (info.isSymbolicLink()) throw new Error('Candidate symlink requires an explicit supported snapshot strategy: ' + local);
      if (info.isDirectory()) await walk(absolute);
      else if (info.isFile()) {
        bytes += info.size;
        if (Object.keys(files).length >= 10000 || bytes > 256 * 1024 * 1024) throw new Error('Candidate exceeds the bounded P4 snapshot capacity; no files were silently omitted');
        files[local] = digest(Buffer.concat([await readFile(absolute),Buffer.from('\0executable:'+String(info.mode & 0o111))]));
      } else throw new Error('Unsupported candidate file type: ' + local);
    }
  }
  await walk(root);
  if (!Object.keys(files).length) throw new Error('Candidate has no deliverable files');
  return files;
}
export async function captureCandidate(root: string, destination: string): Promise<Candidate> {
  root = await realpath(root);
  const tree = resolve(destination, 'tree');
  if (tree === root || tree.startsWith(root + sep) && !exclusions.includes(relative(root,tree).split(sep)[0]!)) throw new Error('Snapshot storage must be outside the candidate');
  const files = await scanCandidate(root);
  await mkdir(dirname(resolve(destination)),{recursive:true});
  await mkdir(resolve(destination),{mode:0o700});
  await mkdir(tree, { mode: 0o700 });
  for (const name of Object.keys(files)) { const output = join(tree, name); await mkdir(resolve(output, '..'), { recursive: true }); await copyFile(join(root, name), output); }
  if (canonical(files) !== canonical(await scanCandidate(root)) || canonical(files) !== canonical(await scanCandidate(tree))) throw new Error('Candidate changed during snapshot capture');
  const candidate: Candidate = { root, tree, digest: digest(canonical(files)), files, excluded: exclusions, createdAt: new Date().toISOString() };
  await writeFile(join(destination, 'candidate.json'), canonical(candidate), { flag: 'wx', mode: 0o600 });
  return candidate;
}
export async function assertCandidate(candidate: Candidate, live = true): Promise<void> {
  if (digest(canonical(candidate.files)) !== candidate.digest || canonical(await scanCandidate(candidate.tree)) !== canonical(candidate.files)) throw new Error('Frozen candidate snapshot is invalid');
  if (live && canonical(await scanCandidate(candidate.root)) !== canonical(candidate.files)) throw new Error('Current workspace differs from the verified candidate');
}
export async function relativeFile(root: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(s => !s || s === '.' || s === '..')) throw new Error('Expected a confined relative file path');
  const base = await realpath(root), absolute = await realpath(join(base, path));
  if (!absolute.startsWith(base + sep) || !(await lstat(absolute)).isFile()) throw new Error('File escapes its declared root');
  return absolute;
}
export async function environmentFingerprint(scope?:VerificationEnvironmentScope): Promise<{ digest: string; node: string; executableDigest: string; platform: string; arch: string }> {
  const value = { node: process.version, executableDigest: digest(await readFile(process.execPath)), platform: process.platform, arch: process.arch };
  const dependencies:Record<string,string>={};
  async function tree(path:string):Promise<void>{for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);if(entry.isDirectory())await tree(p);else if(entry.isFile()&&/\.(js|cjs|json|ts)$/.test(p))dependencies[p]=digest(await readFile(p));}}
  for(const relative of ['./','../executor-codex/','../process-control/','../../apps/verification-ui/'])await tree(fileURLToPath(new URL(relative,import.meta.url)));
  const require=createRequire(import.meta.url);
  for(const name of ['typescript','@types/node'])await tree(dirname(await realpath(require.resolve(name+'/package.json'))));
  await tree(dirname(await realpath(require.resolve('undici-types/package.json',{paths:[dirname(require.resolve('@types/node/package.json'))]}))));
  const electron:unknown=createRequire(import.meta.url)('electron');if(typeof electron==='string')dependencies.electron=digest(await readFile(electron));
  const command=process.env.SUPERVISOR_CODEX_PATH??'codex';let codex:string|undefined;
  for(const path of isAbsolute(command)?[command]:(process.env.PATH??'').split(':').map(p=>join(p,command)))try{codex=await realpath(path);break;}catch{}
  if(codex)dependencies.codex=digest(await readFile(codex));else dependencies.codex='unavailable';
  const config=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'config.toml');if(scope){dependencies.codexConfig=digest(canonical(await scopedConfiguration(config,scope)));await tree(dirname(await realpath(require.resolve('smol-toml'))));}else try{dependencies.codexConfig=digest(await readFile(config));}catch{dependencies.codexConfig='absent';}
  // Persist hashes, never environment values or account credentials.
  dependencies.environment=digest(canonical(process.env));
  return { ...value, digest: digest(canonical({value,dependencies})) };
}
