// F-rag-wh-01 — the feedback webhook must verify the HMAC signature BEFORE the
// rate limit runs, and bucket on the VERIFIED message_id (not a spoofable
// header). Previously rate-limit-first + an x-forwarded-for bucket let an
// unauthenticated caller force a pre-auth Redis write and exhaust the legit
// caller's bucket. Pins both invariants:
//   1. bad signature → 401, limiter never reached (no pre-auth Redis touch)
//   2. valid signature → limiter called with "msg:<message_id>"

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const { rlSpy } = vi.hoisted(() => ({
  rlSpy: vi.fn(async (_bucketId: string) => ({ allowed: true, remaining: 120, reset_seconds: 60 })),
}));
vi.mock("@/lib/rate-limit/feedback-limit", () => ({ checkFeedbackRateLimit: rlSpy }));
// On the authenticated path the route builds a Supabase client and inserts;
// stub it to a chain that resolves so we can assert the limiter call.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({ insert: () => ({ select: async () => ({ data: [{ id: "x" }], error: null }) }) }),
  }),
}));

import { POST } from "@/app/api/feedback/route";

const SECRET = "test-secret";
const MSG_ID = "11111111-1111-1111-1111-111111111111";
const CHUNK_ID = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  rlSpy.mockClear();
  process.env.RAG_WEBHOOK_SECRET = SECRET;
  process.env.SUPABASE_RAG_URL = "http://rag.local";
  process.env.SUPABASE_RAG_SERVICE_ROLE_KEY = "svc";
});

function post(body: string, signature: string): Promise<Response> {
  return POST(
    new Request("http://rag.test/api/feedback", {
      method: "POST",
      headers: { "x-webhook-signature": signature },
      body,
    }),
  );
}

describe("feedback webhook auth ordering (F-rag-wh-01)", () => {
  it("rejects an invalid signature with 401 and never reaches the rate limiter", async () => {
    const body = JSON.stringify({ message_id: MSG_ID, signal_direction: "up", raw_weight: 1, chunk_ids: [CHUNK_ID] });
    const res = await post(body, "deadbeef-not-a-valid-hmac");
    expect(res.status).toBe(401);
    // Limiter runs only after a verified signature — a forged request can
    // neither write to Redis nor share the legit caller's bucket.
    expect(rlSpy).not.toHaveBeenCalled();
  });

  it("on a valid signature, buckets the rate limit on the verified message_id", async () => {
    const body = JSON.stringify({ message_id: MSG_ID, signal_direction: "up", raw_weight: 1, chunk_ids: [CHUNK_ID] });
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const res = await post(body, sig);
    expect(res.status).toBe(200);
    expect(rlSpy).toHaveBeenCalledTimes(1);
    // Bucket key is derived from the SIGNED body, not a spoofable header.
    expect(rlSpy.mock.calls[0]?.[0]).toBe(`msg:${MSG_ID}`);
  });
});
