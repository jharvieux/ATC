// §19.3 — Vercel cron: forum moderation timeout sweep (every 15 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runForumModerationTimeoutSweep } from "@/lib/cron/forum-moderation-timeout-sweep";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runForumModerationTimeoutSweep();
  return Response.json(result);
}
