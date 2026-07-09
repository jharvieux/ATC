// #1591 — the consent + CCPA data-request cluster had a hand-rolled auth
// prelude copied five times that drifted. These tests pin the two properties
// the normalization is FOR, so a future refactor can't silently reintroduce the
// drift:
//
//   1. Missing/invalid auth returns a consistent 401 on every route — including
//      consent/pending, which used to leak a silent 200 `{ pending: [] }`. An
//      unauthenticated caller must never receive a 200.
//   2. export-request scopes both its rate-limit read AND its insert by the
//      auth_user_id that authenticateUser() verified from the session/JWT — never
//      by a client-supplied value. That verified-identity filter is the app-layer
//      half of the isolation (the RLS `auth_user_id = auth.uid()` policy is the
//      DB-layer half); a user can only ever see or create their own export row.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: null as { authUserId: string; email: string | null } | null,
  eqCalls: [] as Array<[string, unknown]>,
  inserted: [] as unknown[],
  existingExport: [] as unknown[],
  pendingRows: [] as unknown[],
  docs: [] as unknown[],
}));

vi.mock("@/lib/auth/authenticate-user", () => ({
  authenticateUser: async () => h.authed,
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: vi.fn(async () => {}) },
}));

function resultFor(table: string, isInsert: boolean): { data: unknown; error: null } {
  if (isInsert) return { data: { id: "export-1" }, error: null };
  if (table === "user_data_export_requests") return { data: h.existingExport, error: null };
  if (table === "user_consent_pending") return { data: h.pendingRows, error: null };
  if (table === "legal_documents") return { data: h.docs, error: null };
  return { data: [], error: null };
}

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      let isInsert = false;
      const c: Record<string, unknown> = {
        select: () => c,
        insert: (v: unknown) => {
          isInsert = true;
          h.inserted.push(v);
          return c;
        },
        eq: (col: string, val: unknown) => {
          h.eqCalls.push([col, val]);
          return c;
        },
        gte: () => c,
        in: () => c,
        limit: () => c,
        single: () => c,
        then: (resolve: (v: unknown) => unknown) => resolve(resultFor(table, isInsert)),
      };
      return c;
    },
  }),
}));

beforeEach(() => {
  vi.resetModules();
  h.authed = null;
  h.eqCalls = [];
  h.inserted = [];
  h.existingExport = [];
  h.pendingRows = [];
  h.docs = [];
});

function post(path: string): Request {
  return new Request(`http://test${path}`, { method: "POST" });
}
function get(path: string): Request {
  return new Request(`http://test${path}`, { method: "GET" });
}

describe("consent/pending — auth normalization (#1591)", () => {
  it("returns 401 (not a silent 200) when auth is missing", async () => {
    h.authed = null;
    const { GET } = await import("@/app/api/user/consent/pending/route");
    const res = await GET(get("/api/user/consent/pending"));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: string; pending?: unknown };
    expect(json.error).toBe("unauthorized");
    // The pre-#1591 drift returned `{ pending: [] }` with status 200 — assert we
    // are NOT doing that.
    expect(json.pending).toBeUndefined();
  });

  it("returns the pending list for the verified user when authenticated", async () => {
    h.authed = { authUserId: "user-abc", email: "u@example.com" };
    h.pendingRows = [
      { document_type: "tou", document_id_pending: "doc-1", flagged_at: "2026-01-01T00:00:00Z" },
    ];
    h.docs = [{ id: "doc-1", document_type: "tou", version: 3, content_markdown: "# ToU" }];
    const { GET } = await import("@/app/api/user/consent/pending/route");
    const res = await GET(get("/api/user/consent/pending"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pending: Array<{ document_type: string; version: number }> };
    expect(json.pending).toHaveLength(1);
    expect(json.pending[0].document_type).toBe("tou");
    expect(json.pending[0].version).toBe(3);
    // Isolation: the pending read is filtered by the verified auth_user_id.
    expect(h.eqCalls).toContainEqual(["auth_user_id", "user-abc"]);
  });
});

describe("data/export-request — auth + isolation (#1591)", () => {
  it("returns 401 when auth is missing", async () => {
    h.authed = null;
    const { POST } = await import("@/app/api/user/data/export-request/route");
    const res = await POST(post("/api/user/data/export-request"));
    expect(res.status).toBe(401);
  });

  it("scopes the rate-limit read and the insert to the verified auth_user_id", async () => {
    h.authed = { authUserId: "user-xyz", email: null };
    h.existingExport = []; // no prior request in window
    const { POST } = await import("@/app/api/user/data/export-request/route");
    const res = await POST(post("/api/user/data/export-request"));
    expect(res.status).toBe(200);
    // App-layer isolation: rate-limit SELECT filters by the token's auth_user_id.
    expect(h.eqCalls).toContainEqual(["auth_user_id", "user-xyz"]);
    // The inserted row is keyed by the verified id — never a client value.
    expect(h.inserted).toContainEqual({ auth_user_id: "user-xyz" });
  });

  it("returns 429 when the user already requested an export in the window", async () => {
    h.authed = { authUserId: "user-xyz", email: null };
    h.existingExport = [{ id: "prev-1", requested_at: "2026-07-01T00:00:00Z" }];
    const { POST } = await import("@/app/api/user/data/export-request/route");
    const res = await POST(post("/api/user/data/export-request"));
    expect(res.status).toBe(429);
    // A rate-limited request must NOT insert a new row.
    expect(h.inserted).toHaveLength(0);
  });
});

describe("data/delete-request — shared prelude (#1591)", () => {
  it("returns 401 when auth is missing (canonical prelude, not a per-file copy)", async () => {
    h.authed = null;
    const { POST } = await import("@/app/api/user/data/delete-request/route");
    const res = await POST(post("/api/user/data/delete-request"));
    expect(res.status).toBe(401);
  });
});
