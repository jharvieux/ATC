// #903 / D-193 — Voice profile resolution.
//
// Resolution order (per operator decision in D-193):
//   1. Member's own profile (user_id = publicUserId)
//   2. Tenant house-style profile (user_id IS NULL)
//   3. null → Phase 3 falls back to persona-neutral professional tone
//
// Tenant isolation: tenantClient (db) auto-injects the tenant_id filter via
// its RLS proxy (DB layer). The user_id condition is the app layer.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface VoiceProfileResult {
  style_card: Record<string, unknown>;
  card_override: string | null;
  source: "own" | "house";
}

/**
 * Returns the applicable voice profile, or null if none exists.
 * Fails closed on DB errors so Phase 3 always has a safe fallback.
 *
 * @param db           tenantClient(ctx) — RLS auto-scopes to resolved tenant.
 * @param publicUserId public.users.id (NOT auth.users.id), or null for house-only.
 */
export async function resolveVoiceProfile(
  db: SupabaseClient,
  publicUserId: string | null,
): Promise<VoiceProfileResult | null> {
  const candidates: Array<{ uid: string | null; source: "own" | "house" }> = publicUserId
    ? [{ uid: publicUserId, source: "own" }, { uid: null, source: "house" }]
    : [{ uid: null, source: "house" }];

  for (const { uid, source } of candidates) {
    try {
      // .is() only works for null/boolean in PostgREST — use .eq() for string values.
      const q = db.from("voice_profiles").select("style_card, card_override");
      const filtered = uid === null ? q.is("user_id", null) : q.eq("user_id", uid);
      const { data, error } = await filtered.maybeSingle();

      if (error) {
        console.warn(`[resolve-voice-profile] DB error (source=${source}):`, error.message);
        return null;
      }
      if (data) {
        return {
          style_card: (data as { style_card: Record<string, unknown> }).style_card ?? {},
          card_override: (data as { card_override: string | null }).card_override ?? null,
          source,
        };
      }
    } catch (err) {
      console.warn(`[resolve-voice-profile] unexpected error:`, err);
      return null;
    }
  }
  return null;
}
