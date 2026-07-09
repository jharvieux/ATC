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

import "server-only";

import Stripe from "stripe";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertSafeStripeAmount, type Cents } from "@/lib/money";
import { safeAwait } from "@/lib/db/safe-mutation";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

// Stripe idempotency keys expire ~24h after first use. Past that window a
// re-call of transfers.create with the same key is NO LONGER deduplicated by
// Stripe and would move real money a second time (#1579). We use a slightly
// conservative 23h so a row that is close to the boundary is alerted, not
// re-created, rather than racing the exact expiry.
const STRIPE_IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;

// Cap on how many transfer pages we scan when looking for an existing transfer.
// destination-scoped, created-filtered lists are small; this only bounds a
// pathological tenant with thousands of same-day transfers.
const MAX_TRANSFER_PAGES = 20;

type ProcessingRow = {
  id: string;
  tenant_id: string;
  amount_cents: bigint;
  attempt_generation: number;
  currency: string;
  stripe_transfer_id: string | null;
  created_at: string;
};

// Page transfers.list filtered by created >= the payout row's created_at so the
// lookup is authoritative for THIS payout's window, instead of the old
// last-10-transfers scan that missed a transfer buried behind 10+ newer ones
// (#1579). Returns the matching transfer or null after exhausting the window.
async function findExistingTransfer(
  stripe: Stripe,
  destination: string,
  createdAtSec: number,
  idempotencyKey: string,
): Promise<Stripe.Transfer | null> {
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_TRANSFER_PAGES; page++) {
    const params: Stripe.TransferListParams = {
      destination,
      created: { gte: createdAtSec },
      limit: 100,
    };
    if (startingAfter) params.starting_after = startingAfter;
    const batch = await stripe.transfers.list(params);
    const match = batch.data.find((t) => t.metadata?.idempotency_key === idempotencyKey);
    if (match) return match;
    if (!batch.has_more || batch.data.length === 0) break;
    startingAfter = batch.data[batch.data.length - 1]?.id;
  }
  return null;
}

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
  // #1694 — gate the whole safety net on BOOKING_RECONCILE_DISABLED, NOT
  // BOOKING_CRONS_DISABLED. During an incident the operator sets BOOKING_CRONS_DISABLED
  // to stop new money movement; this reconcile sweep must keep running so a stuck
  // 'processing' payout still gets recovered/flagged. Only the dedicated reconcile
  // switch stops it entirely.
  if (process.env.BOOKING_RECONCILE_DISABLED === "true") {
    return { recovered: 0, total_processing: 0 };
  }
  // #1694 — when the money-movement switch is on we may still READ Stripe and settle
  // already-existing transfers (recording money that has already moved is not new
  // movement), but we must NOT INITIATE a transfer via transfers.create. That branch
  // is suppressed below and the operator is alerted to reconcile by hand.
  const moneyMovementDisabled = process.env.BOOKING_CRONS_DISABLED === "true";
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not set");
  const stripe = new Stripe(stripeKey);

  const db = createServiceRoleClient();
  const cutoffTime = new Date(Date.now() - 60_000).toISOString();

  const { data: rows, error } = await db
    .from("payout_records")
    .select("id, tenant_id, amount_cents, attempt_generation, currency, stripe_transfer_id, created_at")
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
      // Authoritative lookup: page the full window since the payout was created,
      // not just the tenant's last 10 transfers (#1579).
      const createdAtMs = new Date(row.created_at).getTime();
      const createdAtSec = Math.floor(createdAtMs / 1000);
      const existing = await findExistingTransfer(
        stripe,
        tenant.stripe_connect_account_id,
        createdAtSec,
        idempotencyKey,
      );

      if (existing) {
        // Transfer found — record it and settle (it settled the moment it existed).
        await settleReconciledRow(db, row.id, existing.id);
        recovered++;
        continue;
      }

      // No transfer exists. Re-calling transfers.create is only safe while
      // Stripe still honours the idempotency key. Past the window a re-call is
      // NOT deduplicated and would double-pay (#1579) — alert the operator to
      // reconcile by hand (e.g. bump attempt_generation after confirming no
      // transfer landed) instead of moving money a second time.
      if (Date.now() - createdAtMs > STRIPE_IDEMPOTENCY_WINDOW_MS) {
        await sendOperatorAlert({
          severity: "high",
          signal: "payout_reconcile_past_idempotency_window",
          detail:
            `Payout ${row.id} has been 'processing' with no Stripe transfer for longer than ` +
            `the ${Math.round(STRIPE_IDEMPOTENCY_WINDOW_MS / 3_600_000)}h Stripe idempotency window. ` +
            `The reconcile cron will NOT auto-recreate the transfer (the idempotency key may have ` +
            `expired, so a re-call could double-pay). Confirm whether a transfer landed and, if not, ` +
            `bump attempt_generation to allow a fresh, safely-keyed retry.`,
          payload: {
            payout_record_id: row.id,
            tenant_id: row.tenant_id,
            amount_cents: row.amount_cents.toString(),
            created_at: row.created_at,
            idempotency_key: idempotencyKey,
          },
        });
        continue;
      }

      // #1694 — money-movement switch on: do NOT initiate a transfer even though the
      // idempotency key is still valid. Leave the row 'processing' and alert the
      // operator so a human decides when new money may move again.
      if (moneyMovementDisabled) {
        await sendOperatorAlert({
          severity: "high",
          signal: "payout_reconcile_transfer_suppressed_money_movement_disabled",
          detail:
            `Payout ${row.id} has no Stripe transfer and is within the idempotency window, ` +
            `but BOOKING_CRONS_DISABLED is on, so the reconcile cron will NOT initiate a ` +
            `transfer. The row stays 'processing'. Re-enable money movement (or transfer by ` +
            `hand) to release it.`,
          payload: {
            payout_record_id: row.id,
            tenant_id: row.tenant_id,
            amount_cents: row.amount_cents.toString(),
            created_at: row.created_at,
            idempotency_key: idempotencyKey,
          },
        });
        continue;
      }

      // Within the window — a re-call with the same key is deduplicated by Stripe.
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
    } catch (err) {
      console.error(`payouts-reconcile-processing: error for payout ${row.id}:`, err);
    }
  }

  return { recovered, total_processing: processing.length };
}
