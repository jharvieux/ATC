// Spec ref: §7.9a — Stripe webhook handler contract
//
// Service-role import is permitted here: webhook handlers operate outside any
// user session. This file is in the no-direct-service-role-import allowlist.
//
// Processing contract (§7.9a):
//   1. Verify stripe-signature — 400 on failure, no retry
//   2. Atomic idempotency insert into stripe_webhook_events
//      - 200 on duplicate only after prior processing completed successfully
//      - 500 and clear stale row when duplicate is incomplete/error so Stripe retries
//   3. Dispatch to event-type handler. Currently wired:
//        - transfer.reversed                   (§14.9  payout clawback)
//        - checkout.session.completed          (§15.8  subscription IDs + stage)
//        - account.updated                     (§15.6 / §15.9 tax form + Connect)
//        - customer.subscription.created       (§15.16 initial subscription state)
//        - customer.subscription.updated       (§15.16 ongoing status)
//        - customer.subscription.deleted       (§15.16 cancellation)
//        - invoice.payment_succeeded           (§15.16 paying-status clear)
//        - invoice.payment_failed              (§15.16 grace-clock start)
//      Unknown event types fall through to processing_outcome='unhandled'
//      and a 200 (so Stripe doesn't retry events we don't care about).
//   4. Update row with processing_completed_at + outcome
//   5. Return 200
// Any uncaught exception: update row to outcome='error', return 500 (Stripe retries)
//
// Ordering protection (#1583): the subscription-status handlers below
// (customer.subscription.*, invoice.payment_succeeded/failed) are
// at-least-once and unordered, and the error path above clears the dedup
// row, so a stale event CAN be re-delivered after newer events already
// advanced the tenant's state. Each handler compares the event's `created`
// envelope timestamp against `tenants.subscription_status_event_at` (the
// last-applied event's timestamp) via isStaleSubscriptionEvent() and
// discards events that aren't newer. That JS check is a cheap early-out —
// two concurrent deliveries can both pass it before either writes. The
// actual correctness layer is the `.or(subscription_status_event_at.is.null,
// ...lt.<event created>)` WHERE clause on the UPDATE itself, which makes the
// staleness check atomic in the DB; a 0-row result means a concurrent newer
// event already won and this write is silently dropped.

import Stripe from "stripe";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { STALE_WEBHOOK_PROCESSING_MS } from "./webhook-constants";

export type WebhookEndpoint = "platform" | "connect";

function isStaleSubscriptionEvent(
  eventType: string,
  eventId: string,
  eventCreatedIso: string,
  tenantId: string,
  lastEventAt: string | null,
): boolean {
  if (lastEventAt && eventCreatedIso <= lastEventAt) {
    console.warn(
      "[stripe-webhook] %s: stale event %s (created %s) not newer than last-applied %s for tenant %s — discarding",
      eventType,
      eventId,
      eventCreatedIso,
      lastEventAt,
      tenantId,
    );
    return true;
  }
  return false;
}

async function clearStripeWebhookEventRow(
  db: ReturnType<typeof createServiceRoleClient>,
  eventId: string,
): Promise<void> {
  const { error } = await db
    .from("stripe_webhook_events")
    .delete()
    .eq("stripe_event_id", eventId);
  if (error) {
    throw new Error(`stripe_webhook_events cleanup failed: ${error.message}`);
  }
}

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

  // Stripe signs webhooks with HMAC-SHA256; the `stripe-signature` header is
  // `t=<unix-ts>,v1=<hex-digest>` — the digest is HEX, not base64/base64url.
  // constructEvent recomputes the digest over `<t>.<rawBody>` and enforces the
  // default 5-min timestamp tolerance, so the RAW request body must be passed
  // unmodified (any re-serialization breaks the digest). The hex round-trip is
  // exercised by buildSignedEvent in test/integration/stripe-webhook.test.ts.
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
    raw_event: event as unknown as Record<string, unknown>,
    processing_started_at: new Date().toISOString(),
  });

  if (insertErr) {
    // Postgres unique-constraint violation (23505) = duplicate delivery
    if (insertErr.code === "23505") {
      const { data: existingEvent, error: lookupErr } = await db
        .from("stripe_webhook_events")
        .select("processing_completed_at, processing_outcome, processing_started_at")
        .eq("stripe_event_id", event.id)
        .maybeSingle();
      if (lookupErr) {
        console.error("[stripe-webhook] Duplicate lookup failed for %s: %s", event.id, lookupErr.message);
        return new Response("Database error", { status: 500 });
      }

      const completedAt = (existingEvent as { processing_completed_at?: string | null } | null)?.processing_completed_at;
      const outcome = (existingEvent as { processing_outcome?: string | null } | null)?.processing_outcome;
      if (completedAt && outcome !== "error") {
        console.log("[stripe-webhook] Duplicate event %s — returning 200", event.id);
        return new Response("Duplicate", { status: 200 });
      }

      // [review gap-fill for #719] Age guard before clearing. The original PR
      // deleted ANY incomplete duplicate, but an incomplete row that started only
      // moments ago is most likely a CONCURRENT delivery still in-flight on
      // another invocation — Stripe is at-least-once and can overlap. Deleting it
      // would orphan that run (its completion UPDATE matches 0 rows, silently), and
      // a later retry would re-insert + reprocess → double-processing for handlers
      // that aren't independently idempotent. So only the prior run ERRORED, or an
      // incomplete row older than the stale threshold (crashed), is safe to clear.
      // A still-fresh in-flight row: ask Stripe to retry later WITHOUT deleting —
      // by the next delivery it's either completed (→200 above) or stale (→cleared).
      const startedAt = (existingEvent as { processing_started_at?: string | null } | null)?.processing_started_at;
      const startedMsAgo = startedAt ? Date.now() - Date.parse(startedAt) : Number.POSITIVE_INFINITY;
      if (outcome !== "error" && startedMsAgo < STALE_WEBHOOK_PROCESSING_MS) {
        console.warn("[stripe-webhook] Duplicate event %s still in-flight (started %dms ago) — 500 to retry later, not clearing", event.id, startedMsAgo);
        return new Response("In-flight, retry later", { status: 500 });
      }

      try {
        await clearStripeWebhookEventRow(db, event.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[stripe-webhook] Failed to clear stale duplicate %s: %s", event.id, msg);
        return new Response("Database error", { status: 500 });
      }
      console.warn("[stripe-webhook] Duplicate event %s had incomplete/error processing — cleared row for retry", event.id);
      return new Response("Retry incomplete webhook", { status: 500 });
    }
    console.error("[stripe-webhook] Insert failed: %s", insertErr.message);
    return new Response("Database error", { status: 500 });
  }

  let processingOutcome: string = "unhandled";
  let errorDetail: string | null = null;

  try {
    // Step 3: Dispatch to event-type handler
    // transfer.reversed is a valid Stripe event but absent from some SDK type
    // unions. Cast to string to match it alongside the known exhaustive union.
    //
    // NOTE: payout SETTLEMENT ('processing' → 'paid') is NOT handled here. In
    // Stripe's separate charges-and-transfers model a Transfer settles the
    // instant transfers.create() returns and no transfer.paid webhook is ever
    // delivered, so settlement happens synchronously in payouts-execute-transfer
    // (and payouts-reconcile-processing as the recovery path). §14.7.
    switch (event.type as string) {
      case "transfer.reversed": {
        // §14.9 — Stripe transfer reversed (clawback). process_transfer_reversal()
        // atomically: flips payout_records paid→reversed, writes a negative
        // 'recovery' payout_records row (the ledger entry, keyed
        // transfer_id:event_id), debits payout_balances.available_cents, marks
        // the commission disputed, and opens a reconciliation_review_queue row.
        // Single RPC prevents the crash window of a multi-call sequence (D-091 P8).
        // The recovery row's unique key is the ledger idempotency guard (#1127):
        // money moves ONLY when that row inserts. Returns 1 when a reversal delta
        // was applied; 0 when no payout row exists (not ours) OR this exact
        // (transfer, event) was already applied. Each partial reversal is a
        // distinct event → its own recovery row + balance delta (#1156).
        const rawEvent = event as {
          data: {
            object: Stripe.Transfer;
            previous_attributes?: { amount_reversed?: number };
          };
        };
        const transfer = rawEvent.data.object;

        // Partial reversal: amount_reversed is cumulative; delta is this delivery's amount.
        const prevAmountReversed = rawEvent.data.previous_attributes?.amount_reversed ?? 0;
        const thisReversalCents = transfer.amount_reversed - prevAmountReversed;

        // Re-delivery with same cumulative amount_reversed and no previous_attributes:
        // delta is zero — nothing new to process.
        if (thisReversalCents <= 0) {
          console.warn(
            "[stripe-webhook] transfer.reversed: zero/negative delta for %s (possible re-delivery with same amount_reversed); skipping RPC",
            transfer.id,
          );
          break;
        }

        const { data: processedCount, error: reversalErr } = await db.rpc("process_transfer_reversal", {
          p_transfer_id: transfer.id,
          p_this_reversal_cents: thisReversalCents,
          p_stripe_event_id: event.id,
        });
        if (reversalErr) throw new Error(`process_transfer_reversal failed: ${reversalErr.message}`);

        if ((processedCount as number) > 0) {
          processingOutcome = "success";
        } else {
          console.warn(
            "[stripe-webhook] transfer.reversed: no reversal applied for transfer %s — not ours or already processed",
            transfer.id,
          );
        }
        break;
      }
      // §15.8 — Stripe Checkout session completed: write subscription IDs, advance stage.
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription && session.customer) {
          const tenantId = session.metadata?.tenant_id;
          if (tenantId) {
            const { data: tenant, error: tenantSelectErr } = await db
              .from("tenants")
              .select("onboarding_stage, tenant_type")
              .eq("id", tenantId)
              .maybeSingle();
            if (tenantSelectErr) throw new Error(`checkout.session.completed tenant select failed: ${tenantSelectErr.message}`);

            const { error: updateErr } = await db.from("tenants").update({
              stripe_subscription_id: String(session.subscription),
              stripe_customer_id: String(session.customer),
            }).eq("id", tenantId);
            if (updateErr) {
              throw new Error(`checkout.session.completed update failed: ${updateErr.message}`);
            }

            if (tenant?.onboarding_stage === "subscription") {
              const { progressTo } = await import("@/lib/onboarding/state-machine");
              // BYO hosts skip connect_setup (sub-host payout setup).
              const nextStage = tenant.tenant_type === "byo_host" ? "branding" : "connect_setup";
              await progressTo(tenantId, nextStage);
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
        const { data: tenantRow, error: accountTenantErr } = await db
          .from("tenants")
          .select("id, onboarding_stage")
          .eq("stripe_connect_account_id", account.id)
          .maybeSingle();
        if (accountTenantErr) throw new Error(`account.updated tenant select failed: ${accountTenantErr.message}`);

        if (tenantRow) {
          const updates: Record<string, unknown> = {};
          const { progressTo } = await import("@/lib/onboarding/state-machine");

          if (account.details_submitted && tenantRow.onboarding_stage === "tax_form") {
            updates.w9_received_at = new Date().toISOString();
            const { error: updateErr } = await db.from("tenants").update(updates).eq("id", tenantRow.id);
            if (updateErr) {
              throw new Error(`account.updated (tax_form) update failed: ${updateErr.message}`);
            }
            await progressTo(tenantRow.id, "state_of_operation");
          } else if (
            account.payouts_enabled &&
            tenantRow.onboarding_stage === "connect_setup"
          ) {
            updates.connect_setup_completed_at = new Date().toISOString();
            const { error: updateErr } = await db.from("tenants").update(updates).eq("id", tenantRow.id);
            if (updateErr) {
              throw new Error(`account.updated (connect_setup) update failed: ${updateErr.message}`);
            }
            await progressTo(tenantRow.id, "branding");
          }
          // D-091 P2 #16 — removed dead `else if (Object.keys(updates).length > 0)`
          // branch. `updates` is initialised as {} and ONLY populated inside the
          // two branches above; reaching this branch means neither fired, so the
          // condition was always false and the DB write was dead code.
          processingOutcome = "success";
        }
        break;
      }

      // §15.16 — Subscription state changes. Drive tenants.subscription_status
      // + non_paying_since, which the middleware payment gate and cron
      // filters read. PAYING_STATUSES (active/trialing) → clear the timestamp;
      // anything else → set it iff not already set (preserves grace clock
      // across rapid status transitions).
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const { data: tenantRow, error: subTenantErr } = await db
          .from("tenants")
          .select("id, non_paying_since, subscription_status_event_at")
          .eq("stripe_subscription_id", sub.id)
          .maybeSingle();
        if (subTenantErr) throw new Error(`${event.type} tenant select failed: ${subTenantErr.message}`);
        if (!tenantRow) {
          break;
        }

        const eventCreatedIso = new Date(event.created * 1000).toISOString();
        if (
          isStaleSubscriptionEvent(
            event.type,
            event.id,
            eventCreatedIso,
            tenantRow.id,
            (tenantRow as { subscription_status_event_at: string | null }).subscription_status_event_at,
          )
        ) {
          break;
        }

        const status = event.type === "customer.subscription.deleted"
          ? "canceled"
          : (sub.status as string);
        const isPaying = status === "active" || status === "trialing";

        const updates: Record<string, unknown> = {
          subscription_status: status,
          subscription_status_event_at: eventCreatedIso,
        };
        if (isPaying) {
          updates.non_paying_since = null;
        } else if (!(tenantRow as { non_paying_since: string | null }).non_paying_since) {
          updates.non_paying_since = new Date().toISOString();
        }
        const casRows = await safeAwait(
          db
            .from("tenants")
            .update(updates)
            .eq("id", tenantRow.id)
            .or(`subscription_status_event_at.is.null,subscription_status_event_at.lt.${eventCreatedIso}`)
            .select("id"),
          `tenants.update.${event.type}`,
        );
        if (!casRows || casRows.length === 0) {
          console.warn(
            "[stripe-webhook] %s: CAS guard rejected update for tenant %s (event %s) — a newer event won the race",
            event.type,
            tenantRow.id,
            event.id,
          );
          break;
        }
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
          break;
        }
        const { data: tenantRow, error: paySuccessTenantErr } = await db
          .from("tenants")
          .select("id, subscription_status, subscription_status_event_at")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        if (paySuccessTenantErr) throw new Error(`invoice.payment_succeeded tenant select failed: ${paySuccessTenantErr.message}`);
        if (!tenantRow) {
          break;
        }
        const eventCreatedIso = new Date(event.created * 1000).toISOString();
        if (
          isStaleSubscriptionEvent(
            event.type,
            event.id,
            eventCreatedIso,
            tenantRow.id,
            (tenantRow as { subscription_status_event_at: string | null }).subscription_status_event_at,
          )
        ) {
          break;
        }
        const cur = (tenantRow as { subscription_status: string | null }).subscription_status;
        const updates: Record<string, unknown> = {
          non_paying_since: null,
          subscription_status_event_at: eventCreatedIso,
        };
        if (cur !== "active" && cur !== "trialing") {
          updates.subscription_status = "active";
        }
        const casRows = await safeAwait(
          db
            .from("tenants")
            .update(updates)
            .eq("id", tenantRow.id)
            .or(`subscription_status_event_at.is.null,subscription_status_event_at.lt.${eventCreatedIso}`)
            .select("id"),
          `tenants.update.${event.type}`,
        );
        if (!casRows || casRows.length === 0) {
          console.warn(
            "[stripe-webhook] %s: CAS guard rejected update for tenant %s (event %s) — a newer event won the race",
            event.type,
            tenantRow.id,
            event.id,
          );
          break;
        }
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
          break;
        }
        const { data: tenantRow, error: payFailedTenantErr } = await db
          .from("tenants")
          .select("id, non_paying_since, subscription_status_event_at")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        if (payFailedTenantErr) throw new Error(`invoice.payment_failed tenant select failed: ${payFailedTenantErr.message}`);
        if (!tenantRow) {
          break;
        }
        const eventCreatedIso = new Date(event.created * 1000).toISOString();
        if (
          isStaleSubscriptionEvent(
            event.type,
            event.id,
            eventCreatedIso,
            tenantRow.id,
            (tenantRow as { subscription_status_event_at: string | null }).subscription_status_event_at,
          )
        ) {
          break;
        }
        const updates: Record<string, unknown> = {
          subscription_status: "past_due",
          subscription_status_event_at: eventCreatedIso,
        };
        if (!(tenantRow as { non_paying_since: string | null }).non_paying_since) {
          updates.non_paying_since = new Date().toISOString();
        }
        const casRows = await safeAwait(
          db
            .from("tenants")
            .update(updates)
            .eq("id", tenantRow.id)
            .or(`subscription_status_event_at.is.null,subscription_status_event_at.lt.${eventCreatedIso}`)
            .select("id"),
          `tenants.update.${event.type}`,
        );
        if (!casRows || casRows.length === 0) {
          console.warn(
            "[stripe-webhook] %s: CAS guard rejected update for tenant %s (event %s) — a newer event won the race",
            event.type,
            tenantRow.id,
            event.id,
          );
          break;
        }
        processingOutcome = "success";
        break;
      }
      default:
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
    try {
      await clearStripeWebhookEventRow(db, event.id);
    } catch (err) {
      // [review note #719] Swallow on purpose (unlike the duplicate-path clear,
      // which propagates): we're already returning 500 so Stripe retries, and the
      // next delivery's duplicate-path clears this still-incomplete/errored row.
      // Re-throwing would only mask the real handler error with a cleanup error.
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[stripe-webhook] Failed to clear errored row for %s: %s", event.id, msg);
    }
    return new Response("Handler error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}
