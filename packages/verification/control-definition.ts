import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { VerificationSpec } from '../contracts/p4.js';
import type { ControlDefinitionBinding, ControlEvolutionManifest, FrozenQualificationMatrix, SpecimenRevision } from '../contracts/p4-controls.js';
import { parseControlEvolutionManifest, parseSpecimenRevision, safeControlJSON } from '../contracts/p4-controls.js';
import { assertCandidate, canonical, captureCandidate, digest, relativeFile } from './candidate.js';
import type { Candidate } from './candidate.js';
import { assertDefinition } from './definition.js';
import type { DefinitionBundle } from './records.js';
import { assertQualificationMatrix, controlDigest } from './control-rules.js';
import { parseVerificationSpec } from '../contracts/p4.js';

export interface FrozenSpecimen { revision:SpecimenRevision;candidate:Candidate }
export interface FrozenControlDefinition {
  schemaVersion:1;definition:ControlDefinitionBinding;bundle:DefinitionBundle;
  manifest:ControlEvolutionManifest;matrix:FrozenQualificationMatrix;
  specimens:FrozenSpecimen[];digest:string;
}
function ensure(value:unknown,text:string):asserts value{if(!value)throw new Error(text);}
/** Freeze independently before publishing; an existing destination is never reused. */
export async function captureControlSpec(input:{specPath:string;directory:string;contract:ControlDefinitionBinding['contract']}):Promise<{definition:ControlDefinitionBinding;bundle:DefinitionBundle}> {
  ensure(isAbsolute(input.specPath)&&isAbsolute(input.directory),'Absolute control definition paths required');const raw=await readFile(input.specPath);ensure(raw.length<=1024*1024,'Control spec exceeds capacity');const spec=parseVerificationSpec(JSON.parse(raw.toString()));const root=await realpath(dirname(input.specPath));await mkdir(input.directory,{mode:0o700});const directory=join(input.directory,'verifiers');await mkdir(directory,{mode:0o700});const files:Record<string,string>={};
  for(const name of new Set(spec.cases.flatMap(c=>c.verifier.kind==='command'?c.verifier.files:[]))){const path=await relativeFile(root,name),bytes=await readFile(path);files[name]=digest(bytes);await mkdir(dirname(join(directory,name)),{recursive:true});await copyFile(path,join(directory,name));ensure(digest(await readFile(path))===files[name]&&digest(await readFile(join(directory,name)))===files[name],'Control detector changed during freeze');}
  const controls=[];for(const control of spec.controls)controls.push({id:control.id,candidate:await captureCandidate(control.workspace,join(input.directory,'controls',digest(control.id)))});
  const bundle:DefinitionBundle={root,directory,specPath:input.specPath,specDigest:digest(raw),files,digest:digest(canonical({spec,files,controls:controls.map(c=>({id:c.id,digest:c.candidate.digest}))})),controls};await assertDefinition(spec,bundle);return {definition:{spec,contract:structuredClone(input.contract),definitionDigest:bundle.digest},bundle};
}
/** Every revision gets a new immutable tree; original and successor coexist. */
export async function captureSpecimens(input:{directory:string;specimens:{revision:SpecimenRevision;workspace:string}[]}):Promise<FrozenSpecimen[]> {
  ensure(isAbsolute(input.directory),'Absolute specimen freeze path required');await mkdir(input.directory,{mode:0o700});const frozen:FrozenSpecimen[]=[];const keys=new Set<string>();for(const item of input.specimens){const revision=parseSpecimenRevision(item.revision),key=revision.ref.id+':'+revision.ref.revision;ensure(!keys.has(key),'Duplicate specimen freeze revision');keys.add(key);ensure(isAbsolute(item.workspace),'Absolute specimen source path required');const candidate=await captureCandidate(item.workspace,join(input.directory,digest(key)));ensure(candidate.digest===revision.ref.candidateDigest,'Specimen content differs from immutable revision');frozen.push({revision,candidate});}return frozen;
}
function frozenContent(value:Omit<FrozenControlDefinition,'digest'>){return {schemaVersion:value.schemaVersion,definition:value.definition,bundle:value.bundle,manifest:value.manifest,matrix:value.matrix,specimens:value.specimens};}
export function bindControlDefinition(input:Omit<FrozenControlDefinition,'schemaVersion'|'digest'>):FrozenControlDefinition {
  safeControlJSON(input);const manifest=parseControlEvolutionManifest(input.manifest),matrix=assertQualificationMatrix(input.matrix);ensure(matrix.manifestDigest===controlDigest(manifest)&&matrix.targetDefinitionDigest===input.definition.definitionDigest&&input.bundle.digest===input.definition.definitionDigest,'Frozen control bundle binding changed');const value={schemaVersion:1 as const,...structuredClone(input),manifest,matrix};return {...value,digest:controlDigest(frozenContent(value))};
}
export async function assertFrozenSpecimen(value:FrozenSpecimen):Promise<void> {
  const revision=parseSpecimenRevision(value.revision);ensure(revision.ref.candidateDigest===value.candidate.digest,'Frozen specimen binding changed');await assertCandidate(value.candidate,false);
  for(const witness of revision.witnesses){for(const [path,hash]of Object.entries(witness.proofs)){const stat=await lstat(path);ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024*1024,'Witness proof is not an immutable regular file');ensure(digest(await readFile(path))===hash,'Historical witness proof changed');}}
}
export async function assertControlDefinition(value:FrozenControlDefinition,live=true):Promise<void> {
  safeControlJSON(value);ensure(value.schemaVersion===1&&controlDigest(frozenContent(value))===value.digest,'Frozen control definition digest changed');bindControlDefinition(value);await assertDefinition(value.definition.spec,value.bundle,live);for(const s of value.specimens)await assertFrozenSpecimen(s);
  for(const row of value.matrix.rows)ensure(value.specimens.some(s=>canonical(s.revision.ref)===canonical(row.specimen)),'Matrix specimen missing from frozen bundle');
}
/** Complete text of old/new specimen bytes for independent review, never truncate. */
export async function specimenText(specimens:FrozenSpecimen[],maxBytes=250000):Promise<Record<string,Record<string,string>>> {
  ensure(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=2_000_000,'Invalid complete review capacity');const result:Record<string,Record<string,string>>={};let bytes=0;
  for(const specimen of specimens){await assertFrozenSpecimen(specimen);const files:Record<string,string>={};for(const name of Object.keys(specimen.candidate.files)){const path=await relativeFile(specimen.candidate.tree,name),content=await readFile(path);bytes+=content.length;ensure(bytes<=maxBytes,'Complete specimen review exceeds capacity; split review, never truncate');const text=new TextDecoder('utf-8',{fatal:true}).decode(content);ensure(!text.includes('\0'),'Binary specimen needs a supported independent review adapter');files[name]=text;}result[specimen.revision.ref.id+':'+specimen.revision.ref.revision]=files;}
  return result;
}
/** Byte/path manifest diff; semantic equivalence still requires independent review. */
export function specimenDiff(before:FrozenSpecimen,after:FrozenSpecimen):{path:string;before:string|null;after:string|null}[] {
  ensure(canonical(after.revision.predecessor)===canonical(before.revision.ref),'Specimen diff predecessor changed');return [...new Set([...Object.keys(before.candidate.files),...Object.keys(after.candidate.files)])].sort().filter(path=>before.candidate.files[path]!==after.candidate.files[path]).map(path=>({path,before:before.candidate.files[path]??null,after:after.candidate.files[path]??null}));
}
/** Proofs used by the engine must be confined to its actual output directory. */
export async function qualificationProofs(files:string[],output:string):Promise<Record<string,string>> {
  ensure(files.length>0&&new Set(files).size===files.length&&files.length<=10000,'Missing qualification proof files');const root=await realpath(output),proofs:Record<string,string>={};let bytes=0;for(const path of files){ensure(isAbsolute(path),'Absolute qualification proof path required');const actual=await realpath(path),suffix=relative(root,actual),stat=await lstat(path);ensure(stat.isFile()&&!stat.isSymbolicLink()&&suffix!==''&&suffix!=='..'&&!suffix.startsWith('..'+sep)&&!isAbsolute(suffix),'Qualification proof escaped its output root');bytes+=stat.size;ensure(bytes<=64*1024*1024,'Qualification proof exceeds capacity');proofs[path]=digest(await readFile(path));}return proofs;
}
/** Same verifier version cannot silently change executable implementation bytes. */
export function validateControlImplementationHistory(definitions:{definition:ControlDefinitionBinding;bundle:DefinitionBundle}[]):void {
  const versions=new Map<string,string>();for(const {definition,bundle}of definitions){ensure(definition.definitionDigest===bundle.digest,'Detector implementation binding changed');for(const c of definition.spec.cases){if(c.verifier.kind!=='command')continue;const key=c.id+':'+c.verifier.version,identity=canonical({entry:c.verifier.entry,files:Object.fromEntries(c.verifier.files.map(f=>[f,bundle.files[f]]))});ensure(c.verifier.files.every(f=>bundle.files[f]),'Detector implementation file missing');ensure(!versions.has(key)||versions.get(key)===identity,'Published detector implementation version changed');versions.set(key,identity);}}
}
