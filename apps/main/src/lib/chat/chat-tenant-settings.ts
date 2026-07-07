// #1586 — Request-scoped `tenant_settings` fetch for the chat hot path.
//
// The chat route previously read `tenant_settings` up to three times per
// message (tone-override clamp, persona tone/profanity, streaming deny list),
// each pulling an overlapping column set. This consolidates the two
// common-path reads (tone clamp + persona tone/profanity) into ONE request-
// scoped fetch. The streaming deny-list read stays in load-deny-list.ts, which
// keeps its own fail-closed-throw semantics for the supervisor.
//
// Non-throwing by design: every field falls back to its documented default on
// a missing row (matches the prior inline `?? 3` / `?? false` reads). A missing
// tenant_settings row is a normal state, not an error.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ChatTenantSettings {
  personaToneMaxLevel: number;
  allowProfanity: boolean;
}

export async function loadChatTenantSettings(
  db: SupabaseClient,
  tenantId: string,
  onDbRead?: () => void,
): Promise<ChatTenantSettings> {
  onDbRead?.();
  const { data } = await db
    .from("tenant_settings")
    .select("persona_tone_max_level, allow_profanity")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const row = data as { persona_tone_max_level?: number; allow_profanity?: boolean } | null;
  return {
    personaToneMaxLevel: row?.persona_tone_max_level ?? 3,
    allowProfanity: row?.allow_profanity ?? false,
  };
}
