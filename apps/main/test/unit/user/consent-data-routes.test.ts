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
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

const h = vi.hoisted(() => ({
  authed: null as { authUserId: string; email: string | null } | null,
  eqCalls: [] as Array<[string, unknown]>,
  gteCalls: [] as Array<[string, unknown]>,
  inserted: [] as unknown[],
  existingExport: [] as Array<{ id: string; requested_at: string }>,
  insertError: null as { code: string } | null,
  pendingRows: [] as unknown[],
  docs: [] as unknown[],
  // §17.10 undo-delete route fixtures.
  undoUserRow: null as { id: string; deleted_at: string | null } | null,
  undoUpdated: [] as Array<{ eqCalls: Array<[string, unknown]> }>,
}));

vi.mock("@/lib/auth/authenticate-user", () => ({
  authenticateUser: async () => h.authed,
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: vi.fn(async () => {}) },
}));

// The route computes `thirtyDaysAgo` from Date.now() and passes it as the
// gte() threshold — real filtering here (not a stub that ignores the arg) is
// what lets the boundary tests below prove the actual date-window math, not
// just the "some row exists" shape.
function resultFor(table: string, isInsert: boolean, gteThreshold?: string): { data: unknown; error: unknown } {
  if (isInsert) {
    if (h.insertError) return { data: null, error: h.insertError };
    return { data: { id: "export-1" }, error: null };
  }
  if (table === "user_data_export_requests") {
    const rows = gteThreshold
      ? h.existingExport.filter((r) => r.requested_at >= gteThreshold)
      : h.existingExport;
    return { data: rows, error: null };
  }
  if (table === "user_consent_pending") return { data: h.pendingRows, error: null };
  if (table === "legal_documents") return { data: h.docs, error: null };
  return { data: [], error: null };
}

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "users") {
        // undo-delete: select().eq().eq().maybeSingle(), then update().eq().eq().
        return {
          select: () => ({
            eq: (col1: string, val1: unknown) => {
              h.eqCalls.push([col1, val1]);
              return {
                eq: (col2: string, val2: unknown) => {
                  h.eqCalls.push([col2, val2]);
                  return { maybeSingle: async () => ({ data: h.undoUserRow, error: null }) };
                },
              };
            },
          }),
          update: () => ({
            eq: (col1: string, val1: unknown) => {
              const eqCalls: Array<[string, unknown]> = [[col1, val1]];
              return {
                eq: (col2: string, val2: unknown) => {
                  eqCalls.push([col2, val2]);
                  h.undoUpdated.push({ eqCalls });
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          }),
        };
      }
      let isInsert = false;
      let gteThreshold: string | undefined;
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
        gte: (col: string, val: string) => {
          h.gteCalls.push([col, val]);
          gteThreshold = val;
          return c;
        },
        in: () => c,
        limit: () => c,
        single: () => c,
        then: (resolve: (v: unknown) => unknown) => resolve(resultFor(table, isInsert, gteThreshold)),
      };
      return c;
    },
  }),
}));

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  vi.resetModules();
  h.authed = null;
  h.eqCalls = [];
  h.gteCalls = [];
  h.inserted = [];
  h.existingExport = [];
  h.insertError = null;
  h.pendingRows = [];
  h.docs = [];
  h.undoUserRow = null;
  h.undoUpdated = [];
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
    expect(json.pending[0]?.document_type).toBe("tou");
    expect(json.pending[0]?.version).toBe(3);
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
    // The inserted row is keyed by the verified id — never a client value — and
    // carries the 30-day window_bucket the unique index dedups on (#1705).
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({ auth_user_id: "user-xyz" });
    expect(typeof (h.inserted[0] as { window_bucket: unknown }).window_bucket).toBe("number");
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

  // #1794 — the two tests above pin the "some row exists" shape but never
  // exercised the actual 30-day date arithmetic (gte() was previously a
  // no-op stub). These pin the real boundary: a prior request just inside
  // the window still blocks; one just outside it does not.
  it("is rate-limited by a prior request made 29 days ago (inside the 30-day window)", async () => {
    h.authed = { authUserId: "user-xyz", email: null };
    h.existingExport = [{ id: "prev-1", requested_at: daysAgo(29) }];
    const { POST } = await import("@/app/api/user/data/export-request/route");
    const res = await POST(post("/api/user/data/export-request"));
    expect(res.status).toBe(429);
    expect(h.inserted).toHaveLength(0);
  });

  it("is NOT rate-limited by a prior request made 31 days ago (outside the 30-day window)", async () => {
    h.authed = { authUserId: "user-xyz", email: null };
    h.existingExport = [{ id: "prev-1", requested_at: daysAgo(31) }];
    const { POST } = await import("@/app/api/user/data/export-request/route");
    const res = await POST(post("/api/user/data/export-request"));
    expect(res.status).toBe(200);
    expect(h.inserted).toHaveLength(1);
  });

  it("returns 429 (not 500) when the DB unique index rejects a concurrent double-submit (#1705)", async () => {
    // The SELECT gate passes (no prior row visible to this racing request) but
    // a sibling request already inserted for the same window_bucket, so the
    // insert hits the unique constraint. This is the race the app-layer check
    // alone can't stop — the DB backstop must convert the 23505 into a
    // rate-limit response, never a 500.
    h.authed = { authUserId: "user-race", email: null };
    h.existingExport = [];
    h.insertError = { code: "23505" };
    const { POST } = await import("@/app/api/user/data/export-request/route");
    const res = await POST(post("/api/user/data/export-request"));
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("rate_limited");
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

// #1794 — real tests for the §17.10 undo-delete grace-period boundary,
// replacing stale it.todo stubs in test/unit/legal/consent.test.ts that
// described this exact behavior for code that had already shipped.
describe("data/undo-delete — 30-day grace period (§17.10)", () => {
  function undoRequest(): Request {
    return new Request("http://test/api/user/data/undo-delete", {
      method: "POST",
      headers: { [RESOLVED_TENANT_ID_HEADER]: "tenant-1" },
    });
  }

  it("clears deleted_at when undo is requested within the 30-day grace period", async () => {
    h.authed = { authUserId: "user-1", email: null };
    h.undoUserRow = { id: "row-1", deleted_at: daysAgo(10) };
    const { POST } = await import("@/app/api/user/data/undo-delete/route");
    const res = await POST(undoRequest());
    expect(res.status).toBe(200);
    expect(h.undoUpdated).toHaveLength(1);
    expect(h.undoUpdated[0]?.eqCalls).toContainEqual(["auth_user_id", "user-1"]);
  });

  it("rejects with 410 grace_period_expired once 30 days have elapsed", async () => {
    h.authed = { authUserId: "user-1", email: null };
    h.undoUserRow = { id: "row-1", deleted_at: daysAgo(31) };
    const { POST } = await import("@/app/api/user/data/undo-delete/route");
    const res = await POST(undoRequest());
    expect(res.status).toBe(410);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("grace_period_expired");
    // An expired grace period must NOT clear deleted_at.
    expect(h.undoUpdated).toHaveLength(0);
  });
});
