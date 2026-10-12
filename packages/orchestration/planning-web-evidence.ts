import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';

/** Evidence of observed calls, never user authority or independent report verification. */
export async function planningWebEvidence(path:string,receipt:{threadId:string|null;proofs:Record<string,string>}):Promise<unknown> {
  const digest=receipt.proofs[path];
  // Older or non-provider reasoners may not supply a native event journal.
  if(!digest)return null;
  const maxBytes=32*1024*1024;
  if((await stat(path)).size>maxBytes)throw Error('Planning web evidence exceeds review capacity; original journal retained');
  const bytes=await readFile(path,'utf8');
  if(Buffer.byteLength(bytes)>maxBytes)throw Error('Planning web evidence exceeds review capacity; original journal retained');
  if(createHash('sha256').update(bytes).digest('hex')!==digest)throw Error('Planning web evidence changed before independent review');
  const observations:unknown[]=[];
  for(const line of bytes.split('\n').filter(Boolean)){
    const event=JSON.parse(line);
    if(event.kind!=='codex-event')continue;
    const raw=event.value?.raw,params=raw?.params;
    if(raw?.method!=='item/completed'||params?.item?.type!=='webSearch')continue;
    if(!receipt.threadId||params.threadId!==receipt.threadId||event.value.threadId!==receipt.threadId||event.value.method!==raw.method||event.value.turnId!==params.turnId||typeof params.turnId!=='string'||!params.turnId)throw Error('Planning web evidence context mismatch');
    observations.push({threadId:params.threadId,turnId:params.turnId,item:params.item});
    if(JSON.stringify(observations).length>60_000)throw Error('Planning web observations exceed review context capacity; original journal retained');
  }
  return {journal:{path,sha256:digest},observations,scope:'Observed native web call metadata and returned results only; not user authorization or independent claim verification.'};
}
