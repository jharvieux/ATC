// Unit tests for apps/main/src/app/api/webhooks/gmailpubsub/route.ts
//
// D-091 security-critical paths: bearer JWT verification, envelope parsing,
// tenant lookup, and credential dispatch. Each test targets a specific branch
// that a mutant could flip silently (e.g. removing the JWT check, accepting
// missing payload fields, ignoring DB errors).

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────────────

// jose — mock jwtVerify so tests don't make HTTPS calls to Google
const mockJwtVerify = vi.fn();
vi.mock("jose", () => ({
  createRemoteJWKSet: () => "mock_jwks_set",
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}));

let mockMaybeSingleResult: { data: unknown; error: { message: string } | null } = {
  data: {
    tenant_id: "tenant-1",
    encrypted_refresh_token: "enc_token",
    encryption_key_version: "v1",
    pubsub_history_id: "10000",
    health_status: "connected",
  },
  error: null,
};
const mockSafeAwaitLabels: string[] = [];
vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: async (q: Promise<unknown>, label: string) => {
    void q;
    mockSafeAwaitLabels.push(label);
    return { data: null, error: null };
  },
}));

vi.mock("@/lib/api/db-error-response", () => ({
  dbErrorResponse: (_err: unknown) => Response.json({ error: "db_error" }, { status: 500 }),
}));

let mockDecryptResult: { ok: true; value: string } | { ok: false; error: { code: string } } = {
  ok: true,
  value: "refresh_token_plaintext",
};
vi.mock("@/lib/crypto/credential-cipher", () => ({
  decryptCredential: (_args: unknown) => {
    void _args;
    return mockDecryptResult;
  },
}));

const mockProcessGmailMessage = vi.fn();
vi.mock("@/lib/import/process-gmail-message", () => ({
  processGmailInboundMessage: (...args: unknown[]) => mockProcessGmailMessage(...args),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(mockMaybeSingleResult),
        }),
      }),
      update: () => ({
        eq: () => Promise.resolve({ data: null, error: null }),
      }),
      upsert: () => Promise.resolve({ data: null, error: null }),
    }),
  }),
}));

// fetch — controls OAuth token endpoint and Gmail API responses
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { POST } from "@/app/api/webhooks/gmailpubsub/route";

// ── helpers ────────────────────────────────────────────────────────────────

function makeEnvelope(emailAddress: string, historyId: string): string {
  const data = Buffer.from(JSON.stringify({ emailAddress, historyId })).toString("base64");
  return JSON.stringify({ message: { data } });
}

function makeReq(body: string, overrideHeaders?: Record<string, string>): Request {
  return new Request("https://example.com/api/webhooks/gmailpubsub", {
    method: "POST",
    headers: {
      authorization: "Bearer fake.jwt.token",
      "content-type": "application/json",
      ...overrideHeaders,
    },
    body,
  });
}

function setupHappyPathFetch(): void {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: "goog_access_token" }),
      });
    }
    if (String(url).includes("/history")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ history: [] }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  process.env.GMAIL_PUBSUB_AUDIENCE = "https://example.com/api/webhooks/gmailpubsub";
  process.env.GMAIL_OAUTH_CLIENT_ID = "client-id";
  process.env.GMAIL_OAUTH_CLIENT_SECRET = "client-secret";
  mockJwtVerify.mockResolvedValue({ payload: {} });
  mockMaybeSingleResult = {
    data: {
      tenant_id: "tenant-1",
      encrypted_refresh_token: "enc_token",
      encryption_key_version: "v1",
      pubsub_history_id: "10000",
      health_status: "connected",
    },
    error: null,
  };
  mockDecryptResult = { ok: true, value: "refresh_token_plaintext" };
  mockProcessGmailMessage.mockResolvedValue({ qualified: false, reason: "no_trigger_word" });
  mockSafeAwaitLabels.length = 0;
  mockFetch.mockReset();
  setupHappyPathFetch();
});

// ── auth layer ─────────────────────────────────────────────────────────────

describe("Gmail Pub/Sub webhook — auth layer", () => {
  it("returns 401 when Authorization header is absent (missing bearer)", async () => {
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20000"), { authorization: "" }));
    expect(res.status).toBe(401);
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header has no 'Bearer ' prefix", async () => {
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20000"), { authorization: "Token abc" }));
    expect(res.status).toBe(401);
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  it("returns 500 when GMAIL_PUBSUB_AUDIENCE is not set (server misconfiguration)", async () => {
    delete process.env.GMAIL_PUBSUB_AUDIENCE;
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20000")));
    expect(res.status).toBe(500);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe("server_misconfig");
    // Must NOT proceed past auth — no JWT verification attempt
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  it("returns 401 when jwtVerify throws (invalid / forged JWT)", async () => {
    mockJwtVerify.mockRejectedValue(new Error("signature verification failed"));
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20000")));
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe("jwt_verification_failed");
    // Must NOT proceed to DB layer — JWT is the gatekeeper
    expect(mockSafeAwaitLabels).toHaveLength(0);
  });

  it("passes through when jwtVerify resolves (valid Google-signed JWT)", async () => {
    mockJwtVerify.mockResolvedValue({ payload: { email: "pubsub@gmail.com" } });
    setupHappyPathFetch();
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20000")));
    expect(res.status).toBe(200);
  });
});

// ── envelope parsing ───────────────────────────────────────────────────────

describe("Gmail Pub/Sub webhook — envelope parsing", () => {
  it("returns 400 when message.data is missing from the envelope", async () => {
    const body = JSON.stringify({ message: {} });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(400);
    const j = await res.json() as { error?: string };
    expect(j.error).toBe("missing_message_data");
  });

  it("returns 400 when message.data decodes to non-JSON", async () => {
    const badData = Buffer.from("not json at all").toString("base64");
    const body = JSON.stringify({ message: { data: badData } });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(400);
    const j = await res.json() as { error?: string };
    expect(j.error).toBe("invalid_data_payload");
  });

  it("returns 400 when emailAddress is missing from decoded payload", async () => {
    const data = Buffer.from(JSON.stringify({ historyId: "20000" })).toString("base64");
    const body = JSON.stringify({ message: { data } });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(400);
    const j = await res.json() as { error?: string };
    expect(j.error).toBe("missing_payload_fields");
  });

  it("returns 400 when historyId is missing from decoded payload", async () => {
    const data = Buffer.from(JSON.stringify({ emailAddress: "a@b.com" })).toString("base64");
    const body = JSON.stringify({ message: { data } });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(400);
    const j = await res.json() as { error?: string };
    expect(j.error).toBe("missing_payload_fields");
  });
});

// ── tenant lookup ──────────────────────────────────────────────────────────

describe("Gmail Pub/Sub webhook — tenant lookup", () => {
  it("returns 200 (skipped) when address is unknown — Pub/Sub must be acked to stop retries", async () => {
    // Critical: returning 4xx would cause Pub/Sub to retry indefinitely.
    mockMaybeSingleResult = { data: null, error: null };
    const res = await POST(makeReq(makeEnvelope("unknown@example.com", "20000")));
    expect(res.status).toBe(200);
    const j = await res.json() as { skipped?: string };
    expect(j.skipped).toBe("unknown_address");
  });

  it("returns 200 (skipped) when health_status is not 'connected'", async () => {
    mockMaybeSingleResult = {
      data: {
        tenant_id: "tenant-1",
        encrypted_refresh_token: "enc_token",
        encryption_key_version: "v1",
        pubsub_history_id: "10000",
        health_status: "token_expired",
      },
      error: null,
    };
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20000")));
    expect(res.status).toBe(200);
    const j = await res.json() as { skipped?: string };
    expect(j.skipped).toBe("not_connected");
  });

  it("returns 200 (skipped) when encrypted_refresh_token is null", async () => {
    mockMaybeSingleResult = {
      data: {
        tenant_id: "tenant-1",
        encrypted_refresh_token: null,
        encryption_key_version: null,
        pubsub_history_id: "10000",
        health_status: "connected",
      },
      error: null,
    };
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20000")));
    expect(res.status).toBe(200);
    const j = await res.json() as { skipped?: string };
    expect(j.skipped).toBe("no_refresh_token");
  });
});

// ── credential + downstream ────────────────────────────────────────────────

describe("Gmail Pub/Sub webhook — credential and downstream failures", () => {
  it("returns 500 when refresh token decryption fails — marks health and stops", async () => {
    mockDecryptResult = { ok: false, error: { code: "BAD_CIPHERTEXT" } };
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20000")));
    expect(res.status).toBe(500);
    const j = await res.json() as { error?: string };
    expect(j.error).toBe("refresh_token_decrypt_failed");
    // health marker must be written
    expect(mockSafeAwaitLabels).toContain("gmail_oauth_tokens.update");
  });

  it("returns 502 when OAuth token refresh fails — marks health", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return Promise.resolve({ ok: false, text: () => Promise.resolve("error") });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20000")));
    expect(res.status).toBe(502);
    const j = await res.json() as { error?: string };
    expect(j.error).toBe("oauth_refresh_failed");
    expect(mockSafeAwaitLabels).toContain("gmail_oauth_tokens.update");
  });

  it("returns 502 when Gmail history.list fails", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: "goog_access_token" }),
        });
      }
      // history endpoint fails
      return Promise.resolve({ ok: false });
    });
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20000")));
    expect(res.status).toBe(502);
    const j = await res.json() as { error?: string };
    expect(j.error).toBe("history_fetch_failed");
  });
});

// ── happy path + history pointer ──────────────────────────────────────────

describe("Gmail Pub/Sub webhook — happy path", () => {
  it("returns 200 with processed count when history is empty (no new messages)", async () => {
    const res = await POST(makeReq(makeEnvelope("a@b.com", "20001")));
    expect(res.status).toBe(200);
    const j = await res.json() as { processed?: number };
    expect(j.processed).toBe(0);
    // History pointer must be updated even when there are no new messages
    expect(mockSafeAwaitLabels).toContain("gmail_oauth_tokens.update");
  });

  it("dispatches processGmailInboundMessage for each new message and updates history pointer", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: "goog_access_token" }),
        });
      }
      if (String(url).includes("/history")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              history: [{ messagesAdded: [{ message: { id: "msg-abc" } }] }],
            }),
        });
      }
      if (String(url).includes("/messages/msg-abc")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "msg-abc",
              threadId: "thread-1",
              internalDate: "1700000000000",
              payload: { headers: [], mimeType: "text/plain", body: { data: "" } },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const res = await POST(makeReq(makeEnvelope("a@b.com", "20001")));
    expect(res.status).toBe(200);
    const j = await res.json() as { processed?: number; results?: unknown[] };
    expect(j.processed).toBe(1);
    expect(mockProcessGmailMessage).toHaveBeenCalledOnce();
    expect(mockProcessGmailMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: "msg-abc", tenant_id: "tenant-1" }),
    );
    expect(mockSafeAwaitLabels).toContain("gmail_inbound_messages.upsert");
    expect(mockSafeAwaitLabels).toContain("gmail_oauth_tokens.update");
  });
});
