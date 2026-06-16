// BP36 §36.2 — Bookings by source report (live query against bookings
// for conversion-touch dimensions). Counts confirmed bookings + sums
// gross/net commission. MV is keyed on first_touch_*; we need
// conversion_touch_*, hence live query.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertReportsAccessible } from "@/lib/reporting/tier-gate";
import { parseReportFilters } from "@/lib/reporting/parse-filters";
import { respondCsvOrJson } from "@/lib/reporting/csv";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "reports.bookings_by_source", action: "read" });
    const svc = createServiceRoleClient();

    const gate = await assertReportsAccessible(ctx.tenant_id, svc);
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

    const filters = parseReportFilters(new URL(req.url));
    if ("error" in filters) return Response.json({ error: filters.error }, { status: 400 });

    const { data, error } = await svc
      .from("bookings")
      .select("id, conversion_touch_channel, conversion_touch_utm_source, conversion_touch_utm_campaign, commissions!inner(gross_commission_cents, net_commission_cents)")
      .eq("tenant_id", ctx.tenant_id)
      .not("status", "in", "(cancelled,draft)")
      .gte("created_at", filters.start)
      .lte("created_at", `${filters.end}T23:59:59.999Z`);
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

    type Row = {
      conversion_touch_channel: string | null;
      conversion_touch_utm_source: string | null;
      conversion_touch_utm_campaign: string | null;
      commissions: { gross_commission_cents: number; net_commission_cents: number } | { gross_commission_cents: number; net_commission_cents: number }[] | null;
    };

    const buckets = new Map<string, {
      channel: string | null;
      utm_source: string | null;
      utm_campaign: string | null;
      bookings: number;
      gross_commission_cents: number;
      net_commission_cents: number;
    }>();
    for (const row of (data ?? []) as Row[]) {
      const c = Array.isArray(row.commissions) ? row.commissions[0] ?? null : row.commissions;
      const key = `${row.conversion_touch_channel ?? ""}|${row.conversion_touch_utm_source ?? ""}|${row.conversion_touch_utm_campaign ?? ""}`;
      const b = buckets.get(key) ?? {
        channel: row.conversion_touch_channel,
        utm_source: row.conversion_touch_utm_source,
        utm_campaign: row.conversion_touch_utm_campaign,
        bookings: 0,
        gross_commission_cents: 0,
        net_commission_cents: 0,
      };
      b.bookings += 1;
      b.gross_commission_cents += c?.gross_commission_cents ?? 0;
      b.net_commission_cents += c?.net_commission_cents ?? 0;
      buckets.set(key, b);
    }
    const items = Array.from(buckets.values()).sort((a, b) => b.bookings - a.bookings);
    return respondCsvOrJson({
      format: new URL(req.url).searchParams.get("format"),
      items,
      csv_filename: `bookings-by-source_${filters.start}_${filters.end}.csv`,
      json_body: { items, filters },
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
