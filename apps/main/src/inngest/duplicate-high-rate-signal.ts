// §27.10 — Duplicate signal: > 30% of submissions in last 30d are
// duplicates (per BP22 content_hash deduplication) → abuse_signals row.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";

export const duplicateHighRateSignal = inngest.createFunction(
  {
    id: "duplicate-high-rate-signal-cron",
    triggers: [{ cron: "30 7 * * *" }], // daily 07:30 UTC
  },
  async () => {
    const svc = createServiceRoleClient();
    if (process.env.STAGING_MODE === "true") {
      await safeAwait(svc.from("staging_cron_skips").insert({ cron_id: "duplicate-high-rate-signal-cron" }), "staging_cron_skips.insert");
      return { skipped_for_staging: true };
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows } = await svc
      .from("rag_submissions")
      .select("tenant_id, content_hash, review_status")
      .gte("created_at", since)
      .limit(50000);

    // Group by tenant. A duplicate is a non-first occurrence of content_hash
    // within the tenant's submissions (the BP22 dedup path marks them
    // 'rejected' for duplicate reason — count those + the existing column).
    const tally = new Map<string, { total: number; duplicates: number }>();
    for (const r of (rows ?? []) as Array<{ tenant_id: string; review_status: string }>) {
      const t = tally.get(r.tenant_id) ?? { total: 0, duplicates: 0 };
      t.total++;
      if (r.review_status === "superseded" || r.review_status === "rejected") t.duplicates++;
      tally.set(r.tenant_id, t);
    }

    let written = 0;
    for (const [tenant_id, t] of tally.entries()) {
      if (t.total === 0) continue;
      const rate = t.duplicates / t.total;
      if (rate <= 0.3) continue;
      await safeAwait(svc.from("abuse_signals").insert({
        tenant_id,
        signal_kind: "duplicate_high_rate",
        detail: { total: t.total, duplicates: t.duplicates, duplicate_rate_percent: Math.round(rate * 100) },
      }), "abuse_signals.insert");
      written++;
    }
    return { tenants_seen: tally.size, signals_written: written };
  },
);
