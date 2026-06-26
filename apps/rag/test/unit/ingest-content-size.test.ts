// 500KB content-size guard on /api/ingest/reference and /api/ingest/itinerary (#1439).
//
// WHY: .max(500_000) on the schema text field catches new submissions at parse
// time (→ 400), but the explicit guard after parsing returns a structured 422
// with machine-readable metadata and must fire BEFORE any embedWithUsage call.
// These tests encode that the guard fires first, independently of any DB path.

import { beforeEach, describe, expect, it, vi } from "vitest";

const OVERSIZED = "x".repeat(500_001);

// ── Shared auth mock ─────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  ctx: {
    scope: "write" as "read" | "write",
    service_identifier: "platform-admin" as string,
    tenant_id: null as string | null,
    user_id: null as string | null,
  },
  embedFn: vi.fn(),
}));

vi.mock("@/lib/auth/with-service-auth", () => ({
  withServiceAuth:
    (handler: (req: Request, ctx: typeof mocks.ctx) => Promise<Response>) =>
    (req: Request) =>
      handler(req, mocks.ctx),
}));

// ── Shared DB mock (no DB calls should be made for the size guard path) ──────

// Build a chainable query builder where every terminal method resolves to no-rows.
interface EqChain {
  maybeSingle: () => Promise<{ data: null; error: null }>;
  single: () => Promise<{ data: null; error: null }>;
  eq: () => EqChain;
}

function makeEqChain(): EqChain {
  const terminal: EqChain = {
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    eq: () => terminal,
  };
  return terminal;
}

vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => ({
    from: () => ({
      select: () => ({
        eq: () => makeEqChain(),
        in: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
      }),
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "new-id" }, error: null }) }) }),
      update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }) }) }),
      upsert: () => ({ select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }) }),
    }),
  }),
}));

vi.mock("@/lib/embeddings/openai", () => ({ embedWithUsage: mocks.embedFn }));
vi.mock("@/lib/embeddings/batch/enqueue", () => ({ enqueueEmbedding: vi.fn() }));
vi.mock("@/lib/embeddings/feature-flag", () => ({ isEmbeddingBatchEnabled: () => false }));
vi.mock("@/lib/embeddings/cost-log", () => ({ logEmbeddingCall: vi.fn() }));
vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: async <T>(p: Promise<T>) => p,
}));

// ── /api/ingest/reference ────────────────────────────────────────────────────

const BASE_REF = {
  source_identifier: "cruisemapper:ship:symphony-of-the-seas",
  category: "ship_intel",
  text: "Normal sized content for Symphony of the Seas.",
  source_url: "https://www.cruisemapper.com/ships/symphony",
  source_domain: "cruisemapper.com",
  ship: "Symphony of the Seas",
};

function refReq(body: unknown): Request {
  return new Request("https://rag.test/api/ingest/reference", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/ingest/reference — 500KB content guard (#1439)", () => {
  beforeEach(() => {
    mocks.embedFn.mockReset();
    mocks.ctx.service_identifier = "platform-admin";
    mocks.ctx.scope = "write";
  });

  it("returns 422 content_too_large and blocks embedWithUsage when text exceeds 500KB", async () => {
    // WHY: an oversized payload must be rejected with actionable metadata before
    // incurring any OpenAI embedding cost.
    const { POST } = await import("@/app/api/ingest/reference/route");
    const res = await (POST as (r: Request) => Promise<Response>)(
      refReq({ ...BASE_REF, text: OVERSIZED }),
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string; max_bytes: number; actual_bytes: number };
    expect(json.error).toBe("content_too_large");
    expect(json.max_bytes).toBe(500_000);
    expect(json.actual_bytes).toBe(500_001);
    expect(mocks.embedFn).not.toHaveBeenCalled();
  });

  it("allows content exactly at the 500KB boundary", async () => {
    // WHY: the boundary is inclusive — exactly 500_000 bytes must pass.
    mocks.embedFn.mockResolvedValue({
      embedding: new Array(1536).fill(0.01),
      prompt_tokens: 100,
      model: "text-embedding-3-small",
    });
    const { POST } = await import("@/app/api/ingest/reference/route");
    const res = await (POST as (r: Request) => Promise<Response>)(
      refReq({ ...BASE_REF, text: "x".repeat(500_000) }),
    );
    expect(res.status).not.toBe(422);
  });
});

// ── /api/ingest/itinerary ────────────────────────────────────────────────────

const BASE_ITIN = {
  cruise_line: "RCL",
  ship: "Symphony of the Seas",
  departure_date: "2026-08-15",
  departure_port: "Miami",
  duration_nights: 7,
  ports_of_call: ["Cozumel", "Roatán"],
  text: "Normal sized itinerary content.",
};

function itinReq(body: unknown): Request {
  return new Request("https://rag.test/api/ingest/itinerary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/ingest/itinerary — 500KB content guard (#1439)", () => {
  beforeEach(() => {
    mocks.embedFn.mockReset();
    mocks.ctx.service_identifier = "platform-admin";
    mocks.ctx.scope = "write";
  });

  it("returns 422 content_too_large and blocks embedWithUsage when text exceeds 500KB", async () => {
    // WHY: the guard must fire before the embedding call to avoid paying OpenAI
    // for content we will reject.
    const { POST } = await import("@/app/api/ingest/itinerary/route");
    const res = await (POST as (r: Request) => Promise<Response>)(
      itinReq({ ...BASE_ITIN, text: OVERSIZED }),
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string; max_bytes: number; actual_bytes: number };
    expect(json.error).toBe("content_too_large");
    expect(json.max_bytes).toBe(500_000);
    expect(json.actual_bytes).toBe(500_001);
    expect(mocks.embedFn).not.toHaveBeenCalled();
  });

  it("allows content exactly at the 500KB boundary", async () => {
    // WHY: the boundary is inclusive — exactly 500_000 bytes must pass.
    mocks.embedFn.mockResolvedValue({
      embedding: new Array(1536).fill(0.01),
      prompt_tokens: 100,
      model: "text-embedding-3-small",
    });
    const { POST } = await import("@/app/api/ingest/itinerary/route");
    const res = await (POST as (r: Request) => Promise<Response>)(
      itinReq({ ...BASE_ITIN, text: "x".repeat(500_000) }),
    );
    expect(res.status).not.toBe(422);
  });
});
