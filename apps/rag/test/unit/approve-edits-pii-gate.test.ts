// #2001 — approve-with-edits bypassed the zero-tolerance PII gate.
//
// WHY: ingest quarantines PII-bearing content before it ever reaches
// pending_review, but a reviewer can substitute brand-new edits.content on
// approval. Without re-running detectZeroTolerancePII on the resolved
// content, a reviewer could launder PII/PHI into an approved chunk — through
// approve/global, into a chunk every tenant can read. This test fails if the
// gate is ever removed: it asserts a 422 and that neither the embedding nor
// the chunk insert happens once PII is detected in edits.content.

import { beforeEach, describe, expect, it, vi } from "vitest";

const QUEUE_ID = "00000000-0000-0000-0000-000000000001";
const SSN_CONTENT = "Client SSN is 123-45-6789, please file it.";

const mocks = vi.hoisted(() => ({
  ctx: {
    scope: "write" as "read" | "write",
    service_identifier: "tenant" as string,
    tenant_id: "t-1" as string | null,
    user_id: null as string | null,
  },
  embedFn: vi.fn(),
  insertFn: vi.fn(),
}));

vi.mock("@/lib/auth/with-service-auth", () => ({
  withServiceAuth:
    (handler: (req: Request, ctx: typeof mocks.ctx) => Promise<Response>) =>
    (req: Request) =>
      handler(req, mocks.ctx),
}));

vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => ({
    from: (table: string) => {
      if (table === "knowledge_chunks") {
        return {
          insert: (fields: unknown) => {
            mocks.insertFn(fields);
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id: "chunk-1" }, error: null }),
              }),
            };
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: {
                  id: QUEUE_ID,
                  raw_content: "clean content, no PII here",
                  raw_metadata: {},
                  processing_stage: "pending_review",
                  submitted_by_tenant_id: "t-1",
                },
                error: null,
              }),
          }),
        }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
  }),
}));

vi.mock("@/lib/embeddings/openai", () => ({ embedWithUsage: mocks.embedFn }));
vi.mock("@/lib/embeddings/batch/enqueue", () => ({ enqueueEmbedding: vi.fn() }));
vi.mock("@/lib/embeddings/feature-flag", () => ({ isEmbeddingBatchEnabled: () => false }));
vi.mock("@/lib/embeddings/cost-log", () => ({ logEmbeddingCall: vi.fn() }));
vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: async <T>(p: Promise<T>) => p,
}));

function req(content: string): Request {
  return new Request("http://rag.test/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queue_item_id: QUEUE_ID, edits: { content } }),
  });
}

beforeEach(() => {
  mocks.embedFn.mockReset();
  mocks.insertFn.mockReset();
  mocks.embedFn.mockResolvedValue({ embedding: [0.1], prompt_tokens: 1, model: "test" });
});

describe("approve/tenant — edits.content re-screened for zero-tolerance PII (#2001)", () => {
  beforeEach(() => {
    mocks.ctx.service_identifier = "tenant";
    mocks.ctx.tenant_id = "t-1";
  });

  it("rejects an SSN laundered in via edits.content, before embedding or inserting", async () => {
    const { POST } = await import("@/app/api/approve/tenant/route");
    const res = await (POST as (r: Request) => Promise<Response>)(req(SSN_CONTENT));
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string; categories: string[] };
    expect(json.error).toBe("zero_tolerance_pii_in_edits");
    expect(json.categories).toContain("ssn");
    expect(mocks.embedFn).not.toHaveBeenCalled();
    expect(mocks.insertFn).not.toHaveBeenCalled();
  });

  it("still approves clean edited content", async () => {
    const { POST } = await import("@/app/api/approve/tenant/route");
    const res = await (POST as (r: Request) => Promise<Response>)(req("Clean edited content, nothing sensitive."));
    expect(res.status).toBe(200);
    expect(mocks.insertFn).toHaveBeenCalledTimes(1);
  });
});

describe("approve/global — edits.content re-screened for zero-tolerance PII (#2001)", () => {
  beforeEach(() => {
    mocks.ctx.service_identifier = "platform-admin";
    mocks.ctx.tenant_id = null;
  });

  it("rejects an SSN laundered in via edits.content before it can reach every tenant", async () => {
    const { POST } = await import("@/app/api/approve/global/route");
    const res = await (POST as (r: Request) => Promise<Response>)(req(SSN_CONTENT));
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string; categories: string[] };
    expect(json.error).toBe("zero_tolerance_pii_in_edits");
    expect(json.categories).toContain("ssn");
    expect(mocks.embedFn).not.toHaveBeenCalled();
    expect(mocks.insertFn).not.toHaveBeenCalled();
  });

  it("still approves clean edited content", async () => {
    const { POST } = await import("@/app/api/approve/global/route");
    const res = await (POST as (r: Request) => Promise<Response>)(req("Clean edited content, nothing sensitive."));
    expect(res.status).toBe(200);
    expect(mocks.insertFn).toHaveBeenCalledTimes(1);
  });
});
