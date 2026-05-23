// §23.8 — Mark notification(s) as read.
// POST /api/notifications/mark-read { notification_ids: string[] }

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

export async function POST(req: Request): Promise<Response> {
  const { ctx, user } = await assertPermission(req, { resource: "notifications", action: "write" });
  const db = tenantClient(ctx);

  const body = await req.json() as { notification_ids?: string[] };
  const ids = body.notification_ids;
  if (!ids || ids.length === 0) {
    return Response.json({ error: "notification_ids required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { error } = await db
    .from("notifications")
    .update({ read_at: now })
    .in("id", ids)
    .eq("user_id", user.id)
    .is("read_at", null);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
