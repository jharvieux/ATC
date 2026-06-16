// #902 — TA-mode conversation list.
//
// Lists tenant_member audience conversations for the authenticated user,
// most-recent first. Requires ta_chat:list (agent or tenant_owner only —
// viewer-role customers are excluded per the permission-grants table).
// The audience filter is the second isolation layer: RLS already scopes
// the tenantClient to the resolved tenant; this adds the app-layer filter
// so customer conversations never mix into the TA surface.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "ta_chat",
      action: "list",
    });
    const db = tenantClient(ctx);
    const userId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;

    // Own-only: each member sees only their own TA threads (D-195).
    // The user_id here is auth.users.id (from ctx) — the conversation
    // row stores public.users.id, so we resolve it first.
    if (!userId) {
      return Response.json({ conversations: [] });
    }

    const { data: urow, error: uErr } = await db
      .from("users")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (uErr) {
      return dbErrorResponse();
    }
    const publicUserId = (urow as { id: string } | null)?.id ?? null;
    if (!publicUserId) {
      return Response.json({ conversations: [] });
    }

    const { data, error } = await db
      .from("conversations")
      .select("id, title, status, last_message_at, message_count, active_persona_id")
      .eq("audience", "tenant_member")
      .eq("user_id", publicUserId)
      .order("last_message_at", { ascending: false })
      .limit(50);

    if (error) return dbErrorResponse(error);
    return Response.json({ conversations: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}
