// #394 / D-091 — replace-chunk needs a row-count assert on the update.
//
// Existence is checked up front (404 if the chunk is gone), but the in-place
// .update(...).eq("id", chunk_id) that follows still returned { error: null }
// on a zero-row match — so a chunk hard-deleted between the read and the write
// (TOCTOU) produced a false { ok: true }. These tests pin that the zero-row
// case now surfaces 404.

import { beforeEach, describe, expect, it, vi } from "vitest";

let currentCtx: {
  scope: string;
  service_identifier: string;
  user_id: string | null;
  tenant_id: string | null;
} = { scope: "write", service_identifier: "platform-admin", user_id: null, tenant_id: "t-1" };

vi.mock("@/lib/auth/with-service-auth", () => ({
  withServiceAuth: (handler: (req: Request, ctx: typeof currentCtx) => Promise<Response>) => {
    return (req: Request) => handler(req, currentCtx);
  },
}));

type CasResult = { data: { id: string }[] | null; error: { message: string } | null };
let existing: { id: string; scope: string; tenant_id: string | null } | null = {
  id: "c-1",
  scope: "tenant",
  tenant_id: "t-1",
};
let casResult: CasResult = { data: [{ id: "c-1" }], error: null };

vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => ({
    from: () => ({
      select: () => {
        const readChain = {
          eq: () => readChain,
          maybeSingle: () => Promise.resolve({ data: existing, error: null }),
        };
        return readChain;
      },
      update: () => {
        const updateChain = {
          eq: () => updateChain,
          select: () => Promise.resolve(casResult),
        };
        return updateChain;
      },
    }),
  }),
}));

vi.mock("@/lib/embeddings/openai", () => ({
  embed: async () => [0.1, 0.2, 0.3],
}));

vi.mock("@/lib/pii/regex-prefilter", () => ({
  detectZeroTolerancePII: () => ({ detected: false, categories: [] }),
}));

import { POST } from "@/app/api/admin/replace-chunk/route";

function callReplace(body: unknown): Promise<Response> {
  return POST(
    new Request("http://rag.test/api/admin/replace-chunk", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

beforeEach(() => {
  currentCtx = { scope: "write", service_identifier: "platform-admin", user_id: null, tenant_id: "t-1" };
  existing = { id: "c-1", scope: "tenant", tenant_id: "t-1" };
  casResult = { data: [{ id: "c-1" }], error: null };
});

describe("replace-chunk — row-count assert (#394)", () => {
  it("returns 404 when the update matches zero rows (chunk deleted after the existence read)", async () => {
    casResult = { data: [], error: null };
    const res = await callReplace({ chunk_id: "c-1", content: "new content" });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "chunk_not_found" });
  });

  it("returns 200 ok when exactly one row was updated (happy path)", async () => {
    casResult = { data: [{ id: "c-1" }], error: null };
    const res = await callReplace({ chunk_id: "c-1", content: "new content" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, chunk_id: "c-1" });
  });

  it("returns 404 up front when the chunk does not exist at all", async () => {
    existing = null;
    const res = await callReplace({ chunk_id: "missing", content: "new content" });
    expect(res.status).toBe(404);
  });
});
