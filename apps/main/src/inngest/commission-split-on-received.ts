// §14.3 / §14.6 — Payout split job.
//
// Triggered on commissions.status → received (or partial).
// Writes a payout_records row for the sub-host portion with:
//   - amount_cents = commissions.subhost_payable_cents
//   - status = 'pending'
//   - hold_release_at = received_at + hold_period_days from the tenant's tier
//
// Idempotent on (commission_id, payout_intent) pair — unique index prevents
// duplicate rows on replay.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";
import { safeAwait } from "@/lib/db/safe-mutation";

type CommissionRow = {
  id: string;
  tenant_id: string;
  booking_id: string;
  subhost_payable_cents: bigint;
  platform_retained_cents: bigint;
  commission_rate: number;
  platform_split_rate: number;
  currency: string;
};

type TenantTierRow = {
  tier_definitions: { hold_period_days: number; platform_split_rate: number } | null;
};

export async function runCommissionSplitOnReceived(event: { data: { commission_id: string; received_at?: string } }): Promise<{ skipped: true } | { skipped: true; reason: string } | { ok: true; payout_intent: string }> {
  if (process.env.BOOKING_CRONS_DISABLED === "true") {
    return { skipped: true };
  }
  const { commission_id, received_at } = event.data;
    const receivedAt = received_at ?? new Date().toISOString();
    const db = createServiceRoleClient();

    const { data: commData, error: commError } = await db
      .from("commissions")
      .select("id, tenant_id, booking_id, subhost_payable_cents, platform_retained_cents, commission_rate, platform_split_rate, currency")
      .eq("id", commission_id)
      .single();

    if (commError || !commData) {
      throw new Error(`commission-split-on-received: commission ${commission_id} not found`);
    }

    const commission = commData as CommissionRow;

    // §15.16 — Skip past-grace tenants. Don't write new commission rows
    // for a tenant whose subscription is past due — this is real money
    // movement, and the platform shouldn't accumulate payable balances on
    // a non-paying account.
    const paymentCheck = await assertTenantStillPayingById(db, commission.tenant_id);
    if (!paymentCheck.ok) {
      console.info("[commission-split] skipping past-grace tenant",
        { tenant_id: commission.tenant_id, commission_id, reason: paymentCheck.reason });
      return { skipped: true, reason: paymentCheck.reason };
    }

    // Get hold_period_days from the tenant's tier
    const { data: tenantData } = await db
      .from("tenants")
      .select("tier_id, tier_definitions(hold_period_days, platform_split_rate)")
      .eq("id", commission.tenant_id)
      .single();

    const tenant = tenantData as TenantTierRow | null;
    const holdDays = tenant?.tier_definitions?.hold_period_days ?? 7;

    const holdReleaseAt = new Date(receivedAt);
    holdReleaseAt.setDate(holdReleaseAt.getDate() + holdDays);

    const payoutIntent = `commission.received.${commission_id}`;

    // Insert payout record — idempotent via unique index on (commission_id, payout_intent)
    const { error: insertError } = await db.from("payout_records").insert({
      tenant_id: commission.tenant_id,
      amount_cents: commission.subhost_payable_cents.toString(),
      currency: commission.currency,
      status: "pending",
      hold_release_at: holdReleaseAt.toISOString(),
      commission_id,
      payout_intent: payoutIntent,
    });

    if (insertError) {
      if (insertError.code === "23505") {
        // Duplicate — idempotent replay, safe to ignore
        console.info(
          `commission-split-on-received: payout record already exists for commission ${commission_id}`,
        );
        return { skipped: true };
      }
      throw new Error(`commission-split-on-received: insert failed: ${insertError.message}`);
    }

    // Insert platform_revenue row for revenue recognition at received time
    await safeAwait(db.from("platform_revenue").insert({
      tenant_id: commission.tenant_id,
      commission_id,
      amount_cents: commission.platform_retained_cents.toString(),
      currency: commission.currency,
      tier_rate_applied: commission.platform_split_rate,
      revenue_recognized_at: receivedAt,
    }), "platform_revenue.insert");

    return { ok: true, payout_intent: payoutIntent };
}

export const commissionSplitOnReceived = inngest.createFunction(
  {
    id: "commission-split-on-received",
    triggers: [{ event: "commission/state_received" }],
  },
  ({ event }: { event: { data: { commission_id: string; received_at?: string } } }) =>
    runCommissionSplitOnReceived(event),
);
