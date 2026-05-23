// §27.12 — Daily AI pricing cache refresh.
//
// The actual scrape of Anthropic + OpenAI pricing pages is operator-
// maintained because vendor pages change format. This cron exists as the
// schedule + the timestamp bump so operators have a single signal that
// "pricing hasn't been refreshed in N days".

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const aiPricingCacheRefresh = inngest.createFunction(
  {
    id: "ai-pricing-cache-refresh",
    triggers: [{ cron: "0 8 * * *" }], // daily 08:00 UTC
  },
  async () => {
    const svc = createServiceRoleClient();

    // TODO(operator): fetch Anthropic + OpenAI pricing pages, parse the
    // catalog, and upsert into platform_settings.ai_pricing_catalog.
    // Pricing pages change format; operator owns the parsers.
    console.warn("[ai-pricing-cache-refresh] auto-fetch not implemented; bumping last_refreshed_at only");

    await svc
      .from("platform_settings")
      .upsert(
        {
          key: "ai_pricing_last_refreshed_at",
          value: new Date().toISOString(),
          description: "§27.12 — timestamp of last successful AI pricing cache refresh (manual or auto).",
        },
        { onConflict: "key" },
      );

    return { ok: true, fetched: false, note: "stub — operator wires fetchers" };
  },
);
