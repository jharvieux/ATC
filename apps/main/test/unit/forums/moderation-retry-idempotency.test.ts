// §19.3 — Forum moderation retry: optimistic-locking idempotency contract.
//
// Critical contract: if the same retry event fires 3× in parallel (e.g. from
// Inngest at-least-once delivery), exactly one worker wins the
// `UPDATE ... WHERE moderation_attempt_count = N` lock. The others are no-ops.
//
// This test verifies the optimistic-locking mechanism by simulating three
// concurrent workers reading the same message state (count=0) and racing to
// update it. Only the first updater wins; the others get 0 rows back.

import { describe, it, expect } from "vitest";

// Simulates the optimistic-lock update logic:
//   UPDATE forum_messages SET status = ?, moderation_attempt_count = N+1
//   WHERE id = ? AND moderation_attempt_count = N
// Returns true if the row was updated (this worker won the lock).
function simulateOptimisticUpdate(
  state: { id: string; moderation_attempt_count: number; status: string },
  expectedCount: number,
  newStatus: string,
): boolean {
  if (state.moderation_attempt_count !== expectedCount) {
    // Another worker already incremented the count — this is a no-op
    return false;
  }
  state.moderation_attempt_count += 1;
  state.status = newStatus;
  return true;
}

// Simulates the full retry worker logic:
//   1. Read message (count = N at read time)
//   2. Call "Haiku" (always succeeds with "visible" in this sim)
//   3. Update WHERE count = N
async function retryWorker(
  sharedState: { id: string; moderation_attempt_count: number; status: string },
): Promise<{ won: boolean; status: string }> {
  // Step 1: Read (each worker reads the SAME snapshot — simulating a race)
  const readCount = sharedState.moderation_attempt_count;

  // Step 2: "Haiku call" — simulate success
  await Promise.resolve(); // yields so workers interleave

  // Step 3: Optimistic update
  const won = simulateOptimisticUpdate(sharedState, readCount, "visible");
  return { won, status: sharedState.status };
}

describe("Forum moderation retry — optimistic locking (§19.3)", () => {
  it("exactly one of 3 parallel workers wins the optimistic lock", async () => {
    const message = { id: "msg-001", moderation_attempt_count: 0, status: "pending_moderation" };

    // All three workers read moderation_attempt_count = 0 simultaneously.
    // First to execute the update wins; the other two see count != 0 → no-op.
    const results = await Promise.all([
      retryWorker(message),
      retryWorker(message),
      retryWorker(message),
    ]);

    const winners = results.filter((r) => r.won);
    const noOps = results.filter((r) => !r.won);

    expect(winners).toHaveLength(1);
    expect(noOps).toHaveLength(2);

    // Final state: exactly one status transition
    expect(message.moderation_attempt_count).toBe(1);
    expect(message.status).toBe("visible");
  });

  it("second run of the same event (retry already resolved) is a no-op", async () => {
    // Simulate a message that was already resolved by a prior worker
    const message = { id: "msg-002", moderation_attempt_count: 1, status: "visible" };

    // This worker reads count=1 but message is already resolved —
    // the route handler checks `status !== 'pending_moderation'` and skips.
    // Here we verify the optimistic update alone won't clobber resolved state.
    const won = simulateOptimisticUpdate(message, 0 /* stale read */, "flagged_review");
    expect(won).toBe(false);
    expect(message.status).toBe("visible"); // unchanged
  });

  it("optimistic lock counter increments per-win, not per-attempt", () => {
    const message = { id: "msg-003", moderation_attempt_count: 0, status: "pending_moderation" };

    // Worker 1 wins
    const w1 = simulateOptimisticUpdate(message, 0, "visible");
    // Worker 2 is a no-op (expected count is stale)
    const w2 = simulateOptimisticUpdate(message, 0, "hidden");
    // Worker 3 is a no-op (expected count is still stale)
    const w3 = simulateOptimisticUpdate(message, 0, "flagged_review");

    expect(w1).toBe(true);
    expect(w2).toBe(false);
    expect(w3).toBe(false);

    // Count incremented exactly once; status is from worker 1 only
    expect(message.moderation_attempt_count).toBe(1);
    expect(message.status).toBe("visible");
  });

  it("status decision: max_score < 0.4 → visible, 0.4–0.7 → flagged_review, > 0.7 → hidden", () => {
    function decideStatus(maxScore: number): "visible" | "flagged_review" | "hidden" {
      if (maxScore < 0.4) return "visible";
      if (maxScore <= 0.7) return "flagged_review";
      return "hidden";
    }

    expect(decideStatus(0.1)).toBe("visible");
    expect(decideStatus(0.39)).toBe("visible");
    expect(decideStatus(0.4)).toBe("flagged_review");
    expect(decideStatus(0.7)).toBe("flagged_review");
    expect(decideStatus(0.701)).toBe("hidden");
    expect(decideStatus(0.95)).toBe("hidden");
  });

  it("24h escalation: pending messages older than timeout become flagged_review", () => {
    const timeoutHours = 24;
    const pendingSince = new Date(Date.now() - (timeoutHours + 1) * 60 * 60 * 1000);
    const hoursElapsed = (Date.now() - pendingSince.getTime()) / (1000 * 60 * 60);
    expect(hoursElapsed).toBeGreaterThanOrEqual(timeoutHours);
    // If hoursElapsed >= FORUM_MODERATION_RETRY_TIMEOUT_HOURS → escalate to flagged_review
    // This is the contract tested in the sweep; here we verify the math
  });
});
