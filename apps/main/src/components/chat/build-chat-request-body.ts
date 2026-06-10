// Pure body-builder for POST /api/chat. Extracted from ChatExperience so
// the conditional `persona_slug` spread can be unit-tested without
// spinning up a DOM + form-submit simulation. The shape mirrors what the
// chat API reads from req.json() (see app/api/chat/route.ts).

export interface ChatRequestBodyInputs {
  message: string;
  conversation_id: string | null;
  /** Optional — when set, pins the request to a specific persona. The chat
   *  API reads `body.persona_slug` and resolves the matching persona via
   *  resolveActivePersonaSlug. `undefined` explicitly allowed because
   *  exactOptionalPropertyTypes makes `?: string` reject the React state
   *  shape that yields `string | undefined`. */
  personaSlug?: string | undefined;
  // #902 — "ta" requests the tenant_member audience. The route verifies
  // eligibility server-side; omitting it defaults to customer mode.
  mode?: "ta" | undefined;
}

export function buildChatRequestBody(
  inputs: ChatRequestBodyInputs,
): Record<string, unknown> {
  return {
    message: inputs.message,
    conversation_id: inputs.conversation_id,
    // Conditional spread — omit the field entirely when slug is absent,
    // rather than sending `persona_slug: undefined`. The API treats
    // missing vs explicit-null differently in some places, so keeping the
    // shape minimal matches the prior /chat behaviour.
    ...(inputs.personaSlug ? { persona_slug: inputs.personaSlug } : {}),
    ...(inputs.mode ? { mode: inputs.mode } : {}),
  };
}
