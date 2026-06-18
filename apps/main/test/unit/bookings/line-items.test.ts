// §40.5 — GET + POST /api/bookings/[id]/line-items.
//
// Covers: auth gate, tier gate (POST only), schema validation, item-type
// validation, happy-path list, and happy-path create → 201.
// GET is thin (no gate beyond auth); POST has tier + validate layers.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  lineItemsGate: vi.fn(),
  lineItemsList: vi.fn(),
  lineItemsInsertSingle: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/line-items/tier-gate", () => ({
  assertLineItemsAvailable: mocks.lineItemsGate,
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          order: () => mocks.lineItemsList(),
        }),
      }),
      insert: () => ({
        select: () => ({ single: mocks.lineItemsInsertSingle }),
      }),
    }),
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));

import { GET, POST } from "@/app/api/bookings/[id]/line-items/route";

const PARAMS = { params: Promise.resolve({ id: BOOKING_ID }) };

function makeGetReq(): Request {
  return new Request(`https://example.com/api/bookings/${BOOKING_ID}/line-items`, { method: "GET" });
}

function makePostReq(body: unknown = VALID_BODY): Request {
  return new Request(`https://example.com/api/bookings/${BOOKING_ID}/line-items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  item_type: "flight",
  description: "Return flight SYD-BCN",
  customer_cost_cents: 120000,
};

const CREATED_ITEM = {
  id: "li-001",
  tenant_id: TENANT_ID,
  booking_id: BOOKING_ID,
  item_type: "flight",
  description: "Return flight SYD-BCN",
  customer_cost_cents: 120000,
  status: "planned",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID },
    user: { id: USER_ID },
  });
  mocks.lineItemsGate.mockResolvedValue({ ok: true });
  mocks.lineItemsList.mockResolvedValue({ data: [], error: null });
  mocks.lineItemsInsertSingle.mockResolvedValue({ data: CREATED_ITEM, error: null });
});

// --- GET ---

describe("GET /api/bookings/[id]/line-items — auth gate", () => {
  it("returns 401 when assertPermission throws", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("assertPermission: missing Authorization Bearer token"));
    const res = await GET(makeGetReq(), PARAMS);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/bookings/[id]/line-items — list", () => {
  it("returns { items: [] } when there are no line items", async () => {
    const res = await GET(makeGetReq(), PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("returns line items in the list", async () => {
    mocks.lineItemsList.mockResolvedValue({ data: [CREATED_ITEM], error: null });
    const res = await GET(makeGetReq(), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });
});

// --- POST ---

describe("POST /api/bookings/[id]/line-items — auth gate", () => {
  it("returns 401 when assertPermission throws", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("assertPermission: missing Authorization Bearer token"));
    const res = await POST(makePostReq(), PARAMS);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/bookings/[id]/line-items — tier gate", () => {
  it("returns 403 when line-items tier gate is blocked", async () => {
    mocks.lineItemsGate.mockResolvedValue({ ok: false, reason: "feature_not_in_tier" });
    const res = await POST(makePostReq(), PARAMS);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("feature_not_in_tier");
  });
});

describe("POST /api/bookings/[id]/line-items — schema validation", () => {
  it("returns 400 when description is missing", async () => {
    const res = await POST(makePostReq({ item_type: "flight", customer_cost_cents: 100 }), PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_body");
  });

  it("returns 400 when item_type is not a valid enum value", async () => {
    const res = await POST(makePostReq({ ...VALID_BODY, item_type: "yacht" }), PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_body");
  });

  it("returns 400 when customer_cost_cents is negative", async () => {
    const res = await POST(makePostReq({ ...VALID_BODY, customer_cost_cents: -1 }), PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_body");
  });

  it("returns 400 when customer_cost_cents is missing", async () => {
    const res = await POST(makePostReq({ item_type: "hotel", description: "Hotel night" }), PARAMS);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/bookings/[id]/line-items — happy path", () => {
  it("creates line item and returns 201", async () => {
    const res = await POST(makePostReq(), PARAMS);
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; item_type: string };
    expect(body.id).toBe("li-001");
    expect(body.item_type).toBe("flight");
  });

  it("§40.6 — 'other' item_type defaults include_in_itinerary:false unless caller overrides", async () => {
    // The validator defaults include_in_itinerary to false for 'other' type.
    // A mutant that flips the default polarity would cause this item to be
    // included in the itinerary, surfacing here via the insert spy.
    mocks.lineItemsInsertSingle.mockImplementation(() => {
      // Verify the shape passed to .insert() set include_in_itinerary:false for 'other'
      return Promise.resolve({ data: { ...CREATED_ITEM, item_type: "other", include_in_itinerary: false }, error: null });
    });
    const res = await POST(
      makePostReq({ item_type: "other", description: "Misc charge", customer_cost_cents: 500 }),
      PARAMS,
    );
    expect(res.status).toBe(201);
  });

  it("non-'other' item_type defaults include_in_itinerary:true", async () => {
    mocks.lineItemsInsertSingle.mockResolvedValue({
      data: { ...CREATED_ITEM, include_in_itinerary: true },
      error: null,
    });
    const res = await POST(makePostReq({ ...VALID_BODY, item_type: "hotel", description: "Hotel" }), PARAMS);
    expect(res.status).toBe(201);
  });
});
