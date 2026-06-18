// §26.6 — Vercel cron: auth failure spike monitor (every 5 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runAuthFailureMonitor } from "@/lib/cron/auth-failure-monitor";
import { assertCronAuth } from "@/lib/cron/assert-cron-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authErr = assertCronAuth(req);
  if (authErr) return authErr;
  const result = await runAuthFailureMonitor();
  return Response.json(result);
}
