// BP34 §34.9 — Tier applicability for import features.
//
// Returns a short reason string when the tenant's tier is not permitted
// to use the given intake path; null when permitted.

import type { SupabaseClient } from "@supabase/supabase-js";

export type IntakePath = "email" | "document" | "manual";

const PERMITTED: Record<IntakePath, ReadonlySet<string>> = {
  // All tiers can hand-key a lead.
  manual: new Set([
    "byo_research",
    "byo_professional",
    "byo_agency",
    "sub_starter",
    "sub_pro",
    "sub_agency",
  ]),
  // Email + document require >= BYO Pro (research has no Gmail integration);
  // sub-host tiers can email-import but commission-statement and
  // bookings-of-record-elsewhere are blocked downstream in the pipeline.
  email: new Set([
    "byo_professional",
    "byo_agency",
    "sub_starter",
    "sub_pro",
    "sub_agency",
  ]),
  document: new Set([
    "byo_professional",
    "byo_agency",
    "sub_starter",
    "sub_pro",
    "sub_agency",
  ]),
};

export async function assertIntakePathPermitted(
  tenant_id: string,
  path: IntakePath,
  db: Pick<SupabaseClient, "from">,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data, error } = await db
    .from("tenants")
    .select("tier_id, tier_definitions!inner(code)")
    .eq("id", tenant_id)
    .maybeSingle();

  if (error) return { ok: false, reason: `tier_lookup_failed: ${error.message}` };
  if (!data) return { ok: false, reason: "tenant_not_found" };

  // The Supabase join shape comes back as { tier_definitions: { code } }.
  const tierCode =
    (data as { tier_definitions?: { code?: string } | { code?: string }[] | null }).tier_definitions;
  const code = Array.isArray(tierCode) ? tierCode[0]?.code : tierCode?.code;

  if (!code) return { ok: false, reason: "tenant_has_no_tier" };
  if (!PERMITTED[path].has(code)) {
    return { ok: false, reason: `intake_path_not_permitted_for_tier:${code}:${path}` };
  }
  return { ok: true };
}

// §34.9 — bookings-of-record-elsewhere are BYO-only (sub-host has no
// external host by definition). Called by the promoter when document_type
// is booking_confirmation.
export function isBookingImportPermittedForTenantType(tenant_type: string): boolean {
  return tenant_type === "byo_host";
}
