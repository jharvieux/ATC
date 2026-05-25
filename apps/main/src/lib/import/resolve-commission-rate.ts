// BP34 §34.7.3 — Commission rate resolution for imported bookings.
//
// Resolution order at import-acceptance time:
//   1. From parsed document (commission_rate or implied from amount/fare)
//   2. From host adapter (programmatic capability per §13)
//   3. From agent input (review queue with reason='commission_rate_missing')
//
// Returns { rate, source } when resolved (steps 1 or 2). Returns null when
// the caller must route the import back to review for agent rate entry.
// Step 3 is NOT resolved here — it's a UI flow; the queue holds the row
// with reason='commission_rate_missing' until the agent acts.
//
// `rate` is a decimal in [0, 1] (e.g. 0.12 for 12%). Matches the
// commissions.commission_rate NUMERIC(5,4) column type.

import type { BookingConfirmationFields } from "./extractors/types";

export type CommissionRateSource = "doc_parsed" | "host_adapter" | "agent_set" | "agent_corrected";

export type ResolvedCommissionRate = {
  rate: number;
  source: Extract<CommissionRateSource, "doc_parsed" | "host_adapter">;
  // When source='doc_parsed' and the document gave an explicit amount + fare,
  // we retain both for §34.7.3 cross-check.
  amount_cents?: number;
};

export async function resolveCommissionRate(args: {
  tenant_id: string;
  fields: Pick<
    BookingConfirmationFields,
    "commission_rate" | "commission_amount_cents" | "total_amount_cents" | "cruise_line"
  >;
  // Caller injects the adapter lookup so this helper has no cyclic deps
  // on the host-adapter registry. Pass `undefined` if the tenant has no
  // adapter configured or the adapter doesn't publish a rate API.
  getAdapterRate?: ((cruise_line: string | null) => Promise<number | null>) | undefined;
}): Promise<ResolvedCommissionRate | null> {
  const { fields, getAdapterRate } = args;

  // Step 1 — parsed document.
  if (typeof fields.commission_rate === "number" && fields.commission_rate > 0) {
    return { rate: clampRate(fields.commission_rate), source: "doc_parsed" };
  }

  // Step 1b — implied rate from amount / fare per §34.7.3.
  if (
    typeof fields.commission_amount_cents === "number" &&
    fields.commission_amount_cents > 0 &&
    typeof fields.total_amount_cents === "number" &&
    fields.total_amount_cents > 0
  ) {
    const implied = fields.commission_amount_cents / fields.total_amount_cents;
    if (implied > 0 && implied <= 0.5) {
      return {
        rate: clampRate(implied),
        source: "doc_parsed",
        amount_cents: fields.commission_amount_cents,
      };
    }
    // Implied rate out of plausible band — fall through. The agent will
    // sort it out in review.
  }

  // Step 2 — host adapter.
  if (getAdapterRate) {
    try {
      const adapterRate = await getAdapterRate(fields.cruise_line ?? null);
      if (typeof adapterRate === "number" && adapterRate > 0) {
        return { rate: clampRate(adapterRate), source: "host_adapter" };
      }
    } catch (err) {
      // Adapter failure is not fatal — fall through to agent input. The
      // calling promotion path logs the error.
      console.warn(
        "[resolve-commission-rate] adapter lookup threw:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Step 3 — agent input required.
  return null;
}

function clampRate(n: number): number {
  // commissions.commission_rate is NUMERIC(5,4) → max 9.9999. Realistically
  // any rate above ~0.5 is implausible, but we clamp at 1.0 defensively.
  if (n > 1) return Math.min(1, n / 100); // accept percentage if it slipped through
  return Math.max(0, Math.min(1, n));
}
