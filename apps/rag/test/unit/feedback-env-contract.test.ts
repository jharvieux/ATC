// #1708 — after migrating the feedback route from an inline createClient to
// getRagDb(), the route must still return its explicit 500 { supabase_env_not_set }
// when the rag DB env is unset. getRagDb() throws on missing env; the route
// catches that throw and preserves the original response contract rather than
// letting it surface as a bare unhandled 500. This test pins that behaviour so a
// future refactor can't silently swap the contract for a generic error.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Get past the HMAC gate and rate limit so the request reaches getRagDb().
// The signature/rate-limit paths are exercised by their own suites; here we
// isolate the env-resolution contract.
vi.mock("@atc/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atc/contracts")>();
  return { ...actual, verifyWebhookSignature: async () => true };
});
vi.mock("@/lib/rate-limit/feedback-limit", () => ({
  checkFeedbackRateLimit: async () => ({ allowed: true, reset_seconds: 0 }),
}));

import { POST } from "../../src/app/api/feedback/route";

function makeReq() {
  return new Request("http://rag.test/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": "unused" },
    body: JSON.stringify({
      message_id: "00000000-0000-0000-0000-000000000001",
      signal_direction: "up",
      raw_weight: 1,
      chunk_ids: ["00000000-0000-0000-0000-0000000000aa"],
    }),
  });
}

describe("feedback route — getRagDb env contract (#1708)", () => {
  beforeEach(() => {
    vi.stubEnv("RAG_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("SUPABASE_RAG_URL", "");
    vi.stubEnv("SUPABASE_RAG_SERVICE_ROLE_KEY", "");
  });

  it("returns 500 supabase_env_not_set when the rag DB env is unset", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "supabase_env_not_set" });
  });
});
