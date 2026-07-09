// §23.8 — Mark notification(s) as read.
// POST /api/notifications/mark-read { notification_ids: string[] }

import { markNotifications } from "@/lib/notifications/mark";

export async function POST(req: Request): Promise<Response> {
  return markNotifications(req, "read_at");
}
