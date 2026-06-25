// #394 / D-091 — post-termination review actions need a row-count assert.
//
// Each of the three branches (hard_delete / demote / retain) guards
// .eq("post_termination_review_status","pending") — a CAS-style filter.
// supabase-js returns { error: null } whether one row matched or zero did, so
// without the .select("id") + count check the admin UI got { ok: true } for a
// no-op (chunk already reviewed, or wrong id). These tests pin that a zero-row
// match now surfaces 404 instead of a silent false success.

import { beforeEach, describe, expect, it, vi } from "vitest";

let currentCtx: {
  scope: string;
  service_identifier: string;
  user_id: string | null;
  tenant_id: string | null;
} = { scope: "write", service_identifier: "platform-admin", user_id: null, tenant_id: null };

vi.mock("@/lib/auth/with-service-auth", () => ({
  withServiceAuth: (handler: (req: Request, ctx: typeof currentCtx) => Promise<Response>) => {
    return (req: Request) => handler(req, currentCtx);
  },
}));

type ReviewResult = { data: { id: string }[] | null; error: { message: string } | null };
type Chain = {
  delete: () => Chain;
  update: () => Chain;
  eq: () => Chain;
  select: () => Promise<ReviewResult>;
};

let reviewResult: ReviewResult = { data: [{ id: "c-1" }], error: null };

vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => ({
    from(): Chain {
      const chain: Chain = {
        delete: () => chain,
        update: () => chain,
        eq: () => chain,
        select: () => Promise.resolve(reviewResult),
      };
      return chain;
    },
  }),
}));

import { POST } from "@/app/api/admin/post-termination-review/route";

function callPost(body: unknown): Promise<Response> {
  return POST(
    new Request("http://rag.test/api/admin/post-termination-review", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

beforeEach(() => {
  currentCtx = { scope: "write", service_identifier: "platform-admin", user_id: null, tenant_id: null };
  reviewResult = { data: [{ id: "c-1" }], error: null };
});

describe("post-termination-review — row-count assert (#394)", () => {
  it("rejects a non-platform-admin caller with 403", async () => {
    currentCtx.service_identifier = "chat-service";
    const res = await callPost({ chunk_id: "c-1", action: "retain" });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid action with 400", async () => {
    const res = await callPost({ chunk_id: "c-1", action: "frobnicate" });
    expect(res.status).toBe(400);
  });

  it("hard_delete: 404 when zero rows matched (chunk already reviewed / wrong id)", async () => {
    reviewResult = { data: [], error: null };
    const res = await callPost({ chunk_id: "c-1", action: "hard_delete" });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "chunk_not_found_or_not_pending" });
  });

  it("demote: 404 when zero rows matched", async () => {
    reviewResult = { data: [], error: null };
    const res = await callPost({ chunk_id: "c-1", action: "demote" });
    expect(res.status).toBe(404);
  });

  it("retain: 404 when zero rows matched", async () => {
    reviewResult = { data: [], error: null };
    const res = await callPost({ chunk_id: "c-1", action: "retain" });
    expect(res.status).toBe(404);
  });

  it("retain: 200 ok when exactly one pending row matched (happy path)", async () => {
    reviewResult = { data: [{ id: "c-1" }], error: null };
    const res = await callPost({ chunk_id: "c-1", action: "retain" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, action: "retain", chunk_id: "c-1" });
  });

  it("propagates a real DB error as 500 (not conflated with a no-op)", async () => {
    reviewResult = { data: null, error: { message: "connection reset" } };
    const res = await callPost({ chunk_id: "c-1", action: "demote" });
    expect(res.status).toBe(500);
    // Must NOT echo the raw DB error message to clients (CWE-209 / #1395).
    const json = await res.json() as { error: string; ref: string };
    expect(json.error).toBe("db_error");
    expect(json.ref).toMatch(/^[0-9a-f-]{36}$/);
  });
});
