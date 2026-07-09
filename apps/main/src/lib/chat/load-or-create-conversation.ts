// §24 phase 4 — load an existing conversation (audience-filtered) or create a
// fresh one. Extracted from handleChat so the mutable conversationId `let` and
// the two failure early-returns become one typed result the caller delivers.

import { randomUUID } from "node:crypto";
import type { ChatAudience } from "@/lib/personas/build-system-prompt";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ConversationResolution =
  | { ok: true; conversationId: string; activePersonaId: string | null; contactId: string | null }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "create_failed"; ref: string };

export async function loadOrCreateConversation(args: {
  svc: SupabaseClient;
  tenantId: string;
  audience: ChatAudience;
  conversationIdInput: string | null;
  userId: string | null;
  anonSessionId: string | null;
  isTest: boolean;
}): Promise<ConversationResolution> {
  const { svc, tenantId, audience, conversationIdInput, userId, anonSessionId, isTest } = args;

  if (conversationIdInput) {
    // #902: the audience filter blocks cross-register continuation — a TA
    // continuing a customer thread (or vice versa) would leak the wrong
    // Layer-2 rules into an existing transcript.
    const { data: conv } = await svc
      .from("conversations")
      .select("id, active_persona_id, contact_id")
      .eq("id", conversationIdInput)
      .eq("tenant_id", tenantId)
      .eq("audience", audience)
      .maybeSingle();
    if (!conv) return { ok: false, reason: "not_found" };
    const row = conv as { active_persona_id?: string | null; contact_id?: string | null };
    return {
      ok: true,
      conversationId: conversationIdInput,
      activePersonaId: row.active_persona_id ?? null,
      contactId: row.contact_id ?? null,
    };
  }

  // §15.12 sandbox: stamp is_test on the conversation row at creation time.
  // Snapshot semantics — a tenant who toggles is_sandbox later does NOT
  // retroactively flip existing rows.
  const { data: created, error: createErr } = await svc
    .from("conversations")
    .insert({
      tenant_id: tenantId,
      user_id: userId,
      anonymous_session_id: !userId ? anonSessionId : null,
      audience,
      status: "active",
      first_message_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      message_count: 0,
      is_test: isTest,
    })
    .select("id")
    .single();
  if (createErr || !created) {
    // F-leak-01: generic message + server-logged ref, never the raw DB error.
    const ref = randomUUID();
    console.error("[chat] ref=%s conversation_create_failed", ref, createErr);
    return { ok: false, reason: "create_failed", ref };
  }

  return {
    ok: true,
    conversationId: (created as { id: string }).id,
    activePersonaId: null,
    contactId: null,
  };
}
