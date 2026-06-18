// §8.7a — Vercel cron: retry failed RAG tenant-event deliveries (every 15 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runRagSyncRetry } from "@/lib/cron/rag-sync-retry";
import { assertCronAuth } from "@/lib/cron/assert-cron-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authErr = assertCronAuth(req);
  if (authErr) return authErr;
  const result = await runRagSyncRetry();
  return Response.json(result);
}
