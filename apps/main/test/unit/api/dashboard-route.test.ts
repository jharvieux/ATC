// Tests for GET /api/tenant/dashboard — the admin console home aggregate.
//
// Intent under test:
// 1. team_member_invited derives from seatsInUse > 1 (no separate DB query).
//    A regression changing this rule (e.g. switching to an invitations table
//    without updating the flag) would silently miscomplete the checklist.
// 2. Both conversations_this_month and conversations_prev_month are present in
//    the response so the page can compute its own trend direction and magnitude.
// 3. Auth failure returns respondToAuthError's response, not a 200 or 500.
// 4. A DB failure on any sub-query degrades to a safe default (0/false/empty)
//    rather than 500 — the dashboard must never blank on a single table error.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  from: vi.fn(),
  respondToAuthError: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: mocks.respondToAuthError,
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({ from: mocks.from }),
}));

import { GET } from "@/app/api/tenant/dashboard/route";

function req(): Request {
  return new Request("http://test/api/tenant/dashboard");
}

const BASE_CTX = {
  ctx: { tenant_id: "t-1", source: { kind: "http_request", user_id: "u-owner" } },
  user: { id: "u-owner", role: "tenant_owner" },
};

// Build a chainable Supabase mock that resolves to the given value.
function makeChain(value: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const resolve = () => Promise.resolve(value);
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.gte = () => chain;
  chain.lt = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = resolve;
  // Thenable so that awaiting the chain directly works (count queries skip maybeSingle).
  chain.then = (fn: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(value).then(fn, rej);
  return chain;
}

function mockAllEmpty() {
  mocks.from.mockReturnValue(makeChain({ data: null, error: null, count: 0 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue(BASE_CTX);
  mocks.respondToAuthError.mockReturnValue(new Response("unauth", { status: 401 }));
  mockAllEmpty();
});

describe("GET /api/tenant/dashboard", () => {
  it("returns respondToAuthError result when assertPermission throws", async () => {
    const authErr = Object.assign(new Error("unauth"), { code: "PERM_DENIED" });
    mocks.assertPermission.mockRejectedValue(authErr);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mocks.respondToAuthError).toHaveBeenCalledWith(authErr);
  });

  it("team_member_invited is true when seats_in_use > 1", async () => {
    // The flag marks that the owner has invited at least one additional member.
    // It is derived purely from the active-user count — no separate invitations
    // table. This ensures the checklist step completes once a real member exists.
    let usersCallCount = 0;
    mocks.from.mockImplementation((table: string) => {
      if (table === "users") {
        usersCallCount++;
        if (usersCallCount === 1) {
          // First call: owner first_name lookup.
          return makeChain({ data: { first_name: "Alice" }, error: null });
        }
        // Second call: count active seats — 2 means a team member exists.
        return makeChain({ data: null, error: null, count: 2 });
      }
      return makeChain({ data: null, error: null, count: 0 });
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { setup: { team_member_invited: boolean } };
    expect(body.setup.team_member_invited).toBe(true);
  });

  it("team_member_invited is false when only 1 active user (just the owner)", async () => {
    let usersCallCount = 0;
    mocks.from.mockImplementation((table: string) => {
      if (table === "users") {
        usersCallCount++;
        if (usersCallCount === 1) return makeChain({ data: { first_name: "Alice" }, error: null });
        return makeChain({ data: null, error: null, count: 1 });
      }
      return makeChain({ data: null, error: null, count: 0 });
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { setup: { team_member_invited: boolean } };
    expect(body.setup.team_member_invited).toBe(false);
  });

  it("response includes both conversations_this_month and conversations_prev_month", async () => {
    // The page derives trend % from these two values. Both must be present and
    // distinct so the page can show direction and magnitude correctly.
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: Record<string, unknown> };
    expect(body.stats).toHaveProperty("conversations_this_month");
    expect(body.stats).toHaveProperty("conversations_prev_month");
  });

  it("degrades to empty activity array when audit_log query errors", async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === "audit_log") {
        return makeChain({ data: null, error: { message: "table missing" } });
      }
      return makeChain({ data: null, error: null, count: 0 });
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: unknown[] };
    expect(Array.isArray(body.activity)).toBe(true);
    expect(body.activity).toHaveLength(0);
  });

  it("degrades to 0 stats when tenant_usage_metrics query errors", async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === "tenant_usage_metrics") {
        return makeChain({ data: null, error: { message: "timeout" } });
      }
      return makeChain({ data: null, error: null, count: 0 });
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: { ai_messages_this_month: number; chat_limit_used: number };
    };
    expect(body.stats.ai_messages_this_month).toBe(0);
    expect(body.stats.chat_limit_used).toBe(0);
  });
});
