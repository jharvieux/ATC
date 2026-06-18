// §26.9 — Vercel cron: vendor health probe (every 15 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runVendorHealthProbe } from "@/lib/cron/vendor-health-probe";
import { assertCronAuth } from "@/lib/cron/assert-cron-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authErr = assertCronAuth(req);
  if (authErr) return authErr;
  const result = await runVendorHealthProbe();
  return Response.json(result);
}
