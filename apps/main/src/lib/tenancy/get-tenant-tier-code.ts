// #444 — Shared tenant → tier_definitions.code lookup.
//
// Returns null when the tenant is missing, has no tier assigned, or the
// read fails — callers treat null as least-privilege (no tier-gated
// features). Accepts any Supabase client; callers pick the right one for
// their path (service-role, tenantClient, …).

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export async function getTenantTierCode(
  db: SupabaseClient,
  tenantId: string,
): Promise<string | null> {
  const { data } = await db
    .from("tenants")
    .select("tier_definitions!inner(code)")
    .eq("id", tenantId)
    .maybeSingle();

  // D-265: forward-FK embeds may come back as object OR array.
  const t = (data as { tier_definitions?: { code?: string } | { code?: string }[] | null } | null)
    ?.tier_definitions;
  return Array.isArray(t) ? t[0]?.code ?? null : t?.code ?? null;
}
