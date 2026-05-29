// §19.3 — Forum moderation retry path.
//
// The score→status decision imports the real decideModerationStatus used by
// BOTH the message-post route and the retry job, so a threshold change fails
// this suite (D-091 / #384 — no in-test reimplementation).
//
// The optimistic-lock idempotency contract (only one of N parallel retry
// workers wins the `UPDATE ... WHERE moderation_attempt_count = N` CAS) is a
// database guarantee with no pure-function seam — the prior JS simulation
// asserted nothing about production code. Real coverage needs a DB-backed
// integration harness (blocked on #386); the contract is marked skipped below
// rather than faked.

import { describe, it, expect } from "vitest";
import { decideModerationStatus } from "@/lib/forums/moderation-status";

describe("forum moderation status decision (§19.3)", () => {
  it("max_score < 0.4 → visible", () => {
    expect(decideModerationStatus(0.1)).toBe("visible");
    expect(decideModerationStatus(0.39)).toBe("visible");
  });

  it("max_score 0.4–0.7 → flagged_review", () => {
    expect(decideModerationStatus(0.4)).toBe("flagged_review");
    expect(decideModerationStatus(0.55)).toBe("flagged_review");
    expect(decideModerationStatus(0.7)).toBe("flagged_review");
  });

  it("max_score > 0.7 → hidden", () => {
    expect(decideModerationStatus(0.701)).toBe("hidden");
    expect(decideModerationStatus(0.95)).toBe("hidden");
  });

  it("thresholds are inclusive on the flagged_review band (0.4 and 0.7)", () => {
    // Guards against an off-by-one flip to strict inequalities, which would
    // silently auto-hide 0.7 content or auto-show 0.4 content.
    expect(decideModerationStatus(0.4)).toBe("flagged_review");
    expect(decideModerationStatus(0.7)).toBe("flagged_review");
    expect(decideModerationStatus(0.700001)).toBe("hidden");
  });
});

describe.skip("forum moderation retry — optimistic-lock idempotency (§19.3) — needs DB harness (#386)", () => {
  // The `UPDATE ... WHERE moderation_attempt_count = N` CAS guarantees exactly
  // one of N parallel retry workers wins; the others see 0 rows and no-op.
  // This is a database guarantee, not app logic — it can only be exercised
  // against a real Postgres. Unskip once the #386 integration test DB lands.
  it("exactly one of N parallel workers wins the attempt-count CAS", () => {
    // TODO(#386): seed a forum_messages row at count=0, fire N concurrent
    // retries against the real DB, assert exactly one transition.
  });
});
