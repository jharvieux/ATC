// #712 / #996 — Tests for GET + POST /api/integrations/tokens.
//
// Critical intents:
// - GET: non-owners see only tokens that act as them (user_id filter applied).
//   Without this filter, a viewer could see tokens minted for other members.
// - GET: owners see all tokens; response carries is_owner:true.
// - POST: optional user_id validated against active tenant members before minting.
//   Without this check, an owner could mint a token acting as a user from a
//   different tenant.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  svcFrom: vi.fn(),
  memberMaybeSingle: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: mocks.svcFrom }),
}));

import { GET, POST } from "@/app/api/integrations/tokens/route";

// ── helpers ────────────────────────────────────────────────────────────────────

function req(body?: unknown): Request {
  if (!body) return new Request("http://test/api/integrations/tokens");
  return new Request("http://test/api/integrations/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callerAs(role: "tenant_owner" | "agent" | "viewer", userId = "u-self") {
  return {
    ctx: { tenant_id: "t-1" },
    user: { id: userId, role, tenant_id: "t-1", status: "active" },
  };
}

/** Build a fluent mock chain for the token-list query. Captures eq() calls. */
function makeListChain(tokens: unknown[] = []) {
  const eqCalls: Array<[string, unknown]> = [];
  const orderFn = vi.fn().mockResolvedValue({ data: tokens, error: null });
  // Each .eq() records args and returns a chainable object with .eq() + .order()
  function eqFn(col: string, val: unknown) {
    eqCalls.push([col, val]);
    return { eq: eqFn, order: orderFn };
  }
  const selectFn = vi.fn().mockReturnValue({ eq: eqFn, order: orderFn });
  mocks.svcFrom.mockReturnValue({ select: selectFn });
  return { eqCalls, orderFn };
}

/** Build a mock chain for the POST user-lookup + insert path. */
function makePostChain({
  memberData = null as unknown,
  memberError = null as unknown,
  insertData = { id: "tok-1", name: "test", scopes: ["rag_submissions:create"], created_at: "" } as unknown,
  insertError = null as unknown,
} = {}) {
  const singleFn = vi.fn().mockResolvedValue({ data: insertData, error: insertError });
  const maybeSingleFn = vi.fn().mockResolvedValue({ data: memberData, error: memberError });
  let callCount = 0;

  mocks.svcFrom.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // First call: member lookup (select→eq→eq→eq→maybeSingle)
      const eqChain = () => ({ eq: eqChain, maybeSingle: maybeSingleFn });
      return { select: () => ({ eq: eqChain }) };
    }
    // Second call: insert
    return { insert: () => ({ select: () => ({ single: singleFn }) }) };
  });

  return { maybeSingleFn, singleFn };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── GET ────────────────────────────────────────────────────────────────────────

describe("GET /api/integrations/tokens", () => {
  it("non-owner: adds user_id filter so only caller's own tokens are returned", async () => {
    mocks.assertPermission.mockResolvedValue(callerAs("viewer", "u-viewer"));
    const { eqCalls } = makeListChain([]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { is_owner: boolean };
    expect(body.is_owner).toBe(false);
    // Must filter to caller's own user_id — without this a viewer can read others' tokens.
    expect(eqCalls).toContainEqual(["user_id", "u-viewer"]);
  });

  it("owner: no user_id filter, is_owner:true returned", async () => {
    mocks.assertPermission.mockResolvedValue(callerAs("tenant_owner", "u-owner"));
    const { eqCalls } = makeListChain([]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { is_owner: boolean };
    expect(body.is_owner).toBe(true);
    expect(eqCalls.every(([col]) => col !== "user_id")).toBe(true);
  });
});

// ── POST ───────────────────────────────────────────────────────────────────────

describe("POST /api/integrations/tokens", () => {
  it("mints for caller when no user_id provided", async () => {
    mocks.assertPermission.mockResolvedValue(callerAs("tenant_owner", "u-owner"));
    // Only one svcFrom call expected (the insert — no member lookup needed for self)
    const singleFn = vi.fn().mockResolvedValue({
      data: { id: "tok-2", name: "test", scopes: ["rag_submissions:create"], created_at: "" },
      error: null,
    });
    mocks.svcFrom.mockReturnValue({ insert: () => ({ select: () => ({ single: singleFn }) }) });

    const res = await POST(req({ name: "My token" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string };
    expect(body.token).toMatch(/^atc_pat_/);
  });

  it("validates user_id is an active tenant member before minting", async () => {
    mocks.assertPermission.mockResolvedValue(callerAs("tenant_owner", "u-owner"));
    const { singleFn } = makePostChain({
      memberData: { id: "u-other", status: "active" },
    });

    const res = await POST(req({ name: "Delegated", user_id: "u-other" }));
    expect(res.status).toBe(201);
    expect(singleFn).toHaveBeenCalled();
  });

  it("rejects user_id that is not an active member of this tenant (cross-tenant isolation)", async () => {
    mocks.assertPermission.mockResolvedValue(callerAs("tenant_owner", "u-owner"));
    // Member lookup returns null → not in tenant or not active
    const maybeSingleFn = vi.fn().mockResolvedValue({ data: null, error: null });
    const eqChain = () => ({ eq: eqChain, maybeSingle: maybeSingleFn });
    mocks.svcFrom.mockReturnValue({ select: () => ({ eq: eqChain }) });

    const res = await POST(req({ name: "Evil", user_id: "u-foreign" }));
    expect(res.status).toBe(422);
  });

  it("returns 500 when the member-lookup DB call fails (fail-closed, not fail-open)", async () => {
    mocks.assertPermission.mockResolvedValue(callerAs("tenant_owner", "u-owner"));
    makePostChain({ memberError: { message: "db down" } });

    const res = await POST(req({ name: "Test", user_id: "u-other" }));
    expect(res.status).toBe(500);
  });
});
