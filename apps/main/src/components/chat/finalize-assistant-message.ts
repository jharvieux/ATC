// BP39 — build the finalized assistant ChatMessage from accumulated SSE
// stream parts. Extracted from ChatExperience's `done` handler so the
// attach-assets / attach-citations contract is unit-testable without a DOM.
//
// The regression this guards: the `assets` SSE event was defined server-side
// but never attached to the message client-side, so [[display_asset:<id>]]
// markers had no backing asset and rendered as literal text.

import type { ChatMessage } from "./MessageBubble";
import type { DisplayAsset } from "./renderMessageContent";

type MsgCitation = NonNullable<ChatMessage["citations"]>[number];

export interface FinalizeAssistantMessageInput {
  content: string;
  assistantId: string | null;
  personaName: string;
  citations: MsgCitation[];
  assets: DisplayAsset[];
}

export function finalizeAssistantMessage(input: FinalizeAssistantMessageInput): ChatMessage {
  return {
    id: input.assistantId ?? `local-a-${Date.now()}`,
    role: "assistant",
    content: input.content,
    persona_display_name: input.personaName,
    created_at: new Date().toISOString(),
    ...(input.citations.length > 0 ? { citations: input.citations } : {}),
    ...(input.assets.length > 0 ? { assets: input.assets } : {}),
  };
}
