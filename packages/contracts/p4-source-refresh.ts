import type {SourceRefreshGenerationProof} from './p8-source-refresh.js';
import type {MaterialVerifierBinding,MaterialObservation} from './p4-material.js';
import type {SpecimenRef,FailureWitness} from './p4-controls.js';
/** Host-frozen provenance, never an author/caller exemption from current checks. */
export interface HistoricalMaterialEpoch {
 role:'historical';binding:MaterialVerifierBinding;
 originalJobId:string;originalProposalId:string;originalProofs:Record<string,string>;
 originalObservation:MaterialObservation;modelEventsPath:string;
 observedAt:string;specimen:SpecimenRef;witnessId:string;digest:string;
}
export interface SourceRefreshControlContext {
 rule:'same-input-refresh-v1';generation:SourceRefreshGenerationProof;
 previousBinding:MaterialVerifierBinding;currentBinding:MaterialVerifierBinding;
 historicalEpochs:HistoricalMaterialEpoch[];digest:string;
}
/** Each adaptation preserves the original immutable witness; only a separately
 * executed current specimen receives a new current-source witness. */
export interface SourceRefreshAdaptation {
 previous:SpecimenRef;successor:SpecimenRef;originalWitness:FailureWitness;
 currentWitnessId:string;obligationId:string;expectationDigest:string;
 contextDigest:string;
}
