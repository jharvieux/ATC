// BP36 §36.10 — Reports tier gate. BYO Research has no reports.

import type { SupabaseClient } from "@supabase/supabase-js";

const BLOCKED: ReadonlySet<string> = new Set(["byo_research"]);

export async function assertReportsAccessible(
  tenant_id: string,
  db: Pick<SupabaseClient, "from">,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data, error } = await db
    .from("tenants")
    .select("tier_definitions!inner(code)")
    .eq("id", tenant_id)
    .maybeSingle();
  if (error) return { ok: false, reason: `tier_lookup_failed:${error.message}` };
  if (!data) return { ok: false, reason: "tenant_not_found" };
  const t = (data as { tier_definitions?: { code?: string } | { code?: string }[] | null }).tier_definitions;
  const code = Array.isArray(t) ? t[0]?.code : t?.code;
  if (!code) return { ok: false, reason: "tenant_has_no_tier" };
  if (BLOCKED.has(code)) return { ok: false, reason: `reports_not_available_for_tier:${code}` };
  return { ok: true };
}
