import type { ResearchEvidenceContext, ResearchProposal, ValidatedResearchDraft, BoundCitation } from '../contracts/p8-research.js';
import type { ResearchProjectionInput, ResearchProjection, ResearchGoalAppendProof } from '../contracts/p4-research-projection.js';
import { safeResultJSON } from '../contracts/p7-results.js';
import { parseResearchProposal, validateResearchProposal } from '../orchestration/research-proposal.js';
import { assertResearchEvidenceSnapshot, researchDigest,projectResearchEvidence,citableMaterial } from '../workspace/research-materials.js';
import {assertMaterialIndex,readBounded,bytesDigest} from '../workspace/research-runtime-files.js';
import type { MaterialIntake } from '../workspace/material-intake.js';

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw Error('Research projection: ' + message);
}

function frozenInput(input: ResearchProjectionInput): ResearchProjectionInput {
  safeResultJSON(input);
  ensure(input && [3,4].includes(Object.keys(input).length)
    && Object.keys(input).every(key=>['previous','current','report','goalAppend'].includes(key))
    && ['previous', 'current', 'report'].every(key => Object.hasOwn(input, key)), 'exact frozen inputs required');
  return structuredClone(input);
}

/** Acquisition timestamps and archive paths may differ; identity, every source
 * byte and all original question conditions must match. This is not freshness. */
export function researchSourceBasis(context: ResearchEvidenceContext): unknown {
  return {
    inputs: context.index.inputs,
    acquisitionLimits: context.index.limits,
    completeness: context.index.completeness,
    disposition: context.index.disposition,
    entries: context.index.entries.map(entry => ({
      id: entry.id, input: entry.input, status: entry.status,
      requestedURL: entry.requestedURL, finalURL: entry.finalURL,
      origin: entry.origin, contentType: entry.contentType,
      raw: entry.raw ? {sha256: entry.raw.sha256, size: entry.raw.size, complete: entry.raw.complete} : null,
      text: entry.text ? {sha256: entry.text.sha256, size: entry.text.size, complete: entry.text.complete} : null,
      representation: entry.representation, limitations: entry.limitations, error: entry.error,
      sameOriginAs: entry.sameOriginAs, contentDuplicateOf: entry.contentDuplicateOf
    })),
    dependencyGroups: context.dependencyGroups
  };
}

export function assertResearchProjectionCompatibility(previous: ResearchEvidenceContext, current: ResearchEvidenceContext, goalAppend?:ResearchGoalAppendProof|null): string {
  safeResultJSON({previous, current});
  for (const context of [previous, current]) {
    const {digest, ...body} = context;
    ensure(digest === researchDigest(body), 'context digest changed');
  }
  const basisDigest = researchDigest(researchSourceBasis(previous));
  ensure(basisDigest === researchDigest(researchSourceBasis(current)), 'source identity bytes coverage or dependence changed');
  ensure([previous.contract.version,current.contract.version].every(version=>Number.isSafeInteger(version)&&version>0),
    'contract versions must be positive Run-local integers');
  if(previous.contract.goal!==current.contract.goal){
    ensure(goalAppend,'changed goal needs actual applied append receipts');
    const {digest,...body}=goalAppend;
    ensure(researchDigest(body)===digest&&goalAppend.authority==='actual-applied-receipts-integrity-only'
      &&goalAppend.previousGoalDigest===researchDigest(previous.contract.goal)
      &&goalAppend.currentGoalDigest===researchDigest(current.contract.goal)
      &&goalAppend.previousContractDigest===previous.contractDigest
      &&goalAppend.currentContractDigest===current.contractDigest
      &&typeof goalAppend.previousRunId==='string'&&goalAppend.previousRunId.length>0
      &&typeof goalAppend.currentRunId==='string'&&goalAppend.currentRunId.length>0
      &&goalAppend.previousRunId!==goalAppend.currentRunId
      &&goalAppend.transitionIds.length>0&&goalAppend.appendedMessages.length>0
      &&current.contract.goal===previous.contract.goal+'\n'
        +goalAppend.appendedMessages.map(m=>`${m.id}: ${m.text}`).join('\n'),
      'original goal or actual exact appended requirements changed');
  }else {
    ensure(!goalAppend,'unnecessary goal append evidence');
    ensure(current.contract.version>=previous.contract.version,'original Run-local version decreased');
  }
  // An actual append receipt binds distinct Runs and both complete contracts.
  // Their positive version sequences are independent. This pure projection is
  // integrity only; production readers still rederive the actual DB lineage.
  ensure(researchDigest(previous.limits) === researchDigest(current.limits), 'report capacity/conditions changed');
  const oldIds = previous.requirements.map(req => req.criterionId);
  ensure(new Set(oldIds).size === oldIds.length
    && researchDigest(current.requirements.filter(req => oldIds.includes(req.criterionId)))
      === researchDigest(previous.requirements), 'old ordered questions cutoff or conditions changed');
  ensure(previous.contract.criteria.every(criterion => {
    const next = current.contract.criteria.find(item => item.id === criterion.id);
    return next && researchDigest(next) === researchDigest(criterion);
  }), 'original criterion changed or retired; no append projection permission');
  return basisDigest;
}

/** Keep retained records byte-for-byte as JSON values. Mixed tags, conflicts or
 * followups are unsupported rather than edited, omitted, or reclassified. */
export function projectCurrentResearchReport(input: ResearchProjectionInput): ResearchProjection {
  const {previous, current, report,goalAppend} = frozenInput(input);
  const sourceBasisDigest = assertResearchProjectionCompatibility(previous, current,goalAppend);
  const actual = parseResearchProposal(report, current);
  const oldIds = new Set(previous.requirements.map(req => req.criterionId));
  const questions = actual.questions.filter(question => oldIds.has(question.criterionId));
  const claimIds = new Set(questions.flatMap(question => question.claimIds));
  const claims = actual.claims.filter(claim => claimIds.has(claim.id));
  ensure(claims.every(claim => claim.criterionIds.every(id => oldIds.has(id))),
    'mixed old/new claim labels cannot be losslessly projected');
  ensure(actual.claims.every(claim => !claim.criterionIds.some(id => oldIds.has(id)) || claimIds.has(claim.id)),
    'old-scope claim omitted by old question answers');
  const conflicts = actual.conflicts.filter(conflict => conflict.claimIds.some(id => claimIds.has(id)));
  ensure(conflicts.every(conflict => conflict.claimIds.every(id => claimIds.has(id))),
    'cross-scope conflict cannot be losslessly projected; preserve full relation');
  const followups = actual.followups.filter(followup => followup.criterionIds.some(id => oldIds.has(id)));
  ensure(followups.every(followup => followup.criterionIds.every(id => oldIds.has(id))),
    'cross-scope followup cannot be losslessly projected');
  const projected: ResearchProposal = {
    ...actual,
    contextDigest: previous.digest,
    questions, claims, conflicts, followups
  };
  // Classification/material coverage and all literal citations remain complete,
  // including current citations: they are never silently erased to meet limits.
  parseResearchProposal(projected, previous);
  const body = {
    schemaVersion: 1 as const, rule: 'lossless-prior-questions-v1' as const,
    authority: 'projection-integrity-only' as const,
    previousGoalDigest:researchDigest(previous.contract.goal),currentGoalDigest:researchDigest(current.contract.goal),
    goalAppend:goalAppend??null,
    previousContextDigest: previous.digest, currentContextDigest: current.digest,
    currentReportDigest: researchDigest(actual), projectedReportDigest: researchDigest(projected),
    sourceBasisDigest, retainedQuestionIds: questions.map(question => question.criterionId),
    retainedClaimIds: claims.map(claim => claim.id), report: projected
  };
  return {...body, digest: researchDigest(body)};
}

/** Reads both real immutable archives and every exact span before/after
 * projection. Caller hashes or self-rehashed metadata are not sufficient. */
export async function validateCurrentResearchProjection(
  intake: MaterialIntake,
  input: ResearchProjectionInput
): Promise<ResearchProjection> {
  const frozen = frozenInput(input);
  await assertResearchEvidenceSnapshot(intake, frozen.previous);
  await assertResearchEvidenceSnapshot(intake, frozen.current);
  await validateResearchProposal({intake, context: frozen.current, output: frozen.report});
  const projected = projectCurrentResearchReport(frozen);
  await validateResearchProposal({intake, context: frozen.previous, output: projected.report});
  await assertResearchEvidenceSnapshot(intake, frozen.previous);
  await assertResearchEvidenceSnapshot(intake, frozen.current);
  return projected;
}

/** Synchronous host evidence check for the enclosing publication transaction.
 * Rebuilds from immutable actual index/bytes, not a caller-rehashed envelope. */
export function validateResearchProjectionDraftSync(
 context:ResearchEvidenceContext, output:unknown, dataRoot:string
):ValidatedResearchDraft {
 safeResultJSON({context,output});
 assertMaterialIndex(context.index,dataRoot);
 ensure(researchDigest(projectResearchEvidence(context.contract,context.requirements,context.limits,context.index))
  ===researchDigest(context),'actual projection context changed');
 const proposal=parseResearchProposal(output,context),citations:BoundCitation[]=[];
 for(const citation of proposal.citations){
  const entry=context.index.entries.find(e=>e.id===citation.materialId);
  ensure(entry&&citableMaterial(entry),'projection citation needs complete supported source');
  const source=context.sources.find(s=>s.materialId===citation.materialId);
  ensure(source,'projection literal source missing');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readBounded(source.textPath,context.index.limits.maxItemBytes));
  ensure(Number.isSafeInteger(citation.start)&&Number.isSafeInteger(citation.end)
   &&citation.start>=0&&citation.end>citation.start&&citation.end<=text.length
   &&text.slice(citation.start,citation.end)===citation.quote
   &&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(citation.quote),
   'projection literal quote or UTF16 span changed');
  citations.push({...structuredClone(citation),material:structuredClone(context.material),
   coordinate:'utf16-code-units',rawDigest:entry.raw!.sha256,textDigest:entry.text!.sha256,
   quoteDigest:bytesDigest(citation.quote),acquiredAt:entry.acquiredAt,
   requestedURL:entry.requestedURL,finalURL:entry.finalURL,representation:entry.representation!});
 }
 const body={authority:'untrusted-draft-only' as const,status:'proposed' as const,
  contextDigest:context.digest,proposal,citations,coverage:structuredClone(context.index.entries),
  acquisition:{disposition:context.index.disposition,completeness:context.index.completeness}};
 return {...body,digest:researchDigest(body)};
}
