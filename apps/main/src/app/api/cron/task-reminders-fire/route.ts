// BP37 §37.3 — Vercel cron: task reminder fire-up (every minute).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runTaskRemindersFire } from "@/lib/cron/task-reminders-fire";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runTaskRemindersFire();
  return Response.json(result);
}
