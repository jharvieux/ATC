// BP32 §32.11.2 — help_submission_rate threshold transitions.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveThresholdsSync } from "@/lib/abuse/thresholds";
import { checkHelpSubmissionRate } from "@/lib/abuse/help-submission-rate";

// Minimal chainable Supabase stub whose terminal `.maybeSingle()` resolves to a
// scripted `{ data, error }`. Mirrors the metrics query in loadCurrentMetrics.
type MetricsResult = { data: unknown; error: { message: string } | null };
type Chain = {
  select: () => Chain;
  eq: () => Chain;
  order: () => Chain;
  limit: () => Chain;
  maybeSingle: () => Promise<MetricsResult>;
};
function metricsDb(result: MetricsResult): SupabaseClient {
  const chain: Chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve(result),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("help_submission_rate thresholds", () => {
  it("defaults match the §32.11.2 table: soft1=20, soft2=50, hard=100", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
    });
    expect(t.help_submission_rate_daily.soft1).toBe(20);
    expect(t.help_submission_rate_daily.soft2).toBe(50);
    expect(t.help_submission_rate_daily.hard).toBe(100);
  });

  it("is tier-independent — same flat values across tiers", () => {
    const tiers = ["byo_research", "byo_professional", "byo_agency", "sub_starter", "sub_pro", "sub_agency"] as const;
    for (const tier_code of tiers) {
      const t = resolveThresholdsSync({
        tenant: { tier_code, seat_count: 1, billing_period: "monthly" },
        promoted_chunks_count: 0,
      });
      expect(t.help_submission_rate_daily.soft1).toBe(20);
      expect(t.help_submission_rate_daily.soft2).toBe(50);
      expect(t.help_submission_rate_daily.hard).toBe(100);
    }
  });

  it("override row sets a custom threshold", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      overrides: [
        {
          dimension: "help_submission_rate",
          tier_override: "soft1",
          threshold_value: 10,
          effective_from: "2026-01-01",
          effective_to: null,
        },
      ],
    });
    expect(t.help_submission_rate_daily.soft1).toBe(10);
    expect(t.help_submission_rate_daily.soft2).toBe(50); // unchanged
  });
});

describe("checkHelpSubmissionRate — fail-closed on read error (#393)", () => {
  it("THROWS on a metrics read error rather than allowing", async () => {
    // The regression this guards: a swallowed read error used to surface as
    // `null` → "first submission ever" → { allowed: true }, letting a tenant in
    // `hard` state keep submitting on any transient DB blip. Must fail closed.
    const db = metricsDb({ data: null, error: { message: "connection reset" } });
    await expect(checkHelpSubmissionRate(db, "t-1")).rejects.toThrow(
      /tenant_usage_metrics\.load-current-metrics/,
    );
  });

  it("allows the first submission when there is genuinely no metrics row", async () => {
    const db = metricsDb({ data: null, error: null });
    await expect(checkHelpSubmissionRate(db, "t-1")).resolves.toEqual({
      allowed: true,
      state: "ok",
      count_today: 0,
    });
  });

  it("still blocks a tenant already in hard state (happy path intact)", async () => {
    const db = metricsDb({
      data: {
        help_submission_count: 100,
        help_submission_limit_state: "hard",
        last_recomputed_at: null,
        billing_period: "2026-05",
      },
      error: null,
    });
    const res = await checkHelpSubmissionRate(db, "t-1");
    expect(res.allowed).toBe(false);
    expect(res.state).toBe("hard");
    expect(res.count_today).toBe(100);
  });
});
