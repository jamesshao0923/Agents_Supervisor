import {parseStageRecoveryInput,type PresentedStageRecoveryInput} from './author-stage-recovery-presentation.js';
/** Exact version dispatch only. Neither protocol confers approval or publication. */
import * as v1 from './acceptance-authoring-stages.js';
import * as v2 from './acceptance-authoring-stages-v2.js';
import * as command from './author-stage-command-presentation.js';
import {safeControlJSON} from '../contracts/p4-controls.js';
import {AUTHOR_STAGE_PROTOCOL, AUTHOR_STAGE_PROTOCOL_V2,
  type AnyHostAuthorStageBinding, type HostAuthorStageBinding, type HostAuthorStageBindingV2} from '../contracts/p6-author-stages.js';
import type {AcceptanceAuthoringContext} from './acceptance-authoring.js';
export {authorStageDigest} from './acceptance-authoring-stages.js';
export type {AnyHostAuthorStageBinding} from '../contracts/p6-author-stages.js';
export type PresentedAuthorStageInput = v1.PresentedAuthorStageInput | v2.PresentedAuthorStageInput | command.PresentedCommandStageInput | PresentedStageRecoveryInput;
export function isAuthorStageProtocol(value: unknown): value is typeof AUTHOR_STAGE_PROTOCOL | typeof AUTHOR_STAGE_PROTOCOL_V2 {
  return value === AUTHOR_STAGE_PROTOCOL || value === AUTHOR_STAGE_PROTOCOL_V2;
}
export function validateAuthorStageBinding(value: unknown): AnyHostAuthorStageBinding {
  safeControlJSON(value);
  return (value as {protocol?: unknown})?.protocol === AUTHOR_STAGE_PROTOCOL_V2
    ? v2.validateAuthorStageBinding(value) : v1.validateAuthorStageBinding(value);
}
export function parseAuthorStageInput(value: unknown): PresentedAuthorStageInput | null {
  const input = value as {prompt?:unknown;context?:{authorPresentation?:{schemaVersion?:unknown};authorStage?:{protocol?:unknown}}} | null;
  const recovery=parseStageRecoveryInput(value);if(recovery)return recovery;
  const current=command.parseCommandStageInput(value);if(current)return current;
  // Any V2 marker routes to its strict parser; inconsistent mixed markers never fall back.
  if (input?.prompt === v2.AUTHOR_STAGE_PROMPT || input?.context?.authorPresentation?.schemaVersion === 8
    || input?.context?.authorStage?.protocol === AUTHOR_STAGE_PROTOCOL_V2) return v2.parseAuthorStageInput(value);
  return v1.parseAuthorStageInput(value);
}
export function renderAuthorStageInput(options: {acceptance:AcceptanceAuthoringContext;candidate:unknown;binding:AnyHostAuthorStageBinding;parents:unknown[]}, presentationVersion?:6|8|9): PresentedAuthorStageInput {
  const binding=validateAuthorStageBinding(options.binding);
  if(presentationVersion!==undefined&&presentationVersion!==(binding.protocol===AUTHOR_STAGE_PROTOCOL_V2?8:6)&&!(binding.protocol===AUTHOR_STAGE_PROTOCOL_V2&&presentationVersion===9))throw new Error('Author stage protocol/presentation mismatch');
  if(presentationVersion===9)return command.renderCommandStageInput({...options,binding:binding as HostAuthorStageBindingV2});
  return binding.protocol === AUTHOR_STAGE_PROTOCOL_V2
    ? v2.renderAuthorStageInput({...options,binding}) : v1.renderAuthorStageInput({...options,binding});
}
/** New sessions only; advancing jobs must pass their stored presentation version. */
export function renderNewAuthorStageInput(options: Parameters<typeof renderAuthorStageInput>[0]): PresentedAuthorStageInput {
  return renderAuthorStageInput(options,options.binding.protocol===AUTHOR_STAGE_PROTOCOL_V2?9:6);
}
export function authorStageOutputSchema(context:AcceptanceAuthoringContext,binding:AnyHostAuthorStageBinding,parents:unknown[]) {
  const b=validateAuthorStageBinding(binding);
  return b.protocol === AUTHOR_STAGE_PROTOCOL_V2 ? v2.authorStageOutputSchema(context,b,parents) : v1.authorStageOutputSchema(context,b,parents);
}
export function renderAuthorStagePrompt(context:AcceptanceAuthoringContext,binding:AnyHostAuthorStageBinding,parents:unknown[],presentationVersion?:6|8|9) {
  const b=validateAuthorStageBinding(binding);
  if(presentationVersion!==undefined&&presentationVersion!==(b.protocol===AUTHOR_STAGE_PROTOCOL_V2?8:6)&&!(b.protocol===AUTHOR_STAGE_PROTOCOL_V2&&presentationVersion===9))throw new Error('Author stage protocol/presentation mismatch');
  if(presentationVersion===9)return command.renderCommandStagePrompt(context,b as HostAuthorStageBindingV2,parents);
  return b.protocol === AUTHOR_STAGE_PROTOCOL_V2 ? v2.renderAuthorStagePrompt(context,b,parents) : v1.renderAuthorStagePrompt(context,b,parents);
}
export function parseAuthorStageOutput(value:unknown,context:AcceptanceAuthoringContext,binding:AnyHostAuthorStageBinding,parents:unknown[]) {
  const b=validateAuthorStageBinding(binding);
  return b.protocol === AUTHOR_STAGE_PROTOCOL_V2 ? v2.parseAuthorStageOutput(value,context,b,parents) : v1.parseAuthorStageOutput(value,context,b,parents);
}
export function expandAuthorStages(context:AcceptanceAuthoringContext,definition:unknown,positive:unknown,negative:unknown) {
  safeControlJSON(definition);
  return (definition as {protocol?:unknown})?.protocol === AUTHOR_STAGE_PROTOCOL_V2
    ? v2.expandAuthorStages(context,definition,positive,negative) : v1.expandAuthorStages(context,definition,positive,negative);
}
export function assembleAuthorStages(context:AcceptanceAuthoringContext,definition:unknown,positive:unknown,negative:unknown) {
  safeControlJSON(definition);
  return (definition as {protocol?:unknown})?.protocol === AUTHOR_STAGE_PROTOCOL_V2
    ? v2.assembleAuthorStages(context,definition,positive,negative) : v1.assembleAuthorStages(context,definition,positive,negative);
}
