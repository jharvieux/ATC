// #783 Phase 3 — Cruise catalog read routes for cascade-dropdown group booking.
//
// Intent under test:
//   1. GET /api/cruise-lines returns active lines ordered by display_name.
//   2. GET /api/cruise-lines returns 500 on DB error.
//   3. GET /api/cruise-ships?cruise_line_id= returns ships for that line.
//   4. GET /api/cruise-ships returns 400 when cruise_line_id is missing.
//   5. GET /api/cruise-ships returns 500 on DB error.
//   6. GET /api/cruise-sailings?cruise_ship_id= returns upcoming sailings with ports.
//   7. GET /api/cruise-sailings returns 400 when cruise_ship_id is missing.
//   8. GET /api/cruise-sailings returns 500 on DB error.
//   9. assertPermission is called with resource=groups action=create on all three routes.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "t-1";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  dbQuery: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

// tenantClient dispatches uniformly — one chainable builder for all three tables.
let mockChain: ReturnType<typeof makeMockChain>;
function makeMockChain() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    order: () => mocks.dbQuery(),
  };
  return chain;
}

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: () => mockChain,
  }),
}));

function makeRequest(url: string): Request {
  return new Request(`http://localhost${url}`);
}

beforeEach(() => {
  mockChain = makeMockChain();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID },
    user: { id: "u-1" },
  });
});

// ── /api/cruise-lines ──────────────────────────────────────────────────────

describe("GET /api/cruise-lines", () => {
  it("returns active lines on success", async () => {
    const lines = [{ id: "l-1", display_name: "Royal Caribbean", tier: "premium" }];
    mocks.dbQuery.mockResolvedValue({ data: lines, error: null });

    const { GET } = await import("@/app/api/cruise-lines/route");
    const res = await GET(makeRequest("/api/cruise-lines"));
    const json = await res.json() as { lines: unknown[] };

    expect(res.status).toBe(200);
    expect(json.lines).toEqual(lines);
  });

  it("returns 500 on DB error", async () => {
    mocks.dbQuery.mockResolvedValue({ data: null, error: { message: "db_fail" } });

    const { GET } = await import("@/app/api/cruise-lines/route");
    const res = await GET(makeRequest("/api/cruise-lines"));
    const json = await res.json() as { error: string };

    expect(res.status).toBe(500);
    expect(json.error).toBe("db_error");
    expect((json as { error: string; ref?: string }).ref).toBeTruthy();
  });

  it("calls assertPermission with groups:create", async () => {
    mocks.dbQuery.mockResolvedValue({ data: [], error: null });

    const { GET } = await import("@/app/api/cruise-lines/route");
    await GET(makeRequest("/api/cruise-lines"));

    expect(mocks.assertPermission).toHaveBeenCalledWith(
      expect.any(Request),
      { resource: "groups", action: "create" },
    );
  });
});

// ── /api/cruise-ships ──────────────────────────────────────────────────────

describe("GET /api/cruise-ships", () => {
  it("returns ships for a given cruise_line_id", async () => {
    const ships = [{ id: "s-1", canonical_name: "Symphony of the Seas", ship_class: "Oasis Class" }];
    mocks.dbQuery.mockResolvedValue({ data: ships, error: null });

    const { GET } = await import("@/app/api/cruise-ships/route");
    const res = await GET(makeRequest("/api/cruise-ships?cruise_line_id=l-1"));
    const json = await res.json() as { ships: unknown[] };

    expect(res.status).toBe(200);
    expect(json.ships).toEqual(ships);
  });

  it("returns 400 when cruise_line_id is missing", async () => {
    const { GET } = await import("@/app/api/cruise-ships/route");
    const res = await GET(makeRequest("/api/cruise-ships"));

    expect(res.status).toBe(400);
  });

  it("returns 500 on DB error", async () => {
    mocks.dbQuery.mockResolvedValue({ data: null, error: { message: "db_fail" } });

    const { GET } = await import("@/app/api/cruise-ships/route");
    const res = await GET(makeRequest("/api/cruise-ships?cruise_line_id=l-1"));
    const json = await res.json() as { error: string; ref?: string };

    expect(res.status).toBe(500);
    expect(json.error).toBe("db_error");
    expect(json.ref).toBeTruthy();
  });
});

// ── /api/cruise-sailings ───────────────────────────────────────────────────

describe("GET /api/cruise-sailings", () => {
  it("returns sailings with sorted ports for a given cruise_ship_id", async () => {
    const rawSailings = [
      {
        id: "sail-1",
        departure_date: "2026-09-15",
        departure_port: "Miami",
        duration_nights: 7,
        region: "Caribbean",
        starting_price: 899,
        sailing_port_calls: [
          { port_name: "Cozumel", day_index: 3 },
          { port_name: "Grand Cayman", day_index: 1 },
        ],
      },
    ];
    mocks.dbQuery.mockResolvedValue({ data: rawSailings, error: null });

    const { GET } = await import("@/app/api/cruise-sailings/route");
    const res = await GET(makeRequest("/api/cruise-sailings?cruise_ship_id=s-1"));
    const json = await res.json() as { sailings: Array<{ id: string; ports: string[] }> };

    expect(res.status).toBe(200);
    expect(json.sailings).toHaveLength(1);
    // Ports should be sorted by day_index: Grand Cayman (1) before Cozumel (3).
    expect(json.sailings[0]?.ports).toEqual(["Grand Cayman", "Cozumel"]);
  });

  it("returns 400 when cruise_ship_id is missing", async () => {
    const { GET } = await import("@/app/api/cruise-sailings/route");
    const res = await GET(makeRequest("/api/cruise-sailings"));

    expect(res.status).toBe(400);
  });

  it("returns 500 on DB error", async () => {
    mocks.dbQuery.mockResolvedValue({ data: null, error: { message: "db_fail" } });

    const { GET } = await import("@/app/api/cruise-sailings/route");
    const res = await GET(makeRequest("/api/cruise-sailings?cruise_ship_id=s-1"));
    const json = await res.json() as { error: string; ref?: string };

    expect(res.status).toBe(500);
    expect(json.error).toBe("db_error");
    expect(json.ref).toBeTruthy();
  });
});
