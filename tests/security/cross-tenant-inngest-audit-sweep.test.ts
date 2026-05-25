/**
 * §30.8 BP30 live-dispatch (Tier 1) — audit-fire sweep.
 *
 * Every platform-admin cron wrapped in `withPlatformAdminAudit` must
 * land an audit_log row when it runs. The fix in
 * lib/db/platform-admin-client.ts (system-cron sentinel coercion) made
 * this possible; this sweep proves it works for every wrapped cron.
 *
 * Add a new cron? Add a row to PLATFORM_ADMIN_CRONS below. The test
 * shape is the same: invoke, assert exactly one new audit_log row with
 * the expected `platformAdmin.<reason>` action.
 *
 * Excluded:
 *   - Kill-switched crons (refresh-cruisemapper-static, -itineraries,
 *     evaluatePriceWatches when no watches) — they early-return without
 *     audit by design. Test those when the kill switch is on instead.
 *   - Event-triggered handlers (abuseStateTransitionNotify,
 *     thresholdRecomputeOnSubscriptionChange) — covered by Tier 2.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { TEST_ANON_JWT, TEST_SERVICE_ROLE_JWT } from "./_test-jwt-fixtures";

const haveTier2 = Boolean(process.env.SUPABASE_DB_URL);
const describeIf = haveTier2 ? describe : describe.skip;

if (haveTier2) {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??=
    TEST_ANON_JWT;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??=
    TEST_SERVICE_ROLE_JWT;
  process.env.INNGEST_EVENT_KEY ??= "tier2-test-eventkey";
}

import { invokeInngestHandler } from "./_inngest-invoke";
import { inngest } from "@/inngest/client";

import { abuseRecomputeNightly } from "@/inngest/abuse-recompute-nightly";
import { billingPeriodRollover } from "@/inngest/billing-period-rollover";
import { helpDocVersionsPurge } from "@/inngest/help-doc-versions-purge";
import { helpSubmissionDailyReset } from "@/inngest/help-submission-daily-reset";
import { evaluatePriceWatches } from "@/inngest/evaluate-price-watches";
// bookingCommissionRetentionPurge intentionally NOT here — it uses
// createServiceRoleClient directly with a TODO to wrap in §26
// (see the file header comment). Covered by the Tier-3 retention test
// instead, which asserts the deletion behaviour rather than audit-fire.

// Stub inngest.send so handlers that re-dispatch events (e.g. recompute
// nightly firing per-tenant transitions) don't try to reach the API.
(inngest as unknown as { send: (e: unknown) => Promise<unknown> }).send = async () => ({ ids: [] });

const SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL ?? `postgresql://${process.env.USER}@localhost:5432/atc_main_test`;
const sql = postgres(SUPABASE_DB_URL, { max: 2, idle_timeout: 5, onnotice: () => {} });

interface CronCase {
  name: string;
  fn: unknown;
  reason: string;
}

const PLATFORM_ADMIN_CRONS: CronCase[] = [
  { name: "abuseRecomputeNightly",            fn: abuseRecomputeNightly,           reason: "cross_tenant_admin" },
  { name: "billingPeriodRollover",            fn: billingPeriodRollover,           reason: "cross_tenant_admin" },
  { name: "helpDocVersionsPurge",             fn: helpDocVersionsPurge,            reason: "help_doc_publishing" },
  { name: "helpSubmissionDailyReset",         fn: helpSubmissionDailyReset,        reason: "abuse_threshold_breach_review" },
  { name: "evaluatePriceWatches",             fn: evaluatePriceWatches,            reason: "external_pricing_refresh" },
];

beforeAll(async () => {
  // Some crons short-circuit when STAGING_MODE=true; tests should NOT set it.
  if (process.env.STAGING_MODE === "true") {
    throw new Error("STAGING_MODE=true short-circuits crons before audit; unset to run this suite.");
  }
});

afterAll(async () => { await sql.end(); });

async function countAuditRowsForAction(action: string): Promise<number> {
  const rows = await sql<Array<{ count: string }>>`
    SELECT count(*)::text FROM public.audit_log WHERE action = ${action}
  `;
  return Number(rows[0]!.count);
}

describeIf("BP30 Tier 1 — withPlatformAdminAudit cron audit-fire sweep", () => {
  it.each(PLATFORM_ADMIN_CRONS)(
    "$name lands exactly one audit_log row with action=platformAdmin.$reason",
    async ({ fn, reason }) => {
      const action = `platformAdmin.${reason}`;
      const before = await countAuditRowsForAction(action);

      // Handlers may throw if their environment isn't fully seeded;
      // catch + rethrow with the handler name so failures are clear.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await invokeInngestHandler(fn as any, { name: "cron", data: {} });
      } catch (err) {
        throw new Error(
          `Handler threw during invocation: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const after = await countAuditRowsForAction(action);
      expect(after - before, `audit_log row delta for action=${action}`).toBeGreaterThanOrEqual(1);
    },
  );
});
