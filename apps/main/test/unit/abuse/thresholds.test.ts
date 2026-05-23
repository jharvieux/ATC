// §27.4 — Threshold resolution + override precedence.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveThresholdsSync } from "@/lib/abuse/thresholds";

const baseEnv = {
  ABUSE_AI_COST_SOFT1_PERCENT: "30",
  ABUSE_AI_COST_SOFT2_PERCENT: "50",
  ABUSE_AI_COST_HARD_PERCENT: "70",
  ABUSE_RAG_APPROACHING_PERCENT: "85",
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, baseEnv);
});
afterEach(() => {
  process.env = saved;
});

describe("resolveThresholdsSync — AI cost", () => {
  it("single-seat monthly Sub-Host Pro → soft1=30%, soft2=50%, hard=70% of $149", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
    });
    // $149 = 14900¢. 30% = 4470¢, 50% = 7450¢, 70% = 10430¢.
    expect(t.ai_cost_cents.soft1).toBe(4470n);
    expect(t.ai_cost_cents.soft2).toBe(7450n);
    expect(t.ai_cost_cents.hard).toBe(10430n);
  });

  it("Sub-Host Agency single-seat monthly → 30% of $249 = 7470¢", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_agency", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
    });
    expect(t.ai_cost_cents.soft1).toBe(7470n);
  });
});

describe("resolveThresholdsSync — RAG cap", () => {
  it("Sub-Host Pro with 3 promoted chunks → effective = base + 75", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 3,
    });
    expect(t.rag_cap_total.effective).toBe(t.rag_cap_total.base + 75);
  });

  it("approaching threshold = effective × 0.85 (floored)", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_agency", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
    });
    expect(t.rag_cap_total.approaching).toBe(Math.floor(t.rag_cap_total.effective * 0.85));
  });
});

describe("resolveThresholdsSync — override precedence", () => {
  it("active override replaces computed hard", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      overrides: [
        {
          dimension: "ai_cost",
          tier_override: "hard",
          threshold_value: 15000,
          effective_from: "2020-01-01",
          effective_to: null,
        },
      ],
    });
    expect(t.ai_cost_cents.hard).toBe(15000n);
  });

  it("expired override is ignored", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      overrides: [
        {
          dimension: "ai_cost",
          tier_override: "hard",
          threshold_value: 999999,
          effective_from: "2020-01-01",
          effective_to: "2020-12-31",
        },
      ],
    });
    expect(t.ai_cost_cents.hard).toBe(10430n);
  });
});
