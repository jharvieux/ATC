// Tests for the chat-request body shape. The branch that flips on
// `personaSlug` is the contract Phase 5c added — without it,
// /chat/[slug] would silently fall back to the default persona and the
// per-agent UI would be a lie.

import { describe, it, expect } from "vitest";
import { buildChatRequestBody } from "@/components/chat/build-chat-request-body";

describe("buildChatRequestBody", () => {
  it("omits persona_slug entirely when no slug is provided (the default /chat path's request shape)", () => {
    // The chat API reads `body.persona_slug ?? null`, but the audit
    // memory (D-091 pattern 5) prefers minimal payloads — an absent
    // field is unambiguous, whereas `undefined` JSON-stringifies away
    // and would mask a future contract change.
    const body = buildChatRequestBody({
      message: "hi",
      conversation_id: null,
    });
    expect(body).toEqual({ message: "hi", conversation_id: null });
    expect("persona_slug" in body).toBe(false);
  });

  it("includes persona_slug exactly when the slug is set (the /chat/[slug] contract)", () => {
    // This is the path /chat/marcus-cole etc. depends on — if this stops
    // forwarding the slug, the chat backend silently serves the default
    // persona and no error surfaces.
    const body = buildChatRequestBody({
      message: "tell me about Aruba",
      conversation_id: "conv-123",
      personaSlug: "marcus-cole",
    });
    expect(body).toEqual({
      message: "tell me about Aruba",
      conversation_id: "conv-123",
      persona_slug: "marcus-cole",
    });
  });

  it("treats an empty-string slug as no slug (defensive — caller shouldn't pass it but we don't want to ship `persona_slug: ''` to the API)", () => {
    const body = buildChatRequestBody({
      message: "hi",
      conversation_id: null,
      personaSlug: "",
    });
    expect("persona_slug" in body).toBe(false);
  });
});
