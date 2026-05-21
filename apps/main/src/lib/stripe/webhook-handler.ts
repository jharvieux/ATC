// Spec ref: §7.9a — Stripe webhook handler contract
//
// Service-role import is permitted here: webhook handlers operate outside any
// user session. This file is in the no-direct-service-role-import allowlist.
//
// Processing contract (§7.9a):
//   1. Verify stripe-signature — 400 on failure, no retry
//   2. Atomic idempotency insert into stripe_webhook_events — 200 on duplicate
//   3. Dispatch to event-type handler (all TODO stubs for now)
//   4. Update row with processing_completed_at + outcome
//   5. Return 200
// Any uncaught exception: update row to outcome='error', return 500 (Stripe retries)

import Stripe from "stripe";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export type WebhookEndpoint = "platform" | "connect";

export async function handleStripeWebhook(
  req: Request,
  endpoint: WebhookEndpoint,
): Promise<Response> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret =
    endpoint === "platform"
      ? process.env.STRIPE_WEBHOOK_SECRET
      : process.env.STRIPE_CONNECT_WEBHOOK_SECRET;

  if (!stripeSecretKey || !webhookSecret) {
    console.error("[stripe-webhook] Missing Stripe env vars for endpoint=%s", endpoint);
    return new Response("Server configuration error", { status: 500 });
  }

  const stripe = new Stripe(stripeSecretKey);

  // Step 1: Read raw body + verify signature
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig ?? "", webhookSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[stripe-webhook] Signature verification failed: %s", msg);
    return new Response(`Webhook signature verification failed: ${msg}`, { status: 400 });
  }

  const db = createServiceRoleClient();

  // Step 2: Atomic idempotency insert
  const { error: insertErr } = await db.from("stripe_webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    endpoint,
    // tenant_id is NULL for platform events; connect events may set it after dispatch
    tenant_id: null,
    raw_payload: event as unknown as Record<string, unknown>,
    processing_started_at: new Date().toISOString(),
  });

  if (insertErr) {
    // Postgres unique-constraint violation (23505) = duplicate delivery
    if (insertErr.code === "23505") {
      console.log("[stripe-webhook] Duplicate event %s — returning 200", event.id);
      return new Response("Duplicate", { status: 200 });
    }
    console.error("[stripe-webhook] Insert failed: %s", insertErr.message);
    return new Response("Database error", { status: 500 });
  }

  let processingOutcome: string = "unhandled";
  let errorDetail: string | null = null;

  try {
    // Step 3: Dispatch to event-type handler
    switch (event.type) {
      // TODO(§14): customer.subscription.created
      // TODO(§14): customer.subscription.updated
      // TODO(§14): customer.subscription.deleted
      // TODO(§14): invoice.payment_succeeded
      // TODO(§14): invoice.payment_failed
      // TODO(§16): account.updated (Connect)
      // TODO(§16): account.application.deauthorized (Connect)
      // TODO(§16): transfer.created (Connect)
      // TODO(§16): payout.paid (Connect)
      default:
        processingOutcome = "unhandled";
        break;
    }
  } catch (err) {
    errorDetail = err instanceof Error ? err.message : String(err);
    processingOutcome = "error";
    console.error("[stripe-webhook] Handler error for event %s: %s", event.id, errorDetail);
  }

  // Step 4: Update row with outcome
  const { error: updateErr } = await db
    .from("stripe_webhook_events")
    .update({
      processing_completed_at: new Date().toISOString(),
      processing_outcome: processingOutcome,
      ...(errorDetail !== null ? { error_detail: errorDetail } : {}),
    })
    .eq("stripe_event_id", event.id);

  if (updateErr) {
    console.error("[stripe-webhook] Failed to update outcome for %s: %s", event.id, updateErr.message);
  }

  // Step 5: Return based on outcome
  if (processingOutcome === "error") {
    return new Response("Handler error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}
