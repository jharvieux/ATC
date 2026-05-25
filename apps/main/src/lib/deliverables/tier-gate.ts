// BP39 §39.9 — Tier gating: BYO Research blocked from deliverables.

import type { SupabaseClient } from "@supabase/supabase-js";

const BLOCKED: ReadonlySet<string> = new Set(["byo_research"]);

export async function assertDeliverablesAvailable(
  tenant_id: string,
  db: Pick<SupabaseClient, "from">,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data } = await db
    .from("tenants")
    .select("tier_definitions!inner(code)")
    .eq("id", tenant_id)
    .maybeSingle();
  const t = (data as { tier_definitions?: { code?: string } | { code?: string }[] | null } | null)?.tier_definitions;
  const code = Array.isArray(t) ? t[0]?.code : t?.code;
  if (!code) return { ok: false, reason: "tenant_has_no_tier" };
  if (BLOCKED.has(code)) return { ok: false, reason: `deliverables_not_available_for_tier:${code}` };
  return { ok: true };
}
