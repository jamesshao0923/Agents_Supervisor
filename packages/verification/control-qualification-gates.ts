import type {VerificationResult,VerificationSpec} from '../contracts/p4.js';
import {parseVerificationSpec} from '../contracts/p4.js';
import {parseControlResult,safeControlJSON} from '../contracts/p4-controls.js';
import {evaluateVerification,selectInstances} from './rules.js';
export interface LegacyControlObservation {id:string;passed:boolean;results:VerificationResult[]}
/** Pure recomputation only; callers separately bind actual persisted proof bytes. */
export function legacyControlQualified(spec:VerificationSpec,id:string,results:VerificationResult[]):boolean {
 const control=spec.controls.find(c=>c.id===id);if(!control)return false;
 const selection=selectInstances(spec,{mode:'final'});
 if(results.length!==selection.instances.length||new Set(results.map(r=>r.instanceId)).size!==selection.instances.length)return false;
 for(const raw of results){const r=parseControlResult(raw),instance=selection.instances.find(i=>i.id===r.instanceId);if(!instance||r.executionStatus!=='executed'||r.checks.length!==instance.obligationIds.length||new Set(r.checks.map(c=>c.obligationId)).size!==instance.obligationIds.length||r.checks.some(c=>!instance.obligationIds.includes(c.obligationId)||!c.reason.trim()))return false;}
 if(control.expect==='passed')return evaluateVerification(spec,selection,results).complete;
 // Preserve the existing negative mustFail semantics. An unrelated passing
 // instance is allowed; an error/unknown cannot stand in for the required fault.
 return control.mustFail.every(id=>results.some(r=>r.checks.some(c=>c.obligationId===id&&c.verdict==='failed')));
}
export function assertLegacyControlQualification(specInput:VerificationSpec,controls:LegacyControlObservation[]):void {
 const spec=parseVerificationSpec(specInput);safeControlJSON(controls);const ids=spec.controls.map(c=>c.id);
 if(!ids.length||controls.length!==ids.length||new Set(controls.map(c=>c.id)).size!==ids.length||controls.some(c=>!ids.includes(c.id)||Object.keys(c).sort().join(',')!=='id,passed,results'||c.passed!==true||!legacyControlQualified(spec,c.id,c.results)))throw new Error('Complete declared control qualification evidence is missing or failed');
}
