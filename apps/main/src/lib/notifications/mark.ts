// §23.8 — Shared body for /api/notifications/mark-read and /dismiss, which
// were byte-identical except for the timestamp column they write (#1610).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function markNotifications(
  req: Request,
  column: "read_at" | "dismissed_at",
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "notifications", action: "write" });
    const db = tenantClient(ctx);

    const body = (await req.json()) as { notification_ids?: string[] };
    const ids = body.notification_ids;
    if (!ids || ids.length === 0) {
      return Response.json({ error: "notification_ids required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { error } = await db
      .from("notifications")
      .update({ [column]: now })
      .in("id", ids)
      .eq("user_id", user.id)
      .is(column, null);

    if (error) return dbErrorResponse(error);
    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
