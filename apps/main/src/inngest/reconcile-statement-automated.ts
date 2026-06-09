// §14.8 — Automated statement reconciliation Inngest cron.
//
// Runs daily at 04:00 UTC. For each active sub-host tenant whose host adapter
// reports supports_commission_api === true, fetches yesterday's commission
// statement and reconciles each line item against commissions rows.
//
// Variance thresholds (§14.8):
//   < $5   (500 cents)    → auto-accept, write audit_log row
//   $5–$50 (500–5000 cents) → queue for review (default: accept)
//   > $50  (5000 cents)   → queue for review (default: hold)
//   booking not found     → orphan row; admin investigates

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { selectAdapterForCall } from "@/lib/host-adapters/select-adapter";
import { writeAuditLog } from "@/lib/audit/write";
import { excludeNonPayingPastGrace } from "@/lib/billing/exclude-non-paying";
import { safeAwait } from "@/lib/db/safe-mutation";

const AUTO_ACCEPT_THRESHOLD_CENTS = 500n;   // $5
const REVIEW_HOLD_THRESHOLD_CENTS = 5000n;  // $50

type StatementLineItem = {
  provider_booking_ref: string;
  received_amount_cents: number;
  currency?: string;
  period_start?: string;
  period_end?: string;
};

type TenantRow = {
  id: string;
  display_name: string;
  tenant_type: string;
  stripe_connect_account_id: string | null;
  tier_id: string | null;
  // §15.12 sandbox — short-circuits adapter selection to fallback.
  is_sandbox: boolean;
  // §15.16 — fields excludeNonPayingPastGrace reads.
  status: string;
  subscription_status: string | null;
  non_paying_since: string | null;
  // #699 — internal tenants bypass the payment gate.
  is_platform_internal?: boolean;
};

type CommissionRow = {
  id: string;
  tenant_id: string;
  subhost_payable_cents: string;
  currency: string;
  status: string;
};

export async function runReconcileStatementAutomated(): Promise<{ ok: boolean; processed: number; auto_accepted?: number; queued?: number; orphans?: number }> {
  if (process.env.BOOKING_CRONS_DISABLED === "true") {
    return { ok: true, processed: 0 };
  }
  const db = createServiceRoleClient();

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const periodStart = yesterday.toISOString().split("T")[0]!;
    const periodEnd = periodStart;

    const { data: tenantsRaw } = await db
      .from("tenants")
      .select("id, display_name, tenant_type, stripe_connect_account_id, tier_id, is_sandbox, status, subscription_status, non_paying_since, is_platform_internal")
      .in("tenant_type", ["sub_host"])
      .eq("status", "active")
      // §15.12 sandbox: exclude at the query layer (defense-in-depth). The
      // adapter short-circuit already returns FallbackEmailAdapter for sandbox
      // tenants and the capability check then `continue`s, but skipping these
      // tenants entirely avoids the wasted loop iteration and protects against
      // a future FallbackEmailAdapter gaining supports_commission_api=true.
      .eq("is_sandbox", false);

    if (!tenantsRaw || tenantsRaw.length === 0) {
      return { ok: true, processed: 0 };
    }

    // §15.16 — past-grace tenants don't get new commission rows.
    const tenants = excludeNonPayingPastGrace(tenantsRaw as TenantRow[]);
    if (tenants.length === 0) {
      return { ok: true, processed: 0 };
    }

    let totalProcessed = 0;
    let totalAutoAccepted = 0;
    let totalQueued = 0;
    let totalOrphans = 0;

    for (const tenant of tenants as TenantRow[]) {
      try {
        const correlation_id = crypto.randomUUID();
        const { adapter, ctx } = await selectAdapterForCall(
          { id: tenant.id, prong: tenant.tenant_type, is_sandbox: tenant.is_sandbox },
          { tenant_id: tenant.id, user_id: null, correlation_id },
        );

        if (!adapter.capabilities.supports_commission_api) {
          continue;
        }

        const result = await adapter.fetchCommissionStatement(
          { period_start: periodStart, period_end: periodEnd, format: "json" },
          ctx,
        );

        if (!result.ok) {
          await writeAuditLog({
            tenant_id: tenant.id,
            actor_type: "system",
            action: "reconcile_statement_fetch_failed",
            resource_type: "tenant",
            resource_id: tenant.id,
            changes: { error_code: result.error.code },
          });
          continue;
        }

        const lines = result.value as StatementLineItem[];
        if (!Array.isArray(lines)) continue;

        for (const line of lines) {
          totalProcessed++;

          // Find matching commission by provider_booking_ref via bookings
          const { data: bookingData } = await db
            .from("bookings")
            .select("id")
            .eq("tenant_id", tenant.id)
            .eq("provider_booking_ref", line.provider_booking_ref)
            .maybeSingle();

          if (!bookingData) {
            // Orphan — booking not found
            await safeAwait(db.from("reconciliation_review_queue").insert({
              tenant_id: tenant.id,
              commission_id: null,
              provider_booking_ref: line.provider_booking_ref,
              variance_cents: BigInt(line.received_amount_cents).toString(),
              source_path: "automated",
              status: "orphan",
              notes: JSON.stringify({
                reason: "booking_not_found",
                received_cents: line.received_amount_cents,
                period: periodStart,
              }),
            }), "reconciliation_review_queue.insert");
            totalOrphans++;
            continue;
          }

          const { data: commData } = await db
            .from("commissions")
            .select("id, tenant_id, subhost_payable_cents, currency, status")
            .eq("booking_id", bookingData.id)
            .maybeSingle();

          if (!commData) {
            await safeAwait(db.from("reconciliation_review_queue").insert({
              tenant_id: tenant.id,
              provider_booking_ref: line.provider_booking_ref,
              variance_cents: BigInt(line.received_amount_cents).toString(),
              source_path: "automated",
              status: "orphan",
              notes: JSON.stringify({
                reason: "commission_not_found",
                booking_id: bookingData.id,
                received_cents: line.received_amount_cents,
              }),
            }), "reconciliation_review_queue.insert");
            totalOrphans++;
            continue;
          }

          const commission = commData as CommissionRow;
          const expectedCents = BigInt(commission.subhost_payable_cents);
          const receivedCents = BigInt(line.received_amount_cents);
          const varianceCents =
            receivedCents > expectedCents
              ? receivedCents - expectedCents
              : expectedCents - receivedCents;

          if (varianceCents < AUTO_ACCEPT_THRESHOLD_CENTS) {
            // Auto-accept — within $5 tolerance
            await writeAuditLog({
              tenant_id: tenant.id,
              actor_type: "system",
              action: "reconcile_auto_accepted",
              resource_type: "commission",
              resource_id: commission.id,
              changes: {
                expected_cents: expectedCents.toString(),
                received_cents: receivedCents.toString(),
                variance_cents: varianceCents.toString(),
              },
            });
            totalAutoAccepted++;
            continue;
          }

          // Variance too large — queue for review
          const defaultAction =
            varianceCents >= REVIEW_HOLD_THRESHOLD_CENTS ? "hold" : "accept";

          await safeAwait(db.from("reconciliation_review_queue").insert({
            commission_id: commission.id,
            tenant_id: tenant.id,
            provider_booking_ref: line.provider_booking_ref,
            variance_cents: varianceCents.toString(),
            source_path: "automated",
            status: "pending",
            notes: JSON.stringify({
              expected_cents: expectedCents.toString(),
              received_cents: receivedCents.toString(),
              default_action: defaultAction,
              period: periodStart,
            }),
          }), "reconciliation_review_queue.insert");
          totalQueued++;
        }
      } catch (err) {
        console.error(
          `reconcile-statement-automated: error processing tenant ${tenant.id}:`,
          err,
        );
      }
    }

    return {
      ok: true,
      processed: totalProcessed,
      auto_accepted: totalAutoAccepted,
      queued: totalQueued,
      orphans: totalOrphans,
    };
}

export const reconcileStatementAutomated = inngest.createFunction(
  {
    id: "reconcile-statement-automated",
    triggers: [{ cron: "0 4 * * *" }],
  },
  runReconcileStatementAutomated,
);
