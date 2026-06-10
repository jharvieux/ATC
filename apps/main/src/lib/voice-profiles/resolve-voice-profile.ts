// #903 / D-193 — Voice profile resolution.
//
// The Phase 3 draft composer calls this before generating a draft reply.
// Resolution order (per operator decision in D-193):
//   1. Member's own profile (user_id = publicUserId)
//   2. Tenant house-style profile (user_id = NULL in the DB)
//   3. null → Phase 3 falls back to persona-neutral professional tone
//
// Tenant isolation: tenantClient (db) auto-injects the tenant_id filter via
// its RLS proxy (DB layer). The user_id .is() condition is the app layer.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface VoiceProfileResult {
  style_card: Record<string, unknown>;
  card_override: string | null;
  /** Whether this is the user's own profile or the tenant house default. */
  source: "own" | "house";
}

/**
 * Returns the applicable voice profile for a (tenant, user) pair, or null
 * when none exists. Fails closed on DB errors (returns null) so Phase 3
 * always has a safe fallback.
 *
 * @param db           tenantClient(ctx) — RLS auto-scopes to resolved tenant.
 * @param publicUserId public.users.id (NOT auth.users.id), or null to fetch
 *                     house style only.
 */
export async function resolveVoiceProfile(
  db: SupabaseClient,
  publicUserId: string | null,
): Promise<VoiceProfileResult | null> {
  // Try own profile first, then house style.
  const candidates: Array<{ uid: string | null; source: "own" | "house" }> = publicUserId
    ? [{ uid: publicUserId, source: "own" }, { uid: null, source: "house" }]
    : [{ uid: null, source: "house" }];

  for (const { uid, source } of candidates) {
    try {
      const { data, error } = await db
        .from("voice_profiles")
        .select("style_card, card_override")
        .is("user_id", uid)
        .maybeSingle();

      if (error) {
        console.warn(`[resolve-voice-profile] DB error (source=${source}):`, error.message);
        return null; // fail closed — don't try fallback after a DB error
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
