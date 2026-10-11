import {readdirSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import type {PreparedResearchReader} from '../contracts/p8-research-reader.js';
import type {ProcessIdentity} from '../process-control/index.js';
import {assertResearchReader} from './research-reader.js';
import {researchDigest} from './research-materials.js';
import {MATERIAL_READER_SCHEMA_DIGEST} from '../executor-codex/material-reader-baseline.js';
import {assertMaterialIndex,readBounded,bytesDigest} from './research-runtime-files.js';
function ensure(v:unknown,m:string):asserts v{if(!v)throw Error('Indexed research consumer: '+m);}
/** Reopening validates copies and the actual original journal; no semantic authority. */
export function assertIndexedConsumerArchiveSync(path:string,expected:{jobId:string;attemptId:string;identities:ProcessIdentity[];inputDigest?:string;readerDigest?:string},requireClosed=true) {
 const proof=JSON.parse(readBounded(path,1024*1024).toString('utf8')) as {schemaVersion:number;authority:string;grantVersion?:number;callRoot?:string;owner:{jobId:string;attemptId:string;inputDigest:string};reader:PreparedResearchReader;originalDirectory:string;files:Record<string,string>};
 ensure(expected.inputDigest===undefined||proof.owner.inputDigest===expected.inputDigest,'Reader actual frozen input differs');
 ensure(expected.readerDigest===undefined||proof.reader.digest===expected.readerDigest,'Reader actual frozen view differs');
 ensure(proof.schemaVersion===1&&proof.authority==='material-integrity-only'&&proof.owner.jobId===expected.jobId&&proof.owner.attemptId===expected.attemptId,'Reader archive owner changed');
 const {digest:readerDigest,...readerBody}=proof.reader;ensure(researchDigest(readerBody)===readerDigest&&researchDigest(JSON.parse(readBounded(proof.reader.path).toString('utf8')))===researchDigest(proof.reader),'Frozen reader file changed');
 assertMaterialIndex(proof.reader.context.index);let bytes=0;const records:import('../contracts/p8-research-reader.js').ResearchReaderAudit[]=[];
 const originalOwner=JSON.parse(readBounded(join(proof.originalDirectory,'owner.json')).toString('utf8')) as {owner:import('../contracts/p8-research-reader.js').ResearchReaderOwner;readerDigest:string;protocolDigest:string;schemaVersion:number;protocol:string};
 ensure(originalOwner.schemaVersion===1&&originalOwner.protocol==='indexed-material-v1'&&originalOwner.protocolDigest===MATERIAL_READER_SCHEMA_DIGEST&&originalOwner.readerDigest===proof.reader.digest&&originalOwner.owner.jobId===expected.jobId&&originalOwner.owner.attemptId===expected.attemptId&&originalOwner.owner.inputDigest===proof.owner.inputDigest&&expected.identities.some(i=>researchDigest(i)===researchDigest(originalOwner.owner.processIdentity)),'Reader actual process ownership differs');
 const root=proof.reader.context.material.directory.substring(0,proof.reader.context.material.directory.lastIndexOf('/material-intake/'));
 ensure(proof.originalDirectory===join(root,'material-reader-sessions',bytesDigest(researchDigest({owner:originalOwner.owner,viewDigest:proof.reader.view.digest,protocolDigest:originalOwner.protocolDigest}))),'Reader journal path is not derived from actual owner');
 for(const [copy,sha]of Object.entries(proof.files)){
  ensure(copy===join(dirname(path),basename(copy))&&(basename(copy)==='owner.json'||/^\d+\.json$/.test(basename(copy))),'Reader copy escaped proof directory');const value=readBounded(copy,6*1024*1024);bytes+=value.length;ensure(bytes<=6*1024*1024&&bytesDigest(value)===sha,'Reader audit changed or exceeded capacity');
  const name=copy.slice(copy.lastIndexOf('/')+1);ensure(bytesDigest(readBounded(join(proof.originalDirectory,name),6*1024*1024))===sha,'Original reader journal differs from copied proof');if(name!=='owner.json')records.push(JSON.parse(value.toString('utf8')));
 }
 records.sort((a,b)=>a.sequence-b.sequence);for(let i=0;i<records.length;i++){const r=records[i]!,{digest,...body}=r;ensure(r.sequence===i+1&&researchDigest(body)===digest&&researchDigest(r.owner)===researchDigest(originalOwner.owner)&&r.viewDigest===proof.reader.view.digest,'Reader journal binding/order changed');}
 if(requireClosed)ensure(records.at(-1)?.stage==='closed'&&!records.some(r=>r.stage==='aborted'),'Incomplete reader cannot support applicable result');
 ensure(readdirSync(dirname(path)).filter(name=>name!=='binding.json').sort().join('|')===Object.keys(proof.files).map(name=>basename(name)).sort().join('|'),'Copied reader inventory changed');
 ensure(readdirSync(proof.originalDirectory).sort().join('|')===['owner.json',...records.map(r=>r.sequence+'.json')].sort().join('|'),'Original reader inventory changed');
 return {proof,records};
}
export async function assertIndexedConsumerArchive(path:string,expected:{jobId:string;attemptId:string;identities:ProcessIdentity[];inputDigest?:string;readerDigest?:string},requireClosed=true){
 const actual=assertIndexedConsumerArchiveSync(path,expected,requireClosed);await assertResearchReader(actual.proof.reader);return actual;
}

/** Exact receipt inventory; neither a payload label nor an empty proof list is a grant. */
export function assertIndexedProducerReceiptSync(path:string,proofs:Record<string,string>,expected:{jobId:string;attemptId:string;identity:ProcessIdentity;inputDigest:string;readerDigest:string}) {
 ensure(Object.keys(proofs).length>0&&Object.keys(proofs).filter(p=>p.endsWith('/indexed-reader/binding.json')).length===1&&proofs[path],'Actual complete producer reader binding required');
 const actual=assertIndexedConsumerArchiveSync(path,{jobId:expected.jobId,attemptId:expected.attemptId,identities:[expected.identity],inputDigest:expected.inputDigest,readerDigest:expected.readerDigest});
 const inventory={...actual.proof.files,[path]:bytesDigest(readBounded(path))};
 ensure(researchDigest(proofs)===researchDigest(inventory),'Producer reader receipt inventory differs');
 for(const [p,sha]of Object.entries(inventory))ensure(bytesDigest(readBounded(p,6*1024*1024))===sha,'Producer reader receipt bytes changed');
 return actual;
}

export async function assertIndexedProducerReceipt(...args:Parameters<typeof assertIndexedProducerReceiptSync>){const actual=assertIndexedProducerReceiptSync(...args);await assertResearchReader(actual.proof.reader);return actual;}
