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
import type { CachedTenantSnapshot } from "@/lib/abuse/snapshot";

export interface ChatTenantFlags {
  tenantTier: string;
  isSandbox: boolean;
  aiPausedByPlatform: boolean;
}

// #1586 — derive the chat route's tenant flags from the (nullable) snapshot.
// Pure so these SECURITY-CRITICAL defaults are unit-tested without driving the
// whole SSE handler:
//   • isSandbox FAILS CLOSED to true on snapshot failure — mislabeling a
//     sandbox conversation as real corrupts the abuse firewall (not
//     recoverable); over-tagging a real one only under-counts metrics.
//   • aiPausedByPlatform FAILS OPEN to false — a read blip must not pause a
//     healthy tenant.
// A genuine not-found tenant returns the snapshot stub (is_sandbox=false),
// matching the prior inline read's Boolean(null?.is_sandbox) === false.
export function deriveChatTenantFlags(
  snapshot: CachedTenantSnapshot | null,
): ChatTenantFlags {
  return {
    tenantTier: snapshot?.tenant.tier_code ?? "byo_research",
    isSandbox: snapshot ? snapshot.is_sandbox : true,
    aiPausedByPlatform: snapshot ? snapshot.ai_paused_by_platform : false,
  };
}

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
