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
  dataObject: Record<string, unknown> = {},
  previousAttributes?: Record<string, unknown>,
): { body: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000);
  const event = {
    id: eventId,
    object: "event",
    type: eventType,
    api_version: "2024-04-10",
    created: timestamp,
    data: {
      object: dataObject,
      ...(previousAttributes ? { previous_attributes: previousAttributes } : {}),
    },
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

  it("transfer.reversed for an unknown transfer reverses 0 rows → outcome 'unhandled', 200", async () => {
    // §14.9 — the reversal UPDATE is guarded by stripe_transfer_id + status='paid'.
    // A transfer id that matches no payout_records row must NOT throw (which would
    // make Stripe retry the clawback forever); 0 rows matched → outcome 'unhandled'
    // → 200. Asserting against the real DB proves the guarded UPDATE is benign.
    const eventId = `evt_reversed_${randomUUID().slice(0, 8)}`;
    insertedEventIds.push(eventId);

    const { body, signature } = buildSignedEvent(
      stripe,
      STRIPE_WEBHOOK_SECRET!,
      "transfer.reversed",
      eventId,
      { id: `tr_nonexistent_${randomUUID().slice(0, 8)}` },
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

  it("transfer.reversed same-event re-delivery: dedup unique constraint returns 'Duplicate' — no double-credit", async () => {
    // Stripe re-delivers the exact same event_id (network retry / at-least-once guarantee).
    // The stripe_webhook_events unique constraint catches it before the RPC runs.
    // Balance must reflect a single deduction, not 2×.
    const slug = `tw-${randomUUID().slice(0, 8)}`;
    const transferId = `tr_replay_${randomUUID().slice(0, 8)}`;
    const eventId = `evt_replay_${randomUUID().slice(0, 8)}`;
    insertedEventIds.push(eventId);

    const { data: tenant } = await admin
      .from("tenants")
      .insert({ slug, display_name: "Replay Test", legal_name: "Replay Test LLC", tenant_type: "sub_host" })
      .select("id")
      .single();
    const tenantId = tenant!.id as string;

    await admin.from("payout_records").insert({
      tenant_id: tenantId,
      stripe_transfer_id: transferId,
      status: "paid",
      amount_cents: 20000,
    });
    await admin.from("payout_balances").upsert({
      tenant_id: tenantId,
      available_cents: 0,
      pending_cents: 0,
      in_transit_cents: 0,
      hold_period_days: 7,
    });

    const makeReq = () => {
      const { body, signature } = buildSignedEvent(
        stripe,
        STRIPE_WEBHOOK_SECRET!,
        "transfer.reversed",
        eventId,
        { id: transferId, amount_reversed: 20000 },
      );
      return new Request("http://localhost/api/webhooks/stripe/platform", {
        method: "POST",
        body,
        headers: { "stripe-signature": signature },
      });
    };

    // First delivery: reverses the row, credits balance
    const res1 = await handleStripeWebhook(makeReq(), "platform");
    expect(res1.status).toBe(200);

    // Re-delivery of SAME event_id → unique constraint fires → 'Duplicate'
    const res2 = await handleStripeWebhook(makeReq(), "platform");
    expect(res2.status).toBe(200);
    expect(await res2.text()).toBe("Duplicate");

    // Balance must equal a single deduction, not 2×
    const { data: bal } = await admin
      .from("payout_balances")
      .select("available_cents")
      .eq("tenant_id", tenantId)
      .single();
    expect(Number(bal?.available_cents)).toBe(-20000);

    // Cleanup
    await admin.from("payout_records").delete().eq("stripe_transfer_id", transferId);
    await admin.from("payout_balances").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  });

  it("[#1156] transfer.reversed second partial: distinct event credits balance delta, opens second review row", async () => {
    // Scenario: Stripe partially reverses a transfer in two steps (real Stripe behaviour:
    // each step is a distinct event_id with previous_attributes.amount_reversed set).
    // Event 1: amount_reversed=15000, no previous_attributes → first partial, delta=15000.
    // Event 2: amount_reversed=40000, previous_attributes.amount_reversed=15000 → second partial, delta=25000.
    // The RPC's second pass (FOR UPDATE on status='reversed') must credit the second delta
    // and open a second reconciliation_review_queue clawback row. Total balance = -40000.
    const slug = `tw-${randomUUID().slice(0, 8)}`;
    const transferId = `tr_partial2_${randomUUID().slice(0, 8)}`;
    const eventId1 = `evt_partial2_a_${randomUUID().slice(0, 8)}`;
    const eventId2 = `evt_partial2_b_${randomUUID().slice(0, 8)}`;
    insertedEventIds.push(eventId1, eventId2);

    // Seed: tenant → booking → commission → payout_record (with commission_id)
    // Commission linkage is required so the second-pass review-queue INSERT fires
    // (the RPC skips the INSERT when commission_id IS NULL, mirroring the first pass).
    const { data: tenant } = await admin
      .from("tenants")
      .insert({ slug, display_name: "Partial2 Test", legal_name: "Partial2 Test LLC", tenant_type: "sub_host" })
      .select("id")
      .single();
    const tenantId = tenant!.id as string;

    const { data: booking } = await admin
      .from("bookings")
      .insert({ tenant_id: tenantId })
      .select("id")
      .single();

    const { data: commission } = await admin
      .from("commissions")
      .insert({
        tenant_id: tenantId,
        booking_id: booking!.id,
        commissionable_fare_cents: 500000,
        commission_rate: 0.1,
        platform_split_rate: 0.2,
        gross_commission_cents: 50000,
        host_booking_fee_cents: 0,
        net_commission_cents: 50000,
        platform_retained_cents: 10000,
        subhost_payable_cents: 40000,
      })
      .select("id")
      .single();
    const commissionId = commission!.id as string;

    await admin.from("payout_records").insert({
      tenant_id: tenantId,
      commission_id: commissionId,
      stripe_transfer_id: transferId,
      status: "paid",
      amount_cents: 40000,
    });
    await admin.from("payout_balances").upsert({
      tenant_id: tenantId,
      available_cents: 0,
      pending_cents: 0,
      in_transit_cents: 0,
      hold_period_days: 7,
    });

    // Event 1: first partial reversal — payout_record flips to 'reversed', balance -15000
    const { body: body1, signature: sig1 } = buildSignedEvent(
      stripe, STRIPE_WEBHOOK_SECRET!, "transfer.reversed", eventId1,
      { id: transferId, amount_reversed: 15000 },
    );
    const res1 = await handleStripeWebhook(
      new Request("http://localhost/api/webhooks/stripe/platform", {
        method: "POST", body: body1, headers: { "stripe-signature": sig1 },
      }),
      "platform",
    );
    expect(res1.status).toBe(200);

    // Event 2: second partial reversal — second pass credits delta=25000, balance -40000
    const { body: body2, signature: sig2 } = buildSignedEvent(
      stripe, STRIPE_WEBHOOK_SECRET!, "transfer.reversed", eventId2,
      { id: transferId, amount_reversed: 40000 },
      { amount_reversed: 15000 },
    );
    const res2 = await handleStripeWebhook(
      new Request("http://localhost/api/webhooks/stripe/platform", {
        method: "POST", body: body2, headers: { "stripe-signature": sig2 },
      }),
      "platform",
    );
    expect(res2.status).toBe(200);

    // Both events must resolve as 'success' (one row processed each)
    const { data: ev1 } = await admin.from("stripe_webhook_events")
      .select("processing_outcome").eq("stripe_event_id", eventId1).single();
    expect(ev1?.processing_outcome).toBe("success");

    const { data: ev2 } = await admin.from("stripe_webhook_events")
      .select("processing_outcome").eq("stripe_event_id", eventId2).single();
    expect(ev2?.processing_outcome).toBe("success");

    // Total balance: -15000 (first) + -25000 (second) = -40000
    const { data: bal } = await admin.from("payout_balances")
      .select("available_cents").eq("tenant_id", tenantId).single();
    expect(Number(bal?.available_cents)).toBe(-40000);

    // Two clawback rows in reconciliation_review_queue: one per partial delivery
    const { data: queueRows } = await admin.from("reconciliation_review_queue")
      .select("status, variance_cents").eq("commission_id", commissionId);
    expect(queueRows).toHaveLength(2);
    expect(queueRows?.every((r) => r.status === "clawback")).toBe(true);
    const deltas = queueRows?.map((r) => Number(r.variance_cents)).sort((a, b) => a - b);
    expect(deltas).toEqual([15000, 25000]);

    // Cleanup
    await admin.from("reconciliation_review_queue").delete().eq("commission_id", commissionId);
    await admin.from("payout_records").delete().eq("stripe_transfer_id", transferId);
    await admin.from("payout_balances").delete().eq("tenant_id", tenantId);
    await admin.from("commissions").delete().eq("id", commissionId);
    await admin.from("bookings").delete().eq("id", booking!.id);
    await admin.from("audit_log").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  });

  // §14.9 clawback ledger tests — seed a real payout chain and verify all
  // downstream effects fire atomically.

  it("transfer.reversed (full): credits available balance, marks commission disputed, opens clawback queue row", async () => {
    const slug = `tw-${randomUUID().slice(0, 8)}`;
    const transferId = `tr_full_${randomUUID().slice(0, 8)}`;
    const eventId = `evt_full_${randomUUID().slice(0, 8)}`;
    insertedEventIds.push(eventId);

    // Seed: tenant → booking → commission → payout_record
    const { data: tenant } = await admin
      .from("tenants")
      .insert({ slug, display_name: "Webhook Test", legal_name: "Webhook Test LLC", tenant_type: "sub_host" })
      .select("id")
      .single();
    const tenantId = tenant!.id as string;

    const { data: booking } = await admin
      .from("bookings")
      .insert({ tenant_id: tenantId })
      .select("id")
      .single();

    const { data: commission } = await admin
      .from("commissions")
      .insert({
        tenant_id: tenantId,
        booking_id: booking!.id,
        commissionable_fare_cents: 500000,
        commission_rate: 0.1,
        platform_split_rate: 0.2,
        gross_commission_cents: 50000,
        host_booking_fee_cents: 0,
        net_commission_cents: 50000,
        platform_retained_cents: 10000,
        subhost_payable_cents: 40000,
      })
      .select("id")
      .single();
    const commissionId = commission!.id as string;

    await admin.from("payout_records").insert({
      tenant_id: tenantId,
      commission_id: commissionId,
      stripe_transfer_id: transferId,
      status: "paid",
      amount_cents: 40000,
    });

    // Seed a starting payout_balance so we can assert the credit delta.
    await admin.from("payout_balances").upsert({
      tenant_id: tenantId,
      available_cents: 0,
      pending_cents: 0,
      in_transit_cents: 0,
      hold_period_days: 7,
    });

    const { body, signature } = buildSignedEvent(
      stripe,
      STRIPE_WEBHOOK_SECRET!,
      "transfer.reversed",
      eventId,
      { id: transferId, amount_reversed: 40000 },
    );

    const req = new Request("http://localhost/api/webhooks/stripe/platform", {
      method: "POST",
      body,
      headers: { "stripe-signature": signature },
    });

    const res = await handleStripeWebhook(req, "platform");
    expect(res.status).toBe(200);

    // stripe_webhook_events → success (guards against silent 'unhandled' fall-through)
    const { data: evt } = await admin
      .from("stripe_webhook_events")
      .select("processing_outcome")
      .eq("stripe_event_id", eventId)
      .single();
    expect(evt?.processing_outcome).toBe("success");

    // payout_record → reversed
    const { data: pr } = await admin
      .from("payout_records")
      .select("status")
      .eq("stripe_transfer_id", transferId)
      .single();
    expect(pr?.status).toBe("reversed");

    // payout_balances debited: a §14.9 clawback deducts the reversed amount
    // from funds already settled to the tenant, so available_cents can go
    // negative — this is the money being pulled back, not a balance error.
    const { data: bal } = await admin
      .from("payout_balances")
      .select("available_cents")
      .eq("tenant_id", tenantId)
      .single();
    expect(Number(bal?.available_cents)).toBe(-40000);

    // commission → disputed
    const { data: comm } = await admin
      .from("commissions")
      .select("status")
      .eq("id", commissionId)
      .single();
    expect(comm?.status).toBe("disputed");

    // audit_log row written for the clawback transition — this RPC is the only
    // commission status change outside the app-layer state machine, so without
    // this row the §14.9 transition would leave no audit trail, while every
    // other commission transition logs one via transitionCommissionState.
    const { data: audit } = await admin
      .from("audit_log")
      .select("action, changes")
      .eq("resource_type", "commission")
      .eq("resource_id", commissionId)
      .single();
    expect(audit?.action).toBe("commission.state_transition");
    const auditChanges = audit?.changes as { to?: string; reason?: string } | null;
    expect(auditChanges?.to).toBe("disputed");
    expect(auditChanges?.reason).toBe("transfer_reversed");

    // reconciliation_review_queue → clawback row
    const { data: queue } = await admin
      .from("reconciliation_review_queue")
      .select("status, variance_cents")
      .eq("commission_id", commissionId)
      .single();
    expect(queue?.status).toBe("clawback");
    expect(Number(queue?.variance_cents)).toBe(40000);

    // Cleanup seeded data (stripe_webhook_events cleaned by afterEach)
    await admin.from("reconciliation_review_queue").delete().eq("commission_id", commissionId);
    await admin.from("payout_records").delete().eq("stripe_transfer_id", transferId);
    await admin.from("payout_balances").delete().eq("tenant_id", tenantId);
    await admin.from("commissions").delete().eq("id", commissionId);
    await admin.from("bookings").delete().eq("id", booking!.id);
    // audit_log FK→tenants has no ON DELETE CASCADE; the clawback writes an
    // audit row, so it must be cleared before the tenant delete or that delete
    // FK-violates (silently, since the cleanup result isn't checked).
    await admin.from("audit_log").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  });

  it("transfer.reversed (partial): credits only the delta amount, not the full payout", async () => {
    const slug = `tw-${randomUUID().slice(0, 8)}`;
    const transferId = `tr_partial_${randomUUID().slice(0, 8)}`;
    const eventId = `evt_partial_${randomUUID().slice(0, 8)}`;
    insertedEventIds.push(eventId);

    const { data: tenant } = await admin
      .from("tenants")
      .insert({ slug, display_name: "Webhook Test", legal_name: "Webhook Test LLC", tenant_type: "sub_host" })
      .select("id")
      .single();
    const tenantId = tenant!.id as string;

    const { data: booking } = await admin
      .from("bookings")
      .insert({ tenant_id: tenantId })
      .select("id")
      .single();

    const { data: commission } = await admin
      .from("commissions")
      .insert({
        tenant_id: tenantId,
        booking_id: booking!.id,
        commissionable_fare_cents: 500000,
        commission_rate: 0.1,
        platform_split_rate: 0.2,
        gross_commission_cents: 50000,
        host_booking_fee_cents: 0,
        net_commission_cents: 50000,
        platform_retained_cents: 10000,
        subhost_payable_cents: 40000,
      })
      .select("id")
      .single();
    const commissionId = commission!.id as string;

    await admin.from("payout_records").insert({
      tenant_id: tenantId,
      commission_id: commissionId,
      stripe_transfer_id: transferId,
      status: "paid",
      amount_cents: 40000,
    });

    await admin.from("payout_balances").upsert({
      tenant_id: tenantId,
      available_cents: 0,
      pending_cents: 0,
      in_transit_cents: 0,
      hold_period_days: 7,
    });

    // Partial reversal: 15000 cents reversed this time (cumulative 15000, prev 0)
    const { body, signature } = buildSignedEvent(
      stripe,
      STRIPE_WEBHOOK_SECRET!,
      "transfer.reversed",
      eventId,
      { id: transferId, amount_reversed: 15000 },
      { amount_reversed: 0 },
    );

    const req = new Request("http://localhost/api/webhooks/stripe/platform", {
      method: "POST",
      body,
      headers: { "stripe-signature": signature },
    });

    const res = await handleStripeWebhook(req, "platform");
    expect(res.status).toBe(200);

    // stripe_webhook_events → success (guards against silent 'unhandled' fall-through)
    const { data: evt } = await admin
      .from("stripe_webhook_events")
      .select("processing_outcome")
      .eq("stripe_event_id", eventId)
      .single();
    expect(evt?.processing_outcome).toBe("success");

    // Only the delta (15000) should be deducted, not the full 40000 (§14.9 clawback)
    const { data: bal } = await admin
      .from("payout_balances")
      .select("available_cents")
      .eq("tenant_id", tenantId)
      .single();
    expect(Number(bal?.available_cents)).toBe(-15000);

    // Queue row reflects the partial reversal amount
    const { data: queue } = await admin
      .from("reconciliation_review_queue")
      .select("variance_cents")
      .eq("commission_id", commissionId)
      .single();
    expect(Number(queue?.variance_cents)).toBe(15000);

    await admin.from("reconciliation_review_queue").delete().eq("commission_id", commissionId);
    await admin.from("payout_records").delete().eq("stripe_transfer_id", transferId);
    await admin.from("payout_balances").delete().eq("tenant_id", tenantId);
    await admin.from("commissions").delete().eq("id", commissionId);
    await admin.from("bookings").delete().eq("id", booking!.id);
    // audit_log FK→tenants has no ON DELETE CASCADE; the clawback writes an
    // audit row, so it must be cleared before the tenant delete or that delete
    // FK-violates (silently, since the cleanup result isn't checked).
    await admin.from("audit_log").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  });

  it("transfer.reversed with no commission_id: credits balance but skips commission update and queue row", async () => {
    const slug = `tw-${randomUUID().slice(0, 8)}`;
    const transferId = `tr_nocomm_${randomUUID().slice(0, 8)}`;
    const eventId = `evt_nocomm_${randomUUID().slice(0, 8)}`;
    insertedEventIds.push(eventId);

    const { data: tenant } = await admin
      .from("tenants")
      .insert({ slug, display_name: "Webhook Test", legal_name: "Webhook Test LLC", tenant_type: "sub_host" })
      .select("id")
      .single();
    const tenantId = tenant!.id as string;

    await admin.from("payout_records").insert({
      tenant_id: tenantId,
      commission_id: null,
      stripe_transfer_id: transferId,
      status: "paid",
      amount_cents: 25000,
    });

    await admin.from("payout_balances").upsert({
      tenant_id: tenantId,
      available_cents: 0,
      pending_cents: 0,
      in_transit_cents: 0,
      hold_period_days: 7,
    });

    const { body, signature } = buildSignedEvent(
      stripe,
      STRIPE_WEBHOOK_SECRET!,
      "transfer.reversed",
      eventId,
      { id: transferId, amount_reversed: 25000 },
    );

    const req = new Request("http://localhost/api/webhooks/stripe/platform", {
      method: "POST",
      body,
      headers: { "stripe-signature": signature },
    });

    const res = await handleStripeWebhook(req, "platform");
    expect(res.status).toBe(200);

    // stripe_webhook_events → success (guards against silent 'unhandled' fall-through)
    const { data: evt } = await admin
      .from("stripe_webhook_events")
      .select("processing_outcome")
      .eq("stripe_event_id", eventId)
      .single();
    expect(evt?.processing_outcome).toBe("success");

    // Balance debited (clawback — §14.9)
    const { data: bal } = await admin
      .from("payout_balances")
      .select("available_cents")
      .eq("tenant_id", tenantId)
      .single();
    expect(Number(bal?.available_cents)).toBe(-25000);

    // No reconciliation_review_queue row created
    const { data: queue } = await admin
      .from("reconciliation_review_queue")
      .select("id")
      .eq("tenant_id", tenantId);
    expect(queue).toHaveLength(0);

    await admin.from("payout_records").delete().eq("stripe_transfer_id", transferId);
    await admin.from("payout_balances").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  });
});
