// §27.7 — threshold-recompute recompute core (P2 for #1217).
//
// Pins the math that decides a tenant's abuse/RAG state after a subscription
// change re-resolves thresholds. These are the mutation survivors flagged by
// the 2026-06-17 Stryker sweep (file was 0%): the >= boundaries in the
// classifiers and the "emit a transition only when the state actually changed"
// rule, including the §27.7 invariant that downgrades ARE emitted here.

import { describe, it, expect } from "vitest";
import {
  classifyAbuse,
  classifyRag,
  computeAbuseTransitions,
  type AbuseDimensionInput,
} from "@/inngest/threshold-recompute-on-subscription-change";

const T = { soft1: 100n, soft2: 200n, hard: 300n };

describe("classifyAbuse — boundaries are inclusive at each threshold", () => {
  it("below soft1 is ok", () => {
    expect(classifyAbuse(99n, T)).toBe("ok");
  });
  it("exactly soft1 is soft1 (>= is inclusive)", () => {
    expect(classifyAbuse(100n, T)).toBe("soft1");
  });
  it("between soft1 and soft2 stays soft1", () => {
    expect(classifyAbuse(199n, T)).toBe("soft1");
  });
  it("exactly soft2 is soft2", () => {
    expect(classifyAbuse(200n, T)).toBe("soft2");
  });
  it("between soft2 and hard stays soft2", () => {
    expect(classifyAbuse(299n, T)).toBe("soft2");
  });
  it("exactly hard is hard", () => {
    expect(classifyAbuse(300n, T)).toBe("hard");
  });
  it("above hard is hard", () => {
    expect(classifyAbuse(10_000n, T)).toBe("hard");
  });
});

describe("classifyRag — at_cap is the exact-equality state", () => {
  const R = { approaching: 80, effective: 100 };
  it("below approaching is ok", () => {
    expect(classifyRag(79, R)).toBe("ok");
  });
  it("exactly approaching is approaching", () => {
    expect(classifyRag(80, R)).toBe("approaching");
  });
  it("between approaching and effective stays approaching", () => {
    expect(classifyRag(99, R)).toBe("approaching");
  });
  it("exactly effective is at_cap, not over_cap", () => {
    expect(classifyRag(100, R)).toBe("at_cap");
  });
  it("one over effective is over_cap", () => {
    expect(classifyRag(101, R)).toBe("over_cap");
  });
});

function dim(overrides: Partial<AbuseDimensionInput>): AbuseDimensionInput {
  return {
    dim: "ai_cost",
    value: 0n,
    t: T,
    state_col: "ai_cost_limit_state",
    changed_col: "ai_cost_state_changed_at",
    currentState: "ok",
    ...overrides,
  };
}

describe("computeAbuseTransitions", () => {
  const NOW = "2026-06-19T00:00:00.000Z";

  it("emits nothing when the recomputed state equals the current state", () => {
    const { updates, transitions } = computeAbuseTransitions(
      [dim({ value: 50n, currentState: "ok" })],
      NOW,
    );
    expect(transitions).toEqual([]);
    expect(updates).toEqual({});
  });

  it("emits an upgrade transition with the crossed threshold and stamps both columns", () => {
    const { updates, transitions } = computeAbuseTransitions(
      [dim({ value: 300n, currentState: "ok" })],
      NOW,
    );
    expect(transitions).toEqual([
      { dim: "ai_cost", from: "ok", to: "hard", value: "300", threshold: "300" },
    ]);
    expect(updates).toEqual({
      ai_cost_limit_state: "hard",
      ai_cost_state_changed_at: NOW,
    });
  });

  // §27.7: subscription change is exogenous, so a tier upgrade that pushes a
  // tenant from "hard" back down to "ok" MUST emit the downgrade — the
  // monotonic (no-auto-downgrade) rule only holds inside a stable regime.
  it("emits a downgrade transition (hard → ok) with threshold 0", () => {
    const { transitions } = computeAbuseTransitions(
      [dim({ value: 10n, currentState: "hard" })],
      NOW,
    );
    expect(transitions).toEqual([
      { dim: "ai_cost", from: "hard", to: "ok", value: "10", threshold: "0" },
    ]);
  });

  it("maps the crossed threshold to soft1/soft2 for those transitions", () => {
    const soft1 = computeAbuseTransitions([dim({ value: 150n, currentState: "ok" })], NOW);
    expect(soft1.transitions[0]).toMatchObject({ to: "soft1", threshold: "100" });
    const soft2 = computeAbuseTransitions([dim({ value: 250n, currentState: "ok" })], NOW);
    expect(soft2.transitions[0]).toMatchObject({ to: "soft2", threshold: "200" });
  });

  it("only the dimensions that changed appear in updates and transitions", () => {
    const { updates, transitions } = computeAbuseTransitions(
      [
        dim({ dim: "ai_cost", value: 50n, currentState: "ok" }), // unchanged
        dim({
          dim: "chat_volume",
          value: 300n,
          currentState: "soft1",
          state_col: "chat_volume_limit_state",
          changed_col: "chat_volume_state_changed_at",
        }), // soft1 → hard
      ],
      NOW,
    );
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ dim: "chat_volume", from: "soft1", to: "hard" });
    expect(Object.keys(updates)).toEqual(["chat_volume_limit_state", "chat_volume_state_changed_at"]);
  });
});
