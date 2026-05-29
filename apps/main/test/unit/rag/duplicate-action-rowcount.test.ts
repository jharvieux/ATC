// #394 / D-091 — duplicate-action row-count asserts across all three modes.
//
// supabase-js returns { error: null } whether a status-guarded (or by-id)
// update matched one row or zero, so each branch answered a false success on
// a zero-row no-op:
//   cancel              → false { status: "superseded" }
//   add_with_supersedes → false { status: "supersedes_recorded" } (then sends
//                         the caller on to /approve against a vanished row)
//   replace             → false { status: "replaced" } after the RAG chunk was
//                         already swapped (submission deleted mid-flight)
// Each now chains .select("id") and asserts the affected-row count. #394 scoped
// only `cancel`; d091-reviewer flagged the other two as the same pattern in the
// same route, so they're fixed alongside it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Result = { data: { id: string }[] | null; error: { message: string } | null };

const mocks = vi.hoisted(() => ({
  write: { data: [{ id: "sub-1" }], error: null } as Result,
  readRow: {
    id: "sub-1",
    tenant_id: "t-1",
    redacted_content: "cleaned content",
    extracted_content: null,
    source_url: null,
    normalization_result: {},
  } as Record<string, unknown> | null,
  fetch: vi.fn(),
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
          maybeSingle: () => Promise.resolve({ data: mocks.readRow, error: null }),
        };
        return readChain;
      },
      update: () => {
        const writeChain = {
          eq: () => writeChain,
          select: () => Promise.resolve(mocks.write),
        };
        return writeChain;
      },
    }),
  })),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: (e: unknown) => Response.json({ error: String(e) }, { status: 401 }),
}));

vi.mock("@/lib/rag-auth/sign-service-jwt", () => ({
  signServiceJwt: async () => "jwt-token",
}));

const ORIG_URL = process.env.RAG_SERVICE_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RAG_SERVICE_URL = "https://rag.test";
  mocks.write = { data: [{ id: "sub-1" }], error: null };
  mocks.readRow = {
    id: "sub-1",
    tenant_id: "t-1",
    redacted_content: "cleaned content",
    extracted_content: null,
    source_url: null,
    normalization_result: {},
  };
  mocks.fetch.mockResolvedValue({ ok: true, text: async () => "" } as unknown as Response);
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIG_URL === undefined) delete process.env.RAG_SERVICE_URL;
  else process.env.RAG_SERVICE_URL = ORIG_URL;
});

async function call(body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/rag/queue/[id]/duplicate-action/route");
  return POST(
    new Request("http://test/api/rag/queue/sub-1/duplicate-action", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "sub-1" }) },
  );
}

describe("duplicate-action cancel — CAS row-count assert (#394)", () => {
  it("returns 409 when no row is still ready_for_review (concurrent decision won)", async () => {
    mocks.write = { data: [], error: null };
    const res = await call({ mode: "cancel" });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "not_in_reviewable_state" });
  });

  it("returns 200 { status: superseded } when exactly one row matched (happy path)", async () => {
    const res = await call({ mode: "cancel" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "superseded" });
  });

  it("returns 500 on a real DB error rather than a false success", async () => {
    mocks.write = { data: null, error: { message: "db boom" } };
    const res = await call({ mode: "cancel" });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "db boom" });
  });
});

describe("duplicate-action add_with_supersedes — row-count assert (#394)", () => {
  it("returns 404 when the submission was deleted before the supersedes write", async () => {
    mocks.write = { data: [], error: null };
    const res = await call({ mode: "add_with_supersedes", target_chunk_id: "tc-1" });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
  });

  it("returns 200 { status: supersedes_recorded } when one row matched (happy path)", async () => {
    const res = await call({ mode: "add_with_supersedes", target_chunk_id: "tc-1" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "supersedes_recorded" });
  });

  it("returns 400 when target_chunk_id is missing", async () => {
    const res = await call({ mode: "add_with_supersedes" });
    expect(res.status).toBe(400);
  });
});

describe("duplicate-action replace — row-count assert after RAG swap (#394)", () => {
  it("returns 409 when the submission vanished after the RAG chunk was replaced", async () => {
    mocks.write = { data: [], error: null };
    const res = await call({ mode: "replace", target_chunk_id: "tc-1" });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "submission_gone_after_replace" });
  });

  it("returns 200 { status: replaced } when one row matched (happy path)", async () => {
    const res = await call({ mode: "replace", target_chunk_id: "tc-1" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "replaced", target_chunk_id: "tc-1" });
  });
});
