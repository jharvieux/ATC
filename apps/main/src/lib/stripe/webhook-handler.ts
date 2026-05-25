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
    // transfer.paid is a valid Stripe event but absent from some SDK type unions.
    // Cast to string to allow matching it alongside the known exhaustive union.
    switch (event.type as string) {
      case "transfer.paid": {
        // §14.7 — Stripe transfer paid: transition payout_records 'processing' → 'paid'
        const transfer = (event as { data: { object: Stripe.Transfer } }).data.object;
        const { data: payoutRows } = await db
          .from("payout_records")
          .select("id")
          .eq("stripe_transfer_id", transfer.id)
          .eq("status", "processing");

        if (payoutRows && payoutRows.length > 0) {
          const ids = payoutRows.map((r) => (r as { id: string }).id);
          await db
            .from("payout_records")
            .update({ status: "paid", settled_at: new Date().toISOString() })
            .in("id", ids);
          processingOutcome = "success";
        } else {
          console.warn(
            "[stripe-webhook] transfer.paid: no payout_records row for transfer %s",
            transfer.id,
          );
          processingOutcome = "unhandled";
        }
        break;
      }
      // §15.8 — Stripe Checkout session completed: write subscription IDs, advance stage.
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription && session.customer) {
          const tenantId = session.metadata?.tenant_id;
          if (tenantId) {
            const { data: tenant } = await db
              .from("tenants")
              .select("onboarding_stage")
              .eq("id", tenantId)
              .maybeSingle();

            await db.from("tenants").update({
              stripe_subscription_id: String(session.subscription),
              stripe_customer_id: String(session.customer),
            }).eq("id", tenantId);

            if (tenant?.onboarding_stage === "subscription") {
              const { progressTo } = await import("@/lib/onboarding/state-machine");
              await progressTo(tenantId, "connect_setup");
            }
            processingOutcome = "success";
          }
        }
        break;
      }

      // §15.6 / §15.9 — account.updated: tax form completion and Connect setup completion.
      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        // Find tenant by stripe_connect_account_id.
        const { data: tenantRow } = await db
          .from("tenants")
          .select("id, onboarding_stage")
          .eq("stripe_connect_account_id", account.id)
          .maybeSingle();

        if (tenantRow) {
          const updates: Record<string, unknown> = {};
          const { progressTo } = await import("@/lib/onboarding/state-machine");

          if (account.details_submitted && tenantRow.onboarding_stage === "tax_form") {
            updates.w9_received_at = new Date().toISOString();
            await db.from("tenants").update(updates).eq("id", tenantRow.id);
            await progressTo(tenantRow.id, "state_of_operation");
          } else if (
            account.payouts_enabled &&
            tenantRow.onboarding_stage === "connect_setup"
          ) {
            updates.connect_setup_completed_at = new Date().toISOString();
            await db.from("tenants").update(updates).eq("id", tenantRow.id);
            await progressTo(tenantRow.id, "branding");
          } else if (Object.keys(updates).length > 0) {
            await db.from("tenants").update(updates).eq("id", tenantRow.id);
          }
          processingOutcome = "success";
        }
        break;
      }

      // §15.16 — Subscription state changes. Drive tenants.subscription_status
      // + non_paying_since, which the middleware payment gate and cron
      // filters read. PAYING_STATUSES (active/trialing) → clear the timestamp;
      // anything else → set it iff not already set (preserves grace clock
      // across rapid status transitions).
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const { data: tenantRow } = await db
          .from("tenants")
          .select("id, non_paying_since")
          .eq("stripe_subscription_id", sub.id)
          .maybeSingle();
        if (!tenantRow) {
          processingOutcome = "unhandled";
          break;
        }

        const status = event.type === "customer.subscription.deleted"
          ? "canceled"
          : (sub.status as string);
        const isPaying = status === "active" || status === "trialing";

        const updates: Record<string, unknown> = { subscription_status: status };
        if (isPaying) {
          updates.non_paying_since = null;
        } else if (!(tenantRow as { non_paying_since: string | null }).non_paying_since) {
          updates.non_paying_since = new Date().toISOString();
        }
        await db.from("tenants").update(updates).eq("id", tenantRow.id);
        processingOutcome = "success";
        break;
      }

      // invoice.payment_succeeded — definitive proof the tenant is paying.
      // Clear non_paying_since unconditionally; bump subscription_status to
      // active if it was lagging (Stripe sends payment_succeeded BEFORE the
      // subscription.updated that flips status sometimes).
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        // Stripe SDK v22 moved invoice.subscription into invoice.parent.
        // subscription_details.subscription (the same field, just reorganised
        // when the Parent type was added to distinguish subscription vs
        // quote-shaped invoice origins).
        const sub = invoice.parent?.subscription_details?.subscription;
        const subId = typeof sub === "string" ? sub : sub?.id;
        if (!subId) {
          processingOutcome = "unhandled";
          break;
        }
        const { data: tenantRow } = await db
          .from("tenants")
          .select("id, subscription_status")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        if (!tenantRow) {
          processingOutcome = "unhandled";
          break;
        }
        const cur = (tenantRow as { subscription_status: string | null }).subscription_status;
        const updates: Record<string, unknown> = { non_paying_since: null };
        if (cur !== "active" && cur !== "trialing") {
          updates.subscription_status = "active";
        }
        await db.from("tenants").update(updates).eq("id", tenantRow.id);
        processingOutcome = "success";
        break;
      }

      // invoice.payment_failed — start the grace clock. Don't overwrite
      // an existing non_paying_since (the clock should run from the FIRST
      // failure, not the most recent retry).
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        // Stripe SDK v22 moved invoice.subscription into invoice.parent.
        // subscription_details.subscription (the same field, just reorganised
        // when the Parent type was added to distinguish subscription vs
        // quote-shaped invoice origins).
        const sub = invoice.parent?.subscription_details?.subscription;
        const subId = typeof sub === "string" ? sub : sub?.id;
        if (!subId) {
          processingOutcome = "unhandled";
          break;
        }
        const { data: tenantRow } = await db
          .from("tenants")
          .select("id, non_paying_since")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        if (!tenantRow) {
          processingOutcome = "unhandled";
          break;
        }
        const updates: Record<string, unknown> = { subscription_status: "past_due" };
        if (!(tenantRow as { non_paying_since: string | null }).non_paying_since) {
          updates.non_paying_since = new Date().toISOString();
        }
        await db.from("tenants").update(updates).eq("id", tenantRow.id);
        processingOutcome = "success";
        break;
      }
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
