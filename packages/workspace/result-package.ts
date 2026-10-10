import {constants,closeSync,existsSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,readSync,renameSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,parse,relative,resolve} from 'node:path';
import type {TaskResultManifest} from '../contracts/p7-results.js';
import {parseTaskResultManifest} from '../contracts/p7-results.js';
export interface ResultPackage {id:string;directory:string;manifestDigest:string;files:TaskResultManifest['artifacts'];indexDigest:string}
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
function ensure(ok:unknown,message:string):asserts ok {if(!ok)throw new Error('Result package: '+message);}
function canonical(value:any):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export function assertResultDirectory(path:string):void {ensure(isAbsolute(path),'root must be absolute');let current=parse(path).root;for(const part of relative(current,resolve(path)).split('/').filter(Boolean)){current=join(current,part);const s=lstatSync(current);ensure(s.isDirectory()&&!s.isSymbolicLink(),'unsafe directory ancestor');}}
function file(root:string,path:string,max:number):Buffer {
 assertResultDirectory(root);const absolute=resolve(root,path);ensure(relative(root,absolute)!==''&&!relative(root,absolute).startsWith('..'),'path escape');assertResultDirectory(dirname(absolute));const s=lstatSync(absolute);ensure(s.isFile()&&!s.isSymbolicLink()&&s.size<=max,'not a bounded regular file');
 const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=fstatSync(fd);ensure(before.isFile()&&before.size<=max&&before.ino===s.ino&&before.dev===s.dev,'file changed before open');const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);ensure(n>0,'short read');offset+=n;}const after=fstatSync(fd),now=lstatSync(absolute);ensure(before.ino===after.ino&&before.dev===after.dev&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&now.ino===after.ino&&now.dev===after.dev&&!now.isSymbolicLink(),'file changed during capture');assertResultDirectory(dirname(absolute));return bytes;}finally{closeSync(fd);}
}
function syncDirectory(path:string):void {const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function write(path:string,bytes:Buffer):void {const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
/** Host-only filesystem operation. No database transaction may surround this call. */
export function materializeResultPackage(input:{root:string;id:string;sourceRoot:string;manifest:TaskResultManifest}):ResultPackage {
 const manifest=parseTaskResultManifest(input.manifest);ensure(/^[a-f0-9]{64}$/.test(input.id),'invalid host package id');ensure(manifest.artifacts.length<=256&&manifest.artifacts.reduce((sum,a)=>sum+a.size,0)<=16*1024*1024,'package capacity exceeded');assertResultDirectory(input.root);assertResultDirectory(input.sourceRoot);
 const directory=join(input.root,input.id),staging=join(input.root,input.id+'.staging');if(existsSync(directory))return inspectResultPackage({root:input.root,id:input.id,manifest});ensure(!existsSync(staging),'incomplete staging requires explicit recovery; never overwrite');mkdirSync(staging,{mode:0o700});mkdirSync(join(staging,'files'),{mode:0o700});
 for(const artifact of manifest.artifacts){const bytes=file(input.sourceRoot,artifact.relativePath,16*1024*1024);ensure(bytes.length===artifact.size&&sha(bytes)===artifact.digest,'source bytes differ from manifest');const target=join(staging,'files',artifact.relativePath);mkdirSync(dirname(target),{recursive:true,mode:0o700});assertResultDirectory(dirname(target));write(target,bytes);syncDirectory(dirname(target));}
 write(join(staging,'manifest.json'),Buffer.from(canonical(manifest)));syncDirectory(join(staging,'files'));syncDirectory(staging);renameSync(staging,directory);syncDirectory(input.root);
 return inspectResultPackage({root:input.root,id:input.id,manifest});
}
export function inspectResultPackage(input:{root:string;id:string;manifest:TaskResultManifest}):ResultPackage {
 const manifest=parseTaskResultManifest(input.manifest);ensure(/^[a-f0-9]{64}$/.test(input.id),'invalid host package id');const directory=join(input.root,input.id);assertResultDirectory(directory);ensure(sha(file(directory,'manifest.json',2*1024*1024))===sha(canonical(manifest)),'manifest bytes changed');const filesRoot=join(directory,'files'),found:string[]=[];
 function walk(path:string,prefix=''):void {assertResultDirectory(path);for(const name of readdirSync(path)){const p=join(path,name),r=prefix+name,s=lstatSync(p);ensure(!s.isSymbolicLink(),'package symlink');if(s.isDirectory())walk(p,r+'/');else{ensure(s.isFile(),'nonregular package entry');found.push(r);}}}
 ensure(readdirSync(directory).sort().join(',')==='files,manifest.json','unexpected package entry');walk(filesRoot);ensure(found.length===manifest.artifacts.length&&found.every(p=>manifest.artifacts.some(a=>a.relativePath===p)),'package file set differs');
 for(const a of manifest.artifacts){const b=file(filesRoot,a.relativePath,16*1024*1024);ensure(b.length===a.size&&sha(b)===a.digest,'package bytes changed');}
 return {id:input.id,directory,manifestDigest:sha(canonical(manifest)),files:structuredClone(manifest.artifacts),indexDigest:sha(canonical(manifest.artifacts))};
}
