// §23.8 — Dismiss notification(s).
// POST /api/notifications/dismiss { notification_ids: string[] }

import { markNotifications } from "@/lib/notifications/mark";

export async function POST(req: Request): Promise<Response> {
  return markNotifications(req, "dismissed_at");
}
