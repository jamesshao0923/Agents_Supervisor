import type {TaskContract} from './p1.js';
import type {MaterialIndex} from './p8-materials.js';
/** Integrity references only. These values never grant Run or P4 authority. */
export interface MaterialRef {directory:string;generation:string;indexDigest:string;inputDigest:string}
export interface ResearchRequirement {criterionId:string;question:string;requiredMaterialIds:string[];cutoff:string|null;maxSourceAgeMs:number}
export interface ResearchLimits {maxContextChars:number;maxClaims:number;maxCitations:number;maxQuoteChars:number}
export interface ResearchEvidenceContext {
 schemaVersion:1;purpose:'untrusted-research-evidence';contract:TaskContract;contractDigest:string;
 material:MaterialRef;requirements:ResearchRequirement[];index:MaterialIndex;
 sources:{materialId:string;textPath:string;rawDigest:string;textDigest:string;size:number}[];
 dependencyGroups:{materialIds:string[];reasons:('same-origin'|'identical-bytes')[]}[];
 limits:ResearchLimits;digest:string;
}
export interface CitationRequest {id:string;materialId:string;start:number;end:number;quote:string}
export interface BoundCitation extends CitationRequest {
 material:MaterialRef;coordinate:'utf16-code-units';rawDigest:string;textDigest:string;quoteDigest:string;
 acquiredAt:string;requestedURL:string|null;finalURL:string|null;
 representation:'utf8-text'|'utf8-html-source';
}
/** Every model statement, including status and classification, is a proposal. */
export interface ResearchProposal {
 schemaVersion:1;contextDigest:string;categories:{id:string;description:string}[];citations:CitationRequest[];
 claims:{id:string;criterionIds:string[];kind:'fact'|'inference'|'hypothesis';text:string;supportCitationIds:string[];counterCitationIds:string[];limitations:string[]}[];
 questions:{criterionId:string;status:'proposed-answer'|'gap';claimIds:string[];unresolved:string[]}[];
 materials:{materialId:string;categoryIds:string[];summary:string|null;citationIds:string[];unresolved:string[]}[];
 conflicts:{claimIds:string[];citationIds:string[];explanation:string}[];
 followups:{criterionIds:string[];reason:string}[];
}
export interface ValidatedResearchDraft {
 authority:'untrusted-draft-only';status:'proposed';contextDigest:string;proposal:ResearchProposal;citations:BoundCitation[];
 coverage:MaterialIndex['entries'];acquisition:{disposition:MaterialIndex['disposition'];completeness:MaterialIndex['completeness']};digest:string;
}
