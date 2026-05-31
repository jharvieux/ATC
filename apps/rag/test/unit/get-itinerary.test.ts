// #487 — GET /api/itinerary: scope enforcement, param validation, DB error, null result.
//
// The client (`getSailingItinerary`) is already covered by sailing-itinerary.test.ts.
// These tests cover the server-side route logic: the three behavioral branches
// (scope guard → 403, missing params → 400, DB error → 500) and the null-result
// 200 path that the client tests rely on.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock the auth wrapper ────────────────────────────────────────────────────
let currentScope = "read";
vi.mock("@/lib/auth/with-service-auth", () => ({
  withServiceAuth: (handler: (req: Request, ctx: { scope: string }) => Promise<Response>) => {
    return (req: Request) => handler(req, { scope: currentScope });
  },
}));

// ── Mock the RAG DB ──────────────────────────────────────────────────────────
let dbResult: { data: unknown; error: unknown } = { data: null, error: null };

vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => ({
    from() {
      const builder = {
        select() { return this; },
        eq() { return this; },
        limit() { return this; },
        async maybeSingle() { return dbResult; },
      };
      return builder;
    },
  }),
}));

import { GET } from "../../src/app/api/itinerary/route";

const BASE_URL = "https://rag.test/api/itinerary?cruise_line=NCL&ship=Bliss&departure_date=2026-08-28";

const ROUTE_CTX = { params: Promise.resolve({}) };

function makeReq(url = BASE_URL): Request {
  return new Request(url);
}

beforeEach(() => {
  currentScope = "read";
  dbResult = { data: null, error: null };
});

describe("GET /api/itinerary — scope enforcement", () => {
  it("rejects write scope with 403", async () => {
    currentScope = "write";
    const res = await GET(makeReq(), ROUTE_CTX);
    expect(res.status).toBe(403);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("insufficient_scope");
  });
});

describe("GET /api/itinerary — param validation", () => {
  it("returns 400 when departure_date is missing", async () => {
    const res = await GET(makeReq("https://rag.test/api/itinerary?cruise_line=NCL&ship=Bliss"), ROUTE_CTX);
    expect(res.status).toBe(400);
  });

  it("returns 400 when cruise_line is missing", async () => {
    const res = await GET(makeReq("https://rag.test/api/itinerary?ship=Bliss&departure_date=2026-08-28"), ROUTE_CTX);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/itinerary — DB paths", () => {
  it("returns 500 on DB error", async () => {
    dbResult = { data: null, error: { message: "connection refused" } };
    const res = await GET(makeReq(), ROUTE_CTX);
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("db_error");
  });

  it("returns 200 with null body when sailing is not found", async () => {
    dbResult = { data: null, error: null };
    const res = await GET(makeReq(), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("returns 200 with itinerary data when found", async () => {
    const itinerary = {
      ports_of_call: ["Roatán", "Cozumel"],
      day_by_day: [{ day_number: 1, date: "2026-08-28", port_name: null }],
      region: "Caribbean Cruise",
    };
    dbResult = { data: itinerary, error: null };
    const res = await GET(makeReq(), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(itinerary);
  });
});
