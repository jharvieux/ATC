// BP40 §33.8 — POST + GET /api/price-watches.
//
// POST: subscriber creates a watch. Baseline is set from the current
//       pricing_cache for the (line, ship, sail_date, port, cabin_class).
//       If no cache row exists → 422 "price data not available". If the
//       line has no enabled adapter → 422 with a distinct error.
// GET:  list the caller's watches for the current tenant. Tenant
//       isolation is enforced by RLS + tenantClient.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { CreateWatchSchema } from "@/lib/price-watches/schemas";
import { routeFor } from "@/lib/pricing/line-routing";
import type { CruiseLineCode } from "@/lib/pricing/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "price_watches", action: "create" });
    let body: ReturnType<typeof CreateWatchSchema.parse>;
    try {
      body = CreateWatchSchema.parse(await req.json());
    } catch (err) {
      return Response.json({ error: "invalid_request", detail: String(err) }, { status: 400 });
    }

    // Coverage check (BP40 task 9).
    const route = routeFor(body.cruise_line as CruiseLineCode);
    if (!route) {
      console.warn("[price-watches] uncovered_line", { tenant_id: ctx.tenant_id, line: body.cruise_line });
      return Response.json({ error: "uncovered_line", detail: `Price watching isn't available for ${body.cruise_line} yet.` }, { status: 422 });
    }

    const db = tenantClient(ctx);

    // Baseline from pricing_cache (must exist).
    const { data: cached } = await db
      .from("pricing_cache")
      .select("price_amount, price_currency")
      .eq("cruise_line", body.cruise_line)
      .eq("ship", body.ship)
      .eq("sail_date", body.sail_date)
      .eq("departure_port", body.departure_port)
      .eq("cabin_class", body.cabin_class)
      .limit(1);
    const row = ((cached ?? []) as Array<{ price_amount: number; price_currency: string }>)[0];
    if (!row) {
      return Response.json({ error: "price_data_unavailable", detail: "No cached price for this sailing/cabin yet." }, { status: 422 });
    }
    const rawAmount: unknown = row.price_amount;
    const baselineDollars = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);

    const insertRow = {
      tenant_id: ctx.tenant_id,
      subscriber_user_id: user.id,
      booking_id: body.booking_id ?? null,
      cruise_line: body.cruise_line,
      ship: body.ship,
      sail_date: body.sail_date,
      departure_port: body.departure_port,
      cabin_class: body.cabin_class,
      baseline_price: baselineDollars,
      baseline_currency: row.price_currency,
      threshold_kind: body.threshold_kind,
      dollar_threshold: body.dollar_threshold ?? null,
      percent_threshold: body.percent_threshold ?? null,
      status: "active",
    };
    const { data: created, error: insErr } = await db
      .from("price_watches")
      .insert(insertRow)
      .select("watch_id")
      .single();
    if (insErr || !created) {
      console.error("[price-watches] insert failed:", insErr);
      return Response.json({ error: "create_failed" }, { status: 500 });
    }
    return Response.json({ watch_id: (created as { watch_id: string }).watch_id, status: "active", baseline_price: baselineDollars, baseline_currency: row.price_currency });
  } catch (err) {
    return Response.json({ error: "unauthorized", detail: String(err) }, { status: 401 });
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "price_watches", action: "list" });
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("price_watches")
      .select("*")
      .eq("subscriber_user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      console.error("[price-watches] list failed:", error);
      return Response.json({ error: "list_failed" }, { status: 500 });
    }
    return Response.json({ watches: data ?? [] });
  } catch (err) {
    return Response.json({ error: "unauthorized", detail: String(err) }, { status: 401 });
  }
}
