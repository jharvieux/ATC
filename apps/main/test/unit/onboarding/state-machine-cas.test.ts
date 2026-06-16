// D-091 P1 #39 + #40 — CAS-guarded state-machine updates + revert validation.
//
// progressTo: UPDATE includes a current-stage predicate. Concurrent writers
// that already advanced the stage cause the CAS to match zero rows and the
// function throws StaleStageError.
//
// revertTo: validates target is in the enum AND backwards before issuing
// the UPDATE. CAS-guarded so concurrent edits also surface StaleStageError.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Build a mock Supabase client whose chain reads + updates are scriptable.
// One mock factory per test makes the chain predictable.
type MockBehavior = {
  selectStage: string | null;
  selectError?: { message: string } | null;
  updateRows: Array<{ id: string }>;
  updateError?: { message: string } | null;
};

// Vi.mock the service-role-client module at the top level so the
// state-machine import picks up our mock instead of the real client.
let currentBehavior: MockBehavior;
const updateCalls: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown]>; isFilters: Array<[string, unknown]> }> = [];

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq() {
              return {
                async single() {
                  return {
                    data: currentBehavior.selectStage === null && !currentBehavior.selectError
                      ? { onboarding_stage: null }
                      : currentBehavior.selectStage
                      ? { onboarding_stage: currentBehavior.selectStage }
                      : null,
                    error: currentBehavior.selectError ?? null,
                  };
                },
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          const call = { payload, filters: [] as Array<[string, unknown]>, isFilters: [] as Array<[string, unknown]> };
          updateCalls.push(call);
          const chain = {
            eq(col: string, val: unknown) {
              call.filters.push([col, val]);
              return chain;
            },
            is(col: string, val: unknown) {
              call.isFilters.push([col, val]);
              return chain;
            },
            async select(_cols: string) {
              return {
                data: currentBehavior.updateRows,
                error: currentBehavior.updateError ?? null,
              };
            },
          };
          return chain;
        },
      };
    },
  }),
}));

import {
  assertValidRevertTarget,
  progressTo,
  revertTo,
  StaleStageError,
  InvalidStageTransitionError,
} from "@/lib/onboarding/state-machine";

beforeEach(() => {
  updateCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── assertValidRevertTarget (pure) ─────────────────────────────────────

describe("assertValidRevertTarget — D-091 P1 #40", () => {
  it("accepts a valid backwards revert", () => {
    expect(assertValidRevertTarget("complete", "review_submitted")).toBeNull();
    expect(assertValidRevertTarget("review_submitted", "profile")).toBeNull();
  });

  it("rejects when target is not in the enum", () => {
    expect(assertValidRevertTarget("complete", "not_a_stage")).toBeInstanceOf(InvalidStageTransitionError);
    expect(assertValidRevertTarget("complete", null)).toBeInstanceOf(InvalidStageTransitionError);
    expect(assertValidRevertTarget("complete", 42)).toBeInstanceOf(InvalidStageTransitionError);
    expect(assertValidRevertTarget("complete", undefined)).toBeInstanceOf(InvalidStageTransitionError);
  });

  it("rejects Object.prototype keys (Greptile follow-up on #259)", () => {
    // The `in` operator walks the prototype chain — pre-fix this returned
    // null (valid) because "constructor" exists on Object.prototype.
    // Using Object.hasOwn closes the gap.
    expect(assertValidRevertTarget("complete", "constructor")).toBeInstanceOf(InvalidStageTransitionError);
    expect(assertValidRevertTarget("complete", "toString")).toBeInstanceOf(InvalidStageTransitionError);
    expect(assertValidRevertTarget("complete", "hasOwnProperty")).toBeInstanceOf(InvalidStageTransitionError);
    expect(assertValidRevertTarget("complete", "__proto__")).toBeInstanceOf(InvalidStageTransitionError);
  });

  it("rejects forward revert (target >= current)", () => {
    // This is the AUDIT BUG: admin POST body sets revert_to_stage='complete'
    // while tenant is at 'review_submitted'. Pre-fix that bypasses review.
    expect(assertValidRevertTarget("review_submitted", "complete")).toBeInstanceOf(InvalidStageTransitionError);
    expect(assertValidRevertTarget("profile", "complete")).toBeInstanceOf(InvalidStageTransitionError);
  });

  it("rejects same-stage revert", () => {
    expect(assertValidRevertTarget("profile", "profile")).toBeInstanceOf(InvalidStageTransitionError);
  });

  it("rejects revert from null/unset current stage", () => {
    expect(assertValidRevertTarget(null, "signup")).toBeInstanceOf(InvalidStageTransitionError);
  });
});

// ─── progressTo CAS update ───────────────────────────────────────────────

describe("progressTo — D-091 P1 #39 CAS update", () => {
  it("succeeds when current stage matches and exactly 1 row updated", async () => {
    currentBehavior = {
      selectStage: "profile",
      updateRows: [{ id: "t1" }],
    };
    await expect(progressTo("t1", "legal")).resolves.toBeUndefined();
    // CAS predicate: id eq + onboarding_stage eq current
    expect(updateCalls[0]!.filters).toEqual([
      ["id", "t1"],
      ["onboarding_stage", "profile"],
    ]);
  });

  it("uses .is() instead of .eq() when current is null", async () => {
    currentBehavior = {
      selectStage: null,
      updateRows: [{ id: "t1" }],
    };
    await expect(progressTo("t1", "signup")).resolves.toBeUndefined();
    expect(updateCalls[0]!.filters).toEqual([["id", "t1"]]);
    expect(updateCalls[0]!.isFilters).toEqual([["onboarding_stage", null]]);
  });

  it("throws StaleStageError when CAS matched 0 rows (concurrent advance)", async () => {
    currentBehavior = {
      selectStage: "profile",
      updateRows: [], // someone else moved us already
    };
    await expect(progressTo("t1", "legal")).rejects.toBeInstanceOf(StaleStageError);
  });

  it("is idempotent at-or-past — no UPDATE issued", async () => {
    currentBehavior = {
      selectStage: "complete",
      updateRows: [],
    };
    await expect(progressTo("t1", "profile")).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(0);
  });

  it("throws InvalidStageTransitionError on illegal skip (signup → complete)", async () => {
    currentBehavior = {
      selectStage: "signup",
      updateRows: [],
    };
    await expect(progressTo("t1", "complete")).rejects.toBeInstanceOf(InvalidStageTransitionError);
    expect(updateCalls).toHaveLength(0); // no UPDATE issued
  });

  it("stamps review_submitted_at in the update payload when advancing to review_submitted — SLA cron reads this field", async () => {
    // The 30-day SLA monitor (sub-host-review-sla-monitor) filters on
    // review_submitted_at. If progressTo fails to stamp it, every sub-host
    // that goes through branding-skip gets silently excluded from the cron.
    currentBehavior = {
      selectStage: "branding",
      updateRows: [{ id: "t1" }],
    };
    await expect(progressTo("t1", "review_submitted")).resolves.toBeUndefined();
    expect(updateCalls[0]!.payload).toMatchObject({
      onboarding_stage: "review_submitted",
      review_submitted_at: expect.any(String),
    });
    expect(new Date(updateCalls[0]!.payload["review_submitted_at"] as string).getTime()).toBeGreaterThan(0);
  });

  it("does NOT stamp review_submitted_at for other stage transitions", async () => {
    currentBehavior = {
      selectStage: "profile",
      updateRows: [{ id: "t1" }],
    };
    await expect(progressTo("t1", "legal")).resolves.toBeUndefined();
    expect(updateCalls[0]!.payload).not.toHaveProperty("review_submitted_at");
  });
});

// ─── revertTo validation + CAS ───────────────────────────────────────────

describe("revertTo — D-091 P1 #40 validation + CAS update", () => {
  it("succeeds for a valid backwards revert", async () => {
    currentBehavior = {
      selectStage: "complete",
      updateRows: [{ id: "t1" }],
    };
    await expect(revertTo("t1", "review_submitted")).resolves.toBeUndefined();
    expect(updateCalls[0]!.payload).toEqual({ onboarding_stage: "review_submitted" });
    // CAS predicate
    expect(updateCalls[0]!.filters).toEqual([
      ["id", "t1"],
      ["onboarding_stage", "complete"],
    ]);
  });

  it("REGRESSION: rejects forward target from untrusted input (the audit bug)", async () => {
    currentBehavior = {
      selectStage: "review_submitted",
      updateRows: [],
    };
    // Admin POST body { revert_to_stage: 'complete' } — this is the bypass attempt.
    // Cast to OnboardingStage simulates the untrusted call site.
    await expect(
      revertTo("t1", "complete" as never),
    ).rejects.toBeInstanceOf(InvalidStageTransitionError);
    expect(updateCalls).toHaveLength(0); // NO UPDATE attempted
  });

  it("rejects non-enum target without DB write", async () => {
    currentBehavior = {
      selectStage: "complete",
      updateRows: [],
    };
    await expect(
      revertTo("t1", "not_a_stage" as never),
    ).rejects.toBeInstanceOf(InvalidStageTransitionError);
    expect(updateCalls).toHaveLength(0);
  });

  it("throws StaleStageError when CAS matched 0 rows (concurrent change)", async () => {
    currentBehavior = {
      selectStage: "complete",
      updateRows: [], // someone else updated mid-flight
    };
    await expect(revertTo("t1", "review_submitted")).rejects.toBeInstanceOf(StaleStageError);
  });
});
