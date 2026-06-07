// #828b / #820 — weekly derivation of ballpark general_pricing_ranges.
//
// Reads the interior "from $X" lead-ins the sailing cron keeps fresh in
// pricing_cache and derives approximate per-cabin ranges (interior min/max ×
// category multipliers), stored with source='estimated'. The chat pricing
// anchors read these so price questions surface a ballpark instead of deflecting
// to the booking system. Internal-only (no external fetches) — no kill switch;
// customer exposure is gated by the existing AI_PRICE_ROUNDING_ENABLED.

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { runDeriveGeneralPriceRanges } from "@/lib/pricing/derive-general-price-ranges";

const AUDIT_META = {
  admin_user_id: "system-cron",
  reason: "external_pricing_refresh",
  operation: "derive_general_price_ranges",
} as const;

export const deriveGeneralPriceRanges = inngest.createFunction(
  {
    id: "derive-general-price-ranges",
    triggers: [{ cron: "0 5 * * 1" }], // Mondays 05:00 UTC, after the monthly sailing refresh
  },
  async ({ step }) => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    // Single step → run the work inside the audit wrapper (its db is the
    // service-role client), so one audit row is written per run.
    return await step.run("derive", () =>
      withPlatformAdminAudit(AUDIT_META, async (db, recordQuery) => {
        recordQuery({ op: "select", table: "pricing_cache" });
        recordQuery({ op: "insert", table: "general_pricing_ranges" });
        return runDeriveGeneralPriceRanges(db);
      }),
    );
  },
);
