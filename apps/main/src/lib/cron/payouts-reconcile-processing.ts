// §14.7 — Reconciliation cron for 'processing' payout records. Runs every
// 5 minutes via Vercel cron (/api/cron/payouts-reconcile-processing).
//
// Recovery path for the "Stripe call succeeded but the response was lost"
// (network timeout) case left behind by payouts-execute-transfer.
//
// For each payout_records row in 'processing' older than 60s:
//   1. Check Stripe by idempotency key (via transfer metadata lookup).
//   2. Transfer found → write stripe_transfer_id AND settle 'processing' → 'paid'.
//   3. Transfer not found → re-call Stripe with same key (idempotency cache
//      prevents duplicates), then settle the same way.
// A transfer settles the instant it exists (separate charges-and-transfers model;
// no transfer.paid webhook), so once we know the transfer exists the row must not
// be left in 'processing'. The status='processing' guard keeps this safe against a
// concurrent execute-transfer settling the same row.
//
// CRITICAL: attempt_generation is NEVER auto-incremented here.
// Auto-increment would produce duplicate transfers (§14.7 last "Calls Worth Flagging").
//
// Service-role import permitted: background cron, no user session. §5.4.4.

import Stripe from "stripe";
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

// Settle a reconciled row: write the transfer id and move 'processing' → 'paid'.
// The .eq("status","processing") guard makes this idempotent against a concurrent
// execute-transfer settling the same row — 0 rows matched means it already settled,
// which is benign (log, don't throw). safeAwait still throws on a real DB error.
async function settleReconciledRow(
  db: ReturnType<typeof createServiceRoleClient>,
  rowId: string,
  transferId: string,
): Promise<void> {
  const settled = await safeAwait(db
    .from("payout_records")
    .update({
      stripe_transfer_id: transferId,
      status: "paid",
      settled_at: new Date().toISOString(),
    })
    .eq("id", rowId)
    .eq("status", "processing")
    .select("id"), "payout_records.update.reconcile_settle");
  if (!settled || settled.length === 0) {
    console.info(
      `payouts-reconcile-processing: payout ${rowId} no longer 'processing' at settle (transfer ${transferId}) — already settled by another path`,
    );
  }
}

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
        // Transfer found — record it and settle (it settled the moment it existed).
        await settleReconciledRow(db, row.id, existing.id);
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

        await settleReconciledRow(db, row.id, transfer.id);

        recovered++;
      }
    } catch (err) {
      console.error(`payouts-reconcile-processing: error for payout ${row.id}:`, err);
    }
  }

  return { recovered, total_processing: processing.length };
}
