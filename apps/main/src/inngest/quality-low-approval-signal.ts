// §27.10 — Quality signal: tenant approval rate < 50% over rolling 30d
// with > 20 submissions → write abuse_signals row.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const qualityLowApprovalSignal = inngest.createFunction(
  {
    id: "quality-low-approval-signal-cron",
    triggers: [{ cron: "0 7 * * *" }], // daily 07:00 UTC
  },
  async () => {
    const svc = createServiceRoleClient();
    if (process.env.STAGING_MODE === "true") {
      await svc.from("staging_cron_skips").insert({ cron_id: "quality-low-approval-signal-cron" });
      return { skipped_for_staging: true };
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows } = await svc
      .from("rag_submissions")
      .select("tenant_id, review_status")
      .gte("created_at", since)
      .limit(50000);

    const tally = new Map<string, { total: number; approved: number }>();
    for (const r of (rows ?? []) as Array<{ tenant_id: string; review_status: string }>) {
      if (r.review_status === "pending" || r.review_status === "ready_for_review") continue;
      const t = tally.get(r.tenant_id) ?? { total: 0, approved: 0 };
      t.total++;
      if (r.review_status === "approved") t.approved++;
      tally.set(r.tenant_id, t);
    }

    let written = 0;
    for (const [tenant_id, t] of tally.entries()) {
      if (t.total <= 20) continue;
      const rate = t.approved / t.total;
      if (rate >= 0.5) continue;
      await svc.from("abuse_signals").insert({
        tenant_id,
        signal_kind: "quality_low_approval",
        detail: { total: t.total, approved: t.approved, approval_rate_percent: Math.round(rate * 100) },
      });
      written++;
    }
    return { tenants_seen: tally.size, signals_written: written };
  },
);
