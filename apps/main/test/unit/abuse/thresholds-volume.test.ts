// §27.4 — Volume dimension threshold tests: just-below, at, and just-above
// each boundary, plus scale function with non-1.0 multiplier (annual billing).
//
// 42 survived + 79 NoCoverage — existing thresholds.test.ts covers only AI cost
// and RAG cap. This file adds chat/email/group volume + scale multiplier tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveThresholdsSync, type ResolveThresholdsInput } from "@/lib/abuse/thresholds";
import type { PricingTable } from "@/lib/abuse/revenue";

// §3.3 seed values — local test fixture, not a runtime fallback.
const PRICING: PricingTable = {
  base: {
    byo_research:     { monthly:  1900, annual:  19000 },
    byo_professional: { monthly:  5900, annual:  59000 },
    byo_agency:       { monthly:  9900, annual:  99000 },
    sub_starter:      { monthly:  4900, annual:  49000 },
    sub_pro:          { monthly: 14900, annual: 149000 },
    sub_agency:       { monthly: 24900, annual: 249000 },
  },
  seatLadder: [
    { upTo:        4, monthly: 5900, annual: 59000 }, // users 2–4
    { upTo:       10, monthly: 4900, annual: 49000 }, // users 5–10
    { upTo: Infinity, monthly: 3900, annual: 39000 }, // users 11+
  ],
};


// ── env management ─────────────────────────────────────────────────────────

const baseEnv = {
  ABUSE_AI_COST_SOFT1_PERCENT: "30",
  ABUSE_AI_COST_SOFT2_PERCENT: "50",
  ABUSE_AI_COST_HARD_PERCENT: "70",
  ABUSE_RAG_APPROACHING_PERCENT: "85",
};

let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, baseEnv);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── chat_volume — scale = 1.0 (single-seat non-agency) ────────────────────
// sub_pro: chat_base_monthly=5000, so soft1=5000, soft2=scale(7500)=7500, hard=scale(10000)=10000

describe("resolveThresholdsSync — chat_volume thresholds", () => {
  it("single-seat monthly sub_pro: soft1 = base count (scale 1.0)", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.chat_volume_messages_monthly.soft1).toBe(5000);
  });

  it("single-seat monthly sub_pro: soft2 = floor(base * 1.5) (scale 1.0)", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.chat_volume_messages_monthly.soft2).toBe(7500);
  });

  it("single-seat monthly sub_pro: hard = base * 2 (scale 1.0)", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.chat_volume_messages_monthly.hard).toBe(10000);
  });

  it("annual billing reduces thresholds (revenue < reference → multiplier < 1)", () => {
    // sub_pro annual: revenue = floor(149000/12) = 12416 cents, reference = 14900
    // chat soft1 = floor(5000 * 12416 / 14900) = floor(62080000/14900) = 4166
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "annual" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.chat_volume_messages_monthly.soft1).toBe(4166);
  });
});

// ── email_volume ───────────────────────────────────────────────────────────
// sub_pro: email_base_daily=500

describe("resolveThresholdsSync — email_volume_daily thresholds", () => {
  it("single-seat monthly sub_pro: soft1=500, soft2=750, hard=1000", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.email_volume_daily.soft1).toBe(500);
    expect(t.email_volume_daily.soft2).toBe(750);   // floor(500 * 1.5) = 750
    expect(t.email_volume_daily.hard).toBe(1000);   // 500 * 2
  });

  it("byo_research: email_base_daily=50 → soft1=50, soft2=75, hard=100", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "byo_research", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.email_volume_daily.soft1).toBe(50);
    expect(t.email_volume_daily.soft2).toBe(75);
    expect(t.email_volume_daily.hard).toBe(100);
  });
});

// ── group_invite_monthly ───────────────────────────────────────────────────
// sub_pro: group_invite_base_monthly=1000; per_group_max=100 always

describe("resolveThresholdsSync — group_invite_monthly thresholds", () => {
  it("single-seat monthly sub_pro: soft1=1000, soft2=1500, hard=2000", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.group_invite_monthly.soft1).toBe(1000);
    expect(t.group_invite_monthly.soft2).toBe(1500);
    expect(t.group_invite_monthly.hard).toBe(2000);
  });

  it("per_group_max is always 100 regardless of tier or revenue", () => {
    for (const tier_code of ["sub_starter", "sub_pro", "sub_agency", "byo_research", "byo_professional", "byo_agency"] as const) {
      const t = resolveThresholdsSync({
        tenant: { tier_code, seat_count: 1, billing_period: "monthly" },
        promoted_chunks_count: 0,
        pricing: PRICING,

      });
      expect(t.group_invite_monthly.per_group_max).toBe(100);
    }
  });

  it("byo_research (group_invite_base=0): all group thresholds are 0", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "byo_research", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.group_invite_monthly.soft1).toBe(0);
    expect(t.group_invite_monthly.soft2).toBe(0);
    expect(t.group_invite_monthly.hard).toBe(0);
  });
});

// ── RAG approaching percent env var ───────────────────────────────────────

describe("resolveThresholdsSync — ABUSE_RAG_APPROACHING_PERCENT env var", () => {
  it("defaults to 85% of effective when env var is unset", () => {
    delete process.env.ABUSE_RAG_APPROACHING_PERCENT;
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.rag_cap_total.approaching).toBe(Math.floor(t.rag_cap_total.effective * 0.85));
  });

  it("uses a custom approaching percent when set", () => {
    process.env.ABUSE_RAG_APPROACHING_PERCENT = "70";
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.rag_cap_total.approaching).toBe(Math.floor(t.rag_cap_total.effective * 0.70));
  });
});

// ── override: future effective_from ignored ────────────────────────────────

describe("resolveThresholdsSync — override date range filtering", () => {
  it("ignores an override whose effective_from is in the future", () => {
    const future = new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10);
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      overrides: [
        { dimension: "chat_volume", tier_override: "soft1", threshold_value: 999999, effective_from: future, effective_to: null },
      ],
      pricing: PRICING,

    });
    expect(t.chat_volume_messages_monthly.soft1).toBe(5000); // unchanged
  });

  it("applies an override whose effective_from is today (inclusive boundary)", () => {
    const today = new Date().toISOString().slice(0, 10);
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      overrides: [
        { dimension: "chat_volume", tier_override: "hard", threshold_value: 99999, effective_from: today, effective_to: null },
      ],
      pricing: PRICING,

    });
    expect(t.chat_volume_messages_monthly.hard).toBe(99999);
  });

  it("applies chat_volume override for all three tiers", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      overrides: [
        { dimension: "chat_volume", tier_override: "soft1", threshold_value: 1111, effective_from: "2020-01-01", effective_to: null },
        { dimension: "chat_volume", tier_override: "soft2", threshold_value: 2222, effective_from: "2020-01-01", effective_to: null },
        { dimension: "chat_volume", tier_override: "hard",  threshold_value: 3333, effective_from: "2020-01-01", effective_to: null },
      ],
      pricing: PRICING,

    });
    expect(t.chat_volume_messages_monthly.soft1).toBe(1111);
    expect(t.chat_volume_messages_monthly.soft2).toBe(2222);
    expect(t.chat_volume_messages_monthly.hard).toBe(3333);
  });

  it("applies email_volume override", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      overrides: [
        { dimension: "email_volume", tier_override: "soft1", threshold_value: 777, effective_from: "2020-01-01", effective_to: null },
      ],
      pricing: PRICING,

    });
    expect(t.email_volume_daily.soft1).toBe(777);
    expect(t.email_volume_daily.soft2).toBe(750); // unchanged
  });

  it("applies group_invite override", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      overrides: [
        { dimension: "group_invite", tier_override: "hard", threshold_value: 5000, effective_from: "2020-01-01", effective_to: null },
      ],
      pricing: PRICING,

    });
    expect(t.group_invite_monthly.hard).toBe(5000);
    expect(t.group_invite_monthly.soft1).toBe(1000); // unchanged
  });
});

// ── scale: multi-seat byo_agency ───────────────────────────────────────────
// 2-seat byo_agency: base=9900, 2nd seat band 1 at 5900 → revenue=15800, reference=9900
// scale(5000) = floor(5000 * 15800 / 9900) = floor(79000000/9900) = floor(7979.7...) = 7979

describe("resolveThresholdsSync — revenue-scaled thresholds for multi-seat agency", () => {
  it("2-seat byo_agency chat_volume.soft1 > single-seat (higher revenue → higher cap)", () => {
    const single = resolveThresholdsSync({
      tenant: { tier_code: "byo_agency", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    const two = resolveThresholdsSync({
      tenant: { tier_code: "byo_agency", seat_count: 2, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(two.chat_volume_messages_monthly.soft1).toBeGreaterThan(single.chat_volume_messages_monthly.soft1);
  });

  it("2-seat byo_agency monthly: chat soft1 = floor(5000 * 15800 / 9900) = 7979", () => {
    // 2nd seat: band 1 (users 2-4) at 5900/mo. Revenue = 9900+5900=15800. Ref=9900.
    // scale(5000) = floor(5000 * 15800 / 9900) = floor(79_000_000 / 9900) = 7979
    const t = resolveThresholdsSync({
      tenant: { tier_code: "byo_agency", seat_count: 2, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.chat_volume_messages_monthly.soft1).toBe(7979);
  });
});

// ── effective_monthly_revenue_cents is surfaced ───────────────────────────

describe("resolveThresholdsSync — effective_monthly_revenue_cents field", () => {
  it("equals the single-seat monthly price for non-agency monthly billing", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.effective_monthly_revenue_cents).toBe(14900n);
  });

  it("is less than the monthly price for annual billing (annual/12 floor)", () => {
    const t = resolveThresholdsSync({
      tenant: { tier_code: "sub_pro", seat_count: 1, billing_period: "annual" },
      promoted_chunks_count: 0,
      pricing: PRICING,

    });
    expect(t.effective_monthly_revenue_cents).toBe(12416n); // floor(149000/12)
  });
});
