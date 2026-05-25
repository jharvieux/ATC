// BP38 §38.9 — Tier gating: BYO Research max 1 option, others up to 5.

import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_OPTIONS_BY_TIER: Record<string, number> = {
  byo_research: 1,
};
const DEFAULT_MAX = 5;

export async function getMaxOptionsForTenant(
  tenant_id: string,
  db: Pick<SupabaseClient, "from">,
): Promise<number> {
  const { data } = await db
    .from("tenants")
    .select("tier_definitions!inner(code)")
    .eq("id", tenant_id)
    .maybeSingle();
  const t = (data as { tier_definitions?: { code?: string } | { code?: string }[] | null } | null)?.tier_definitions;
  const code = Array.isArray(t) ? t[0]?.code : t?.code;
  if (code && MAX_OPTIONS_BY_TIER[code] !== undefined) {
    return MAX_OPTIONS_BY_TIER[code]!;
  }
  return DEFAULT_MAX;
}
