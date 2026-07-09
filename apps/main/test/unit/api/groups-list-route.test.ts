// §18.2 — GET /api/groups (list).
//
// #1588: an unbounded select silently loses groups past PostgREST's
// max-rows cap. Pin that the route issues an explicit .range() and honors
// caller-supplied limit/offset, echoing total/limit/offset back so a
// client can tell it's seeing a partial page.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  groupsQuery: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table !== "groups") throw new Error(`unmocked table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              range: (...args: unknown[]) => mocks.groupsQuery(...args),
            }),
          }),
        }),
      };
    },
  }),
}));

import { GET } from "@/app/api/groups/route";

const TENANT_ID = "t-1";

function req(query = ""): Request {
  return new Request(`https://tenant.example.com/api/groups${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: TENANT_ID }, user: { id: "u-1" } });
});

describe("GET /api/groups", () => {
  it("defaults to a bounded page (limit 50, offset 0) and returns the count as total", async () => {
    mocks.groupsQuery.mockResolvedValue({ data: [{ id: "g1" }], error: null, count: 3 });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body: { groups: unknown[]; total: number; limit: number; offset: number } = await res.json();

    expect(mocks.groupsQuery).toHaveBeenCalledWith(0, 49);
    expect(body.total).toBe(3);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("honors limit/offset query params via .range()", async () => {
    mocks.groupsQuery.mockResolvedValue({ data: [], error: null, count: 400 });

    const res = await GET(req("?limit=25&offset=100"));
    const body: { total: number; limit: number; offset: number } = await res.json();

    expect(mocks.groupsQuery).toHaveBeenCalledWith(100, 124);
    expect(body.total).toBe(400);
    expect(body.limit).toBe(25);
    expect(body.offset).toBe(100);
  });

  it("clamps an oversized limit to the 200 cap rather than trusting the caller", async () => {
    mocks.groupsQuery.mockResolvedValue({ data: [], error: null, count: 0 });

    const res = await GET(req("?limit=999999"));
    const body: { limit: number } = await res.json();

    expect(mocks.groupsQuery).toHaveBeenCalledWith(0, 199);
    expect(body.limit).toBe(200);
  });

  it("returns 500 on a DB error (fail-loud, not a silent empty list)", async () => {
    mocks.groupsQuery.mockResolvedValue({ data: null, error: { message: "groups RLS" } });

    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});
