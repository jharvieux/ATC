// BP36 §36.2 — Source funnel: contacts → quotes → bookings per first_touch_channel.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertReportsAccessible } from "@/lib/reporting/tier-gate";
import { parseReportFilters } from "@/lib/reporting/parse-filters";
import { respondCsvOrJson } from "@/lib/reporting/csv";

export async function GET(req: Request): Promise<Response> {
  const { ctx } = await assertPermission(req, { resource: "reports.source_funnel", action: "read" });
  const svc = createServiceRoleClient();

  const gate = await assertReportsAccessible(ctx.tenant_id, svc);
  if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

  const filters = parseReportFilters(new URL(req.url));
  if ("error" in filters) return Response.json({ error: filters.error }, { status: 400 });

  const { data, error } = await svc
    .from("attribution_rollup")
    .select("first_touch_channel, contacts_acquired, quotes_created, bookings_confirmed")
    .eq("tenant_id", ctx.tenant_id)
    .gte("day", filters.start)
    .lte("day", filters.end);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const buckets = new Map<string, { channel: string | null; contacts: number; quotes: number; bookings: number }>();
  for (const row of (data ?? []) as Array<{
    first_touch_channel: string | null;
    contacts_acquired: number;
    quotes_created: number;
    bookings_confirmed: number;
  }>) {
    const key = row.first_touch_channel ?? "";
    const b = buckets.get(key) ?? { channel: row.first_touch_channel, contacts: 0, quotes: 0, bookings: 0 };
    b.contacts += row.contacts_acquired;
    b.quotes += row.quotes_created;
    b.bookings += row.bookings_confirmed;
    buckets.set(key, b);
  }
  const items = Array.from(buckets.values()).map((b) => ({
    ...b,
    contact_to_quote_pct: b.contacts > 0 ? Math.round((b.quotes / b.contacts) * 1000) / 10 : null,
    quote_to_booking_pct: b.quotes > 0 ? Math.round((b.bookings / b.quotes) * 1000) / 10 : null,
    contact_to_booking_pct: b.contacts > 0 ? Math.round((b.bookings / b.contacts) * 1000) / 10 : null,
  })).sort((a, b) => b.contacts - a.contacts);
  return respondCsvOrJson({
    format: new URL(req.url).searchParams.get("format"),
    items,
    csv_filename: `source-funnel_${filters.start}_${filters.end}.csv`,
    json_body: { items, filters },
  });
}
