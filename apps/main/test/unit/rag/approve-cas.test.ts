// #394 / D-091 — approve must CAS on review_status, not just .eq("id").
//
// The review_status check at the top is a snapshot read; the two RAG fetches
// (ingest + approve) are a wide TOCTOU window. Two reviewers racing both pass
// that check and both create a chunk. The final rag_submissions update used to
// guard only .eq("id", id), so both wrote 'approved' + double-counted. It now
// chains .eq("review_status","ready_for_review").select("id") so the loser gets
// a 409 instead of a false success. (The loser's chunk is still created upstream
// — documented residual; this guards the duplicate submission write + count.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type CasResult = { data: { id: string }[] | null; error: { message: string } | null };

const mocks = vi.hoisted(() => ({
  read: {
    id: "sub-1",
    tenant_id: "t-1",
    review_status: "ready_for_review",
    redacted_content: "verified cruise content",
    extracted_content: null,
    source_url: null,
    normalization_result: {},
    content_hash: "h",
  } as Record<string, unknown>,
  cas: { data: [{ id: "sub-1" }], error: null } as CasResult,
  fetch: vi.fn(),
  haikuPiiRedact: vi.fn().mockImplementation(async (content: string) => ({ status: "clean" as const, content })),
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({ ctx: { tenant_id: "t-1" }, user: { id: "u-1" } })),
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: vi.fn(() => ({
    from: () => ({
      select: () => {
        const readChain = {
          eq: () => readChain,
          maybeSingle: () => Promise.resolve({ data: mocks.read, error: null }),
        };
        return readChain;
      },
      update: () => {
        const updateChain = {
          eq: () => updateChain,
          select: () => Promise.resolve(mocks.cas),
        };
        return updateChain;
      },
    }),
  })),
}));

vi.mock("@/lib/abuse/snapshot", () => ({
  loadTenantSnapshot: async () => ({
    tenant: { id: "t-1", tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
  }),
  // call-wrapper (imported by haikuPiiRedact) re-exports this from snapshot.
  PLATFORM_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  _resetSnapshotCacheForTests: () => {},
  evictTenantSnapshot: () => {},
}));

vi.mock("@/lib/rag-ingest/haiku-pii-redact", () => ({
  haikuPiiRedact: mocks.haikuPiiRedact,
}));

vi.mock("@/lib/abuse/counters", () => ({
  adjustRagChunkCount: async () => undefined,
}));

vi.mock("@/lib/rag-auth/sign-service-jwt", () => ({
  signServiceJwt: async () => "jwt-token",
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: (e: unknown) => Response.json({ error: String(e) }, { status: 401 }),
}));

const ORIG_URL = process.env.RAG_SERVICE_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RAG_SERVICE_URL = "https://rag.test";
  mocks.read = {
    id: "sub-1",
    tenant_id: "t-1",
    review_status: "ready_for_review",
    redacted_content: "verified cruise content",
    extracted_content: null,
    source_url: null,
    normalization_result: {},
    content_hash: "h",
  };
  mocks.cas = { data: [{ id: "sub-1" }], error: null };
  // ingest → queue_item_id; approve → chunk_id. Both 200.
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/ingest")) {
      return { ok: true, json: async () => ({ queue_item_id: "q-1" }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({ chunk_id: "chunk-1" }) } as unknown as Response;
  });
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIG_URL === undefined) delete process.env.RAG_SERVICE_URL;
  else process.env.RAG_SERVICE_URL = ORIG_URL;
});

async function callApprove(body: Record<string, unknown> = {}): Promise<Response> {
  const { POST } = await import("@/app/api/rag/queue/[id]/approve/route");
  return POST(
    new Request("http://test/api/rag/queue/sub-1/approve", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "sub-1" }) },
  );
}

describe("approve — review_status CAS row-count assert (#394)", () => {
  it("returns 409 already_resolved when the CAS update matches zero rows (concurrent approval won)", async () => {
    mocks.cas = { data: [], error: null };
    const res = await callApprove();
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "already_resolved" });
  });

  it("returns 200 approved when the CAS update matches exactly one row (happy path)", async () => {
    mocks.cas = { data: [{ id: "sub-1" }], error: null };
    const res = await callApprove();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ chunk_id: "chunk-1", status: "approved" });
  });

  it("returns 409 early (before any RAG call) when the submission is not ready_for_review", async () => {
    mocks.read = { ...mocks.read, review_status: "approved" };
    const res = await callApprove();
    expect(res.status).toBe(409);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns 500 when the CAS update itself errors", async () => {
    mocks.cas = { data: null, error: { message: "db boom" } };
    const res = await callApprove();
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string; ref?: string };
    expect(json.error).toBe("db_error");
    expect(json.ref).toBeTruthy();
  });

  // ── 500KB content cap (#1388) ────────────────────────────────────────────

  it("returns 422 content_too_large when DB row content exceeds 500KB (backward-compat guard for pre-cap rows)", async () => {
    // WHY: rows stored before the IngestRequestSchema.max(500_000) cap was added
    // would silently receive a 400 from the ingest endpoint and be permanently
    // unapprovable through the UI. This guard surfaces a meaningful 422 before the
    // ingest POST fires, so operators know the content must be trimmed.
    mocks.read = { ...mocks.read, redacted_content: "x".repeat(500_001), extracted_content: null };
    const res = await callApprove();
    expect(res.status).toBe(422);
    const json = await res.json() as { error: string; max_bytes: number; actual_bytes: number };
    expect(json.error).toBe("content_too_large");
    expect(json.max_bytes).toBe(500_000);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  // ── PII pipeline on reviewer edits (f012) ────────────────────────────────

  it("returns 422 pii_check_failed when Haiku redaction fails for edits.content (fail-closed)", async () => {
    // Removing the 422 branch in approve/route.ts would cause this test to
    // return 200 instead — the test fails as required.
    mocks.haikuPiiRedact.mockResolvedValueOnce({ status: "failed", reason: "haiku_error: x" });
    const res = await callApprove({ edits: { content: "some edited text" } });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: "pii_check_failed" });
  });

  it("redacts SSN from edits.content before forwarding to RAG (redactPii runs before Haiku)", async () => {
    let capturedRawContent: unknown;
    mocks.fetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if ((url as string).includes("/api/ingest")) {
        capturedRawContent = JSON.parse((opts?.body as string) ?? "{}").raw_content;
        return { ok: true, json: async () => ({ queue_item_id: "q-1" }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ chunk_id: "chunk-1" }) } as unknown as Response;
    });

    const res = await callApprove({ edits: { content: "SSN is 123-45-6789 see attached" } });
    expect(res.status).toBe(200);
    expect(capturedRawContent).not.toContain("123-45-6789");
    expect(capturedRawContent).toContain("[REDACTED_SSN]");
  });
});
