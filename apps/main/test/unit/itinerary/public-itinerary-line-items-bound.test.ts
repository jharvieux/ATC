// #1836 — GET /i/[token] (public itinerary page) booking_line_items read.
//
// #1788 bounded this read with .limit(MAX_BOOKING_LINE_ITEMS) but no .order()
// — which 500 rows come back once a booking exceeds the cap is undefined
// without one. Mirrors the same fix + test shape as the itinerary send-path
// (test/unit/api/itinerary-send-line-items-bound.test.ts). This page had no
// test coverage at all before this issue.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_BOOKING_LINE_ITEMS } from "@/lib/line-items/validate";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const ITINERARY_ID = "iiiiiiii-iiii-iiii-iiii-iiiiiiiiiiii";
const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TOKEN = "public-token-abc123";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/audit/write", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "user-agent": "test-agent" })),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const ITIN_ROW = {
  id: ITINERARY_ID,
  tenant_id: TENANT_ID,
  booking_id: BOOKING_ID,
  status: "sent",
  agent_notes: null,
  bookings: {
    cruise_line: "Royal Caribbean",
    ship_name: "Icon of the Seas",
    sailing_date: "2026-09-01",
    duration_nights: 7,
    cabin_category: "Balcony",
    departure_port: "Miami",
    primary_contact_id: null,
  },
  tenants: { display_name: "Acme Travel" },
};

function makeSvc(liOrderCalls: Array<[string, unknown]>, liData: unknown[]) {
  return {
    from(table: string) {
      if (table === "trip_itineraries") {
        return { select: () => ({ eq: () => ({ neq: () => ({ maybeSingle: async () => ({ data: ITIN_ROW, error: null }) }) }) }) };
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue(undefined);
});

describe("GET /i/[token] — booking_line_items bound read (#1836)", () => {
  it("orders by start_date ascending (nulls last) before applying the MAX_BOOKING_LINE_ITEMS cap", async () => {
    const liOrderCalls: Array<[string, unknown]> = [];
    const svc = makeSvc(liOrderCalls, []);
    vi.doMock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: () => svc }));
    vi.resetModules();
    const { default: PublicItineraryPage } = await import("@/app/i/[token]/page");

    await PublicItineraryPage({ params: Promise.resolve({ token: TOKEN }) });

    expect(liOrderCalls).toEqual([
      ["start_date", { ascending: true, nullsFirst: false }],
      ["__limit__", MAX_BOOKING_LINE_ITEMS],
    ]);
  });

  it("renders the full capped set when the booking is at the MAX_BOOKING_LINE_ITEMS cap (total-detection)", async () => {
    const liData = Array.from({ length: MAX_BOOKING_LINE_ITEMS }, (_, i) => ({
      id: `li-${i}`,
      item_type: "other" as const,
      description: `Item ${i}`,
      supplier_name: null,
      start_date: null,
      include_in_itinerary: i % 2 === 0,
    }));
    const liOrderCalls: Array<[string, unknown]> = [];
    const svc = makeSvc(liOrderCalls, liData);
    vi.doMock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: () => svc }));
    vi.resetModules();
    const { default: PublicItineraryPage } = await import("@/app/i/[token]/page");

    const element = await PublicItineraryPage({ params: Promise.resolve({ token: TOKEN }) });

    expect(liOrderCalls.at(-1)).toEqual(["__limit__", MAX_BOOKING_LINE_ITEMS]);
    // Walk the returned element tree for the rendered <li> count instead of a
    // full DOM render — half of the capped rows pass include_in_itinerary.
    const html = JSON.stringify(element);
    const liCount = (html.match(/"Item \d+"/g) ?? []).length;
    expect(liCount).toBe(MAX_BOOKING_LINE_ITEMS / 2);
  });
});
