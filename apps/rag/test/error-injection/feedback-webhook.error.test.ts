// Tier 2 — RAG feedback webhook error-injection.
//
// /api/feedback receives thumbs-up/down signals from the main app over
// HMAC-SHA256-signed webhooks. Failure modes covered:
//
//   - Missing RAG_WEBHOOK_SECRET → 500, fail-closed config.
//   - Missing signature → 401.
//   - Tampered signature → 401.
//   - Invalid body shape → 400.
//   - Missing Supabase env → 500.
//   - DB insert error → 500 (route surfaces error.message). Main app
//     will retry; the bulk insert is idempotent at the application
//     level (chunk_id + message_id + signal_direction repeats are
//     scored at retrieval time, not deduped at write).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const mocks = vi.hoisted(() => ({
  /** What the supabase `.insert(...).select(...)` resolves to. */
  insertResult: { data: [{ id: "ev-1" }], error: null } as { data: unknown; error: { message: string } | null },
  /** Whether the rate limit allows the request. */
  rateLimitAllowed: true,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(_table: string) {
      void _table;
      return {
        insert(_rows: unknown) {
          void _rows;
          return {
            select: async (_cols: string) => {
              void _cols;
              return mocks.insertResult;
            },
          };
        },
      };
    },
  }),
}));

vi.mock("@/lib/rate-limit/feedback-limit", () => ({
  checkFeedbackRateLimit: async () => ({
    allowed: mocks.rateLimitAllowed,
    reset_seconds: 60,
  }),
}));

import { POST } from "@/app/api/feedback/route";

const SECRET = "test-rag-webhook-secret";

const ORIG = {
  RAG_WEBHOOK_SECRET: process.env.RAG_WEBHOOK_SECRET,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

beforeEach(() => {
  process.env.RAG_WEBHOOK_SECRET = SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://test-supabase.local";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  mocks.insertResult = { data: [{ id: "ev-1" }], error: null };
  mocks.rateLimitAllowed = true;
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

// `crypto.subtle` is required by the route's hmacHex helper. Node 20+
// exposes it as a global; vitest may need a small shim in older runtimes,
// but our pnpm engines pin to Node 24.

// Web Crypto produces hex via `crypto.subtle.sign` — the helper inside
// the route uses that. We replicate the same algorithm using node:crypto
// here to build correct test signatures.
function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeBody(): string {
  return JSON.stringify({
    message_id: "11111111-1111-1111-1111-111111111111",
    signal_direction: "up",
    raw_weight: 1,
    chunk_ids: ["22222222-2222-2222-2222-222222222222"],
  });
}

function makeReq(opts: { signature?: string | null; body?: string } = {}): Request {
  const body = opts.body ?? makeBody();
  const signature = opts.signature === null ? null : opts.signature ?? sign(body);
  const headers: HeadersInit = signature ? { "x-webhook-signature": signature } : {};
  return new Request("https://rag.example/api/feedback", {
    method: "POST",
    headers,
    body,
  });
}

describe("RAG feedback webhook — Pattern 2 (config + signature fail-closed)", () => {
  it("returns 500 when RAG_WEBHOOK_SECRET is missing", async () => {
    delete process.env.RAG_WEBHOOK_SECRET;
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("rag_webhook_secret_not_configured");
  });

  it("returns 401 when the signature header is missing", async () => {
    const res = await POST(makeReq({ signature: null }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the signature does not match HMAC", async () => {
    const res = await POST(makeReq({ signature: "deadbeef" }));
    expect(res.status).toBe(401);
  });

  it("returns 500 when Supabase env is unset (fail-closed on missing infra)", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("supabase_env_not_set");
  });

  it("returns 429 when the rate-limit is hit", async () => {
    mocks.rateLimitAllowed = false;
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
  });
});

describe("RAG feedback webhook — Pattern 1 (DB insert error)", () => {
  it("returns 500 + the error message when the bulk insert fails", async () => {
    mocks.insertResult = { data: null, error: { message: "synthetic db failure" } };
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("synthetic db failure");
  });
});

describe("RAG feedback webhook — body validation", () => {
  it("returns 400 when the body fails zod validation", async () => {
    const res = await POST(makeReq({ body: JSON.stringify({ bogus: true }) }));
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("invalid_body");
  });

  it("returns ok on happy path with valid signature + body", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; inserted_count: number };
    expect(json.ok).toBe(true);
    expect(json.inserted_count).toBe(1);
  });
});
