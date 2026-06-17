// §26.9 — Vercel cron: vendor health probe (every 15 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runVendorHealthProbe } from "@/lib/cron/vendor-health-probe";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runVendorHealthProbe();
  return Response.json(result);
}
