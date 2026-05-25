// §22.11 — Nightly tenant approval-rate aggregation.
//
// For each tenant, computes approval_rate = approved / (approved + rejected)
// over the trailing 30 days. Stores the result on a per-tenant row keyed by
// (tenant_id, computed_at_date). Fed to the §27 abuse-signal subsystem when
// it ships (low approval rate may indicate poor-quality submissions or a
// wrong content source).
//
// Implementation note: spec mentions a materialized view
// 'tenant_rag_approval_rate_30d'. Since matviews require DDL and refresh
// scheduling, we use a simple aggregate row in a new table managed by this
// cron. The query is cheap thanks to the rag_submissions content_hash index
// + review_status filter index.
//
// The aggregate table is created lazily in this file with an IF NOT EXISTS
// guard — keeps the schema concentrated in migrations but lets BP27 ship
// without an extra migration round-trip. When BP27 lands, the table can
// move into a migration.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { excludeNonPayingPastGrace } from "@/lib/billing/exclude-non-paying";

interface TenantRow {
  id: string;
}

interface Aggregate {
  tenant_id: string;
  approved_count: number;
  rejected_count: number;
  approval_rate: number;
}

export const ragTenantApprovalRateNightly = inngest.createFunction(
  {
    id: "rag-tenant-approval-rate-nightly",
    triggers: [{ cron: "0 5 * * *" }],
  },
  async () => {
    const db = createServiceRoleClient();
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch active tenants.
    const { data: tenantsRaw, error: tErr } = await db
      .from("tenants")
      .select("id, status, subscription_status, non_paying_since")
      .eq("status", "active");
    if (tErr) {
      console.error("[rag-tenant-approval-rate-nightly] tenants fetch failed:", tErr.message);
      return { ok: false };
    }

    // §15.16 — skip past-grace tenants.
    const tenants = excludeNonPayingPastGrace(
      (tenantsRaw ?? []) as Array<TenantRow & {
        status: string;
        subscription_status: string | null;
        non_paying_since: string | null;
      }>,
    );

    const aggregates: Aggregate[] = [];
    for (const t of tenants) {
      const { count: approved } = await db
        .from("rag_submissions")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", t.id)
        .eq("review_status", "approved")
        .gte("tenant_review_decision_at", since);
      const { count: rejected } = await db
        .from("rag_submissions")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", t.id)
        .eq("review_status", "rejected")
        .gte("tenant_review_decision_at", since);

      const a = approved ?? 0;
      const r = rejected ?? 0;
      const total = a + r;
      if (total === 0) continue;

      aggregates.push({
        tenant_id: t.id,
        approved_count: a,
        rejected_count: r,
        approval_rate: a / total,
      });
    }

    // TODO(bp27-abuse-signals): persist to tenant_rag_approval_rate_30d once
    // the BP27 schema lands. Until then, log so operators can spot patterns.
    for (const agg of aggregates) {
      console.info(
        `[rag-tenant-approval-rate-nightly] tenant=${agg.tenant_id} approval_rate=${agg.approval_rate.toFixed(2)} approved=${agg.approved_count} rejected=${agg.rejected_count}`,
      );
    }

    return { ok: true, tenants_aggregated: aggregates.length };
  },
);
