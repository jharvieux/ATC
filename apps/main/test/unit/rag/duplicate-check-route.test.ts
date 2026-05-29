// #393 / D-091 — duplicate-check must surface a matches read error.
//
// The matches query used to discard `error`; on a DB error `matches` came back
// null → the route answered `duplicate: false`, silently waving a real
// duplicate into the review queue. It now returns 500 (matching the curErr
// handling on the read just above it) so the failure is visible and retryable.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Result = { data: unknown; error: { message: string } | null };
type Chain = {
  select: () => Chain;
  eq: () => Chain;
  neq: () => Chain;
  order: () => Chain;
  limit: () => Promise<Result>;
  maybeSingle: () => Promise<Result>;
};

const mocks = vi.hoisted(() => ({
  cur: { data: { content_hash: "h" }, error: null } as Result,
  matches: { data: [], error: null } as Result,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({ ctx: { tenant_id: "t-1" } })),
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: vi.fn(() => {
    const chain: Chain = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      order: () => chain,
      limit: () => Promise.resolve(mocks.matches),
      maybeSingle: () => Promise.resolve(mocks.cur),
    };
    return { from: () => chain };
  }),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: (e: unknown) => Response.json({ error: String(e) }, { status: 401 }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cur = { data: { content_hash: "h" }, error: null };
  mocks.matches = { data: [], error: null };
});

async function callGet(): Promise<Response> {
  const { GET } = await import("@/app/api/rag/queue/[id]/duplicate-check/route");
  return GET(new Request("http://test/api/rag/queue/sub-1/duplicate-check"), {
    params: Promise.resolve({ id: "sub-1" }),
  });
}

describe("GET duplicate-check — surfaces matches read error (#393)", () => {
  it("returns 500 when the matches query errors (was a silent duplicate:false)", async () => {
    mocks.matches = { data: null, error: { message: "db boom" } };
    const res = await callGet();
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "db boom" });
  });

  it("returns duplicate:false when there are genuinely no matches (happy path intact)", async () => {
    mocks.matches = { data: [], error: null };
    const res = await callGet();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ duplicate: false });
  });
});
