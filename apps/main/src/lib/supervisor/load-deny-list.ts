// §24.5 — Union of the platform-wide deny list and the tenant supplemental
// list. Extracted from run-supervisor.ts so the BP24 streaming chat path
// (per-sentence supervisor) can load the same list once per turn without
// invoking the full runSupervisor pipeline.
//
// The platform list (BP11 key: 'supervisor_slur_deny_list') is non-removable
// by tenants; the supplemental list is tenant-additive only. Dedupe by
// lowercase value.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function loadUnionSlurDenyList(
  db: SupabaseClient,
  tenant_id: string,
): Promise<string[]> {
  const { data: slurSetting, error: platformErr } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "supervisor_slur_deny_list")
    .maybeSingle();
  if (platformErr) throw new Error(`supervisor_slur_deny_list.read failed: ${platformErr.message}`);

  const platformDenyList: string[] = Array.isArray(slurSetting?.value)
    ? (slurSetting.value as string[])
    : [];

  const { data: tenantSupplemental, error: tenantErr } = await db
    .from("tenant_settings")
    .select("supplemental_hate_speech_denylist")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (tenantErr) throw new Error(`supplemental_hate_speech_denylist.read failed: ${tenantErr.message}`);

  const supplemental: string[] = Array.isArray(
    (tenantSupplemental as { supplemental_hate_speech_denylist?: unknown } | null)
      ?.supplemental_hate_speech_denylist,
  )
    ? ((tenantSupplemental as { supplemental_hate_speech_denylist: unknown[] })
        .supplemental_hate_speech_denylist as string[])
    : [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of [...platformDenyList, ...supplemental]) {
    const key = String(term).toLowerCase();
    if (!seen.has(key) && term) {
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}
