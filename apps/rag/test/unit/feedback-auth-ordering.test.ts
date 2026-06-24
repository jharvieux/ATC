// F-rag-wh-01 — the feedback webhook must verify the HMAC signature BEFORE the
// rate limit runs. Previously rate-limit-first meant an unauthenticated caller
// forced a pre-auth Redis write and could spoof x-forwarded-for to exhaust the
// legitimate caller's bucket. This pins: a bad signature → 401, and the rate
// limiter is never reached (so no pre-auth Redis touch).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { rlSpy } = vi.hoisted(() => ({
  rlSpy: vi.fn(async () => ({ allowed: true, remaining: 120, reset_seconds: 60 })),
}));
vi.mock("@/lib/rate-limit/feedback-limit", () => ({ checkFeedbackRateLimit: rlSpy }));
// createClient must never be reached on the 401 path; stub it to be import-safe.
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }));

import { POST } from "@/app/api/feedback/route";

beforeEach(() => {
  rlSpy.mockClear();
  process.env.RAG_WEBHOOK_SECRET = "test-secret";
});

function post(signature: string): Promise<Response> {
  return POST(
    new Request("http://rag.test/api/feedback", {
      method: "POST",
      headers: { "x-webhook-signature": signature },
      body: JSON.stringify({
        message_id: "m1",
        chunk_ids: ["c1"],
        signal_direction: "up",
        raw_weight: 1,
      }),
    }),
  );
}

describe("feedback webhook auth ordering (F-rag-wh-01)", () => {
  it("rejects an invalid signature with 401 and never reaches the rate limiter", async () => {
    const res = await post("deadbeef-not-a-valid-hmac");
    expect(res.status).toBe(401);
    // The rate limiter runs only after a verified signature — so a forged
    // request can neither write to Redis nor share the legit caller's bucket.
    expect(rlSpy).not.toHaveBeenCalled();
  });
});
