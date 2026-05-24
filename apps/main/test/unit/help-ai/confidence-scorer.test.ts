// BP31 §32.8 — Confidence scorer (Phase B stub).
//
// The Haiku scorer is deferred per MEMORY D-066; this test pins the stub
// behavior so a future "wire the Haiku call" PR has a clear before/after
// signal. Once the real scorer lands, replace `stubbed: true` assertions
// + the uniform-0.5 expectations with calibrated ranges.

import { describe, it, expect } from "vitest";
import { scoreBugDraft } from "@/lib/help-ai/confidence-scorer";
import { EMPTY_BUG_DRAFT } from "@/lib/help-ai/flow-controller";

describe("scoreBugDraft — Phase B stub", () => {
  it("returns uniform 0.5 across all six factors", async () => {
    const result = await scoreBugDraft(EMPTY_BUG_DRAFT, { tenant_id: "tenant-1" });
    expect(result.score).toBe(0.5);
    expect(result.factors.specificity_of_location).toBe(0.5);
    expect(result.factors.clarity_of_actual_behavior).toBe(0.5);
    expect(result.factors.clarity_of_expected_behavior).toBe(0.5);
    expect(result.factors.completeness_of_steps).toBe(0.5);
    expect(result.factors.reproducibility_signal).toBe(0.5);
    expect(result.factors.environment_completeness).toBe(0.5);
  });

  it("ignores draft content (uniform 0.5 for a high-quality and low-quality input)", async () => {
    const highQuality = {
      ...EMPTY_BUG_DRAFT,
      where_in_platform: "/admin/branding",
      actual_behavior: "Custom domain verification stays on 'Pending' indefinitely",
      expected_behavior: "Should verify within a few minutes of adding CNAME",
      steps_to_reproduce: "1. /admin/branding 2. Add domain 3. Add CNAME at registrar 4. Refresh — still Pending",
      frequency: "once" as const,
    };
    const lowQuality = { ...EMPTY_BUG_DRAFT, actual_behavior: "broken" };
    const a = await scoreBugDraft(highQuality, { tenant_id: "tenant-1" });
    const b = await scoreBugDraft(lowQuality, { tenant_id: "tenant-1" });
    expect(a.score).toBe(b.score); // stub doesn't differentiate
    expect(a.score).toBe(0.5);
  });

  it("sets stubbed=true so callers can decide whether to surface a 'TODO' hint", async () => {
    const result = await scoreBugDraft(EMPTY_BUG_DRAFT, { tenant_id: "tenant-1" });
    expect(result.stubbed).toBe(true);
  });

  it("rationale references the cost-deferral decision", async () => {
    const result = await scoreBugDraft(EMPTY_BUG_DRAFT, { tenant_id: "tenant-1" });
    expect(result.rationale).toMatch(/stub|deferred|D-?066/i);
  });
});
