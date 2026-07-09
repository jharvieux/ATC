// §6.7 — Promo state reconciliation.
//
// Stored `promo_status` is a denormalization of `expected_promo_state()`.
// Retrieval already uses the function directly (lazy-state-read fallback,
// §6.7), so the stored field is informational — but tenant-facing surfaces
// (admin chunk views, drift alerting) read it directly. Keep it aligned.
//
// Hourly cron. Idempotent — recomputes from absolute time, not from a
// state machine. Resumes correctly after any outage length.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "./client";

function ragDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_RAG_URL;
  const key = process.env.SUPABASE_RAG_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("RAG Supabase env not set for promo-state-reconcile");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export const promoStateReconcile = inngest.createFunction(
  {
    id: "promo-state-reconcile",
    triggers: [{ cron: "0 * * * *" }], // hourly at :00
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    const db = ragDb();
    const { data, error } = await db.rpc("reconcile_promo_status");
    if (error) {
      console.error("[promo-state-reconcile] rpc failed:", error.message);
      return { ok: false, error: error.message };
    }
    const reconciled = typeof data === "number" ? data : 0;
    return { ok: true, reconciled };
  },
);
