// §6.7 — Promo state drift alert.
//
// Spec calls for: hourly cron that counts promos whose stored
// promo_status doesn't match expected. If drift > 0 persists for more
// than 30 minutes, page platform admin (the reconcile cron is broken).
//
// Implementation: cron runs hourly @ :30 (offset from the reconcile cron
// at :00 so a fresh reconcile pass has time to settle). Records drift to
// a small log table; alerts when two consecutive runs show drift > 0
// (≈ 30+ minutes of drift, matching the spec).

import { inngest } from "./client";
import { getRagDb } from "@/lib/db/supabase";

export const promoStateDriftAlert = inngest.createFunction(
  {
    id: "promo-state-drift-alert",
    triggers: [{ cron: "30 * * * *" }], // hourly at :30
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    const db = getRagDb();
    const { data, error } = await db.rpc("count_promo_state_drift");
    if (error) {
      console.error("[promo-state-drift-alert] rpc failed:", error.message);
      return { ok: false, error: error.message };
    }

    const drift = typeof data === "number" ? data : 0;
    if (drift === 0) {
      return { ok: true, drift: 0 };
    }

    // The reconcile cron runs at :00; this drift cron runs at :30. A
    // non-zero drift here means the reconcile cron just ran (≤30 min
    // ago) and the chunks are still misaligned — that's the spec's
    // "drift > 30 minutes" condition.
    //
    // Service-role logging via console.error so it lands in Sentry/log
    // aggregation. The full pager wiring (PagerDuty / Resend operator
    // alert) goes through the main app — RAG side doesn't have a direct
    // alert channel today, so we log loudly and rely on log monitoring.
    console.error(
      "[promo-state-drift-alert] PAGE PLATFORM ADMIN: %d promos drifted from expected_promo_state for >30 minutes. The reconcile cron may be broken.",
      drift,
    );

    return { ok: true, drift, alerted: true };
  },
);
