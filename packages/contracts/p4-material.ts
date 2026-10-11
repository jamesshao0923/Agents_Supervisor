/** Native P4 provenance; this binding is captured from actual Run-owned activity. */
export interface MaterialVerifierBinding {
 schemaVersion:1;operationId:string;executionId:string;inputPath:string;inputDigest:string;completionPath:string;completionDigest:string;contextDigest:string;
}
export interface MaterialVerifier {kind:'material';version:string;claimFile:string;binding:MaterialVerifierBinding;timeoutMs:number}
export interface MaterialProjectionObservation {
 rule:'lossless-prior-questions-v1';currentBinding:MaterialVerifierBinding;
 currentClaimDigest:string;projectionDigest:string;
}
export interface MaterialObservation {projection?:MaterialProjectionObservation;schemaVersion:1;binding:MaterialVerifierBinding;observedAt:string;sourceAcquiredAt:string;maxAgeMs:number;coverage:{completeness:'complete'|'partial';disposition:'completed'|'cancelled'|'deadline'};proofPath:string;proofDigest:string}
const obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const text={type:'string',minLength:1,maxLength:4096};const sha={type:'string',minLength:64,maxLength:64};
export const MATERIAL_BINDING_SCHEMA=obj({schemaVersion:{type:'integer',const:1},operationId:text,executionId:text,inputPath:text,inputDigest:sha,completionPath:text,completionDigest:sha,contextDigest:sha});
export function materialVerifierSchema(bindings:MaterialVerifierBinding[]):Record<string,unknown>{if(!bindings.length)throw Error('Material verifier requires an actual host binding');return obj({kind:{type:'string',const:'material'},version:text,claimFile:text,binding:{anyOf:bindings.map(binding=>obj(Object.fromEntries(Object.entries(binding).map(([key,value])=>[key,{type:typeof value==='number'?'integer':'string',const:value}]))))},timeoutMs:{type:'integer',minimum:1000,maximum:3600000}});}
export function parseMaterialVerifier(value:unknown):MaterialVerifier {
 const v=value as MaterialVerifier;const exact=(o:unknown,keys:string[])=>{if(!o||typeof o!=='object'||Array.isArray(o)||![Object.prototype,null].includes(Object.getPrototypeOf(o)))throw Error('Invalid material verifier object');const descriptors=Object.getOwnPropertyDescriptors(o);if(Reflect.ownKeys(o).length!==keys.length||keys.some(k=>!descriptors[k]||!Object.hasOwn(descriptors[k]!,'value')||!descriptors[k]!.enumerable))throw Error('Invalid material verifier fields');};
 exact(v,['kind','version','claimFile','binding','timeoutMs']);exact(v.binding,['schemaVersion','operationId','executionId','inputPath','inputDigest','completionPath','completionDigest','contextDigest']);
 if(v.kind!=='material'||v.binding.schemaVersion!==1||!Number.isSafeInteger(v.timeoutMs)||v.timeoutMs<1000||v.timeoutMs>3600000)throw Error('Invalid native material verifier');
 for(const name of ['version','claimFile'] as const)if(typeof v[name]!=='string'||!v[name].trim()||v[name].length>4096||v[name].includes('\0'))throw Error('Invalid material field');
 if(v.claimFile.startsWith('/')||/[\\\0?#]/.test(v.claimFile)||v.claimFile.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('Invalid material claim path');
 for(const name of ['operationId','executionId','inputPath','completionPath'] as const)if(typeof v.binding[name]!=='string'||!v.binding[name].trim()||v.binding[name].includes('\0')||v.binding[name].length>4096)throw Error('Invalid material binding');
 for(const name of ['inputPath','completionPath'] as const)if(!v.binding[name].startsWith('/')||v.binding[name].split('/').some(x=>x==='.'||x==='..'))throw Error('Material binding must use an exact host path');
 for(const name of ['inputDigest','completionDigest','contextDigest'] as const)if(!/^[a-f0-9]{64}$/.test(v.binding[name]))throw Error('Invalid material binding digest');return structuredClone(v);
}
