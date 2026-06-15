// #746 — PATCH /api/admin/abuse/override-requests/[id]
// CAS guard: zero-row update (request already reviewed by a concurrent admin)
// must return 409 "already_reviewed" instead of silently reporting success.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = {
  safeAwaitRowCount: vi.fn(),
};

vi.mock("@/lib/auth/assert-platform-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-platform-admin")>(
    "@/lib/auth/assert-platform-admin",
  );
  const gate = async () => ({ admin_user_id: "admin-1", role: "reviewer" as const, via: "session" as const });
  return {
    ...actual,
    assertPlatformAdmin: vi.fn(gate),
    assertPlatformRole: vi.fn(gate),
    assertPlatformAdminArea: vi.fn(gate),
  };
});

// DB must be chainable so the query expression evaluates without throwing;
// safeAwaitRowCount (mocked below) receives the chain and controls the result.
const chainProxy = new Proxy({} as Record<string | symbol, unknown>, {
  get(_t, prop) {
    if (prop === "then") return undefined; // not thenable at root
    return () => chainProxy;
  },
});
const mockDb = { from: () => chainProxy };

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (_opts: unknown, fn: (db: unknown, rec: () => void) => Promise<unknown>) =>
    fn(mockDb, () => {}),
  ),
}));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>("@/lib/db/safe-mutation");
  return { ...actual, safeAwaitRowCount: mocks.safeAwaitRowCount };
});

beforeEach(() => {
  vi.resetModules();
  mocks.safeAwaitRowCount.mockResolvedValue([{ id: "req-1" }]);
});

async function patchRequest(body: unknown, id = "req-1"): Promise<Response> {
  const { PATCH } = await import("@/app/api/admin/abuse/override-requests/[id]/route");
  return PATCH(
    new Request(`http://test/api/admin/abuse/override-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("PATCH /api/admin/abuse/override-requests/[id] — CAS guard (#746)", () => {
  it("returns 409 already_reviewed when the request was reviewed by a concurrent admin", async () => {
    const { SupabaseMutationError } = await import("@/lib/db/safe-mutation");
    mocks.safeAwaitRowCount.mockRejectedValue(
      new SupabaseMutationError("tenant_override_requests.cas_deny", {
        message: "Expected 1 row(s); got 0.",
        code: "ROW_COUNT_MISMATCH",
        hint: "",
        details: null,
        name: "RowCountMismatch",
      } as never),
    );
    const res = await patchRequest({ action: "deny", deny_reason: "valid reason here" });
    expect(res.status).toBe(409);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toBe("already_reviewed");
  });

  it("returns 200 ok on successful deny", async () => {
    const res = await patchRequest({ action: "deny", deny_reason: "valid reason here" });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });

  it("returns 400 on invalid_input (missing deny_reason)", async () => {
    const res = await patchRequest({ action: "deny" });
    expect(res.status).toBe(400);
  });
});
