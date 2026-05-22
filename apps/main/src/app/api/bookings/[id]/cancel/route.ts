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
import { transitionCommissionState } from "@/lib/commissions/state-machine";

type CommissionRow = {
  id: string;
  status: string;
  platform_retained_cents: bigint;
  currency: string;
  platform_split_rate: number;
};

type PayoutRow = {
  id: string;
  status: string;
  stripe_transfer_id: string | null;
  settled_at: string | null;
  amount_cents: bigint;
};

const CLAWBACK_WINDOW_DAYS = 60;

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

    // Mark booking as cancelled
    await db
      .from("bookings")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", bookingId);

    // Load commissions
    const { data: commissionData } = await db
      .from("commissions")
      .select("id, status, platform_retained_cents, currency, platform_split_rate")
      .eq("booking_id", bookingId)
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
      .eq("commission_id", commission.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!payoutData) {
      return Response.json({ ok: true, clawback: "no_payout" });
    }

    const payout = payoutData as PayoutRow;

    if (payout.status === "pending") {
      // Within hold period — zero out and cancel payout, insert negative revenue row
      await adminDb
        .from("payout_records")
        .update({ status: "cancelled", amount_cents: 0 })
        .eq("id", payout.id);

      // Negative platform_revenue row for clawback
      await adminDb.from("platform_revenue").insert({
        tenant_id: ctx.tenant_id,
        commission_id: commission.id,
        amount_cents: (-BigInt(commission.platform_retained_cents)).toString(),
        currency: commission.currency,
        tier_rate_applied: commission.platform_split_rate,
        notes: "clawback_within_hold_period",
      });

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
        console.warn(
          "[audit-log:STUB] " +
            JSON.stringify({
              action: "clawback_requires_contractual_recovery",
              booking_id: bookingId,
              commission_id: commission.id,
              payout_id: payout.id,
              days_since_settlement: daysSinceSettlement,
              _stub: "§26",
            }),
        );
        return Response.json({ ok: true, clawback: "contractual_recovery_required" });
      }

      if (payout.stripe_transfer_id) {
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not set");
        const stripe = new Stripe(stripeKey);
        const reversalKey = `clawback-${payout.id}`;

        await stripe.transfers.createReversal(
          payout.stripe_transfer_id,
          {},
          { idempotencyKey: reversalKey },
        );

        // Negative revenue row for the reversal
        await adminDb.from("platform_revenue").insert({
          tenant_id: ctx.tenant_id,
          commission_id: commission.id,
          amount_cents: (-BigInt(commission.platform_retained_cents)).toString(),
          currency: commission.currency,
          tier_rate_applied: commission.platform_split_rate,
          notes: `stripe_reversal:${reversalKey}`,
        });

        await transitionCommissionState(commission.id, "waived", { reason: "stripe_reversal" });
        return Response.json({ ok: true, clawback: "stripe_reversal_initiated" });
      }
    }

    return Response.json({ ok: true, clawback: "no_action" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error";
    return Response.json({ error: message }, { status: 500 });
  }
}
