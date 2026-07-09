// §23.8 — Dismiss notification(s).
// POST /api/notifications/dismiss { notification_ids: string[] }

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { markNotifications } from "@/lib/notifications/mark";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "notifications", action: "write" });

    const body = (await req.json()) as { notification_ids?: string[] };
    const ids = body.notification_ids;
    if (!ids || ids.length === 0) {
      return Response.json({ error: "notification_ids required" }, { status: 400 });
    }

    const { error } = await markNotifications(ctx, user.id, ids, "dismissed_at");
    if (error) return dbErrorResponse(error);
    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
