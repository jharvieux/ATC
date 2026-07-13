// Tier 1 — ai-pricing-cache-refresh error-injection.
//
// Uses `runAiPricingCacheRefresh` from PR #275. Smallest of the 4 Tier-1
// crons: one read + one upsert, no branch-specific chain shape — the exact
// case _helpers.ts's makeFailingDbClient was built for (#1860 retrofit;
// see README.md's "Actual handler test pattern" for why the other 8 probes
// don't use it).
//
//   - upsert returns { error } — pre-#272 was unchecked; post-#272 the
//     safeAwait wrapper now throws so the cron throws instead of silently
//     leaving the staleness flag wrong.
//   - missing `ai_pricing_last_refreshed_at` row → defaults to stale=true.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** What `select("value").eq("key", ...).maybeSingle()` returns. */
  singleRow: null as { value: string | null } | null,
  /** Which verbs makeFailingDbClient should fail. */
  fail: [] as Array<"insert" | "update" | "delete" | "upsert">,
}));

vi.mock("@/lib/db/service-role-client", async () => {
  const { makeFailingDbClient } = await import("./_helpers");
  return {
    createServiceRoleClient: () =>
      makeFailingDbClient({
        fail: mocks.fail,
        singleRow: mocks.singleRow,
        error: { message: "synthetic db error" },
      }),
  };
});

import { runAiPricingCacheRefresh } from "@/inngest/ai-pricing-cache-refresh";

beforeEach(() => {
  mocks.singleRow = null;
  mocks.fail = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAiPricingCacheRefresh — Pattern 1 (DB upsert error)", () => {
  it("throws SupabaseMutationError when the upsert fails", async () => {
    mocks.fail = ["upsert"];
    await expect(runAiPricingCacheRefresh()).rejects.toThrow(/synthetic db error/);
  });

  it("returns stale=true when no last_refreshed_at row exists", async () => {
    mocks.singleRow = null;
    const result = await runAiPricingCacheRefresh();
    expect(result.ok).toBe(true);
    expect(result.last_refreshed_at).toBe(null);
    expect(result.stale).toBe(true);
  });

  it("returns stale=true when last refresh was > 30 days ago", async () => {
    const days31Ago = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    mocks.singleRow = { value: days31Ago };
    const result = await runAiPricingCacheRefresh();
    expect(result.stale).toBe(true);
  });

  it("returns stale=false when last refresh was recent", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    mocks.singleRow = { value: yesterday };
    const result = await runAiPricingCacheRefresh();
    expect(result.stale).toBe(false);
  });
});
