// §26 — Platform-admin management API guardrails.
//
// Contracts pinned here (the security-load-bearing behavior):
//   - Mutations are superadmin-gated (assertSuperadmin throwing → 403).
//   - You cannot change or remove yourself (self-lockout guard, before any DB).
//   - You cannot demote/remove the LAST superadmin (lockout-everyone guard).
//   - Add validates the role enum, resolves the email (404 if no account),
//     and rejects an existing admin (409).

import { describe, it, expect, vi, beforeEach } from "vitest";

interface DbConfig {
  rpcId?: string | null;
  existing?: boolean;
  insertRow?: unknown;
  targetRole?: string | null;
  superadminCount?: number;
  updateRow?: unknown;
}

const mocks = vi.hoisted(() => {
  // Defined inside vi.hoisted so it's initialized before the hoisted vi.mock
  // factory references it (a top-level class would be in the TDZ at that point).
  class FakePlatformAdminError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
    toResponse(): Response {
      return Response.json({ error: this.code, detail: this.message }, { status: this.status });
    }
  }
  return {
    FakePlatformAdminError,
    assertPlatformAdmin: vi.fn(),
    assertSuperadmin: vi.fn(),
    dbConfig: {} as DbConfig,
  };
});

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  assertPlatformAdmin: mocks.assertPlatformAdmin,
  assertSuperadmin: mocks.assertSuperadmin,
  PlatformAdminError: mocks.FakePlatformAdminError,
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: (
    _opts: unknown,
    fn: (db: unknown, rq: () => void) => Promise<unknown>,
  ) => fn(makeDb(mocks.dbConfig), () => {}),
}));

function makeDb(cfg: DbConfig) {
  function builder() {
    const state = { selectCols: "", count: false, op: "select" as "select" | "insert" | "update" | "delete" };
    function resolve(): unknown {
      if (state.op === "insert") return { data: cfg.insertRow ?? { auth_user_id: "new", role: "reviewer" }, error: null };
      if (state.op === "update") return { data: cfg.updateRow ?? { auth_user_id: "t", role: "reviewer" }, error: null };
      if (state.op === "delete") return { data: null, error: null };
      if (state.count) return { count: cfg.superadminCount ?? 2, error: null };
      if (state.selectCols.includes("role")) return { data: cfg.targetRole ? { role: cfg.targetRole } : null, error: null };
      if (state.selectCols.trim() === "auth_user_id") return { data: cfg.existing ? { auth_user_id: "x" } : null, error: null };
      return { data: [], error: null };
    }
    const api = {
      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        state.selectCols = cols ?? "";
        if (opts?.count) state.count = true;
        return api;
      },
      order: () => api,
      eq: () => api,
      insert: () => { state.op = "insert"; return api; },
      update: () => { state.op = "update"; return api; },
      delete: () => { state.op = "delete"; return api; },
      maybeSingle: () => Promise.resolve(resolve()),
      single: () => Promise.resolve(resolve()),
      then: (r: (v: unknown) => void) => r(resolve()),
    };
    return api;
  }
  return {
    from: () => builder(),
    rpc: () => Promise.resolve({ data: cfg.rpcId ?? null, error: null }),
  };
}

import { POST } from "@/app/api/admin/admins/route";
import { PATCH, DELETE } from "@/app/api/admin/admins/[authUserId]/route";

function jsonReq(body?: unknown): Request {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request("https://admin.internal/api/admin/admins", init);
}
const params = (authUserId: string) => ({ params: Promise.resolve({ authUserId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbConfig = {};
  mocks.assertSuperadmin.mockResolvedValue({ admin_user_id: "me", role: "superadmin", via: "session" });
});

describe("POST /api/admin/admins (add)", () => {
  it("returns 403 when the caller is not a superadmin", async () => {
    mocks.assertSuperadmin.mockRejectedValue(new mocks.FakePlatformAdminError(403, "not_a_superadmin", "no"));
    const res = await POST(jsonReq({ email: "a@b.com", role: "reviewer" }));
    expect(res.status).toBe(403);
  });

  it("returns 400 for an invalid role", async () => {
    const res = await POST(jsonReq({ email: "a@b.com", role: "king" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_role" });
  });

  it("returns 404 when the email has no auth account yet", async () => {
    mocks.dbConfig = { rpcId: null };
    const res = await POST(jsonReq({ email: "ghost@b.com", role: "reviewer" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "user_not_found" });
  });

  it("returns 409 when the user is already an admin", async () => {
    mocks.dbConfig = { rpcId: "target-uuid", existing: true };
    const res = await POST(jsonReq({ email: "a@b.com", role: "reviewer" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_admin" });
  });

  it("returns 201 on success", async () => {
    mocks.dbConfig = { rpcId: "target-uuid", existing: false, insertRow: { auth_user_id: "target-uuid", role: "reviewer", email: "a@b.com" } };
    const res = await POST(jsonReq({ email: "a@b.com", role: "reviewer" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe("PATCH /api/admin/admins/:id (change role)", () => {
  it("returns 403 when not a superadmin", async () => {
    mocks.assertSuperadmin.mockRejectedValue(new mocks.FakePlatformAdminError(403, "not_a_superadmin", "no"));
    const res = await PATCH(jsonReq({ role: "reviewer" }), params("other"));
    expect(res.status).toBe(403);
  });

  it("returns 409 when changing your own role", async () => {
    const res = await PATCH(jsonReq({ role: "reviewer" }), params("me"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "cannot_change_self" });
  });

  it("returns 409 when demoting the last superadmin", async () => {
    mocks.dbConfig = { targetRole: "superadmin", superadminCount: 1 };
    const res = await PATCH(jsonReq({ role: "reviewer" }), params("other"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "last_superadmin" });
  });

  it("returns 404 when the target is not an admin", async () => {
    mocks.dbConfig = { targetRole: null };
    const res = await PATCH(jsonReq({ role: "reviewer" }), params("other"));
    expect(res.status).toBe(404);
  });

  it("allows demoting a superadmin when another remains", async () => {
    mocks.dbConfig = { targetRole: "superadmin", superadminCount: 2, updateRow: { auth_user_id: "other", role: "reviewer" } };
    const res = await PATCH(jsonReq({ role: "reviewer" }), params("other"));
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/admin/admins/:id (remove)", () => {
  it("returns 409 when removing yourself", async () => {
    const res = await DELETE(jsonReq(), params("me"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "cannot_remove_self" });
  });

  it("returns 409 when removing the last superadmin", async () => {
    mocks.dbConfig = { targetRole: "superadmin", superadminCount: 1 };
    const res = await DELETE(jsonReq(), params("other"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "last_superadmin" });
  });

  it("removes a non-last admin", async () => {
    mocks.dbConfig = { targetRole: "reviewer", superadminCount: 2 };
    const res = await DELETE(jsonReq(), params("other"));
    expect(res.status).toBe(200);
  });
});
