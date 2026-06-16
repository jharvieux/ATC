// §25.7 — Granular consent toggles for the authenticated user.
//
// GET  /api/user/privacy → returns the four flags
// PUT  /api/user/privacy → updates one or more flags
//
// Flags: marketing_email_opt_in, travel_news_opt_in, memory_opt_out,
// performance_analytics_opt_out.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

const FLAGS = [
  "marketing_email_opt_in",
  "travel_news_opt_in",
  "memory_opt_out",
  "performance_analytics_opt_out",
] as const;

type FlagName = (typeof FLAGS)[number];

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Privacy preferences",
      action: "get",
    });
    const userId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;
    if (!userId) return Response.json({ error: "unauthenticated" }, { status: 401 });

    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("users")
      .select(FLAGS.join(", "))
      .eq("id", userId)
      .maybeSingle();
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    return Response.json({ preferences: data ?? {} });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function PUT(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Privacy preferences update",
      action: "put",
    });
    const userId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;
    if (!userId) return Response.json({ error: "unauthenticated" }, { status: 401 });

    const body = (await req.json()) as Partial<Record<FlagName, boolean>>;
    const update: Partial<Record<FlagName, boolean>> = {};
    for (const f of FLAGS) {
      if (typeof body[f] === "boolean") update[f] = body[f];
    }
    if (Object.keys(update).length === 0) {
      return Response.json({ error: "no_known_flags_in_body" }, { status: 422 });
    }

    const db = tenantClient(ctx);
    const { error } = await db.from("users").update(update).eq("id", userId);
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    return Response.json({ ok: true, updated: update });
  } catch (err) {
    return respondToAuthError(err);
  }
}
