// §14.9 — Booking cancellation with clawback logic.
//
// When a booking is cancelled:
//   - commission.state = 'expected' → waive (no money received, nothing to claw back)
//   - commission.state = 'received' + payout 'pending' → zero payout, insert negative platform_revenue
//   - payout 'available' or later (within 60d) → Stripe Connect reversal
//   - >60d from payout → emit clawback_requires_contractual_recovery (platform admin only)

import Stripe from "stripe";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { transitionCommissionState, InvalidCommissionTransitionError } from "@/lib/commissions/state-machine";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait, safeAwaitRowCount, SupabaseMutationError } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";

type CommissionRow = {
  id: string;
  status: string;
  platform_retained_cents: bigint;
  currency: string;
  platform_split_rate: number;
  received_commission_cents: bigint | null;
  gross_commission_cents: bigint;
};

type PayoutRow = {
  id: string;
  status: string;
  stripe_transfer_id: string | null;
  settled_at: string | null;
  amount_cents: bigint;
};

const CLAWBACK_WINDOW_DAYS = 60;

/**
 * §34.8.2 — Write clawback fields onto the commissions row so §36's
 * "Lost revenue from cancellations" report can query them. Called from
 * each branch in §14.9 cancellation that produces a clawback (pending
 * payout zeroed, Stripe reversal, contractual recovery required).
 *
 * `amount` is the cents value clawed back (BigInt to match the
 * commissions money columns). `reason` is free text; commonly populated
 * from the cancellation context.
 */
async function writeClawbackFields(
  adminDb: ReturnType<typeof createServiceRoleClient>,
  commissionId: string,
  tenantId: string,
  amount: bigint,
  reason: string,
): Promise<void> {
  await safeAwait(adminDb
    .from("commissions")
    .update({
      clawback_amount_cents: amount.toString(),
      clawback_at: new Date().toISOString(),
      clawback_reason: reason,
    })
    .eq("tenant_id", tenantId)
    .eq("id", commissionId), "commissions.update");
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bookings", action: "cancel" });
    const { id: bookingId } = await params;

    const db = tenantClient(ctx);
    const adminDb = createServiceRoleClient();

    // Load booking
    const { data: bookingData, error: bookingError } = await db
      .from("bookings")
      .select("id, status")
      .eq("id", bookingId)
      .single();

    if (bookingError || !bookingData) {
      return Response.json({ error: "Booking not found." }, { status: 404 });
    }
    if ((bookingData as { status: string }).status === "cancelled") {
      return Response.json({ error: "Booking is already cancelled." }, { status: 422 });
    }

    // §36.5.2 — optional cancellation_reason_category + free-text reason
    // from the request body. Both nullable in the schema; we accept both
    // as optional in v1 (UI requires the free-text reason).
    const body = (await req.json().catch(() => ({}))) as {
      cancellation_reason?: unknown;
      cancellation_reason_category?: unknown;
    };
    const reason = typeof body.cancellation_reason === "string" ? body.cancellation_reason : null;
    const reasonCategory = typeof body.cancellation_reason_category === "string"
      ? body.cancellation_reason_category
      : null;

    const VALID_CATEGORIES = new Set([
      "customer_change_of_mind",
      "medical",
      "family_emergency",
      "financial",
      "cruise_line_change",
      "weather_or_natural_disaster",
      "poor_prior_experience_with_line",
      "other",
    ]);
    if (reasonCategory && !VALID_CATEGORIES.has(reasonCategory)) {
      return Response.json({ error: `invalid_category:${reasonCategory}` }, { status: 400 });
    }

    // Mark booking as cancelled
    await safeAwait(db
      .from("bookings")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        cancellation_reason: reason,
        cancellation_reason_category: reasonCategory,
      })
      .eq("id", bookingId), "bookings.update");

    // Load commissions
    const { data: commissionData } = await db
      .from("commissions")
      .select("id, status, platform_retained_cents, currency, platform_split_rate, received_commission_cents, gross_commission_cents")
      .eq("booking_id", bookingId)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();

    if (!commissionData) {
      return Response.json({ ok: true, clawback: "no_commission" });
    }

    const commission = commissionData as CommissionRow;

    if (commission.status === "expected") {
      // No money received — simply waive
      await transitionCommissionState(commission.id, "waived", {
        reason: "booking_cancelled_before_receipt",
      });
      return Response.json({ ok: true, clawback: "waived" });
    }

    if (commission.status !== "received" && commission.status !== "partial") {
      return Response.json({ ok: true, clawback: "not_applicable" });
    }

    // Load payout record
    const { data: payoutData } = await adminDb
      .from("payout_records")
      .select("id, status, stripe_transfer_id, settled_at, amount_cents")
      .eq("tenant_id", ctx.tenant_id)
      .eq("commission_id", commission.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!payoutData) {
      return Response.json({ ok: true, clawback: "no_payout" });
    }

    const payout = payoutData as PayoutRow;

    if (payout.status === "pending") {
      // Zero out the pending payout before writing the clawback — money in the hold
      // period hasn't left the platform yet, so we can cancel the transfer. The CAS
      // guard (.eq("status","pending")) is what makes this safe: if the payout raced
      // to 'processing'/'available' (sub-host funds already on the way), the update
      // matches 0 rows → 409 so the caller retries with fresh state, rather than
      // writing a clawback against an un-cancelled transfer (D-091 R2 / #846).
      try {
        await safeAwaitRowCount(
          adminDb
            .from("payout_records")
            .update({ status: "cancelled", amount_cents: 0 })
            .eq("tenant_id", ctx.tenant_id)
            .eq("id", payout.id)
            .eq("status", "pending")
            .select("id"),
          "payout_records.cas_cancel",
          1,
        );
      } catch (err) {
        if (err instanceof SupabaseMutationError && err.code === "ROW_COUNT_MISMATCH") {
          return Response.json(
            { error: "payout_state_changed", message: "Payout status changed concurrently — retry" },
            { status: 409 },
          );
        }
        throw err;
      }

      // Negative platform_revenue row for clawback
      await safeAwait(adminDb.from("platform_revenue").insert({
        tenant_id: ctx.tenant_id,
        commission_id: commission.id,
        amount_cents: (-BigInt(commission.platform_retained_cents)).toString(),
        currency: commission.currency,
        tier_rate_applied: commission.platform_split_rate,
        notes: "clawback_within_hold_period",
      }), "platform_revenue.insert");

      // §34.8.2 — record clawback for §36 "Lost revenue from cancellations" report.
      await writeClawbackFields(adminDb, commission.id, ctx.tenant_id, commission.gross_commission_cents, "cancelled_during_hold");

      await transitionCommissionState(commission.id, "waived", { reason: "cancelled_during_hold" });
      return Response.json({ ok: true, clawback: "cancelled_pending_payout" });
    }

    if (
      payout.status === "available" ||
      payout.status === "processing" ||
      payout.status === "paid"
    ) {
      const settledAt = payout.settled_at ? new Date(payout.settled_at) : null;
      const daysSinceSettlement = settledAt
        ? (Date.now() - settledAt.getTime()) / (1000 * 60 * 60 * 24)
        : 0;

      if (daysSinceSettlement > CLAWBACK_WINDOW_DAYS) {
        // After 60d — alert platform admin, no automatic action
        await writeAuditLog({
          tenant_id: ctx.tenant_id,
          actor_type: "system",
          action: "clawback_requires_contractual_recovery",
          resource_type: "booking",
          resource_id: bookingId,
          changes: {
            commission_id: commission.id,
            payout_id: payout.id,
            days_since_settlement: daysSinceSettlement,
          },
        });
        // §34.8.2 — record the clawback intent even though recovery is manual,
        // so §36's report counts the canceled-but-not-recovered amount.
        const receivedAmount = commission.received_commission_cents ?? commission.gross_commission_cents;
        await writeClawbackFields(adminDb, commission.id, ctx.tenant_id, receivedAmount, "contractual_recovery_required_post_60d");
        return Response.json({ ok: true, clawback: "contractual_recovery_required" });
      }

      if (payout.stripe_transfer_id) {
        // F-pay-01 (#1375 / #1391) — settled-payout clawback must be
        // single-entry AND crash-recoverable. The unique idempotency_key on
        // platform_revenue makes the ledger INSERT itself the guard
        // (ON CONFLICT DO NOTHING), so correctness no longer depends on payout
        // status ordering.
        //
        // Order (D-091 #10): Stripe reversal FIRST (idempotency-keyed, so
        // concurrent duplicates collapse to one and a failed call leaves the
        // payout untouched + retryable) → idempotent ledger insert (the
        // single-entry guard) → idempotent payout status flip → idempotent
        // finalize. A crash anywhere in this branch is recoverable on retry:
        // the reversal no-ops, the ledger upsert DO-NOTHINGs (no duplicate),
        // the status flip converges, and the finalize re-runs idempotently.
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not set");
        const stripe = new Stripe(stripeKey);
        const reversalKey = `clawback-${payout.id}`;

        await stripe.transfers.createReversal(
          payout.stripe_transfer_id,
          {},
          { idempotencyKey: reversalKey },
        );

        // The single-entry guard: ignoreDuplicates → ON CONFLICT DO NOTHING on
        // the unique idempotency_key. A concurrent cancel / post-crash retry can
        // re-run this with no duplicate negative ledger row.
        await safeAwait(
          adminDb
            .from("platform_revenue")
            .upsert(
              {
                tenant_id: ctx.tenant_id,
                commission_id: commission.id,
                amount_cents: (-BigInt(commission.platform_retained_cents)).toString(),
                currency: commission.currency,
                tier_rate_applied: commission.platform_split_rate,
                notes: `stripe_reversal:${reversalKey}`,
                idempotency_key: reversalKey,
              },
              { onConflict: "idempotency_key", ignoreDuplicates: true },
            ),
          "platform_revenue.insert",
        );

        // Converge the payout to reversed — idempotent (no status-CAS), so a
        // retry never dead-ends at 409.
        await safeAwait(
          adminDb
            .from("payout_records")
            .update({ status: "reversed", reversed_at: new Date().toISOString() })
            .eq("tenant_id", ctx.tenant_id)
            .eq("id", payout.id),
          "payout_records.update.reversed",
        );

        // Finalize (§34.8.2): record the clawback for §36 + waive the
        // commission. Run unconditionally so a post-crash retry converges — both
        // steps are idempotent: writeClawbackFields writes fixed values, and a
        // commission already 'waived' by a concurrent winner makes the terminal
        // self-transition a tolerated no-op (reaching this branch means it
        // wasn't 'waived' at entry — §14.9 early-returns otherwise — so the
        // throw only happens in the concurrent-loser race).
        const receivedAmount = commission.received_commission_cents ?? commission.gross_commission_cents;
        await writeClawbackFields(adminDb, commission.id, ctx.tenant_id, receivedAmount, `stripe_reversal:${reversalKey}`);
        try {
          await transitionCommissionState(commission.id, "waived", { reason: "stripe_reversal" });
        } catch (err) {
          if (!(err instanceof InvalidCommissionTransitionError && err.from === "waived" && err.to === "waived")) {
            throw err;
          }
          // Already waived by a concurrent winner — idempotent no-op.
        }
        return Response.json({ ok: true, clawback: "stripe_reversal_initiated" });
      }
    }

    return Response.json({ ok: true, clawback: "no_action" });
  } catch (err) {
    return respondToAuthError(err);
  }
}
