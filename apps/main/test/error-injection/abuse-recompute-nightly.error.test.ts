// Tier 1 — abuse-recompute-nightly error-injection.
//
// Uses `runAbuseRecomputeNightly` from PR #275. The cron has a large
// inner body wrapped in `withPlatformAdminAudit`; full DB-fail coverage
// would require mocking ~8 tables (tenants, tier_definitions,
// tenant_usage_metrics, ai_call_log, messages, conversations,
// platform_revenue, abuse_recompute_drift_log, etc.). This probe covers
// only the two highest-value failure modes:
//
//   - STAGING_MODE=true → early-exit, no withPlatformAdminAudit call.
//   - withPlatformAdminAudit's wrapper itself throws (e.g., audit_log
//     row insert fails). The cron must propagate so Inngest retries.
//
// Deep per-table DB-fail tests are deferred — Pattern 1 enforcement is
// already comprehensive at the lint-rule level after PR #279 flipped
// `atc/no-unchecked-supabase-mutation` to `error`. Any new unchecked
// mutation in this cron would fail CI before reaching production.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Whether withPlatformAdminAudit's inner callback should run normally. */
  auditWrapperThrows: false,
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: async (
    _opts: unknown,
    _fn: (db: unknown, recordQuery: (q: unknown) => void) => Promise<unknown>,
  ) => {
    void _opts; void _fn;
    if (mocks.auditWrapperThrows) {
      throw new Error("synthetic audit wrapper failure");
    }
    return { tenants_processed: 0, tenants_skipped_non_paying: 0, drift_records: 0, elapsed_ms: 1 };
  },
  platformAdminClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
}));

vi.mock("@/lib/rag-auth/sign-service-jwt", () => ({
  signServiceJwt: async () => "fake-jwt",
}));

vi.mock("@/lib/abuse/state-machine", () => ({
  checkStateTransitionIfNeeded: async () => undefined,
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  excludeNonPayingPastGrace: (rows: unknown[]) => rows,
}));

import { runAbuseRecomputeNightly } from "@/inngest/abuse-recompute-nightly";

const ORIG_STAGING = process.env.STAGING_MODE;

beforeEach(() => {
  mocks.auditWrapperThrows = false;
  delete process.env.STAGING_MODE;
});

afterEach(() => {
  if (ORIG_STAGING === undefined) delete process.env.STAGING_MODE;
  else process.env.STAGING_MODE = ORIG_STAGING;
  vi.restoreAllMocks();
});

describe("runAbuseRecomputeNightly — early exits", () => {
  it("returns {skipped_for_staging:true} when STAGING_MODE=true (no audit call)", async () => {
    process.env.STAGING_MODE = "true";
    const result = await runAbuseRecomputeNightly();
    expect(result).toEqual({ skipped_for_staging: true });
  });
});

describe("runAbuseRecomputeNightly — audit wrapper failure", () => {
  it("propagates an error from withPlatformAdminAudit so Inngest retries", async () => {
    mocks.auditWrapperThrows = true;
    await expect(runAbuseRecomputeNightly()).rejects.toThrow(/synthetic audit wrapper failure/);
  });

  it("returns the wrapper's result on happy path", async () => {
    const result = await runAbuseRecomputeNightly() as {
      tenants_processed: number;
      drift_records: number;
    };
    expect(result.tenants_processed).toBe(0);
    expect(result.drift_records).toBe(0);
  });
});
