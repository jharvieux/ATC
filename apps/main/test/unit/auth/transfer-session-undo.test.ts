// Unit tests for apps/main/src/app/api/auth/transfer-session/undo/route.ts
//
// D-091 critical path: impersonation-adjacent. The undo gate must verify:
//   - caller owns the anonymous session (transferred_to_user_id === user.id)
//   - the 24-hour window hasn't elapsed
//   - the CAS update won the race against the finalize cron
//
// 94 NoCoverage mutants in Stryker — this file was entirely untested.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────────────

const { h } = vi.hoisted(() => ({
  h: {
    permFails: false,
    userId: "user-1",
    tenantId: "tenant-1",
    sessionRow: null as Record<string, unknown> | null,
    sessionReadError: null as { message: string } | null,
    // #1703 — the undo is now a single atomic RPC (undo_session_transfer) that
    // does the CAS clear AND the conversation revert in one transaction. The
    // mock returns the session-row count (0 = finalize cron won the race → 409)
    // or an error (→ 500 fail-closed).
    rpcReturn: 1 as number | null,
    rpcError: null as { message: string } | null,
    rpcCalledWith: null as { name: string; params: Record<string, unknown> } | null,
    writeAuditCalled: false,
  },
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: async (_req: unknown, _opts: unknown) => {
    if (h.permFails) throw new Error("forbidden");
    return {
      ctx: { tenant_id: h.tenantId, source: { kind: "http_request" as const, user_id: "auth-1" } },
      user: { id: h.userId, auth_user_id: "auth-1", tenant_id: h.tenantId, status: "active", role: "viewer" },
    };
  },
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: (_err: unknown) => Response.json({ error: "auth" }, { status: 403 }),
}));

vi.mock("@/lib/audit/write", () => ({
  writeAuditLog: async () => { h.writeAuditCalled = true; },
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: h.sessionRow, error: h.sessionReadError }),
          }),
        }),
      }),
    }),
    rpc: (name: string, params: Record<string, unknown>) => {
      h.rpcCalledWith = { name, params };
      return Promise.resolve({
        data: h.rpcError ? null : h.rpcReturn,
        error: h.rpcError,
      });
    },
  }),
}));

import { POST } from "@/app/api/auth/transfer-session/undo/route";

// ── helpers ────────────────────────────────────────────────────────────────

const VALID_UUID = "00000000-0000-0000-0000-000000000001";

function req(body?: unknown): Request {
  return new Request("https://app.example.com/api/auth/transfer-session/undo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : { body: JSON.stringify({ anonymous_session_id: VALID_UUID }) }),
  });
}

function makeSession(overrides: Partial<{
  id: string;
  transferred_to_user_id: string | null;
  transfer_soft_commit_at: string | null;
  transfer_committed_at: string | null;
  transfer_undo_count: number;
}>  = {}): Record<string, unknown> {
  return {
    id: VALID_UUID,
    transferred_to_user_id: h.userId,
    transfer_soft_commit_at: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    transfer_committed_at: null,
    transfer_undo_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  h.permFails = false;
  h.userId = "user-1";
  h.tenantId = "tenant-1";
  h.sessionRow = makeSession();
  h.sessionReadError = null;
  h.rpcReturn = 1;
  h.rpcError = null;
  h.rpcCalledWith = null;
  h.writeAuditCalled = false;
});

// ── auth gate ──────────────────────────────────────────────────────────────

describe("transfer-session undo — auth gate", () => {
  it("returns 403 when assertPermission fails", async () => {
    h.permFails = true;
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(h.writeAuditCalled).toBe(false);
  });
});

// ── input validation ───────────────────────────────────────────────────────

describe("transfer-session undo — input validation", () => {
  it("returns 400 when body is missing anonymous_session_id", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_body");
  });

  it("returns 400 when anonymous_session_id is not a UUID", async () => {
    const res = await POST(req({ anonymous_session_id: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const res = await POST(new Request("https://app.example.com/api/auth/transfer-session/undo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    }));
    expect(res.status).toBe(400);
  });
});

// ── DB lookup ──────────────────────────────────────────────────────────────

describe("transfer-session undo — DB lookup", () => {
  it("returns 500 when DB read errors (fail-closed — not 404)", async () => {
    h.sessionReadError = { message: "connection timeout" };
    h.sessionRow = null;
    const res = await POST(req());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("db_error");
    expect(h.writeAuditCalled).toBe(false);
  });

  it("returns 404 when session row does not exist (or belongs to a different tenant)", async () => {
    h.sessionRow = null;
    const res = await POST(req());
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("session_not_found");
  });
});

// ── ownership + state guards ───────────────────────────────────────────────

describe("transfer-session undo — ownership and state guards", () => {
  it("returns 403 when caller did not own the transfer (not_owner guard)", async () => {
    h.sessionRow = makeSession({ transferred_to_user_id: "different-user" });
    const res = await POST(req());
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_owner");
    expect(h.writeAuditCalled).toBe(false);
  });

  it("returns 409 when transfer is already finalized (transfer_committed_at set)", async () => {
    h.sessionRow = makeSession({ transfer_committed_at: new Date().toISOString() });
    const res = await POST(req());
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("transfer_already_finalized");
    expect(h.writeAuditCalled).toBe(false);
  });

  it("returns 409 when transfer is not in soft-commit state (transfer_soft_commit_at is null)", async () => {
    h.sessionRow = makeSession({ transfer_soft_commit_at: null });
    const res = await POST(req());
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("transfer_not_in_soft_commit");
    expect(h.writeAuditCalled).toBe(false);
  });

  it("returns 409 when 24h undo window has elapsed", async () => {
    const overDue = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    h.sessionRow = makeSession({ transfer_soft_commit_at: overDue });
    const res = await POST(req());
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("undo_window_elapsed");
    expect(h.writeAuditCalled).toBe(false);
  });

  it("allows undo when soft_commit_at is just inside the 24h window", async () => {
    const justInside = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    h.sessionRow = makeSession({ transfer_soft_commit_at: justInside });
    const res = await POST(req());
    expect(res.status).toBe(200);
  });
});

// ── atomic RPC: race + fail-closed (#1703) ─────────────────────────────────

describe("transfer-session undo — atomic RPC race and error handling", () => {
  it("returns 409 when the RPC reports zero session rows updated (finalize cron won the race)", async () => {
    // undo_session_transfer's CAS matched no row: the finalize Inngest job
    // committed between our pre-check read and the RPC. Must be 409 (not 500 —
    // the race is user-visible and actionable), and the RPC's internal
    // conversation revert never ran because the CAS guarded it.
    h.rpcReturn = 0;
    const res = await POST(req());
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("transfer_already_finalized");
    expect(h.writeAuditCalled).toBe(false);
  });

  it("returns 500 (fail-closed, sanitized) when the RPC errors", async () => {
    // A genuine RPC/DB failure must not claim success or write the audit log,
    // and the raw error detail must not leak (dbErrorResponse sanitizes).
    h.rpcError = { message: "connection reset" };
    const res = await POST(req());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("db_error");
    expect(h.writeAuditCalled).toBe(false);
  });
});

// ── happy path ─────────────────────────────────────────────────────────────

describe("transfer-session undo — happy path", () => {
  it("returns 200 and writes audit log when undo succeeds", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(h.writeAuditCalled).toBe(true);
  });

  it("invokes undo_session_transfer with the session, tenant, and caller ids (atomic revert)", async () => {
    // The CAS clear AND the conversation revert live inside this one RPC now
    // (#1703). Pin that the route hands it the caller-verified ids so the
    // atomic transaction reverts the right session's conversations.
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(h.rpcCalledWith?.name).toBe("undo_session_transfer");
    expect(h.rpcCalledWith?.params).toEqual({
      p_session_id: VALID_UUID,
      p_tenant_id: "tenant-1",
      p_user_id: "user-1",
    });
  });
});
