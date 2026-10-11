/** A model suggests execution scope only. The host assigns cost and permissions. */
export interface GoalResearchGroups {
  schemaVersion: 1;
  groups: {id: string; purpose: string; materialIds: string[]; criterionIds: string[]}[];
}
/** Persisted host decision; a suggestion is never represented as dispatched work. */
export interface GoalResearchGroupingDecision {
  schemaVersion: 1;
  mode: 'single' | 'grouped';
  reason: string;
  groupCount: number;
  maxActive: number;
  perGroupReservation: number;
  groupReservation: number;
  totalProtectedReservation: number;
  registrationId: string | null;
}
export function goalResearchGroupsSchema(materialIds: readonly string[]): Record<string, unknown> {
  if (!materialIds.length || new Set(materialIds).size !== materialIds.length || materialIds.some(id => !id.trim())) {
    throw Error('Invalid original research material IDs');
  }
  const text = {type: 'string', minLength: 1, maxLength: 12000};
  const object = (properties: Record<string, unknown>) => ({type: 'object', additionalProperties: false,
    properties, required: Object.keys(properties)});
  return {anyOf: [{type: 'null'}, object({schemaVersion: {type: 'integer', const: 1},
    groups: {type: 'array', minItems: 1, maxItems: 32, items: object({
      id: {type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$'},
      purpose: {type: 'string', minLength: 1, maxLength: 2000},
      materialIds: {type: 'array', minItems: 1, maxItems: materialIds.length,
        items: {...text, enum: [...materialIds]}},
      criterionIds: {type: 'array', minItems: 1, maxItems: 64, items: text},
    })},
  })]};
}
