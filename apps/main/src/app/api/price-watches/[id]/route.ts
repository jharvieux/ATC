// BP40 §33.8 — PATCH /api/price-watches/[id]
// Update threshold / pause / resume / cancel.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { PatchWatchSchema } from "@/lib/price-watches/schemas";
import { respondToAuthError } from "@/lib/auth/respond";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "price_watches", action: "update" });
    let body: ReturnType<typeof PatchWatchSchema.parse>;
    try {
      body = PatchWatchSchema.parse(await req.json());
    } catch (err) {
      return Response.json({ error: "invalid_request", detail: String(err) }, { status: 400 });
    }

    const db = tenantClient(ctx);
    // Ownership check — must belong to caller.
    const { data: existing } = await db
      .from("price_watches")
      .select("watch_id, subscriber_user_id")
      .eq("watch_id", params.id)
      .maybeSingle();
    const owner = (existing as { subscriber_user_id: string } | null)?.subscriber_user_id;
    if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
    if (owner !== user.id) return Response.json({ error: "forbidden" }, { status: 403 });

    const update: Record<string, unknown> = {};
    if (body.status) update.status = body.status;
    if (body.threshold_kind) update.threshold_kind = body.threshold_kind;
    if (body.dollar_threshold !== undefined) update.dollar_threshold = body.dollar_threshold;
    if (body.percent_threshold !== undefined) update.percent_threshold = body.percent_threshold;

    if (Object.keys(update).length === 0) {
      return Response.json({ error: "no_changes" }, { status: 400 });
    }
    const { error: updErr } = await db
      .from("price_watches")
      .update(update)
      .eq("watch_id", params.id);
    if (updErr) {
      console.error("[price-watches] patch failed:", updErr);
      return Response.json({ error: "update_failed" }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
