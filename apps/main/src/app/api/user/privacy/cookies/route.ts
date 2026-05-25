// §25.8 — Persist cookie_preferences for authenticated users.
//
// Body: { performance: boolean, marketing: boolean, set_at: string }
// Anonymous callers: 200 no-op (the first-party cookie is the persistence).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Cookie preferences",
      action: "post",
    });
    const userId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;
    if (!userId) return Response.json({ ok: true, anonymous: true });

    const body = (await req.json()) as {
      performance?: boolean;
      marketing?: boolean;
      set_at?: string;
    };
    const performance = Boolean(body.performance);
    const marketing = Boolean(body.marketing);

    const db = tenantClient(ctx);
    const prefs = {
      performance,
      marketing,
      set_at: body.set_at ?? new Date().toISOString(),
    };

    // performance_analytics_opt_out mirrors the inverse of performance for §25.7.
    const { error } = await db
      .from("users")
      .update({
        cookie_preferences: prefs,
        performance_analytics_opt_out: !performance,
      })
      .eq("id", userId);
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
