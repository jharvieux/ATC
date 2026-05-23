// §24.1 / §24.7 — List the caller's conversations.
//
// Returns the authenticated user's conversations in the resolved tenant,
// most-recent first. Anonymous chat conversations live in the anon-session
// and are not surfaced here (they're transferred per §11.6 on signup).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Chat conversations",
      action: "list",
    });
    const db = tenantClient(ctx);
    const userId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;

    let q = db
      .from("conversations")
      .select("id, title, status, last_message_at, message_count, active_persona_id")
      .order("last_message_at", { ascending: false })
      .limit(50);
    if (userId) q = q.eq("user_id", userId);

    const { data, error } = await q;
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ conversations: data ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
