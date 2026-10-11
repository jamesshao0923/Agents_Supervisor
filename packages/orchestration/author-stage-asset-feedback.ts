import {AUTHOR_STAGE_PROTOCOL_V2, type AnyHostAuthorStageBinding, type AuthorNegativeStageV2} from '../contracts/p6-author-stages.js';
import {acceptanceAuthoringSchema, type AcceptanceAuthoringContext} from './acceptance-authoring.js';
import {authorStageOutputSchema, expandAuthorStages, validateAuthorStageBinding} from './author-stage-protocol.js';

export interface AuthorStageAssetRequirements {
  minFiles: number;
  maxFiles: number;
  requiredTargets: {path: string; criterionIds: string[]}[];
}
export interface AuthorStageControlAssetFeedback {
  controlId: string;
  bundleIndex: number;
  fragmentIndex: number;
  basePositiveId: string;
  basePositiveDigest: string;
  remainingFiles: string[];
  missingTargets: string[];
  violations: ('below-min-files' | 'above-max-files' | 'missing-required-target')[];
}
export type AuthorStageAssetFeedback = {
  schemaVersion: 1;
  kind: 'author-stage-expanded-control-feedback';
  available: true;
  requirements: AuthorStageAssetRequirements;
  controls: AuthorStageControlAssetFeedback[];
} | {
  schemaVersion: 1;
  kind: 'author-stage-expanded-control-feedback';
  available: false;
  reason: string;
};

/** Advisory data only: never edits assets or grants a stage/recovery/P4 verdict. */
export function describeAuthorStageAssetFeedback(options: {
  acceptance: AcceptanceAuthoringContext;
  binding: AnyHostAuthorStageBinding;
  parents: unknown[];
  raw: unknown;
}): AuthorStageAssetFeedback | null {
  const binding = validateAuthorStageBinding(options.binding);
  if (binding.protocol !== AUTHOR_STAGE_PROTOCOL_V2 || binding.index !== 2) return null;
  try {
    const {acceptance, parents, raw} = options;
    // This verifies the exact parent result digests and current stage schema.
    // Pure expansion intentionally preserves structurally rejected full assets.
    authorStageOutputSchema(acceptance, binding, parents);
    const bundle = expandAuthorStages(acceptance, parents[0], parents[1], raw);
    if (!acceptance.criteria.length || acceptance.criteria.some(c => c.kind !== 'command')) {
      throw new Error('Asset feedback requires the original command-only context');
    }
    const schema = acceptanceAuthoringSchema(acceptance) as {
      properties: {controls: {items: {properties: {files: {minItems: number; maxItems: number}}}}};
    };
    const {minItems: minFiles, maxItems: maxFiles} = schema.properties.controls.items.properties.files;
    if (!Number.isSafeInteger(minFiles) || !Number.isSafeInteger(maxFiles) || minFiles < 0 || maxFiles < minFiles) {
      throw new Error('Original complete control-file limits are unavailable');
    }
    const targets = new Map<string, string[]>();
    for (const criterion of acceptance.criteria) {
      targets.set(criterion.target, [...(targets.get(criterion.target) ?? []), criterion.id]);
    }
    const requiredTargets = [...targets].map(([path, criterionIds]) => ({path, criterionIds}));
    // expandAuthorStages already validates the raw negative structure, exact IDs,
    // base mappings/digests, paths and diff operations without repairing them.
    const negative = raw as AuthorNegativeStageV2;
    const controls = negative.controls.map((control, fragmentIndex): AuthorStageControlAssetFeedback => {
      const bundleIndex = bundle.controls.findIndex(c => c.id === control.id);
      if (bundleIndex < 0) throw new Error('Expanded control mapping unavailable');
      const remainingFiles = bundle.controls[bundleIndex]!.files.map(file => file.path);
      const missingTargets = requiredTargets.filter(target => !remainingFiles.includes(target.path)).map(target => target.path);
      const violations: AuthorStageControlAssetFeedback['violations'] = [];
      if (remainingFiles.length < minFiles) violations.push('below-min-files');
      if (remainingFiles.length > maxFiles) violations.push('above-max-files');
      if (missingTargets.length) violations.push('missing-required-target');
      return {controlId: control.id, bundleIndex, fragmentIndex,
        basePositiveId: control.basePositiveId, basePositiveDigest: control.basePositiveDigest,
        remainingFiles, missingTargets, violations};
    });
    return {schemaVersion: 1, kind: 'author-stage-expanded-control-feedback', available: true,
      requirements: {minFiles, maxFiles, requiredTargets}, controls};
  } catch (error) {
    return {schemaVersion: 1, kind: 'author-stage-expanded-control-feedback', available: false,
      reason: error instanceof Error ? error.message : String(error)};
  }
}
