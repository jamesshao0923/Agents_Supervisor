import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { parseVerificationSpec, type VerificationSpec } from '../contracts/p4.js';
import { assertCandidate, canonical, captureCandidate, digest, relativeFile } from './candidate.js';
import type { DefinitionBundle } from './records.js';
export async function captureDefinition(specPath: string, directory: string): Promise<{spec:VerificationSpec;bundle:DefinitionBundle}> {
  if (!isAbsolute(specPath)) throw new Error('Verification spec path must be absolute');
  const raw = await readFile(specPath); if(raw.length>1024*1024)throw new Error('Verification definition too large');
  const spec = parseVerificationSpec(JSON.parse(raw.toString())), root = dirname(specPath), target = join(directory,'verifiers');
  const files:Record<string,string>={}; await mkdir(target,{recursive:true});
  for(const name of new Set(spec.cases.flatMap(c=>c.verifier.kind==='command'?c.verifier.files:[]))) {
    const path=await relativeFile(root,name), bytes=await readFile(path); files[name]=digest(bytes);
    await mkdir(dirname(join(target,name)),{recursive:true}); await copyFile(path,join(target,name));
    if(digest(await readFile(path))!==files[name]||digest(await readFile(join(target,name)))!==files[name])throw new Error('Verifier implementation changed during freeze');
  }
  const controls=[];for(const control of spec.controls)controls.push({id:control.id,candidate:await captureCandidate(control.workspace,join(directory,'controls',digest(control.id)))});
  const specDigest=digest(raw), hash=digest(canonical({spec,files,controls:controls.map(c=>({id:c.id,digest:c.candidate.digest}))}));
  const bundle={root,directory:target,specPath,specDigest,files,digest:hash,controls};
  await assertDefinition(spec,bundle); return {spec,bundle};
}
export async function assertDefinition(spec:VerificationSpec,bundle:DefinitionBundle,live=true):Promise<void> {
  if(live&&digest(await readFile(bundle.specPath))!==bundle.specDigest)throw new Error('Verification definition changed; review and publish a new revision');
  for(const [name,hash] of Object.entries(bundle.files)) {
    if(digest(await readFile(await relativeFile(bundle.directory,name)))!==hash)throw new Error('Frozen verifier implementation changed');
    if(live&&digest(await readFile(await relativeFile(bundle.root,name)))!==hash)throw new Error('Verifier implementation changed; new review required');
  }
  for(const control of bundle.controls)await assertCandidate(control.candidate,live);
  if(digest(canonical({spec,files:bundle.files,controls:bundle.controls.map(c=>({id:c.id,digest:c.candidate.digest}))}))!==bundle.digest)throw new Error('Definition bundle integrity failed');
}
/** A published implementation version identifies immutable bytes, including historical cases. */
export function validateBundleChange(previous:{spec:VerificationSpec;bundle:DefinitionBundle}|null,next:{spec:VerificationSpec;bundle:DefinitionBundle}):void {
  if(!previous)return;
  for(const old of previous.bundle.controls)if(next.bundle.controls.find(c=>c.id===old.id)?.candidate.digest!==old.candidate.digest)throw new Error('Published control content cannot be replaced');
  for(const old of previous.spec.cases) {
    if(old.verifier.kind!=='command')continue;
    const version=old.verifier.version;
    const identity=(verifier:typeof old.verifier,bundle:DefinitionBundle)=>canonical({entry:verifier.entry,files:Object.fromEntries(verifier.files.map(f=>[f,bundle.files[f]]))});
    for(const nextCase of next.spec.cases.filter(c=>c.id===old.id&&c.verifier.kind==='command'&&c.verifier.version===version)) {
      if(nextCase.verifier.kind==='command'&&identity(old.verifier,previous.bundle)!==identity(nextCase.verifier,next.bundle))throw new Error('Published verifier version cannot point to changed implementation bytes; use a new version and case revision');
    }
  }
}
