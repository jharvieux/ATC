// §7.9a — Vercel cron: Stripe webhook incomplete-event reconcile (every 15 minutes).
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.

import { runStripeWebhookIncompleteReconcile } from "@/lib/cron/stripe-webhook-incomplete-reconcile";
import { assertCronAuth } from "@/lib/cron/assert-cron-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authErr = assertCronAuth(req);
  if (authErr) return authErr;
  const result = await runStripeWebhookIncompleteReconcile();
  return Response.json(result);
}
