// Stripe webhook integration tests
// Spec ref: §7.9a — Stripe webhook handler contract
//
// Validates the three invariants that matter most:
//   1. Invalid signature → 400 (no row inserted, Stripe won't retry with same payload)
//   2. Duplicate delivery → 200 + exactly one row in stripe_webhook_events
//   3. Unhandled event type → row with processing_outcome = 'unhandled', 200
//
// Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (to read rows),
//           STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET set in the environment.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { handleStripeWebhook } from "@/lib/stripe/webhook-handler";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const haveAll = Boolean(
  SUPABASE_URL && SERVICE_KEY && STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET,
);

const describeIf = haveAll ? describe : describe.skip;

// Builds a valid signed Stripe event payload + signature header.
function buildSignedEvent(
  stripe: Stripe,
  secret: string,
  eventType: string,
  eventId: string,
): { body: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000);
  const event = {
    id: eventId,
    object: "event",
    type: eventType,
    api_version: "2024-04-10",
    created: timestamp,
    data: { object: {} },
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
  };
  const body = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
  });
  return { body, signature };
}

describeIf("Stripe webhook handler", () => {
  let admin: SupabaseClient;
  let stripe: Stripe;
  const insertedEventIds: string[] = [];

  beforeEach(() => {
    admin = createClient(SUPABASE_URL!, SERVICE_KEY!);
    stripe = new Stripe(STRIPE_SECRET_KEY!);
  });

  afterEach(async () => {
    // Clean up any rows inserted during this test
    if (insertedEventIds.length > 0) {
      await admin
        .from("stripe_webhook_events")
        .delete()
        .in("stripe_event_id", insertedEventIds);
      insertedEventIds.length = 0;
    }
  });

  it("returns 400 on invalid signature", async () => {
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: "customer.created" });
    const req = new Request("http://localhost/api/webhooks/stripe/platform", {
      method: "POST",
      body,
      headers: { "stripe-signature": "bad-sig" },
    });

    const res = await handleStripeWebhook(req, "platform");
    expect(res.status).toBe(400);
  });

  it("deduplicates: second delivery of same event returns 200 with one row", async () => {
    const eventId = `evt_dup_${randomUUID().slice(0, 8)}`;
    insertedEventIds.push(eventId);

    const { body, signature } = buildSignedEvent(
      stripe,
      STRIPE_WEBHOOK_SECRET!,
      "customer.subscription.created",
      eventId,
    );

    const makeRequest = () =>
      new Request("http://localhost/api/webhooks/stripe/platform", {
        method: "POST",
        body,
        headers: { "stripe-signature": signature },
      });

    // First delivery
    const res1 = await handleStripeWebhook(makeRequest(), "platform");
    expect(res1.status).toBe(200);

    // Second delivery (duplicate)
    const res2 = await handleStripeWebhook(makeRequest(), "platform");
    expect(res2.status).toBe(200);

    // Exactly one row
    const { data, error } = await admin
      .from("stripe_webhook_events")
      .select("stripe_event_id")
      .eq("stripe_event_id", eventId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("marks unhandled event type with processing_outcome = unhandled", async () => {
    const eventId = `evt_unhandled_${randomUUID().slice(0, 8)}`;
    insertedEventIds.push(eventId);

    const { body, signature } = buildSignedEvent(
      stripe,
      STRIPE_WEBHOOK_SECRET!,
      "some.unknown.event.type",
      eventId,
    );

    const req = new Request("http://localhost/api/webhooks/stripe/platform", {
      method: "POST",
      body,
      headers: { "stripe-signature": signature },
    });

    const res = await handleStripeWebhook(req, "platform");
    expect(res.status).toBe(200);

    const { data, error } = await admin
      .from("stripe_webhook_events")
      .select("processing_outcome")
      .eq("stripe_event_id", eventId)
      .single();

    expect(error).toBeNull();
    expect(data?.processing_outcome).toBe("unhandled");
  });
});
