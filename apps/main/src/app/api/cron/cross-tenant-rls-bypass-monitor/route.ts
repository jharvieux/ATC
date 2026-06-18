// §26.6 — Vercel cron: cross-tenant RLS bypass attempt monitor (every 15 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runCrossTenantRlsBypassMonitor } from "@/lib/cron/cross-tenant-rls-bypass-monitor";
import { assertCronAuth } from "@/lib/cron/assert-cron-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authErr = assertCronAuth(req);
  if (authErr) return authErr;
  const result = await runCrossTenantRlsBypassMonitor();
  return Response.json(result);
}
