/** Spec ref: §7.9a — Inngest serve endpoint */

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { stripeWebhookIncompleteReconcile } from "@/inngest/stripe-webhook-incomplete-reconcile";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [stripeWebhookIncompleteReconcile],
});
