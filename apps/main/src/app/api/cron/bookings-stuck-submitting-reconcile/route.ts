// §14.4 — Vercel cron: reconcile bookings stuck in 'submitting' (every 5 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runBookingsStuckSubmittingReconcile } from "@/lib/cron/bookings-stuck-submitting-reconcile";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runBookingsStuckSubmittingReconcile();
  return Response.json(result);
}
