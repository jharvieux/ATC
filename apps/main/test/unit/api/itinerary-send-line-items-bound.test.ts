// #1836 — PATCH /api/itineraries/[id] (send path) booking_line_items read.
//
// #1788 bounded this read with .limit(MAX_BOOKING_LINE_ITEMS) but no .order()
// — which 500 rows come back once a booking exceeds the cap is undefined
// without one. The sibling GET (/api/bookings/[id]/line-items) already orders
// by start_date before limiting; this pins the same shape here, plus the
// send-path having ANY test coverage at all (it had none before this issue).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_BOOKING_LINE_ITEMS } from "@/lib/line-items/validate";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ITINERARY_ID = "iiiiiiii-iiii-iiii-iiii-iiiiiiiiiiii";
const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  renderItineraryPdf: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", () => ({ assertPermission: mocks.assertPermission }));
vi.mock("@/lib/deliverables/itinerary-pdf", () => ({ renderItineraryPdf: mocks.renderItineraryPdf }));
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: (err: unknown) => Response.json({ error: String(err) }, { status: 401 }),
}));

const ITIN_ROW = {
  id: ITINERARY_ID,
  tenant_id: TENANT_ID,
  booking_id: BOOKING_ID,
  status: "draft",
  access_token: "tok",
  agent_notes: null,
  bookings: {
    tenant_id: TENANT_ID,
    cruise_line: "Royal Caribbean",
    ship_name: "Icon of the Seas",
    sailing_date: "2026-09-01",
    duration_nights: 7,
    cabin_category: "Balcony",
    departure_port: "Miami",
    primary_contact_id: null, // skip the contacts lookup branch
  },
};

// Records the exact booking_line_items query chain calls so the test fails
// if .order() is dropped or its args regress.
function makeSvc(liOrderCalls: Array<[string, unknown]>, liData: unknown[]) {
  let tripItinerariesCalls = 0;
  return {
    from(table: string) {
      if (table === "trip_itineraries") {
        tripItinerariesCalls++;
        if (tripItinerariesCalls === 1) {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: ITIN_ROW, error: null }) }) }) };
        }
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({ data: { id: ITINERARY_ID, status: "sent" }, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { display_name: "Acme Travel" }, error: null }) }) }) };
      }
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { first_name: "Jordan", last_name: "Agent", email: "agent@example.com", phone: null },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "booking_line_items") {
        return {
          select: () => ({
            eq: () => ({
              order: (col: string, opts: unknown) => {
                liOrderCalls.push([col, opts]);
                return {
                  limit: (n: number) => {
                    liOrderCalls.push(["__limit__", n]);
                    return Promise.resolve({ data: liData, error: null });
                  },
                };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  };
}

function patchReq(body: Record<string, unknown>): Request {
  return new Request(`https://example.com/api/itineraries/${ITINERARY_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: TENANT_ID }, user: { id: USER_ID } });
  mocks.renderItineraryPdf.mockResolvedValue(Buffer.from("pdf-bytes"));
  mocks.writeAuditLog.mockResolvedValue(undefined);
});

describe("PATCH /api/itineraries/[id] send path — booking_line_items bound read (#1836)", () => {
  it("orders by start_date ascending (nulls last) before applying the MAX_BOOKING_LINE_ITEMS cap", async () => {
    const liOrderCalls: Array<[string, unknown]> = [];
    const svc = makeSvc(liOrderCalls, []);
    vi.doMock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: () => svc }));
    vi.resetModules();
    const { PATCH } = await import("@/app/api/itineraries/[id]/route");

    const res = await PATCH(patchReq({ send: true }), { params: Promise.resolve({ id: ITINERARY_ID }) });

    expect(res.status).toBe(200);
    // .order() must run before .limit() — that's the sequence that makes the
    // 500-row cap deterministic instead of "whichever 500 Postgres feels like".
    expect(liOrderCalls).toEqual([
      ["start_date", { ascending: true, nullsFirst: false }],
      ["__limit__", MAX_BOOKING_LINE_ITEMS],
    ]);
  });

  it("still succeeds and uses the capped set when the booking is at the MAX_BOOKING_LINE_ITEMS cap (total-detection)", async () => {
    // Simulate a booking whose line-item count is exactly at the cap — the
    // realistic "was this truncated?" boundary. include_in_itinerary is
    // alternated so the filter step is exercised over the full capped set,
    // not just a handful of rows.
    const liData = Array.from({ length: MAX_BOOKING_LINE_ITEMS }, (_, i) => ({
      id: `li-${i}`,
      item_type: "other" as const,
      description: `Item ${i}`,
      supplier_name: null,
      start_date: null,
      end_date: null,
      include_in_itinerary: i % 2 === 0,
    }));
    const liOrderCalls: Array<[string, unknown]> = [];
    const svc = makeSvc(liOrderCalls, liData);
    vi.doMock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: () => svc }));
    vi.resetModules();
    const { PATCH } = await import("@/app/api/itineraries/[id]/route");

    const res = await PATCH(patchReq({ send: true }), { params: Promise.resolve({ id: ITINERARY_ID }) });

    expect(res.status).toBe(200);
    // The query only ever requested MAX_BOOKING_LINE_ITEMS rows — confirms the
    // bound was actually sent to the DB, not just present as dead code.
    expect(liOrderCalls.at(-1)).toEqual(["__limit__", MAX_BOOKING_LINE_ITEMS]);
    expect(mocks.renderItineraryPdf).toHaveBeenCalledOnce();
    const pdfData = mocks.renderItineraryPdf.mock.calls[0]![0] as { line_items: unknown[] };
    // Half of the capped rows pass include_in_itinerary — proves the route
    // consumed the full capped array, not a truncated slice of it.
    expect(pdfData.line_items).toHaveLength(MAX_BOOKING_LINE_ITEMS / 2);
  });
});
