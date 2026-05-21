/** Spec ref: §7.9a — Stripe platform webhook endpoint */

import { handleStripeWebhook } from "@/lib/stripe/webhook-handler";

export async function POST(req: Request): Promise<Response> {
  return handleStripeWebhook(req, "platform");
}
