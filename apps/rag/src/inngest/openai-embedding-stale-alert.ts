// Issue #686 — Operator alert if any pending embedding has been waiting
// longer than the OpenAI batch SLA (24h) + buffer (12h).
//
// Daily cron. Counts rows where status IN ('pending','submitted') AND
// queued_at < NOW() - INTERVAL '36 hours'. Non-zero count → log loudly so
// the platform admin gets paged via log monitoring.

import { inngest } from "./client";
import { getRagDb } from "@/lib/db/supabase";

export const openaiEmbeddingStaleAlert = inngest.createFunction(
  {
    id: "openai-embedding-stale-alert",
    triggers: [{ cron: "0 7 * * *" }], // daily at 07:00 UTC
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    const db = getRagDb();
    const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const { count, error } = await db
      // d091-allow:service-role-tenant — platform stale-alert cron; pending_embedding.tenant_id nullable by design; platform-wide count required.
      .from("pending_embedding")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "submitted"])
      .lt("queued_at", cutoff);
    if (error) {
      console.error("[openai-embedding-stale-alert] count failed:", error.message);
      return { ok: false, error: error.message };
    }

    const stale = count ?? 0;
    if (stale === 0) return { ok: true, stale: 0 };

    console.error(
      "[openai-embedding-stale-alert] PAGE PLATFORM ADMIN: %d pending_embedding rows older than 36h. The flush or reconcile cron may be broken.",
      stale,
    );
    return { ok: true, stale, alerted: true };
  },
);
