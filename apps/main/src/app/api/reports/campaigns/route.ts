// BP36 §36.2 / §36.4 — Campaign performance + GET/POST for the
// campaigns table.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { tenantClient } from "@/lib/db/tenant-client";
import { assertReportsAccessible } from "@/lib/reporting/tier-gate";
import { parseReportFilters } from "@/lib/reporting/parse-filters";
import { respondCsvOrJson } from "@/lib/reporting/csv";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "reports.campaigns", action: "read" });
    const svc = createServiceRoleClient();
    const gate = await assertReportsAccessible(ctx.tenant_id, svc);
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

    const filters = parseReportFilters(new URL(req.url));
    if ("error" in filters) return Response.json({ error: filters.error }, { status: 400 });

    // Pull the rollup for the date window.
    const { data: rollupData, error: rollupErr } = await svc
      .from("attribution_rollup")
      .select("first_touch_utm_campaign, contacts_acquired, bookings_confirmed, gross_commission_cents, net_commission_cents")
      .eq("tenant_id", ctx.tenant_id)
      .gte("day", filters.start)
      .lte("day", filters.end)
      .not("first_touch_utm_campaign", "is", null);
    if (rollupErr) return Response.json({ error: rollupErr.message }, { status: 500 });

    // Aggregate by campaign.
    const byCampaign = new Map<string, { leads: number; bookings: number; gross: number; net: number }>();
    for (const r of (rollupData ?? []) as Array<{
      first_touch_utm_campaign: string;
      contacts_acquired: number;
      bookings_confirmed: number;
      gross_commission_cents: number;
      net_commission_cents: number;
    }>) {
      const c = r.first_touch_utm_campaign;
      const b = byCampaign.get(c) ?? { leads: 0, bookings: 0, gross: 0, net: 0 };
      b.leads += r.contacts_acquired;
      b.bookings += r.bookings_confirmed;
      b.gross += r.gross_commission_cents;
      b.net += r.net_commission_cents;
      byCampaign.set(c, b);
    }

    // Join in the campaigns table for cost data.
    const { data: campaignRows, error: cErr } = await svc
      .from("campaigns")
      .select("utm_campaign, display_name, campaign_cost_cents, currency")
      .eq("tenant_id", ctx.tenant_id);
    if (cErr) return Response.json({ error: cErr.message }, { status: 500 });
    const costByCampaign = new Map<string, { cost: number | null; display: string | null; currency: string }>();
    for (const c of (campaignRows ?? []) as Array<{
      utm_campaign: string;
      display_name: string | null;
      campaign_cost_cents: number | null;
      currency: string;
    }>) {
      costByCampaign.set(c.utm_campaign, {
        cost: c.campaign_cost_cents,
        display: c.display_name,
        currency: c.currency,
      });
    }

    const items = Array.from(byCampaign.entries()).map(([utm_campaign, stats]) => {
      const meta = costByCampaign.get(utm_campaign);
      return {
        utm_campaign,
        display_name: meta?.display ?? null,
        campaign_cost_cents: meta?.cost ?? null,
        currency: meta?.currency ?? null,
        leads: stats.leads,
        bookings: stats.bookings,
        gross_commission_cents: stats.gross,
        net_commission_cents: stats.net,
        cost_per_lead_cents:
          meta?.cost !== null && meta?.cost !== undefined && stats.leads > 0
            ? Math.round(meta.cost / stats.leads)
            : null,
      };
    }).sort((a, b) => b.bookings - a.bookings);

    return respondCsvOrJson({
      format: new URL(req.url).searchParams.get("format"),
      items,
      csv_filename: `campaigns_${filters.start}_${filters.end}.csv`,
      json_body: { items, filters },
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "reports.campaigns", action: "create" });
    const svc = createServiceRoleClient();
    const gate = await assertReportsAccessible(ctx.tenant_id, svc);
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

    const body = (await req.json().catch(() => null)) as
      | {
          utm_campaign?: unknown;
          display_name?: unknown;
          campaign_cost_cents?: unknown;
          currency?: unknown;
          campaign_start?: unknown;
          campaign_end?: unknown;
          notes?: unknown;
        }
      | null;
    if (!body || typeof body.utm_campaign !== "string" || body.utm_campaign.trim().length === 0) {
      return Response.json({ error: "utm_campaign required" }, { status: 400 });
    }

    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("campaigns")
      .insert({
        tenant_id: ctx.tenant_id,
        utm_campaign: body.utm_campaign.trim().toLowerCase(),
        display_name: typeof body.display_name === "string" ? body.display_name : null,
        campaign_cost_cents: typeof body.campaign_cost_cents === "number" ? body.campaign_cost_cents : null,
        currency: typeof body.currency === "string" ? body.currency : "USD",
        campaign_start: typeof body.campaign_start === "string" ? body.campaign_start : null,
        campaign_end: typeof body.campaign_end === "string" ? body.campaign_end : null,
        notes: typeof body.notes === "string" ? body.notes : null,
      })
      .select()
      .single();
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json(data, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
