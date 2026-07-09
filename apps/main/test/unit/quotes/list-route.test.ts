// §12.4 / §38 — GET /api/quotes (list).
//
// The helper test (representative-option.test.ts) pins the §38.4.3 selection
// rule in isolation. This file pins the route's OWN assembly logic, which the
// helper test can't reach:
//   1. options are grouped by quote_id in-process and the representative
//      option's trip + total is flattened onto each row — and one quote's
//      options must not bleed onto another's (the Map grouping isolates them).
//   2. a quote with no matching options flattens to null trip/total, not a throw.
//   3. the empty-quotes short-circuit returns {quotes: []} WITHOUT issuing the
//      second (quote_options) query.
//   4. both reads fail loud: a DB error on either the container or the options
//      read is a 500, never a silent render with blank rows.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  tenantClient: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
      "@/lib/auth/assert-permission",
    );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: mocks.tenantClient,
}));

import { GET } from "@/app/api/quotes/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

type Result = { data: Array<Record<string, unknown>> | null; error: { message: string } | null; count?: number };

// Mock tenantClient: routes .from(table) to the supplied result and records
// which tables were queried, so the empty-quotes short-circuit can be verified.
function makeDb(quotes: Result, options: Result) {
  const tablesQueried: string[] = [];
  const rangeCalls: Array<[number, number]> = [];
  const db = {
    from(table: string) {
      tablesQueried.push(table);
      const result = table === "quotes" ? quotes : options;
      // The quotes query chains .order(created_at).order(id).range() (#1701
      // audit r2 tiebreaker); the quote_options query terminates at a single
      // .order(option_index). `firstOrder` is thenable (so quote_options
      // resolves directly) and also exposes .order() so the quotes
      // tiebreaker chain reaches `terminal`, which exposes .range() (#1588).
      const terminal = {
        range: (from: number, to: number) => {
          rangeCalls.push([from, to]);
          return Promise.resolve(result);
        },
        then: (resolve: (v: Result) => void, reject: (e: unknown) => void) =>
          Promise.resolve(result).then(resolve, reject),
      };
      const firstOrder = {
        order: () => terminal,
        then: (resolve: (v: Result) => void, reject: (e: unknown) => void) =>
          Promise.resolve(result).then(resolve, reject),
      };
      const chain = {
        select: () => chain,
        in: () => chain,
        order: () => firstOrder,
      };
      return chain;
    },
  };
  return { db, tablesQueried, rangeCalls };
}

function req(query = ""): Request {
  return new Request(`https://tenant.example.com/api/quotes${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
    user: { id: "u1", auth_user_id: "auth-1", tenant_id: TENANT_ID, status: "active", role: "agent" },
  });
});

describe("GET /api/quotes — representative-option grouping + flatten", () => {
  it("flattens each quote's representative option (customer-selected wins) and isolates options per quote", async () => {
    const { db } = makeDb(
      {
        data: [
          { id: "q1", status: "sent", created_at: "2026-06-02T00:00:00Z" },
          { id: "q2", status: "draft", created_at: "2026-06-01T00:00:00Z" },
        ],
        error: null,
      },
      {
        data: [
          // q1: lower-index option is NOT selected; the customer-selected
          // higher-index option must win (§38.4.3).
          { quote_id: "q1", option_index: 1, customer_selected: false, cruise_line: "Royal", ship_name: "Icon", sailing_date: "2026-09-01", total_amount_cents: 100000 },
          { quote_id: "q1", option_index: 2, customer_selected: true, cruise_line: "Celebrity", ship_name: "Edge", sailing_date: "2026-10-04", total_amount_cents: 250000 },
          // q2: a single option — must not pick up q1's options.
          { quote_id: "q2", option_index: 1, customer_selected: false, cruise_line: "NCL", ship_name: "Bliss", sailing_date: "2026-08-15", total_amount_cents: 99999 },
        ],
        error: null,
      },
    );
    mocks.tenantClient.mockReturnValue(db);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quotes: Array<Record<string, unknown>> };

    expect(body.quotes).toHaveLength(2);
    // q1 → the customer-selected option, not the lower-index one.
    expect(body.quotes[0]).toMatchObject({
      id: "q1",
      cruise_line: "Celebrity",
      ship_name: "Edge",
      sailing_date: "2026-10-04",
      total_amount_cents: 250000,
    });
    // q2 → its own single option, proving the Map grouping isolates quotes.
    expect(body.quotes[1]).toMatchObject({
      id: "q2",
      cruise_line: "NCL",
      total_amount_cents: 99999,
    });
  });

  it("flattens trip + total to null for a quote with no options", async () => {
    const { db } = makeDb(
      { data: [{ id: "q1", status: "draft", created_at: "2026-06-02T00:00:00Z" }], error: null },
      { data: [], error: null },
    );
    mocks.tenantClient.mockReturnValue(db);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quotes: Array<Record<string, unknown>> };
    expect(body.quotes[0]).toMatchObject({
      id: "q1",
      cruise_line: null,
      ship_name: null,
      sailing_date: null,
      total_amount_cents: null,
    });
  });

  it("short-circuits an empty quote list WITHOUT issuing the quote_options query", async () => {
    const { db, tablesQueried } = makeDb({ data: [], error: null }, { data: [], error: null });
    mocks.tenantClient.mockReturnValue(db);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quotes: unknown[] };
    expect(body.quotes).toEqual([]);
    expect(tablesQueried).toEqual(["quotes"]); // options read never happened
  });

  it("returns 500 when the container read errors (fail-loud, no silent empty list)", async () => {
    const { db } = makeDb({ data: null, error: { message: "quotes RLS" } }, { data: [], error: null });
    mocks.tenantClient.mockReturnValue(db);

    const res = await GET(req());
    expect(res.status).toBe(500);
  });

  it("returns 500 when the quote_options read errors (fail-loud)", async () => {
    const { db } = makeDb(
      { data: [{ id: "q1", status: "draft", created_at: "2026-06-02T00:00:00Z" }], error: null },
      { data: null, error: { message: "quote_options RLS" } },
    );
    mocks.tenantClient.mockReturnValue(db);

    const res = await GET(req());
    expect(res.status).toBe(500);
  });

  it("delegates auth errors to respondToAuthError (401 for invalid session)", async () => {
    mocks.assertPermission.mockRejectedValue(
      new Error("assertPermission: invalid or expired access token."),
    );
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  // #1588 — PostgREST silently truncates unbounded selects at its max-rows
  // default, so a tenant with more quotes than that cap would lose rows off
  // the end with no signal. Pin that the route now issues an explicit
  // .range() (never an unbounded select) and honors caller-supplied
  // limit/offset, echoing them back with `total` so a client can tell it's
  // seeing a partial page rather than everything.
  it("honors limit/offset query params via .range() and echoes total/limit/offset", async () => {
    const { db, rangeCalls } = makeDb(
      { data: [{ id: "q1", status: "draft", created_at: "2026-06-02T00:00:00Z" }], error: null, count: 137 },
      { data: [], error: null },
    );
    mocks.tenantClient.mockReturnValue(db);

    const res = await GET(req("?limit=20&offset=40"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; limit: number; offset: number };

    expect(rangeCalls).toEqual([[40, 59]]); // offset, offset + limit - 1
    expect(body.total).toBe(137);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(40);
  });

  it("clamps an oversized limit to the MAX_LIMIT cap rather than trusting the caller", async () => {
    const { db, rangeCalls } = makeDb(
      { data: [], error: null, count: 0 },
      { data: [], error: null },
    );
    mocks.tenantClient.mockReturnValue(db);

    const res = await GET(req("?limit=100000"));
    const body = (await res.json()) as { limit: number };
    expect(body.limit).toBe(200);
    expect(rangeCalls).toEqual([[0, 199]]);
  });
});
