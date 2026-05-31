// Integration tests for CRM contacts — §12.1, §12.2, §12.4
//
// Covers DOB display rules, commission worked examples (stub), and quote lifecycle.
// Cross-tenant isolation and FK constraints live in test/integration/rls.test.ts
// (describeIf(haveSupabase)) where they can exercise real RLS policies.

import { describe, it, expect, beforeEach } from "vitest";
import { dobDisplayLabel, shouldSuppressDobInPdf } from "@/lib/contacts/dob-display";
import { workedExamples } from "../../fixtures/commission-worked-examples";

// ── DOB display unit tests ────────────────────────────────────────────────────

describe("dob-display (§11.5 / §12)", () => {
  it("returns null when no DOB", () => {
    expect(dobDisplayLabel({ date_of_birth: null })).toBeNull();
    expect(dobDisplayLabel({ date_of_birth: null })).toBeNull();
  });

  it("returns raw date when not estimated", () => {
    expect(dobDisplayLabel({ date_of_birth: "1985-06-15", date_of_birth_is_estimated: false }))
      .toBe("1985-06-15");
  });

  it("appends estimated marker when estimated", () => {
    const label = dobDisplayLabel({ date_of_birth: "1985-06-15", date_of_birth_is_estimated: true });
    expect(label).toContain("estimated");
    expect(label).toContain("click to confirm");
  });

  it("suppresses DOB in PDF when estimated", () => {
    expect(shouldSuppressDobInPdf({ date_of_birth_is_estimated: true })).toBe(true);
    expect(shouldSuppressDobInPdf({ date_of_birth_is_estimated: false })).toBe(false);
    expect(shouldSuppressDobInPdf({ date_of_birth_is_estimated: null })).toBe(false);
  });
});

// ── Commission worked-example fixtures (§12.7) ────────────────────────────────
// Skipped until Part 4 implements the runtime commission math.

describe.skip("commission worked examples (§12.7) — awaiting Part 4", () => {
  it.each(workedExamples)("$label", ({ inputs, expected }) => {
    // TODO(prompt-15): import and call computeCommissionSplit(inputs) here
    void inputs;
    void expected;
  });
});

// ── Quote lifecycle ────────────────────────────────────────────────────────────
// TODO(#37): replace transitionTo stub with real progressTo() once state-machine lib is implemented

describe("quote lifecycle (§12.4)", () => {
  type QuoteStatus = "draft" | "sent" | "viewed" | "accepted" | "declined" | "expired" | "converted";
  let quoteStatus: QuoteStatus;

  beforeEach(() => {
    quoteStatus = "draft";
  });

  function transitionTo(next: QuoteStatus): { ok: boolean; error?: string } {
    const allowed: Partial<Record<QuoteStatus, QuoteStatus[]>> = {
      draft:    ["sent"],
      sent:     ["viewed", "accepted", "declined", "expired"],
      viewed:   ["accepted", "declined", "expired"],
      accepted: ["converted"],
    };
    if ((allowed[quoteStatus] ?? []).includes(next)) {
      quoteStatus = next;
      return { ok: true };
    }
    return { ok: false, error: `Cannot transition from ${quoteStatus} to ${next}` };
  }

  it("draft → sent → accepted → converted is valid", () => {
    expect(transitionTo("sent").ok).toBe(true);
    expect(transitionTo("accepted").ok).toBe(true);
    expect(transitionTo("converted").ok).toBe(true);
  });

  it("cannot send an already-sent quote", () => {
    transitionTo("sent");
    expect(transitionTo("sent").ok).toBe(false);
  });

  it("cannot accept a draft quote", () => {
    expect(transitionTo("accepted").ok).toBe(false);
  });
});
