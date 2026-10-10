import {acquireMaterialEvidence} from './material.js';
import {bytesDigest,assertTrue} from '../workspace/research-runtime-files.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceVerifier } from '../contracts/p4.js';
import type { SourceObservation } from './records.js';
import { digest, relativeFile } from './candidate.js';
const MAX_SOURCE_BYTES=2*1024*1024;
async function readSource(url:string,timeoutMs:number,signal?:AbortSignal):Promise<{bytes:Buffer;finalUrl:string}> {
  const requestSignal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
  requestSignal.throwIfAborted();
  const requestedUrl=new URL(url);if(requestedUrl.protocol!=='https:')throw new Error('Sources require HTTPS');
  const response=await fetch(requestedUrl,{signal:requestSignal});
  if(!response.ok||new URL(response.url).protocol!=='https:'||!response.body) {
    await response.body?.cancel().catch(()=>{});
    throw new Error('Source unavailable: '+url+' HTTP '+response.status);
  }
  const reader=response.body.getReader();let count=0,complete=false;const chunks:Uint8Array[]=[];
  try {
    while(true) {
      requestSignal.throwIfAborted();const next=await reader.read();requestSignal.throwIfAborted();
      if(next.done){complete=true;break;}
      count+=next.value.byteLength;if(count>MAX_SOURCE_BYTES)throw new Error('Source too large; provide a bounded primary document');
      chunks.push(next.value);
    }
    requestSignal.throwIfAborted();return {bytes:Buffer.concat(chunks,count),finalUrl:response.url};
  } finally {
    // Keep the original read/timeout/abort error even if cancelling an errored stream fails.
    if(!complete)await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
export async function acquireSources(verifier:SourceVerifier,candidateTree:string,output:string,signal?:AbortSignal) {
  await mkdir(output,{recursive:true}); const claim=await readFile(await relativeFile(candidateTree,verifier.claimFile),'utf8');
  if(claim.length>100_000)throw new Error('Research claim exceeds bounded verification context');
  const material=verifier.binding?await acquireMaterialEvidence({kind:'material',version:verifier.version,claimFile:verifier.claimFile,binding:verifier.binding,timeoutMs:verifier.timeoutMs},candidateTree,join(output,'material-binding'),signal??new AbortController().signal):undefined;
  const observations:SourceObservation[]=[], materials:{id:string;text:string;excerpt:string}[]=[],proofFiles:string[]=[];
  for(const source of verifier.sources) {
    const {bytes,finalUrl}=await readSource(source.url,verifier.timeoutMs,signal);
    if(material){const entry=material.payload.context.index.entries.find(e=>e.input.kind==='url'&&e.input.url===source.url);assertTrue(entry?.raw?.complete&&entry.raw.sha256===bytesDigest(bytes)&&entry.finalURL===finalUrl,'Source changed from the exact material generation');assertTrue(material.payload.proposed.citations.some(c=>c.materialId===entry.id&&c.quote===source.excerpt),'Source excerpt is not an exact host-bound material span');}
    const text=bytes.toString('utf8');const path=join(output,digest(source.id)+'.source');await writeFile(path,bytes);proofFiles.push(path);
    const observation={id:source.id,url:source.url,digest:digest(bytes),acquiredAt:new Date().toISOString(),maxAgeMs:source.maxAgeMs,path};observations.push(observation);
    const metadata=join(output,digest(source.id)+'.json');await writeFile(metadata,JSON.stringify({...observation,finalUrl,excerpt:source.excerpt}));proofFiles.push(metadata);
    // Full bytes are retained; a model sees the supplied quote and surrounding source, never just a URL.
    const offset=text.indexOf(source.excerpt);if(offset<0)throw new Error('Claimed excerpt not present in actual source: '+source.id);
    materials.push({id:source.id,excerpt:source.excerpt,text:text.slice(Math.max(0,offset-12000),Math.min(text.length,offset+source.excerpt.length+12000))});
  }
  if(material){assertTrue(material.payload.context.index.entries.filter(e=>e.input.kind==='url').every(e=>verifier.sources.some(s=>e.input.kind==='url'&&s.url===e.input.url)),'Bound HTTPS source verifier omits acquired material');proofFiles.push(...material.proofFiles);}
  return {claim,observations,materials,proofFiles,...(material?{material}:{})};
}
export async function assertSourcesCurrent(sources:SourceObservation[],refresh=false,signal?:AbortSignal):Promise<void> {
  for(const source of sources) {
    signal?.throwIfAborted();
    if(Date.now()-Date.parse(source.acquiredAt)>source.maxAgeMs)throw new Error('Source evidence expired: '+source.id);
    if(digest(await readFile(source.path))!==source.digest)throw new Error('Stored source evidence changed: '+source.id);
    if(refresh){const {bytes}=await readSource(source.url,15000,signal);if(digest(bytes)!==source.digest)throw new Error('Source content changed: '+source.id);}
  }
}
