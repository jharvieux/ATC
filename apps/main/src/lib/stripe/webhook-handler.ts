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
//        - transfer.paid                       (§14.7  payout settlement)
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

import Stripe from "stripe";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { STALE_WEBHOOK_PROCESSING_MS } from "./webhook-constants";

export type WebhookEndpoint = "platform" | "connect";

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
    // transfer.paid is a valid Stripe event but absent from some SDK type unions.
    // Cast to string to allow matching it alongside the known exhaustive union.
    switch (event.type as string) {
      case "transfer.paid": {
        // §14.7 — Stripe transfer paid: transition payout_records 'processing' → 'paid'
        const transfer = (event as { data: { object: Stripe.Transfer } }).data.object;
        // #717: surface DB errors so Stripe retries (non-200) instead of silently
        // stranding a payout_record in 'processing' and acknowledging the event.
        const { data: payoutRows, error: payoutSelectErr } = await db
          .from("payout_records")
          .select("id")
          .eq("stripe_transfer_id", transfer.id)
          .eq("status", "processing");
        if (payoutSelectErr) throw new Error(`transfer.paid select failed: ${payoutSelectErr.message}`);

        if (payoutRows && payoutRows.length > 0) {
          const ids = payoutRows.map((r) => (r as { id: string }).id);
          // D-091 P1 #1 — every Supabase mutation must check error.
          // Silent failure here = payout stuck in 'processing' + 200 to Stripe
          // = Stripe never retries = lost reconciliation.
          // #744: .eq("status","processing") closes the TOCTOU gap — without it,
          // .in("id",ids) matches an admin-reset row and count check still passes.
          const { data: updatedRows, error: updateErr } = await db
            .from("payout_records")
            .update({ status: "paid", settled_at: new Date().toISOString() })
            .in("id", ids)
            .eq("status", "processing")
            .select("id");
          if (updateErr) {
            throw new Error(`transfer.paid update failed: ${updateErr.message}`);
          }
          // ids were just SELECTed for status='processing'; a short count means
          // a concurrent reconcile/admin action moved some rows first (TOCTOU). Throw
          // → non-200 → Stripe retries; the retry's SELECT converges (D-091).
          if ((updatedRows ?? []).length !== ids.length) {
            throw new Error(
              `transfer.paid updated ${(updatedRows ?? []).length} of ${ids.length} expected rows`,
            );
          }
          processingOutcome = "success";
        } else {
          console.warn(
            "[stripe-webhook] transfer.paid: no payout_records row for transfer %s",
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
          .select("id, non_paying_since")
          .eq("stripe_subscription_id", sub.id)
          .maybeSingle();
        if (subTenantErr) throw new Error(`${event.type} tenant select failed: ${subTenantErr.message}`);
        if (!tenantRow) {
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
        const { error: updateErr } = await db.from("tenants").update(updates).eq("id", tenantRow.id);
        if (updateErr) {
          throw new Error(`${event.type} update failed: ${updateErr.message}`);
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
          .select("id, subscription_status")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        if (paySuccessTenantErr) throw new Error(`invoice.payment_succeeded tenant select failed: ${paySuccessTenantErr.message}`);
        if (!tenantRow) {
          break;
        }
        const cur = (tenantRow as { subscription_status: string | null }).subscription_status;
        const updates: Record<string, unknown> = { non_paying_since: null };
        if (cur !== "active" && cur !== "trialing") {
          updates.subscription_status = "active";
        }
        const { error: updateErr } = await db.from("tenants").update(updates).eq("id", tenantRow.id);
        if (updateErr) {
          throw new Error(`invoice.payment_succeeded update failed: ${updateErr.message}`);
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
          .select("id, non_paying_since")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        if (payFailedTenantErr) throw new Error(`invoice.payment_failed tenant select failed: ${payFailedTenantErr.message}`);
        if (!tenantRow) {
          break;
        }
        const updates: Record<string, unknown> = { subscription_status: "past_due" };
        if (!(tenantRow as { non_paying_since: string | null }).non_paying_since) {
          updates.non_paying_since = new Date().toISOString();
        }
        const { error: updateErr } = await db.from("tenants").update(updates).eq("id", tenantRow.id);
        if (updateErr) {
          throw new Error(`invoice.payment_failed update failed: ${updateErr.message}`);
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
