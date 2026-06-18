// §8.7a — Vercel cron: retry failed RAG tenant-event deliveries (every 15 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runRagSyncRetry } from "@/lib/cron/rag-sync-retry";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runRagSyncRetry();
  return Response.json(result);
}
