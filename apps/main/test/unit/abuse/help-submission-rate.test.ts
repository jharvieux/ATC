// BP32 §32.11.2 — help_submission_rate threshold transitions.

import { describe, it, expect } from "vitest";
import { resolveThresholdsSync } from "@/lib/abuse/thresholds";

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
