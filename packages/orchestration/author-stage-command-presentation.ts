import * as v2 from './acceptance-authoring-stages-v2.js';
import {safeControlJSON} from '../contracts/p4-controls.js';

export const AUTHOR_STAGE_COMMAND_PROMPT = 'Supervisor acceptance-stage command evidence presentation v9';
export type PresentedCommandStageInput = Omit<v2.PresentedAuthorStageInput,'context'> & {
  context: Omit<v2.PresentedAuthorStageInput['context'],'authorPresentation'> & {
    authorPresentation: {schemaVersion:9;kind:'acceptance-stage'};
  };
};

/** Instructions only: the original V2 schema, parent binding and P4 authority remain unchanged. */
export function renderCommandStagePrompt(...args: Parameters<typeof v2.renderAuthorStagePrompt>): string {
  return [
    'Command evidence presentation v9. At definition time, plan the executable evidence using the actual command ABI. candidateEntries declares frozen project-relative Node CLI entries which the host runs separately for EACH positive/negative control and the final candidate before the independent checker. The host records actual file digest, stdout/stderr, exit and confirmed stop; only if all declared entries execute successfully does the checker run. Those host records are not passed to the checker as readable files, parameters or an invented environment variable. The checker must still independently establish each behavioral obligation; a zero entry exit alone does not establish assertion coverage. Do not make a positive control require an unspecified evidence channel or observations which can only be created by the later P4 execution. New P4 entry execution does not prove a particular earlier development action: preserve any explicit historical requirement and use only actually supplied authenticated history, otherwise report the limitation without inventing a new contract requirement.',
    'The supplied TypeScript parser supports ordinary JavaScript syntax including computed property/element access; parsing is not a safety or behavioral verdict. A syntax form such as indexing is not itself prohibited behavior. Analyze the actual target and behavior required by the contract; do not impose a blanket syntax restriction or mark all computed access unsupported solely because the chosen checker does not analyze it. Do not assume every computed access is safe either. Where evidence is genuinely unavailable retain unknown; such a checker cannot qualify a known-valid positive control. The positive-stage implementation must be able to evaluate the complete frozen definition without adding contract restrictions or fixed unknown verdicts for missing invented channels.',
    v2.renderAuthorStagePrompt(...args),
  ].join('\n\n');
}

export function renderCommandStageInput(options: Parameters<typeof v2.renderAuthorStageInput>[0]): PresentedCommandStageInput {
  const old=v2.renderAuthorStageInput(options);
  return {...old,prompt:AUTHOR_STAGE_COMMAND_PROMPT,context:{...old.context,authorPresentation:{schemaVersion:9,kind:'acceptance-stage'}}};
}

export function parseCommandStageInput(value: unknown): PresentedCommandStageInput | null {
  const input=value as Partial<PresentedCommandStageInput>|null;
  const marker=input?.context?.authorPresentation;
  if(input?.prompt!==AUTHOR_STAGE_COMMAND_PROMPT&&marker?.schemaVersion!==9)return null;
  safeControlJSON(value);
  if(input?.prompt!==AUTHOR_STAGE_COMMAND_PROMPT||marker?.schemaVersion!==9||marker.kind!=='acceptance-stage')
    throw new Error('Author stages: unknown command evidence presentation');
  // Reuse the exact V2 validator, including all own keys, immutable context,
  // parent digests and schema. Never treat the adapted object as a stored job.
  const parsed=v2.parseAuthorStageInput({...input,prompt:v2.AUTHOR_STAGE_PROMPT,
    context:{...input.context,authorPresentation:{...marker,schemaVersion:8}}});
  if(!parsed)throw new Error('Author stages: missing V2 command input');
  return renderCommandStageInput({acceptance:parsed.context.acceptance,candidate:parsed.context.candidate,
    binding:parsed.context.authorStage,parents:parsed.context.authorStageParents});
}
