// §27.12 — AI pricing catalog cost-estimate math.

import { describe, it, expect, afterEach } from "vitest";
import { getCostEstimate, _resetPricingCacheForTests } from "@/lib/ai/pricing";

afterEach(() => _resetPricingCacheForTests());

describe("getCostEstimate", () => {
  it("Haiku 1M input + 1M output → input $80 + output $400 = 48000¢", () => {
    const cost = getCostEstimate({
      model: "claude-haiku-4-5-20251001",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    // 8000¢/M input + 40000¢/M output = 48000¢
    expect(cost).toBe(48000n);
  });

  it("#851 — Haiku undated alias is priced (same as the pinned snapshot, no $0 zero-out)", () => {
    // When the chain serves via the alias, cost-tracking must not silently bill $0.
    const cost = getCostEstimate({
      model: "claude-haiku-4-5",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBe(48000n); // identical to claude-haiku-4-5-20251001
  });

  it("#857 — claude-opus-4-8 is priced (mirrors 4-7 placeholder; no $0 zero-out until verified)", () => {
    const cost = getCostEstimate({
      model: "claude-opus-4-8",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBe(900000n); // 150000 + 750000 — same as claude-opus-4-7 for now
  });

  it("Sonnet 100k tokens input only → 3000¢", () => {
    const cost = getCostEstimate({
      model: "claude-sonnet-4-6",
      input_tokens: 100_000,
      output_tokens: 0,
    });
    // 30000¢/M × 100k = 3000¢
    expect(cost).toBe(3000n);
  });

  it("Unknown model → 0¢ (charge nothing, log warn)", () => {
    const cost = getCostEstimate({
      model: "unknown-fake-model",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBe(0n);
  });

  it("Negative token counts treated as zero", () => {
    const cost = getCostEstimate({
      model: "claude-haiku-4-5-20251001",
      input_tokens: -100,
      output_tokens: -100,
    });
    expect(cost).toBe(0n);
  });
});
