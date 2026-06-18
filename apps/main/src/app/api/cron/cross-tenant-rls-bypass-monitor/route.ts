// §26.6 — Vercel cron: cross-tenant RLS bypass attempt monitor (every 15 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runCrossTenantRlsBypassMonitor } from "@/lib/cron/cross-tenant-rls-bypass-monitor";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runCrossTenantRlsBypassMonitor();
  return Response.json(result);
}
