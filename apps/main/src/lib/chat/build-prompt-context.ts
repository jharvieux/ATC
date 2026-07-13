// #1759/#1781 — prompt-assembly phase, extracted verbatim from handleChat.
//
// Owns persona/tone resolution, RAG retrieve, and the system-prompt build:
// resolves the active persona, looks up customer rapport tone memory,
// retrieves RAG context (and emits the `persona`/`sources` SSE events),
// resolves the turn's tone level, assembles the displayable-assets +
// pricing-anchors + customer-context + help-context prompt blocks, and
// builds the final system prompt (with §24.9 persona augmentation appended).
//
// The caller keeps the orchestration spine: identity/quota/conversation
// resolution runs BEFORE this; generation + delivery run AFTER.

import type { SupabaseClient } from "@supabase/supabase-js";
import { retrieveForChat, type RetrieveForChatResult } from "@/lib/rag/retrieve-for-chat";
import { resolveToneLevel } from "@/lib/chat/tone-resolution";
import { resolveActivePersonaSlug } from "@/lib/personas/resolve-active-persona-slug";
import { buildDisplayableAssetsBlock } from "@/lib/ai/display-assets-block";
import { resolveCustomerContext, type CustomerContextRef } from "@/lib/chat/customer-context";
import { buildHelpContextBlock } from "@/lib/chat/help-context";
import { buildSystemPrompt, type ChatAudience } from "@/lib/personas/build-system-prompt";

// The SSE events this phase emits — a structural subset of the route's
// SseEvent union, so the route's `send` is directly assignable.
export type PromptContextSseEvent =
  | { type: "persona"; slug: string; display_name: string }
  | { type: "sources"; citations: unknown[] };

type TurnMessage = { role: "user" | "assistant"; content: unknown };

export type BuildPromptContextArgs = {
  svc: SupabaseClient;
  tenantId: string;
  audience: ChatAudience;
  userId: string | null;
  conversationId: string;
  chatHistory: TurnMessage[];
  userMessage: string;
  personaSlugInput: string | null;
  conversationActivePersonaId: string | null;
  tenantTier: string;
  tenantMaxTone: number;
  customerContextRef: CustomerContextRef | null;
  personaAugmentation: string | null;
  send: (ev: PromptContextSseEvent) => Promise<void>;
};

export type PromptContextResult = {
  personaSlug: string;
  systemPrompt: string;
  retrieval: RetrieveForChatResult;
  availableAssetIds: string[];
};

export async function buildPromptContext(args: BuildPromptContextArgs): Promise<PromptContextResult> {
  const {
    svc,
    tenantId,
    audience,
    userId,
    conversationId,
    chatHistory,
    userMessage,
    personaSlugInput,
    conversationActivePersonaId,
    tenantTier,
    tenantMaxTone,
    customerContextRef,
    personaAugmentation,
    send,
  } = args;

  // §24.6 precedence: switched persona (conversation.active_persona_id) wins
  // over the request body, which wins over the default. See resolver.
  const personaSlug = await resolveActivePersonaSlug(svc, {
    activePersonaId: conversationActivePersonaId,
    requestedSlug: personaSlugInput,
  });

  let customerRapportLevel: number | null = null;
  let customerRapportDirective: "direct" | null = null;
  if (userId && audience === "customer") {
    const { data: mem } = await svc
      .from("customer_memories")
      .select("rapport_tone_level, rapport_tone_directive")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .maybeSingle();
    customerRapportLevel = (mem as { rapport_tone_level?: number } | null)?.rapport_tone_level ?? null;
    customerRapportDirective = (mem as { rapport_tone_directive?: "direct" } | null)?.rapport_tone_directive ?? null;
  }

  // Build conversation context for entity extraction: last 4 history entries,
  // trimmed so follow-up questions like "send the deck plan" can resolve back
  // to the ship being discussed without re-mentioning it.
  const contextMessages = chatHistory
    .slice(-4)
    .map((m) => {
      const text = typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type?: string; text?: string }>)
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join(" ");
      return { role: m.role as "user" | "assistant", text: text.slice(0, 250) };
    })
    .filter((m) => m.text.trim().length > 0);

  const retrieval = await retrieveForChat({
    message: userMessage,
    tenant_id: tenantId,
    // #850 — user_id MUST be a real users.id or null. ai_call_log.user_id has an
    // FK to users(id), and entity_extraction's wrapper writes that row mid-retrieval.
    // Passing the anon session id here FK-violated the insert → extraction threw →
    // empty entities → the concierge ignored ship+date itinerary data on every
    // anonymous turn. Anon attribution is carried by conversation_id
    // (conversations.anonymous_session_id), never user_id.
    user_id: userId,
    conversation_id: conversationId,
    persona_id: personaSlug,
    // #902: the closed-promo gate hides promos from non-booked CUSTOMERS;
    // a staff member is entitled to see their own tenant's promos.
    customer_has_booking: audience === "tenant_member",
    context_messages: contextMessages,
  });

  await send({ type: "persona", slug: personaSlug, display_name: personaSlug });
  if (retrieval.citations.length > 0) {
    await send({ type: "sources", citations: retrieval.citations });
  }

  // #902: TA mode pins professional tone (D-195) — customer rapport memory and
  // message-driven tone resolution are customer-audience machinery.
  const tone = audience === "tenant_member"
    ? { level: 2 }
    : resolveToneLevel({
        tenant_max_level: tenantMaxTone,
        persona_slug: personaSlug,
        customer_rapport_level: customerRapportLevel,
        customer_rapport_directive: customerRapportDirective,
        customer_message: userMessage,
        ...(retrieval.entities.intent === "support" ? { topic: "cancellation_complaint" as const } : {}),
      });

  // BP39 §33.7.1 — build the DISPLAYABLE ASSETS prompt block from the
  // assets retrieveForChat surfaced (already scope-filtered + chunk-filtered).
  const displayableAssetsBlock = buildDisplayableAssetsBlock(retrieval.assets);
  const availableAssetIds = retrieval.assets.map((a) => a.asset_id);

  // §33.7 D-088 — build the PRICING ANCHORS block from the conversation's
  // entities. Reads general_pricing_ranges + applies the +10%/$100 round
  // rule. Empty string when no entities or feature flag is off.
  const { buildPricingAnchorsBlock } = await import("@/lib/pricing/build-pricing-anchors-block");
  const pricingAnchorsBlock = await buildPricingAnchorsBlock(svc, {
    cruiseLines: retrieval.entities.cruise_lines,
    ships: retrieval.entities.ships,
  });

  // §20.4 — Customer context: server-resolves the ref against the tenant.
  // A bad/cross-tenant ref returns null; we silently drop it (no error
  // surfaced to the client because context is best-effort enrichment).
  const customerContext = audience === "customer" && customerContextRef
    ? await resolveCustomerContext({ ref: customerContextRef, tenant_id: tenantId, db: svc })
    : null;

  // #902 — PLATFORM HELP CONTEXT is built ONLY on the TA branch: customer
  // prompts structurally never contain platform-internals content.
  const helpContextBlock = audience === "tenant_member"
    ? buildHelpContextBlock(userMessage, tenantTier)
    : null;

  const systemPromptBase = await buildSystemPrompt({
    persona_slug: personaSlug,
    tenant_id: tenantId,
    tenant_tier: tenantTier,
    tone_level: tone.level,
    db: svc,
    audience,
    knowledge_block: retrieval.knowledge_block,
    ...(displayableAssetsBlock ? { displayable_assets_block: displayableAssetsBlock } : {}),
    ...(pricingAnchorsBlock ? { pricing_anchors_block: pricingAnchorsBlock } : {}),
    ...(customerContext ? { customer_context: customerContext } : {}),
    ...(helpContextBlock ? { help_context_block: helpContextBlock } : {}),
  });

  // Append the §24.9 persona augmentation if Soft1/Soft2 fired.
  let systemPrompt = systemPromptBase.prompt;
  if (personaAugmentation) {
    systemPrompt += `\n\n[Soft-tier note for this turn]\n${personaAugmentation}`;
  }

  return { personaSlug, systemPrompt, retrieval, availableAssetIds };
}
