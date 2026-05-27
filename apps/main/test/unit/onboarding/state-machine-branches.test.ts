// Onboarding state machine — extra branch coverage for the surfaces the
// existing tests don't reach: error-class shapes, stageIndex/nextStage edge
// cases, assertStageComplete, DB-error propagation in progressTo/revertTo,
// and the connect_setup → review_submitted branding-skip allowance.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock service-role-client. Scriptable per-test via currentBehavior.
// ---------------------------------------------------------------------------

type MockBehavior = {
  selectStage: string | null | undefined; // undefined => row missing
  selectError?: { message: string } | null;
  updateRows?: Array<{ id: string }>;
  updateError?: { message: string } | null;
};

let currentBehavior: MockBehavior;
const updateCalls: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq() {
              return {
                async single() {
                  if (currentBehavior.selectError) {
                    return { data: null, error: currentBehavior.selectError };
                  }
                  if (currentBehavior.selectStage === undefined) {
                    return { data: null, error: null };
                  }
                  return {
                    data: { onboarding_stage: currentBehavior.selectStage },
                    error: null,
                  };
                },
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          const call = { payload, filters: [] as Array<[string, unknown]> };
          updateCalls.push(call);
          const chain: Record<string, unknown> = {
            eq(col: string, val: unknown) {
              call.filters.push([col, val]);
              return chain;
            },
            is(col: string, val: unknown) {
              call.filters.push([col, val]);
              return chain;
            },
            async select(_cols: string) {
              return {
                data: currentBehavior.updateRows ?? [],
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
  ONBOARDING_STAGES,
  isAtOrPast,
  nextStage,
  assertStageComplete,
  progressTo,
  revertTo,
  OnboardingStageError,
  InvalidStageTransitionError,
  StaleStageError,
} from "@/lib/onboarding/state-machine";

beforeEach(() => {
  updateCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Error-class shapes — survivors at L35, L37, L46, L47, L105, L107.
// ---------------------------------------------------------------------------

describe("OnboardingStageError shape", () => {
  it("name='OnboardingStageError' and message names both stages", () => {
    const err = new OnboardingStageError("profile", "complete");
    expect(err.name).toBe("OnboardingStageError");
    expect(err.message).toContain("profile");
    expect(err.message).toContain("complete");
    expect(err.currentStage).toBe("profile");
    expect(err.requiredStage).toBe("complete");
  });

  it("handles null currentStage in the message", () => {
    const err = new OnboardingStageError(null, "signup");
    expect(err.message).toContain("signup");
    expect(err.currentStage).toBeNull();
  });

  it("is an instance of Error", () => {
    expect(new OnboardingStageError("signup", "profile")).toBeInstanceOf(Error);
  });
});

describe("InvalidStageTransitionError shape", () => {
  it("name='InvalidStageTransitionError' and message contains 'Cannot advance'", () => {
    const err = new InvalidStageTransitionError("signup", "complete");
    expect(err.name).toBe("InvalidStageTransitionError");
    expect(err.message).toContain("signup");
    expect(err.message).toContain("complete");
    expect(err.message.toLowerCase()).toContain("cannot advance");
    expect(err.from).toBe("signup");
    expect(err.to).toBe("complete");
  });

  it("handles null from-stage in the message", () => {
    const err = new InvalidStageTransitionError(null, "signup");
    expect(err.from).toBeNull();
    expect(err.to).toBe("signup");
  });

  it("is an instance of Error", () => {
    expect(new InvalidStageTransitionError("signup", "profile")).toBeInstanceOf(Error);
  });
});

describe("StaleStageError shape", () => {
  it("name='StaleStageError' and message names both stages + retry hint", () => {
    const err = new StaleStageError("profile", "legal");
    expect(err.name).toBe("StaleStageError");
    expect(err.message).toContain("profile");
    expect(err.message).toContain("legal");
    expect(err.message.toLowerCase()).toContain("retry");
    expect(err.expected).toBe("profile");
    expect(err.target).toBe("legal");
  });

  it("handles null expected (mid-write race from null state)", () => {
    const err = new StaleStageError(null, "signup");
    expect(err.expected).toBeNull();
    expect(err.target).toBe("signup");
  });

  it("is an instance of Error", () => {
    expect(new StaleStageError("signup", "profile")).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// stageIndex (indirect via isAtOrPast) — survivor at L52 / L53.
// ---------------------------------------------------------------------------

describe("isAtOrPast — null-handling boundary (L52/53)", () => {
  it("two nulls compare equal at the -1 sentinel boundary", () => {
    expect(isAtOrPast(null, "signup")).toBe(false);
    // Two nulls would land at -1 >= -1, but the API only accepts a real
    // OnboardingStage as target, so we exercise via the null-current case
    // alongside the every-stage check below.
  });

  it("null current returns false for every real stage", () => {
    for (const s of ONBOARDING_STAGES) {
      expect(isAtOrPast(null, s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// nextStage — survivors around the +1 lookup (L64-65).
// ---------------------------------------------------------------------------

describe("nextStage — every adjacent pair", () => {
  it("each stage's nextStage is the very next entry in ONBOARDING_STAGES", () => {
    for (let i = 0; i < ONBOARDING_STAGES.length - 1; i++) {
      const cur = ONBOARDING_STAGES[i]!;
      const expected = ONBOARDING_STAGES[i + 1]!;
      expect(nextStage(cur)).toBe(expected);
    }
  });

  it("complete (last stage) returns null", () => {
    expect(nextStage("complete")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assertStageComplete — DB error / null row / not-yet-at / past / equal-to.
// ---------------------------------------------------------------------------

describe("assertStageComplete", () => {
  it("returns silently when tenant is past the required stage", async () => {
    currentBehavior = { selectStage: "complete" };
    await expect(assertStageComplete("t1", "profile")).resolves.toBeUndefined();
  });

  it("returns silently when tenant is AT the required stage", async () => {
    currentBehavior = { selectStage: "tax_form" };
    await expect(assertStageComplete("t1", "tax_form")).resolves.toBeUndefined();
  });

  it("throws OnboardingStageError when tenant has not reached the stage", async () => {
    currentBehavior = { selectStage: "profile" };
    await expect(assertStageComplete("t1", "complete")).rejects.toBeInstanceOf(OnboardingStageError);
  });

  it("throws OnboardingStageError when row exists but onboarding_stage is null", async () => {
    currentBehavior = { selectStage: null };
    await expect(assertStageComplete("t1", "signup")).rejects.toBeInstanceOf(OnboardingStageError);
  });

  it("throws OnboardingStageError when row is missing (data null)", async () => {
    currentBehavior = { selectStage: undefined };
    await expect(assertStageComplete("t1", "signup")).rejects.toBeInstanceOf(OnboardingStageError);
  });

  it("throws a generic Error containing the DB message on fetch error", async () => {
    currentBehavior = {
      selectStage: undefined,
      selectError: { message: "synthetic db down" },
    };
    await expect(assertStageComplete("t1", "signup")).rejects.toThrow(/synthetic db down/);
  });
});

// ---------------------------------------------------------------------------
// progressTo — connect_setup → review_submitted skip (L167-168).
// ---------------------------------------------------------------------------

describe("progressTo — branding skip + DB-error propagation", () => {
  it("allows connect_setup → review_submitted (skipping branding) per §15.10", async () => {
    currentBehavior = {
      selectStage: "connect_setup",
      updateRows: [{ id: "t1" }],
    };
    await expect(progressTo("t1", "review_submitted")).resolves.toBeUndefined();
    // CAS predicate uses the current stage as the guard.
    expect(updateCalls[0]!.filters).toContainEqual(["onboarding_stage", "connect_setup"]);
  });

  it("REJECTS a non-branding skip even of similar shape (subscription → review_submitted)", async () => {
    currentBehavior = {
      selectStage: "subscription",
      updateRows: [],
    };
    await expect(progressTo("t1", "review_submitted")).rejects.toBeInstanceOf(
      InvalidStageTransitionError,
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("REJECTS branding skip from any other source stage (profile → review_submitted)", async () => {
    currentBehavior = {
      selectStage: "profile",
      updateRows: [],
    };
    await expect(progressTo("t1", "review_submitted")).rejects.toBeInstanceOf(
      InvalidStageTransitionError,
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("REJECTS connect_setup advancing to anything other than branding or review_submitted (e.g. complete)", async () => {
    currentBehavior = {
      selectStage: "connect_setup",
      updateRows: [],
    };
    await expect(progressTo("t1", "complete")).rejects.toBeInstanceOf(
      InvalidStageTransitionError,
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("connect_setup → branding (the normal one-stage forward) still works", async () => {
    currentBehavior = {
      selectStage: "connect_setup",
      updateRows: [{ id: "t1" }],
    };
    await expect(progressTo("t1", "branding")).resolves.toBeUndefined();
  });

  it("propagates DB fetch error with 'progressTo:' prefix and the message", async () => {
    currentBehavior = {
      selectStage: undefined,
      selectError: { message: "synthetic fetch failure" },
    };
    await expect(progressTo("t1", "profile")).rejects.toThrow(/progressTo:.*synthetic fetch failure/);
  });

  it("propagates DB update error with 'progressTo:' prefix and the message", async () => {
    currentBehavior = {
      selectStage: "signup",
      updateRows: [{ id: "t1" }],
      updateError: { message: "synthetic update failure" },
    };
    await expect(progressTo("t1", "profile")).rejects.toThrow(/progressTo:.*synthetic update failure/);
  });

  it("from null current: advances to 'signup' (first stage) only", async () => {
    currentBehavior = {
      selectStage: null,
      updateRows: [{ id: "t1" }],
    };
    await expect(progressTo("t1", "signup")).resolves.toBeUndefined();
  });

  it("from null current: rejects advancing past the first stage", async () => {
    currentBehavior = {
      selectStage: null,
      updateRows: [],
    };
    await expect(progressTo("t1", "profile")).rejects.toBeInstanceOf(InvalidStageTransitionError);
  });

  it("writes payload { onboarding_stage: <nextStageValue> } on success", async () => {
    currentBehavior = {
      selectStage: "profile",
      updateRows: [{ id: "t1" }],
    };
    await progressTo("t1", "legal");
    expect(updateCalls[0]!.payload).toEqual({ onboarding_stage: "legal" });
  });
});

// ---------------------------------------------------------------------------
// revertTo — DB error propagation + payload shape.
// ---------------------------------------------------------------------------

describe("revertTo — DB-error propagation + payload", () => {
  it("propagates DB fetch error with 'revertTo:' prefix", async () => {
    currentBehavior = {
      selectStage: undefined,
      selectError: { message: "synthetic fetch failure" },
    };
    await expect(revertTo("t1", "profile")).rejects.toThrow(/revertTo:.*synthetic fetch failure/);
  });

  it("propagates DB update error with 'revertTo:' prefix", async () => {
    currentBehavior = {
      selectStage: "complete",
      updateRows: [{ id: "t1" }],
      updateError: { message: "synthetic update failure" },
    };
    await expect(revertTo("t1", "profile")).rejects.toThrow(/revertTo:.*synthetic update failure/);
  });

  it("writes payload { onboarding_stage: <targetStage> } on success", async () => {
    currentBehavior = {
      selectStage: "complete",
      updateRows: [{ id: "t1" }],
    };
    await revertTo("t1", "profile");
    expect(updateCalls[0]!.payload).toEqual({ onboarding_stage: "profile" });
  });

  it("CAS predicate matches both id and the current stage", async () => {
    currentBehavior = {
      selectStage: "complete",
      updateRows: [{ id: "t1" }],
    };
    await revertTo("t1", "review_submitted");
    expect(updateCalls[0]!.filters).toContainEqual(["id", "t1"]);
    expect(updateCalls[0]!.filters).toContainEqual(["onboarding_stage", "complete"]);
  });
});
