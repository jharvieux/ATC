// §26.6 — Vercel cron: auth failure spike monitor (every 5 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runAuthFailureMonitor } from "@/lib/cron/auth-failure-monitor";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runAuthFailureMonitor();
  return Response.json(result);
}
