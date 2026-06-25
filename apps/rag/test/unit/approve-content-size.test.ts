// 500KB content-size guard on RAG-side approve routes (#1388 gap).
//
// WHY: IngestRequestSchema.raw_content.max(500_000) was added to prevent new
// oversized ingestions, and the main-app approve route got a backward-compat
// guard for pre-cap rows already in the DB. The two RAG-side approve routes
// (/api/approve/tenant and /api/approve/global) had the same gap: a pre-cap
// row with raw_content > 500KB would reach embedWithUsage() and fail opaquely,
// leaving the queue item permanently stuck. This test encodes that the guard
// fires BEFORE any embedding call, with a meaningful 422 + metadata.

import { beforeEach, describe, expect, it, vi } from "vitest";

const QUEUE_ID = "00000000-0000-0000-0000-000000000001";
const OVERSIZED = "x".repeat(500_001);

const mocks = vi.hoisted(() => ({
  ctx: {
    scope: "write" as "read" | "write",
    service_identifier: "tenant" as string,
    tenant_id: "t-1" as string | null,
    user_id: null as string | null,
  },
  rawContent: "normal",
  embedFn: vi.fn(),
}));

vi.mock("@/lib/auth/with-service-auth", () => ({
  withServiceAuth:
    (handler: (req: Request, ctx: typeof mocks.ctx) => Promise<Response>) =>
    (req: Request) =>
      handler(req, mocks.ctx),
}));

vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: {
                id: QUEUE_ID,
                raw_content: mocks.rawContent,
                raw_metadata: {},
                processing_stage: "pending_review",
                submitted_by_tenant_id: "t-1",
              },
              error: null,
            }),
        }),
      }),
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

function req(): Request {
  return new Request("http://rag.test/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queue_item_id: QUEUE_ID }),
  });
}

beforeEach(() => {
  mocks.rawContent = "normal";
  mocks.embedFn.mockReset();
});

// ── tenant approve ───────────────────────────────────────────────────────────

describe("approve/tenant — 500KB content guard (#1388 gap)", () => {
  beforeEach(() => {
    mocks.ctx.service_identifier = "tenant";
    mocks.ctx.tenant_id = "t-1";
  });

  it("returns 422 content_too_large when DB row exceeds 500KB and blocks the embedding call", async () => {
    // WHY: a pre-cap row stuck in the queue would silently fail at the
    // embedding layer and be unrecoverable through the UI without this guard.
    mocks.rawContent = OVERSIZED;
    const { POST } = await import("@/app/api/approve/tenant/route");
    const res = await (POST as (r: Request) => Promise<Response>)(req());
    expect(res.status).toBe(422);
    const json = await res.json() as { error: string; max_bytes: number; actual_bytes: number };
    expect(json.error).toBe("content_too_large");
    expect(json.max_bytes).toBe(500_000);
    expect(json.actual_bytes).toBe(500_001);
    expect(mocks.embedFn).not.toHaveBeenCalled();
  });
});

// ── global approve ───────────────────────────────────────────────────────────

describe("approve/global — 500KB content guard (#1388 gap)", () => {
  beforeEach(() => {
    mocks.ctx.service_identifier = "platform-admin";
    mocks.ctx.tenant_id = null;
  });

  it("returns 422 content_too_large when DB row exceeds 500KB and blocks the embedding call", async () => {
    mocks.rawContent = OVERSIZED;
    const { POST } = await import("@/app/api/approve/global/route");
    const res = await (POST as (r: Request) => Promise<Response>)(req());
    expect(res.status).toBe(422);
    const json = await res.json() as { error: string; max_bytes: number; actual_bytes: number };
    expect(json.error).toBe("content_too_large");
    expect(json.max_bytes).toBe(500_000);
    expect(json.actual_bytes).toBe(500_001);
    expect(mocks.embedFn).not.toHaveBeenCalled();
  });
});
