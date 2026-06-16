// BP36 §36.2 — First-touch vs last-touch comparison (live query).
//
// Reveals influence of multi-touch journeys: e.g. first_touch=social
// but conversion_touch=search means the customer was acquired by social
// then closed by search. Result set is small (~50 distinct pair combos).

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertReportsAccessible } from "@/lib/reporting/tier-gate";
import { parseReportFilters } from "@/lib/reporting/parse-filters";
import { respondCsvOrJson } from "@/lib/reporting/csv";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "reports.first_vs_last_touch", action: "read" });
    const svc = createServiceRoleClient();
    const gate = await assertReportsAccessible(ctx.tenant_id, svc);
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

    const filters = parseReportFilters(new URL(req.url));
    if ("error" in filters) return Response.json({ error: filters.error }, { status: 400 });

    const { data, error } = await svc
      .from("bookings")
      .select("id, conversion_touch_channel, primary_contact_id, contacts:primary_contact_id(first_touch_channel)")
      .eq("tenant_id", ctx.tenant_id)
      .not("status", "in", "(cancelled,draft)")
      .gte("created_at", filters.start)
      .lte("created_at", `${filters.end}T23:59:59.999Z`);
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

    type Row = {
      conversion_touch_channel: string | null;
      contacts: { first_touch_channel: string | null } | { first_touch_channel: string | null }[] | null;
    };

    const pairs = new Map<string, { first: string | null; last: string | null; count: number }>();
    for (const row of (data ?? []) as Row[]) {
      const c = Array.isArray(row.contacts) ? row.contacts[0] ?? null : row.contacts;
      const first = c?.first_touch_channel ?? null;
      const last = row.conversion_touch_channel;
      const key = `${first ?? ""}|${last ?? ""}`;
      const p = pairs.get(key) ?? { first, last, count: 0 };
      p.count += 1;
      pairs.set(key, p);
    }

    const items = Array.from(pairs.values()).sort((a, b) => b.count - a.count);
    return respondCsvOrJson({
      format: new URL(req.url).searchParams.get("format"),
      items,
      csv_filename: `first-vs-last-touch_${filters.start}_${filters.end}.csv`,
      json_body: { items, filters },
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
