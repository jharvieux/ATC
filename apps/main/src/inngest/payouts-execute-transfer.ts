// §14.7 — Stripe Connect transfer job with deterministic idempotency contract.
//
// CRITICAL ORDER: DB write FIRST, then Stripe call. This is NOT a preference.
// If DB write fails → return early, no Stripe call.
// If Stripe call fails with network timeout → leave row in 'processing'.
//   The reconciliation cron (payouts-reconcile-processing) is the recovery path.
//
// Idempotency key format: payout-{payoutRecord.id}-gen{attempt_generation}
// attempt_generation is NEVER auto-incremented by reconciliation — only by operator reset.

import Stripe from "stripe";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertSafeStripeAmount, type Cents } from "@/lib/money";
import { safeAwait } from "@/lib/db/safe-mutation";

// Drain loop cap — processed rows move to 'processing' so they don't reappear.
const BATCH_LIMIT = 100;
const TIME_BUDGET_MS = 55_000;

type PayoutRow = {
  id: string;
  tenant_id: string;
  amount_cents: bigint;
  attempt_generation: number;
  currency: string;
  commission_id: string | null;
};

type TenantRow = {
  stripe_connect_account_id: string | null;
};

/**
 * D-091 P1 #24 — CAS-style lock acquisition with row-count verification.
 *
 * Supabase JS does NOT throw or return an error when an UPDATE matches
 * zero rows; it returns `{ data: null, error: null }`. Without checking
 * the affected-row count, a concurrent runner that already claimed the
 * lock looks identical to a successful lock acquisition — and the second
 * runner proceeds to its Stripe transfer, double-processing the payout.
 *
 * Chaining `.select("id")` returns the rows that the UPDATE actually
 * affected. Length 0 means the row was NOT in the expected state (lock
 * already held); length 1 means the lock was successfully acquired.
 *
 * Pure-ish for testability: takes the Supabase client as a parameter so
 * unit tests can pass a mock without needing the full Inngest runtime.
 */
export async function tryAcquirePayoutLock(
  db: ReturnType<typeof createServiceRoleClient>,
  payoutId: string,
): Promise<{ acquired: boolean; reason?: "db_error" | "already_locked"; error?: string }> {
  const { data, error } = await db
    .from("payout_records")
    .update({ status: "processing" })
    .eq("id", payoutId)
    .eq("status", "available")
    .select("id");
  if (error) return { acquired: false, reason: "db_error", error: error.message };
  if (!data || data.length === 0) return { acquired: false, reason: "already_locked" };
  return { acquired: true };
}

// D-091 / error-injection probe — inner body extracted for direct test
// invocation. Mirrors the tryAcquirePayoutLock precedent.
export async function runPayoutsExecuteTransfer(): Promise<{ processed: number; failed: number; total: number; batches: number }> {
  if (process.env.BOOKING_CRONS_DISABLED === "true") {
    return { processed: 0, failed: 0, total: 0, batches: 0 };
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not set");
  const stripe = new Stripe(stripeKey);
  const db = createServiceRoleClient();

  let processed = 0;
  let failed = 0;
  let total = 0;
  let batches = 0;
  const start = Date.now();

  while (Date.now() - start < TIME_BUDGET_MS) {
    const { data: rows, error } = await db
      .from("payout_records")
      .select("id, tenant_id, amount_cents, attempt_generation, currency, commission_id")
      .eq("status", "available")
      .gt("amount_cents", 0)
      .limit(BATCH_LIMIT);

    if (error) throw new Error(`payouts-execute-transfer: fetch failed: ${error.message}`);

    const available = (rows ?? []) as PayoutRow[];
    batches++;
    total += available.length;

    for (const row of available) {
      // Load the tenant's Stripe Connect account
      const { data: tenantData } = await db
        .from("tenants")
        .select("stripe_connect_account_id")
        .eq("id", row.tenant_id)
        .single();

      const tenant = tenantData as TenantRow | null;
      if (!tenant?.stripe_connect_account_id) {
        console.warn(
          `payouts-execute-transfer: tenant ${row.tenant_id} has no stripe_connect_account_id — skipping payout ${row.id}`,
        );
        continue;
      }

      // §14.7: Step 1 — DB write FIRST. Transition to 'processing'.
      // D-091 P1 #24 — see tryAcquirePayoutLock above for rationale.
      const lockResult = await tryAcquirePayoutLock(db, row.id);
      if (!lockResult.acquired) {
        if (lockResult.reason === "db_error") {
          console.warn(
            `payouts-execute-transfer: failed to lock payout ${row.id}: ${lockResult.error}`,
          );
        } else {
          console.info(
            `payouts-execute-transfer: skipped payout ${row.id} — already locked by another run`,
          );
        }
        continue;
      }

      const amountCents = BigInt(row.amount_cents) as Cents;
      assertSafeStripeAmount(amountCents);

      const idempotencyKey = `payout-${row.id}-gen${row.attempt_generation}`;

      // §14.7: Step 2 — Stripe call with deterministic idempotency key
      try {
        const transfer = await stripe.transfers.create(
          {
            amount: Number(amountCents),
            currency: row.currency.toLowerCase(),
            destination: tenant.stripe_connect_account_id,
            description: `ATC payout for record ${row.id}`,
            metadata: {
              payout_record_id: row.id,
              tenant_id: row.tenant_id,
              idempotency_key: idempotencyKey,
            },
          },
          { idempotencyKey },
        );

        // Step 3: Write stripe_transfer_id; leave status='processing' for webhook
        await safeAwait(db
          .from("payout_records")
          .update({ stripe_transfer_id: transfer.id })
          .eq("id", row.id), "payout_records.update");

        processed++;
      } catch (err) {
        if (err instanceof Stripe.errors.StripeError) {
          const isNetworkError =
            err.type === "StripeConnectionError" ||
            err.type === "StripeAPIError";

          if (isNetworkError) {
            // Step 5: leave in 'processing' — reconciliation cron handles this
            console.warn(
              `payouts-execute-transfer: network error for payout ${row.id}, leaving in 'processing'`,
            );
          } else {
            // Step 4: Explicit Stripe error → transition to 'failed'
            await safeAwait(db
              .from("payout_records")
              .update({
                status: "failed",
                failed_at: new Date().toISOString(),
                failure_reason: err.message,
              })
              .eq("id", row.id), "payout_records.update");

            console.error(
              `payouts-execute-transfer: Stripe error for payout ${row.id}: ${err.message}`,
            );
            failed++;
          }
        } else {
          // Unknown error — leave in processing
          console.error(
            `payouts-execute-transfer: unexpected error for payout ${row.id}:`,
            err,
          );
        }
      }
    }

    if (available.length < BATCH_LIMIT) break;
  }

  return { processed, failed, total, batches };
}

export const payoutsExecuteTransfer = inngest.createFunction(
  {
    id: "payouts-execute-transfer",
    triggers: [{ cron: "0 3 * * *" }],
  },
  runPayoutsExecuteTransfer,
);
