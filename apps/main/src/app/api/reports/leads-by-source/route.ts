// BP36 §36.2 — Leads by source report (MV-backed).
//
// Groups attribution_rollup by first_touch_channel + utm_source + utm_campaign,
// sums contacts_acquired across the tenant-scoped date range.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertReportsAccessible } from "@/lib/reporting/tier-gate";
import { parseReportFilters } from "@/lib/reporting/parse-filters";
import { respondCsvOrJson } from "@/lib/reporting/csv";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "reports.leads_by_source", action: "read" });
    const svc = createServiceRoleClient();

    const gate = await assertReportsAccessible(ctx.tenant_id, svc);
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

    const filters = parseReportFilters(new URL(req.url));
    if ("error" in filters) return Response.json({ error: filters.error }, { status: 400 });

    const { data, error } = await svc
      .from("attribution_rollup")
      .select("first_touch_channel, first_touch_utm_source, first_touch_utm_campaign, contacts_acquired")
      .eq("tenant_id", ctx.tenant_id)
      .gte("day", filters.start)
      .lte("day", filters.end);
    if (error) return dbErrorResponse(error);

    // Roll up to the dimensional grain (the MV pre-aggregates by day; we
    // re-aggregate dropping the day dimension for the leads-by-source view).
    const buckets = new Map<string, { channel: string | null; utm_source: string | null; utm_campaign: string | null; count: number }>();
    for (const row of (data ?? []) as Array<{
      first_touch_channel: string | null;
      first_touch_utm_source: string | null;
      first_touch_utm_campaign: string | null;
      contacts_acquired: number;
    }>) {
      const key = `${row.first_touch_channel ?? ""}|${row.first_touch_utm_source ?? ""}|${row.first_touch_utm_campaign ?? ""}`;
      const b = buckets.get(key) ?? {
        channel: row.first_touch_channel,
        utm_source: row.first_touch_utm_source,
        utm_campaign: row.first_touch_utm_campaign,
        count: 0,
      };
      b.count += row.contacts_acquired;
      buckets.set(key, b);
    }
    const items = Array.from(buckets.values()).sort((a, b) => b.count - a.count);
    return respondCsvOrJson({
      format: new URL(req.url).searchParams.get("format"),
      items,
      csv_filename: `leads-by-source_${filters.start}_${filters.end}.csv`,
      json_body: { items, filters },
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
