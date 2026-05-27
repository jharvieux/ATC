// §27.12 — Daily AI pricing staleness check.
//
// Vendor pricing is operator-managed via PUT /api/admin/ai-pricing (web
// scrapers are ToS-exposed + brittle, so we don't auto-fetch). This cron
// flips platform_settings.ai_pricing_stale to 'true' when the last
// operator update is more than STALENESS_DAYS old, so the admin dashboard
// can show a yellow banner reminding the operator to re-verify vendor
// pricing pages.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

const STALENESS_DAYS = 30;

// D-091 / error-injection probe — inner body extracted for direct test
// invocation.
export interface AiPricingCacheRefreshResult {
  ok: boolean;
  last_refreshed_at: string | null;
  stale: boolean;
}

export async function runAiPricingCacheRefresh(): Promise<AiPricingCacheRefreshResult> {
  const svc = createServiceRoleClient();

  const { data: row } = await svc
    .from("platform_settings")
    .select("value")
    .eq("key", "ai_pricing_last_refreshed_at")
    .maybeSingle();

  const lastRefreshed = (row?.value as string | undefined) ?? null;
  const stale = lastRefreshed
    ? Date.now() - new Date(lastRefreshed).getTime() > STALENESS_DAYS * 24 * 60 * 60 * 1000
    : true;

  await svc
    .from("platform_settings")
    .upsert(
      {
        key: "ai_pricing_stale",
        value: stale,
        description: "§27.12 — true when ai_pricing_last_refreshed_at is older than STALENESS_DAYS.",
      },
      { onConflict: "key" },
    );

  return { ok: true, last_refreshed_at: lastRefreshed, stale };
}

export const aiPricingCacheRefresh = inngest.createFunction(
  {
    id: "ai-pricing-cache-refresh",
    triggers: [{ cron: "0 8 * * *" }], // daily 08:00 UTC
  },
  runAiPricingCacheRefresh,
);
