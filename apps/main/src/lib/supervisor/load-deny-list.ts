// §24.5 — Union of the platform-wide deny list and the tenant supplemental
// list. Extracted from run-supervisor.ts so the BP24 streaming chat path
// (per-sentence supervisor) can load the same list once per turn without
// invoking the full runSupervisor pipeline.
//
// The platform list (BP11 key: 'supervisor_slur_deny_list') is non-removable
// by tenants; the supplemental list is tenant-additive only. Dedupe by
// lowercase value.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCachedPlatformSetting } from "@/lib/platform/platform-setting-cache";

export async function loadUnionSlurDenyList(
  db: SupabaseClient,
  tenant_id: string,
): Promise<string[]> {
  // #1586 — the platform slur list changes weekly-to-never; served from the
  // shared 60s cache. Fail-closed preserved: a read error still throws (the
  // cache surfaces the error rather than caching it), so the supervisor never
  // silently checks against an empty platform list.
  const { value: slurValue, error: platformErr } = await getCachedPlatformSetting(
    db,
    "supervisor_slur_deny_list",
  );
  if (platformErr) throw new Error(`supervisor_slur_deny_list.read failed: ${platformErr.message}`);

  const platformDenyList: string[] = Array.isArray(slurValue)
    ? (slurValue as string[])
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
