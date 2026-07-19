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
import { safeAwait } from "@/lib/db/safe-mutation";

// Extracted so the RPC-name contract with the migration (#2018) is unit-pinnable
// without the Inngest wrapper: the SECURITY DEFINER fn name below MUST match the
// one defined in 20260619000000_bp36_source_of_business.sql — a rename on either
// side silently kills the nightly refresh.
export async function runAttributionRollupRefresh() {
  if (process.env.BP36_ROLLUP_REFRESH_DISABLED === "true") {
    return { skipped: true, reason: "BP36_ROLLUP_REFRESH_DISABLED=true" };
  }

  const svc = createServiceRoleClient();

  if (process.env.STAGING_MODE === "true") {
    await safeAwait(svc.from("staging_cron_skips").insert({ cron_id: "attribution-rollup-refresh" }), "staging_cron_skips.insert");
    return { skipped_for_staging: true };
  }

  const startedAt = Date.now();
  const { error } = await svc.rpc("refresh_attribution_rollup");
  if (error) {
    // #1740 lesson: a swallowed RPC error must not report success — it hid
    // the broken #2018 refresh since June. Throw so Inngest retries and a
    // failed run surfaces instead of a silent `{ error }` return.
    console.error("[attribution-rollup-refresh] failed:", error.message);
    throw new Error(`refresh_attribution_rollup failed: ${error.message}`);
  }
  return { ok: true, duration_ms: Date.now() - startedAt };
}

export const attributionRollupRefresh = inngest.createFunction(
  {
    id: "attribution-rollup-refresh",
    triggers: [{ cron: "0 3 * * *" }], // 03:00 UTC nightly
  },
  runAttributionRollupRefresh,
);
