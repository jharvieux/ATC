// BP36 §36.7 — Lost revenue from cancellations (live query).
//
// Default grouping: cancellation_reason_category. Optional secondary
// drill-down dimensions via ?group_by=channel|cruise_line|sail_quarter.
// Measures: cancelled_count, lost_expected_cents, clawback_cents,
// net_impact_cents.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertReportsAccessible } from "@/lib/reporting/tier-gate";
import { parseReportFilters } from "@/lib/reporting/parse-filters";
import { respondCsvOrJson } from "@/lib/reporting/csv";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const VALID_SECONDARY = new Set(["channel", "cruise_line", "sail_quarter"]);

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "reports.cancellations", action: "read" });
    const svc = createServiceRoleClient();

    const gate = await assertReportsAccessible(ctx.tenant_id, svc);
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

    const url = new URL(req.url);
    const filters = parseReportFilters(url);
    if ("error" in filters) return Response.json({ error: filters.error }, { status: 400 });

    const groupBy = url.searchParams.get("group_by") ?? "channel";
    if (!VALID_SECONDARY.has(groupBy)) {
      return Response.json({ error: `invalid_group_by:${groupBy}` }, { status: 400 });
    }

    type Row = {
      cancellation_reason_category: string | null;
      conversion_touch_channel: string | null;
      cruise_line: string | null;
      sailing_date: string | null;
      commissions:
        | { gross_commission_cents: number; received_commission_cents: number | null; clawback_amount_cents: number | null }
        | { gross_commission_cents: number; received_commission_cents: number | null; clawback_amount_cents: number | null }[]
        | null;
    };

    // #1745 — PostgREST caps any single response at ~1000 rows (db-max-rows)
    // regardless of a requested .limit(), which would silently truncate the
    // lost-revenue totals below. Page in 1000-row windows (matches
    // apps/rag/src/lib/embeddings/batch/flush.ts, #808) so the aggregation
    // always covers every matching cancellation.
    const PAGE = 1000;
    const data: Row[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data: page, error } = await svc
        .from("bookings")
        .select("id, cancellation_reason_category, conversion_touch_channel, cruise_line, sailing_date, commissions!inner(gross_commission_cents, received_commission_cents, clawback_amount_cents)")
        .eq("tenant_id", ctx.tenant_id)
        .eq("status", "cancelled")
        .gte("cancelled_at", filters.start)
        .lte("cancelled_at", `${filters.end}T23:59:59.999Z`)
        .range(from, from + PAGE - 1);
      if (error) return dbErrorResponse(error);
      const batch = (page ?? []) as Row[];
      data.push(...batch);
      if (batch.length < PAGE) break;
    }

    const buckets = new Map<string, {
      category: string;
      secondary: string | null;
      cancelled_count: number;
      lost_expected_cents: number;
      clawback_cents: number;
      net_impact_cents: number;
    }>();
    for (const row of data) {
      const cm = Array.isArray(row.commissions) ? row.commissions[0] ?? null : row.commissions;
      const lostExpected = cm && (cm.received_commission_cents ?? 0) === 0 ? cm.gross_commission_cents : 0;
      const clawback = cm?.clawback_amount_cents ?? 0;
      const category = row.cancellation_reason_category ?? "uncategorized";
      const secondary =
        groupBy === "channel"
          ? row.conversion_touch_channel
          : groupBy === "cruise_line"
          ? row.cruise_line
          : row.sailing_date
          ? sailQuarter(row.sailing_date)
          : null;

      const key = `${category}|${secondary ?? ""}`;
      const b = buckets.get(key) ?? {
        category,
        secondary,
        cancelled_count: 0,
        lost_expected_cents: 0,
        clawback_cents: 0,
        net_impact_cents: 0,
      };
      b.cancelled_count += 1;
      b.lost_expected_cents += lostExpected;
      b.clawback_cents += clawback;
      b.net_impact_cents += lostExpected + clawback;
      buckets.set(key, b);
    }

    const items = Array.from(buckets.values()).sort((a, b) => b.net_impact_cents - a.net_impact_cents);
    return respondCsvOrJson({
      format: url.searchParams.get("format"),
      items,
      csv_filename: `cancellations_${groupBy}_${filters.start}_${filters.end}.csv`,
      json_body: { items, group_by: groupBy, filters },
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

function sailQuarter(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}Q${q}`;
}
