// WHY: The timingSafeEqual + length-parity guard in the webhook routes is a
// security fix for a timing oracle (PR #758, f017/f038). These tests pin the
// behavior so a future refactor can't revert to a `===` comparison. The
// recorded-fixture test (valid HMAC → 200) also guards against re-encoding
// the signature incorrectly (e.g., switching from hex to base64).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

const SECRET = "test-webhook-secret";

// Node crypto and the route's Web Crypto hmacHex() produce identical output:
// both are HMAC-SHA256 over UTF-8 bytes, hex-encoded.
function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
        // platform-settings-events batches the stale-revision check into a
        // single .in() read (#1792) instead of one .eq().maybeSingle() per key.
        in: async () => ({ data: [], error: null }),
      }),
      upsert: async () => ({ error: null }),
    }),
  }),
}));

const TENANT_BODY = JSON.stringify({
  event_type: "tenant.created",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  source_revision: 1,
  payload: { status: "active", tenant_type: "agency", display_name: "Test Tenant" },
});

const PLATFORM_BODY = JSON.stringify({
  event_type: "platform_settings.updated",
  source_revision: 1,
  payload: { changes: [{ key: "some_key", value: "some_value" }] },
});

function makeReq(url: string, body: string, sig?: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== null && sig !== undefined) headers["x-webhook-signature"] = sig;
  return new Request(url, { method: "POST", headers, body });
}

import { POST as tenantEventsPost } from "@/app/api/tenant-events/route";
import { POST as platformSettingsPost } from "@/app/api/platform-settings-events/route";

beforeEach(() => {
  vi.stubEnv("RAG_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("SUPABASE_RAG_URL", "http://supabase.test");
  vi.stubEnv("SUPABASE_RAG_SERVICE_ROLE_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tenant-events webhook — HMAC signature (timingSafeEqual, f017)", () => {
  it("returns 401 when x-webhook-signature header is absent", async () => {
    const res = await tenantEventsPost(makeReq("http://rag.test/api/tenant-events", TENANT_BODY));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_signature" });
  });

  it("returns 401 when signature is wrong but correct length", async () => {
    const valid = hmacHex(SECRET, TENANT_BODY);
    const wrong = valid.slice(0, -1) + (valid.endsWith("0") ? "1" : "0");
    const res = await tenantEventsPost(makeReq("http://rag.test/api/tenant-events", TENANT_BODY, wrong));
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong-length signature (length parity pre-check prevents Buffer.byteLength throw)", async () => {
    const res = await tenantEventsPost(makeReq("http://rag.test/api/tenant-events", TENANT_BODY, "tooshort"));
    expect(res.status).toBe(401);
  });

  it("returns 200 for valid HMAC-SHA256 hex signature (recorded fixture)", async () => {
    const sig = hmacHex(SECRET, TENANT_BODY);
    const res = await tenantEventsPost(makeReq("http://rag.test/api/tenant-events", TENANT_BODY, sig));
    expect(res.status).toBe(200);
  });
});

describe("tenant-events webhook — secret rotation set (#2004, D-091 #28)", () => {
  it("accepts a signature under RAG_WEBHOOK_SECRET_CURRENT when the legacy var is unset", async () => {
    vi.stubEnv("RAG_WEBHOOK_SECRET", "");
    vi.stubEnv("RAG_WEBHOOK_SECRET_CURRENT", "rotated-current");
    const sig = hmacHex("rotated-current", TENANT_BODY);
    const res = await tenantEventsPost(makeReq("http://rag.test/api/tenant-events", TENANT_BODY, sig));
    expect(res.status).toBe(200);
  });

  it("accepts a signature under RAG_WEBHOOK_SECRET_PREVIOUS during rotation overlap", async () => {
    // Zero-downtime rotation: main may still be signing with the old secret
    // while the operator finishes the flip — _PREVIOUS keeps those verifiable.
    vi.stubEnv("RAG_WEBHOOK_SECRET", "");
    vi.stubEnv("RAG_WEBHOOK_SECRET_CURRENT", "rotated-current");
    vi.stubEnv("RAG_WEBHOOK_SECRET_PREVIOUS", "old-previous");
    const sig = hmacHex("old-previous", TENANT_BODY);
    const res = await tenantEventsPost(makeReq("http://rag.test/api/tenant-events", TENANT_BODY, sig));
    expect(res.status).toBe(200);
  });

  it("rejects a signature under a secret no longer in the rotation set", async () => {
    vi.stubEnv("RAG_WEBHOOK_SECRET", "");
    vi.stubEnv("RAG_WEBHOOK_SECRET_CURRENT", "rotated-current");
    const sig = hmacHex(SECRET, TENANT_BODY); // retired secret
    const res = await tenantEventsPost(makeReq("http://rag.test/api/tenant-events", TENANT_BODY, sig));
    expect(res.status).toBe(401);
  });

  it("returns 500 fail-closed when no member of the rotation set is configured", async () => {
    vi.stubEnv("RAG_WEBHOOK_SECRET", "");
    const sig = hmacHex(SECRET, TENANT_BODY);
    const res = await tenantEventsPost(makeReq("http://rag.test/api/tenant-events", TENANT_BODY, sig));
    expect(res.status).toBe(500);
  });
});

describe("platform-settings-events webhook — HMAC signature (timingSafeEqual, f038)", () => {
  it("returns 401 when x-webhook-signature header is absent", async () => {
    const res = await platformSettingsPost(makeReq("http://rag.test/api/platform-settings-events", PLATFORM_BODY));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_signature" });
  });

  it("returns 401 when signature is wrong but correct length", async () => {
    const valid = hmacHex(SECRET, PLATFORM_BODY);
    const wrong = valid.slice(0, -1) + (valid.endsWith("0") ? "1" : "0");
    const res = await platformSettingsPost(makeReq("http://rag.test/api/platform-settings-events", PLATFORM_BODY, wrong));
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong-length signature (length parity pre-check prevents Buffer.byteLength throw)", async () => {
    const res = await platformSettingsPost(makeReq("http://rag.test/api/platform-settings-events", PLATFORM_BODY, "tooshort"));
    expect(res.status).toBe(401);
  });

  it("returns 200 for valid HMAC-SHA256 hex signature (recorded fixture)", async () => {
    const sig = hmacHex(SECRET, PLATFORM_BODY);
    const res = await platformSettingsPost(makeReq("http://rag.test/api/platform-settings-events", PLATFORM_BODY, sig));
    expect(res.status).toBe(200);
  });
});
