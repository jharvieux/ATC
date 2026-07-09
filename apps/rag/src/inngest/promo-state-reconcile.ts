// §6.7 — Promo state reconciliation.
//
// Stored `promo_status` is a denormalization of `expected_promo_state()`.
// Retrieval already uses the function directly (lazy-state-read fallback,
// §6.7), so the stored field is informational — but tenant-facing surfaces
// (admin chunk views, drift alerting) read it directly. Keep it aligned.
//
// Hourly cron. Idempotent — recomputes from absolute time, not from a
// state machine. Resumes correctly after any outage length.

import { inngest } from "./client";
import { getRagDb } from "@/lib/db/supabase";

export const promoStateReconcile = inngest.createFunction(
  {
    id: "promo-state-reconcile",
    triggers: [{ cron: "0 * * * *" }], // hourly at :00
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    const db = getRagDb();
    const { data, error } = await db.rpc("reconcile_promo_status");
    if (error) {
      console.error("[promo-state-reconcile] rpc failed:", error.message);
      return { ok: false, error: error.message };
    }
    const reconciled = typeof data === "number" ? data : 0;
    return { ok: true, reconciled };
  },
);
