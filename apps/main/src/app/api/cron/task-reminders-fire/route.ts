// BP37 §37.3 — Vercel cron: task reminder fire-up (every minute).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runTaskRemindersFire } from "@/lib/cron/task-reminders-fire";
import { assertCronAuth } from "@/lib/cron/assert-cron-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authErr = assertCronAuth(req);
  if (authErr) return authErr;
  const result = await runTaskRemindersFire();
  return Response.json(result);
}
