// BP37 §37.10 — Tier gating for tasks features.

import type { SupabaseClient } from "@supabase/supabase-js";

const SEQUENCES_BLOCKED: ReadonlySet<string> = new Set(["byo_research"]);
const CUSTOM_SEQUENCE_CREATION_ALLOWED: ReadonlySet<string> = new Set([
  "byo_agency",
  "sub_pro",
  "sub_agency",
]);
const ASSIGNMENT_ALLOWED: ReadonlySet<string> = new Set(["byo_agency", "sub_agency"]);

async function tierCode(tenant_id: string, db: Pick<SupabaseClient, "from">): Promise<string | null> {
  const { data } = await db
    .from("tenants")
    .select("tier_definitions!inner(code)")
    .eq("id", tenant_id)
    .maybeSingle();
  const t = (data as { tier_definitions?: { code?: string } | { code?: string }[] | null } | null)?.tier_definitions;
  return Array.isArray(t) ? t[0]?.code ?? null : t?.code ?? null;
}

export async function assertSequencesAvailable(
  tenant_id: string,
  db: Pick<SupabaseClient, "from">,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const code = await tierCode(tenant_id, db);
  if (code && SEQUENCES_BLOCKED.has(code)) {
    return { ok: false, reason: `sequences_not_available_for_tier:${code}` };
  }
  return { ok: true };
}

export async function assertCustomSequenceCreationAllowed(
  tenant_id: string,
  db: Pick<SupabaseClient, "from">,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const code = await tierCode(tenant_id, db);
  if (!code) return { ok: false, reason: "tenant_has_no_tier" };
  if (!CUSTOM_SEQUENCE_CREATION_ALLOWED.has(code)) {
    return { ok: false, reason: `custom_sequence_creation_blocked_for_tier:${code}` };
  }
  return { ok: true };
}

export async function assertAssignmentAllowed(
  tenant_id: string,
  db: Pick<SupabaseClient, "from">,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const code = await tierCode(tenant_id, db);
  if (!code) return { ok: false, reason: "tenant_has_no_tier" };
  if (!ASSIGNMENT_ALLOWED.has(code)) {
    return { ok: false, reason: `assignment_blocked_for_tier:${code}` };
  }
  return { ok: true };
}
