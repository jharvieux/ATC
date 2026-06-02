// BP40 §33.8 — POST /api/price-watches/[id]/rearm
//
// Reset baseline to the CURRENT cached price and flip status back to
// 'active'. Used after a trigger fires + subscriber has either acted
// (rebooked) or chosen to keep watching with a new baseline.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export const dynamic = "force-dynamic";

export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "price_watches", action: "rearm" });
    const db = tenantClient(ctx);

    const { data: watch } = await db
      .from("price_watches")
      .select("*")
      .eq("watch_id", params.id)
      .maybeSingle();
    const w = watch as {
      watch_id: string; subscriber_user_id: string;
      cruise_line: string; ship: string; sail_date: string; departure_port: string; cabin_class: string;
    } | null;
    if (!w) return Response.json({ error: "not_found" }, { status: 404 });
    if (w.subscriber_user_id !== user.id) return Response.json({ error: "forbidden" }, { status: 403 });

    const { data: cached } = await db
      .from("pricing_cache")
      .select("price_amount, price_currency")
      .eq("cruise_line", w.cruise_line)
      .eq("ship", w.ship)
      .eq("sail_date", w.sail_date)
      .eq("departure_port", w.departure_port)
      .eq("cabin_class", w.cabin_class)
      .limit(1);
    const row = ((cached ?? []) as Array<{ price_amount: number; price_currency: string }>)[0];
    if (!row) {
      return Response.json({ error: "price_data_unavailable", detail: "No current cached price; cannot reset baseline." }, { status: 422 });
    }
    const rawAmount: unknown = row.price_amount;
    const baselineDollars = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);

    const nowIso = new Date().toISOString();
    const { error: updErr } = await db
      .from("price_watches")
      .update({
        baseline_price: baselineDollars,
        baseline_currency: row.price_currency,
        baseline_set_at: nowIso,
        status: "active",
        triggered_at: null,
        notified_at: null,
      })
      .eq("watch_id", params.id);
    if (updErr) {
      console.error("[price-watches] rearm failed:", updErr);
      return Response.json({ error: "rearm_failed" }, { status: 500 });
    }
    return Response.json({ ok: true, baseline_price: baselineDollars, baseline_currency: row.price_currency });
  } catch (err) {
    return respondToAuthError(err);
  }
}
