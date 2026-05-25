// BP36 §36.6.2 — Nightly refresh of attribution_rollup materialized view.
//
// CONCURRENTLY refresh keeps reports queryable during the rebuild; the
// unique index defined in the migration is what enables that. Service-
// role-only because authenticated users have no privilege to REFRESH.
//
// Kill-switch: BP36_ROLLUP_REFRESH_DISABLED=true short-circuits the
// function (useful if a misbehaving rollup is hammering DB during
// nightly window).

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const attributionRollupRefresh = inngest.createFunction(
  {
    id: "attribution-rollup-refresh",
    triggers: [{ cron: "0 3 * * *" }], // 03:00 UTC nightly
  },
  async () => {
    if (process.env.BP36_ROLLUP_REFRESH_DISABLED === "true") {
      return { skipped: true, reason: "BP36_ROLLUP_REFRESH_DISABLED=true" };
    }

    const svc = createServiceRoleClient();

    if (process.env.STAGING_MODE === "true") {
      await svc.from("staging_cron_skips").insert({ cron_id: "attribution-rollup-refresh" });
      return { skipped_for_staging: true };
    }

    const startedAt = Date.now();
    // Supabase-js doesn't expose raw SQL by default; use the RPC if defined,
    // otherwise fall through to the `query` method on the underlying
    // postgres client. We invoke via a SECURITY DEFINER function for safety.
    const { error } = await svc.rpc("refresh_attribution_rollup");
    if (error) {
      console.error("[attribution-rollup-refresh] failed:", error.message);
      return { error: error.message };
    }
    return { ok: true, duration_ms: Date.now() - startedAt };
  },
);
