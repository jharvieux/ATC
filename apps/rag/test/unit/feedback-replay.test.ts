// #1385 / F-rag-wh-02 — feedback webhook replay protection.
//
// Pins WHY the dedup exists: the HMAC proves the body was signed by the caller,
// but NOT that it is fresh. A captured signed request can be re-delivered
// forever, inserting duplicate feedback rows that cross feedback_min_signal_count
// and poison retrieval ranking. The Redis SET NX dedup key (24h TTL) ensures a
// second delivery with an identical content fingerprint is rejected with 409.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Track SET NX calls to verify the dedup key is being written and checked.
const redisMockStore = new Map<string, string>();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: () => ({ select: () => Promise.resolve({ data: [{ id: "1" }], error: null }) }),
    }),
  }),
}));

vi.mock("@/lib/redis/client", () => ({
  getRedis: () => ({
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      if (redisMockStore.has(key)) return null; // NX — already present
      redisMockStore.set(key, value);
      return "OK";
    }),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 60),
  }),
}));

import { POST } from "../../src/app/api/feedback/route";

beforeEach(() => {
  redisMockStore.clear();
});

// Build a valid-looking signed request. We don't test the HMAC here (that's
// the existing HMAC tests' job); we stub the secret out and build the body so
// the signature match is deterministic.
async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TEST_SECRET = "test-secret-replay";
const BODY = JSON.stringify({
  message_id: "00000000-0000-0000-0000-000000000001",
  signal_direction: "up",
  raw_weight: 5,
  chunk_ids: ["00000000-0000-0000-0000-000000000002"],
});

function makeRequest(body: string, sig: string) {
  return new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { "x-webhook-signature": sig },
    body,
  });
}

describe("feedback webhook replay protection (#1385)", () => {
  it("accepts a first delivery", async () => {
    vi.stubEnv("RAG_WEBHOOK_SECRET", TEST_SECRET);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");

    const sig = await hmacHex(TEST_SECRET, BODY);
    const res = await POST(makeRequest(BODY, sig));
    expect(res.status).not.toBe(409);
  });

  it("rejects a replayed delivery (same fingerprint) with 409", async () => {
    vi.stubEnv("RAG_WEBHOOK_SECRET", TEST_SECRET);

    const sig = await hmacHex(TEST_SECRET, BODY);
    // First delivery accepted
    await POST(makeRequest(BODY, sig));
    // Second delivery with identical body/sig → same fingerprint → 409
    const res2 = await POST(makeRequest(BODY, sig));
    expect(res2.status).toBe(409);
    const json = await res2.json() as { error: string };
    expect(json.error).toBe("duplicate_delivery");
  });

  it("allows a delivery with a different message_id (distinct fingerprint)", async () => {
    vi.stubEnv("RAG_WEBHOOK_SECRET", TEST_SECRET);

    const body2 = JSON.stringify({
      message_id: "00000000-0000-0000-0000-000000000099",
      signal_direction: "up",
      raw_weight: 5,
      chunk_ids: ["00000000-0000-0000-0000-000000000002"],
    });
    const sig2 = await hmacHex(TEST_SECRET, body2);
    // First delivery of BODY already in store from setup
    const sig = await hmacHex(TEST_SECRET, BODY);
    await POST(makeRequest(BODY, sig));
    // Different message_id → different fingerprint → not a replay
    const res = await POST(makeRequest(body2, sig2));
    expect(res.status).not.toBe(409);
  });
});
