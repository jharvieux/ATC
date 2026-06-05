// Issue #692 — Nightly cron that reconciles RAG embedding cost into
// tenant_usage_metrics.ai_cost_cents on this DB.
//
// Background: lib/embeddings/cost-log.ts on the rag service writes one
// rag_ai_call_log row per embedding call. The dashboard at
// /admin/resources merges these into the platform-admin Resource
// Utilization view (PR #691), but the enforcement layer
// (tenant_usage_metrics → soft1 → soft2 → hard limit state machine) on
// this DB never sees embedding spend. A tenant who ingests heavily
// through approve/tenant or replace-chunk would never trip their AI
// cost limit from embedding alone.
//
// Trade-off vs the direct cross-service write (also considered): a
// reconciler adds up to 24h enforcement lag, but the direct write would
// put rag's hot path on a service-role connection back to main, expand
// the attack surface, and silently mis-account on any cross-service
// failure. For embedding-cost — usually steady, occasionally spiky —
// the lag is acceptable. The hard-limit state machine still kicks in
// once the increment lands.
//
// Idempotency: rag_cost_reconcile_ledger has rag_log_id as PRIMARY KEY,
// and reconcile_rag_cost_row RPC does the ledger INSERT + the
// increment_tenant_ai_cost call in one PL/pgSQL transaction. Retry storms
// can't double-count: any row that succeeded once will hit the PK
// constraint on the second attempt and the RPC returns FALSE.

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { getRagReadClient } from "@/lib/db/rag-read";
import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";

// Lookback > cron interval ensures no row falls through the seam between
// runs. The PK on rag_cost_reconcile_ledger handles the overlap correctly:
// rows already counted by yesterday's run get skipped by the RPC.
const LOOKBACK_HOURS = 25;

// Read in chunks so a single firing of the cron can't OOM if rag traffic
// spiked overnight. The reconciler keeps pulling pages until the cap is
// hit, then exits cleanly — tomorrow's run picks up the rest. Cap is high
// enough that normal traffic finishes in one firing.
const PAGE_SIZE = 500;
const MAX_PAGES_PER_RUN = 20;

function billingPeriodRangeFor(date: Date): string {
  // DATERANGE literal — `[start,end)` calendar month containing `date`.
  // Matches the pattern in lib/ai/call-wrapper.ts:currentBillingPeriodRange.
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

interface RagLogRow {
  id: string;
  tenant_id: string | null;
  cost_estimate_cents: number;
  created_at: string;
}

export const ragCostReconcile = inngest.createFunction(
  {
    id: "rag-cost-reconcile",
    triggers: [{ cron: "30 4 * * *" }], // daily at 04:30 UTC (after onboarding-stale-suspend at 04:15)
    // Two concurrent reconciler runs would race on the same ledger rows
    // and ON CONFLICT DO NOTHING would resolve correctly, but the run
    // summary metrics (scanned / reconciled / skipped) would be wrong
    // and the duplicate scan wastes the RAG DB's query budget.
    concurrency: { limit: 1 },
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    return withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "rag_cost_reconciliation",
        operation: "rag_cost_reconcile",
        reason_detail: `nightly_lookback_${LOOKBACK_HOURS}h`,
      },
      async (db, recordQuery) => {
        const ragDb = getRagReadClient();
        const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

        let scanned = 0;
        let reconciled = 0;
        let skippedPlatform = 0;
        let pagesRead = 0;
        let lastCreatedAt: string | null = null;
        let lastId: string | null = null;

        while (pagesRead < MAX_PAGES_PER_RUN) {
          // Keyset pagination on (created_at, id) — stable under concurrent
          // writes and avoids the OFFSET drift that breaks if new rows are
          // written between pages.
          let query = ragDb
            .from("rag_ai_call_log")
            .select("id, tenant_id, cost_estimate_cents, created_at")
            .eq("purpose", "embedding")
            .gte("created_at", cutoff)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .limit(PAGE_SIZE);
          if (lastCreatedAt && lastId) {
            // `(created_at, id) > (last_created_at, last_id)` lexical compare.
            // PostgREST `.or()` builds the tuple inequality.
            query = query.or(
              `created_at.gt.${lastCreatedAt},and(created_at.eq.${lastCreatedAt},id.gt.${lastId})`,
            );
          }
          const page = (await safeAwait(
            query,
            "rag_ai_call_log.select.cost_reconcile_page",
          )) as RagLogRow[] | null;
          const rows = page ?? [];
          if (rows.length === 0) break;

          for (const row of rows) {
            scanned++;
            // Skip platform overhead (NULL tenant_id) and cross-tenant
            // crons (PLATFORM_SENTINEL_TENANT_ID). Neither belongs in any
            // single tenant's usage gate.
            if (!row.tenant_id || row.tenant_id === PLATFORM_SENTINEL_TENANT_ID) {
              skippedPlatform++;
              continue;
            }
            // Bill against the period of the original call, NOT "current".
            // A row written on May 30 reconciled in a June 1 cron belongs
            // to May's usage limit, not June's.
            const period = billingPeriodRangeFor(new Date(row.created_at));
            const newlyCounted = (await safeAwait(
              db.rpc("reconcile_rag_cost_row", {
                p_rag_log_id: row.id,
                p_tenant_id: row.tenant_id,
                p_billing_period: period,
                p_amount_cents: row.cost_estimate_cents.toString(),
              }),
              "rag_cost_reconcile.rpc",
            )) as boolean | null;
            if (newlyCounted === true) reconciled++;
          }

          recordQuery({ op: "select", table: "rag.rag_ai_call_log", row_count: rows.length });

          const last = rows[rows.length - 1]!;
          lastCreatedAt = last.created_at;
          lastId = last.id;
          pagesRead++;
          if (rows.length < PAGE_SIZE) break;
        }

        const pagedOut = pagesRead >= MAX_PAGES_PER_RUN;
        if (pagedOut) {
          // Don't throw — partial reconcile is preferable to a retry storm
          // that would re-scan everything. Tomorrow's cron picks up where
          // this one left off (via created_at >= NOW() - LOOKBACK_HOURS,
          // which extends the window forward).
          console.warn(
            "[rag-cost-reconcile] page cap hit at %d pages; tail will be picked up by next firing",
            MAX_PAGES_PER_RUN,
          );
        }

        return { ok: true, scanned, reconciled, skipped_platform: skippedPlatform, paged_out: pagedOut };
      },
    );
  },
);
