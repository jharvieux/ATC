// #747 — POST /api/admin/reconciliation/queue
// CAS guard: zero-row update (item already actioned by concurrent admin) must
// return 409 "already_actioned" instead of silently reporting success.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = {
  safeAwaitRowCount: vi.fn(),
  // #1674 — the fetch of the queue row, parametrized so tests can drive the
  // 404 (not-found) and 422 (already-reviewed) publicMessage branches.
  fetchResult: { data: null as unknown, error: null as unknown },
};

vi.mock("@/lib/auth/assert-platform-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-platform-admin")>(
    "@/lib/auth/assert-platform-admin",
  );
  const gate = async () => ({ admin_user_id: "admin-1", role: "finance" as const, via: "session" as const });
  return {
    ...actual,
    assertPlatformAdmin: vi.fn(gate),
    assertPlatformRole: vi.fn(gate),
    assertPlatformAdminArea: vi.fn(gate),
  };
});

// updateChain is a chainable proxy for the safeAwaitRowCount path; it must
// not be thenable at root so the mock receives it unawaited.
const updateChain = new Proxy({} as Record<string | symbol, unknown>, {
  get(_t, prop) {
    if (prop === "then") return undefined;
    return () => updateChain;
  },
});

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (_opts: unknown, fn: (db: unknown, rec: () => void) => Promise<unknown>) => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => mocks.fetchResult,
          }),
        }),
        update: () => updateChain,
      }),
    };
    return fn(db, () => {});
  }),
}));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>("@/lib/db/safe-mutation");
  return { ...actual, safeAwaitRowCount: mocks.safeAwaitRowCount };
});

beforeEach(() => {
  vi.resetModules();
  mocks.safeAwaitRowCount.mockResolvedValue([{ id: "q-1" }]);
  mocks.fetchResult = {
    data: { id: "q-1", status: "pending", commission_id: "c-1", notes: null },
    error: null,
  };
});

async function postAction(body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/admin/reconciliation/queue/route");
  return POST(
    new Request("http://test/api/admin/reconciliation/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/admin/reconciliation/queue — CAS guard (#747)", () => {
  it("returns 409 already_actioned when item was reviewed by a concurrent admin", async () => {
    const { SupabaseMutationError } = await import("@/lib/db/safe-mutation");
    mocks.safeAwaitRowCount.mockRejectedValue(
      new SupabaseMutationError("reconciliation_review_queue.cas_action", {
        message: "Expected 1 row(s); got 0.",
        code: "ROW_COUNT_MISMATCH",
        hint: "",
        details: null,
        name: "RowCountMismatch",
      } as never),
    );
    const res = await postAction({ id: "q-1", action: "accepted" });
    expect(res.status).toBe(409);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toBe("already_actioned");
  });

  it("returns 200 ok on successful action", async () => {
    const res = await postAction({ id: "q-1", action: "accepted" });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect((json as { ok?: boolean }).ok).toBe(true);
  });

  it("returns 400 on missing required fields", async () => {
    const res = await postAction({ id: "q-1" });
    expect(res.status).toBe(400);
  });
});

// #1674 — the sanitization guard lets ONLY the whitelisted 404/422
// publicMessage text past the egress. These pin that the specific messages
// surface at the right status; a refactor that drops `publicMessage` would
// fall through to a generic db_error 500 and fail here.
describe("POST /api/admin/reconciliation/queue — publicMessage egress (#1674)", () => {
  it("returns 404 'Queue item not found' when the row does not exist", async () => {
    mocks.fetchResult = { data: null, error: null };
    const res = await postAction({ id: "missing", action: "accepted" });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("Queue item not found");
  });

  it("returns 422 'Item has already been reviewed' when status is terminal", async () => {
    mocks.fetchResult = {
      data: { id: "q-1", status: "accepted", commission_id: "c-1", notes: null },
      error: null,
    };
    const res = await postAction({ id: "q-1", action: "accepted" });
    expect(res.status).toBe(422);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("Item has already been reviewed");
  });

  it("returns a sanitized 500 (not raw detail) when the fetch errors", async () => {
    mocks.fetchResult = { data: null, error: { message: "relation does not exist", code: "42P01" } };
    const res = await postAction({ id: "q-1", action: "accepted" });
    expect(res.status).toBe(404);
    // fetchError → the 404 publicMessage path (fetchError || !existing), not a
    // raw-detail leak. The DB message must never appear in the body.
    const json = await res.json() as { error: string };
    expect(json.error).toBe("Queue item not found");
  });
});
