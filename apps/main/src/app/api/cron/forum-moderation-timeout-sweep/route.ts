// §19.3 — Vercel cron: forum moderation timeout sweep (every 15 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runForumModerationTimeoutSweep } from "@/lib/cron/forum-moderation-timeout-sweep";
import { assertCronAuth } from "@/lib/cron/assert-cron-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authErr = assertCronAuth(req);
  if (authErr) return authErr;
  const result = await runForumModerationTimeoutSweep();
  return Response.json(result);
}
