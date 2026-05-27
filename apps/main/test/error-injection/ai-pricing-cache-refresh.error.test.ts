// Tier 1 — ai-pricing-cache-refresh error-injection.
//
// Uses `runAiPricingCacheRefresh` from PR #275. Smallest of the 4 Tier-1
// crons: one read + one upsert. The interesting failure modes are:
//
//   - upsert returns { error } — pre-#272 was unchecked; post-#272 the
//     safeAwait wrapper now throws so the cron throws instead of silently
//     leaving the staleness flag wrong.
//   - missing `ai_pricing_last_refreshed_at` row → defaults to stale=true.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** What `select("value").eq("key", ...).maybeSingle()` returns. */
  lastRefreshedRow: { value: null } as { value: string | null } | null,
  /** What `upsert(...)` resolves to. */
  upsertResult: { data: null, error: null } as { data: unknown; error: { message: string } | null },
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(_table: string) {
      void _table;
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: mocks.lastRefreshedRow, error: null }),
              };
            },
          };
        },
        upsert(_payload: unknown, _opts: unknown) {
          void _payload; void _opts;
          return Promise.resolve(mocks.upsertResult);
        },
      };
    },
  }),
}));

import { runAiPricingCacheRefresh } from "@/inngest/ai-pricing-cache-refresh";

beforeEach(() => {
  mocks.lastRefreshedRow = { value: null };
  mocks.upsertResult = { data: null, error: null };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAiPricingCacheRefresh — Pattern 1 (DB upsert error)", () => {
  it("throws SupabaseMutationError when the upsert fails", async () => {
    mocks.upsertResult = { data: null, error: { message: "synthetic db error" } };
    await expect(runAiPricingCacheRefresh()).rejects.toThrow(/synthetic db error/);
  });

  it("returns stale=true when no last_refreshed_at row exists", async () => {
    mocks.lastRefreshedRow = null;
    const result = await runAiPricingCacheRefresh();
    expect(result.ok).toBe(true);
    expect(result.last_refreshed_at).toBe(null);
    expect(result.stale).toBe(true);
  });

  it("returns stale=true when last refresh was > 30 days ago", async () => {
    const days31Ago = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    mocks.lastRefreshedRow = { value: days31Ago };
    const result = await runAiPricingCacheRefresh();
    expect(result.stale).toBe(true);
  });

  it("returns stale=false when last refresh was recent", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    mocks.lastRefreshedRow = { value: yesterday };
    const result = await runAiPricingCacheRefresh();
    expect(result.stale).toBe(false);
  });
});
