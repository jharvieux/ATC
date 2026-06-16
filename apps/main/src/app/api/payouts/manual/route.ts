// §7.6 / §14.6 — Request a manual payout.
//
// POST /api/payouts/manual
//
// Precondition: tenants.stripe_connect_account_id must be set. Otherwise
// returns 412 with a structured hint so the UI can route the user to
// Connect onboarding. The actual transfer is still handled by the daily
// payouts-execute-transfer cron (§14.7); this route is the agent-facing
// "request it now" signal and acknowledges the available balance.
//
// The transition from 'available' to 'in_flight' / 'paid' happens in
// the cron — this route does NOT mutate payout_records (avoiding a
// state-machine boundary the cron owns).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

interface PayoutSumRow {
  amount_cents: string | number | null;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "payouts",
      action: "request",
    });

    const db = tenantClient(ctx);
    const { data: tenantRow, error: tenantErr } = await db
      .from("tenants")
      .select("stripe_connect_account_id")
      .eq("id", ctx.tenant_id)
      .maybeSingle();
    if (tenantErr) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }
    const stripeAccountId = (tenantRow as { stripe_connect_account_id?: string | null } | null)
      ?.stripe_connect_account_id;

    if (!stripeAccountId) {
      return Response.json(
        {
          error: "stripe_connect_incomplete",
          detail:
            "Manual payouts require a completed Stripe Connect onboarding. " +
            "Open /settings/billing to finish.",
          action_path: "/settings/billing",
        },
        { status: 412 },
      );
    }

    // Surface the current available balance so the UI can confirm
    // "request received, X will land at the next payout window."
    const { data: rows, error: balErr } = await db
      .from("payout_records")
      .select("amount_cents")
      .eq("status", "available");
    if (balErr) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }
    let availableCents = 0n;
    for (const r of (rows ?? []) as PayoutSumRow[]) {
      if (r.amount_cents != null) availableCents += BigInt(r.amount_cents);
    }

    return Response.json(
      {
        status: "requested",
        available_cents: availableCents.toString(),
        // §14.7 — payouts-execute-transfer runs daily; the request is
        // acknowledged but the actual Stripe transfer happens on the
        // next cron tick. UI should reflect this expectation.
        message:
          availableCents === 0n
            ? "No available balance to pay out yet."
            : "Request received; transfer runs at the next daily payout window.",
      },
      { status: 202 },
    );
  } catch (err) {
    return respondToAuthError(err);
  }
}
