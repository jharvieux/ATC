// §14.7 — Reconciliation cron for 'processing' payout records.
//
// Runs every 5 minutes. For each payout_records row in 'processing' older than 60s:
//   1. Check Stripe by idempotency key (via transfer metadata lookup).
//   2. Transfer found → write stripe_transfer_id; row stays 'processing' for webhook.
//   3. Transfer not found → re-call Stripe with same key (idempotency cache prevents duplicates).
//
// CRITICAL: attempt_generation is NEVER auto-incremented here.
// Auto-increment would produce duplicate transfers (§14.7 last "Calls Worth Flagging").

import Stripe from "stripe";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertSafeStripeAmount, type Cents } from "@/lib/money";
import { safeAwait } from "@/lib/db/safe-mutation";

type ProcessingRow = {
  id: string;
  tenant_id: string;
  amount_cents: bigint;
  attempt_generation: number;
  currency: string;
  stripe_transfer_id: string | null;
};

type TenantRow = { stripe_connect_account_id: string | null };

// D-091 / error-injection probe — inner body extracted for direct test
// invocation.
export async function runPayoutsReconcileProcessing(): Promise<{ recovered: number; total_processing: number }> {
  if (process.env.BOOKING_CRONS_DISABLED === "true") {
    return { recovered: 0, total_processing: 0 };
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not set");
    const stripe = new Stripe(stripeKey);

    const db = createServiceRoleClient();
    const cutoffTime = new Date(Date.now() - 60_000).toISOString();

    const { data: rows, error } = await db
      .from("payout_records")
      .select("id, tenant_id, amount_cents, attempt_generation, currency, stripe_transfer_id")
      .eq("status", "processing")
      .is("stripe_transfer_id", null)
      .lt("created_at", cutoffTime);

    if (error) throw new Error(`payouts-reconcile-processing: fetch failed: ${error.message}`);

    const processing = rows ?? [];
    let recovered = 0;

    for (const rawRow of processing) {
      const row = rawRow as ProcessingRow;
      const idempotencyKey = `payout-${row.id}-gen${row.attempt_generation}`;

      const { data: tenantData } = await db
        .from("tenants")
        .select("stripe_connect_account_id")
        .eq("id", row.tenant_id)
        .single();

      const tenant = tenantData as TenantRow | null;
      if (!tenant?.stripe_connect_account_id) continue;

      try {
        // Search for an existing transfer with our idempotency key in metadata
        const transfers = await stripe.transfers.list({
          destination: tenant.stripe_connect_account_id,
          limit: 10,
        });

        const existing = transfers.data.find(
          (t) => t.metadata?.idempotency_key === idempotencyKey,
        );

        if (existing) {
          // Transfer found — write stripe_transfer_id
          await safeAwait(db
            .from("payout_records")
            .update({ stripe_transfer_id: existing.id })
            .eq("id", row.id), "payout_records.update");
          recovered++;
        } else {
          // Transfer not found — re-call with same idempotency key
          const amountCents = BigInt(row.amount_cents) as Cents;
          assertSafeStripeAmount(amountCents);

          const transfer = await stripe.transfers.create(
            {
              amount: Number(amountCents),
              currency: row.currency.toLowerCase(),
              destination: tenant.stripe_connect_account_id,
              description: `ATC payout for record ${row.id} (reconciliation retry)`,
              metadata: {
                payout_record_id: row.id,
                tenant_id: row.tenant_id,
                idempotency_key: idempotencyKey,
              },
            },
            { idempotencyKey },
          );

          await safeAwait(db
            .from("payout_records")
            .update({ stripe_transfer_id: transfer.id })
            .eq("id", row.id), "payout_records.update");

          recovered++;
        }
      } catch (err) {
        console.error(`payouts-reconcile-processing: error for payout ${row.id}:`, err);
      }
    }

  return { recovered, total_processing: processing.length };
}

export const payoutsReconcileProcessing = inngest.createFunction(
  {
    id: "payouts-reconcile-processing",
    triggers: [{ cron: "*/5 * * * *" }],
  },
  runPayoutsReconcileProcessing,
);
