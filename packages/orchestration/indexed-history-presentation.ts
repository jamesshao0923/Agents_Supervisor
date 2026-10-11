import {safeControlJSON} from '../contracts/p4-controls.js';
export const INDEXED_COMPACT_MARKER={schemaVersion:7,kind:'indexed-history-references'} as const;
export const INDEXED_COMPACT_PROMPT='Supervisor indexed-history control-evolution author presentation v7';
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
function ensure(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
function keys(v:any,expected:string[]){ensure(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===expected.sort().join(','),'Unknown indexed-history reference fields');}
export function isIndexedCompact(context:any):boolean{return canonical(context?.authorPresentation)===canonical(INDEXED_COMPACT_MARKER);}
export function compactIndexedHistoryContext(context:any):any{
 safeControlJSON(context);const c=structuredClone(context);
 ensure(canonical(c.acceptance)===canonical(c.evolution.current),'Acceptance differs from complete current context');
 delete c.acceptance;c.acceptanceRef='evolution.current';c.authorPresentation=structuredClone(INDEXED_COMPACT_MARKER);
 const witnesses=c.evolution.history.specimens.flatMap((s:any)=>s.revision.witnesses);
 for(const w of witnesses){ensure(!Object.hasOwn(w.result,'proofFilesRef'),'Preexisting proof reference');const paths=Object.keys(w.proofs).sort();ensure(Array.isArray(w.result.proofFiles)&&w.result.proofFiles.length===paths.length&&new Set(w.result.proofFiles).size===paths.length&&w.result.proofFiles.every((p:string)=>paths.includes(p)),'Proof inventory cannot be represented losslessly');w.result.proofFilesRef={from:'witness.proofs.keys',order:w.result.proofFiles.map((p:string)=>paths.indexOf(p))};delete w.result.proofFiles;}
 for(const e of c.evolution.sourceRefresh.historicalEpochs){const matches=witnesses.filter((w:any)=>w.id===e.witnessId);ensure(matches.length===1&&canonical(matches[0].proofs)===canonical(e.originalProofs),'Epoch inventory differs from unique original witness');e.originalProofsRef={witnessId:e.witnessId};delete e.originalProofs;}
 expandIndexedHistoryContext(c);return c;
}
/** References are data deduplication only. All host authority uses the expanded value. */
export function expandIndexedHistoryContext(context:any):any{
 if(!isIndexedCompact(context))return context;
 safeControlJSON(context);keys(context,['candidate','evolution','authorPresentation','acceptanceRef']);ensure(context.acceptanceRef==='evolution.current','Unknown acceptance reference');
 const c=structuredClone(context),e=c.evolution;ensure(e?.sourceRefresh&&Array.isArray(e.history?.specimens)&&Array.isArray(e.sourceRefresh.historicalEpochs),'Incomplete referenced history');
 const witnesses=e.history.specimens.flatMap((s:any)=>s.revision.witnesses);
 for(const w of witnesses){ensure(w.result&&!Object.hasOwn(w.result,'proofFiles'),'Mixed proof representation');keys(w.result.proofFilesRef,['from','order']);const ref=w.result.proofFilesRef,paths=Object.keys(w.proofs).sort();ensure(ref.from==='witness.proofs.keys'&&Array.isArray(ref.order)&&ref.order.length===paths.length&&new Set(ref.order).size===paths.length&&ref.order.every((i:unknown)=>Number.isSafeInteger(i)&&Number(i)>=0&&Number(i)<paths.length),'Unknown proof order reference');w.result.proofFiles=ref.order.map((i:number)=>paths[i]);delete w.result.proofFilesRef;}
 for(const epoch of e.sourceRefresh.historicalEpochs){ensure(!Object.hasOwn(epoch,'originalProofs'),'Mixed epoch representation');keys(epoch.originalProofsRef,['witnessId']);ensure(epoch.originalProofsRef.witnessId===epoch.witnessId,'Epoch reference identity changed');const matches=witnesses.filter((w:any)=>w.id===epoch.witnessId);ensure(matches.length===1,'Unknown or ambiguous epoch witness');epoch.originalProofs=structuredClone(matches[0].proofs);delete epoch.originalProofsRef;}
 c.acceptance=structuredClone(e.current);delete c.acceptanceRef;return c;
}
export function expandedAuthorInput<T>(input:T):T{
 const v=input as any;if(!isIndexedCompact(v?.context))return input;
 ensure(v.prompt===INDEXED_COMPACT_PROMPT,'Referenced author prompt marker changed');return {...v,context:expandIndexedHistoryContext(v.context)};
}
export function renderIndexedHistoryReferences(context:any,fullPrompt:string):string{
 const expanded=expandIndexedHistoryContext(context),old=canonical(expanded.evolution);ensure(fullPrompt.includes(old),'Complete evolution payload absent');
 return fullPrompt.replace(old,canonical(context.evolution))+'\n\nLossless references v1: acceptance is exactly evolution.current. Every result.proofFilesRef uses sorted Object.keys of that same witness.proofs, with order listing each zero-based index exactly once in original array order. Each epoch.originalProofsRef denotes the complete proofs map of its unique same-history witnessId. These are complete duplicate inventories, never permission to omit a source, check, ancestor or proof. All unique proof paths and hashes appear in full; host authority expands these references before every check.';
}
