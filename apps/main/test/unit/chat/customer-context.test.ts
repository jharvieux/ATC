// §20.4 — resolveCustomerContext: tenant scoping + ref-type fan-out.

import { describe, it, expect, vi } from "vitest";
import { resolveCustomerContext } from "@/lib/chat/customer-context";

type Row = Record<string, unknown> | null;

function makeDb(routes: Record<string, { row: Row; error?: { message: string } | null }>) {
  return {
    from(table: string) {
      const lookup: { id?: string; tenant_id?: string } = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "id") lookup.id = val;
          if (col === "tenant_id") lookup.tenant_id = val;
          return chain;
        },
        maybeSingle: async () => {
          const key = `${table}:${lookup.id}:${lookup.tenant_id}`;
          const hit = routes[key];
          if (!hit) return { data: null, error: null };
          return { data: hit.row, error: hit.error ?? null };
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof resolveCustomerContext>[0]["db"];
}

describe("resolveCustomerContext", () => {
  it("returns booking context with formatted price + cabin fields", async () => {
    const db = makeDb({
      "bookings:b1:t1": {
        row: {
          id: "b1",
          tenant_id: "t1",
          cruise_line: "Royal Caribbean",
          ship_name: "Wonder of the Seas",
          sailing_date: "2026-08-15",
          duration_nights: 7,
          cabin_category: "Balcony",
          departure_port: "Miami",
          total_amount_cents: 245000,
          currency: "USD",
          status: "draft",
        },
      },
    });
    const ctx = await resolveCustomerContext({ ref: { type: "booking", id: "b1" }, tenant_id: "t1", db });
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("Royal Caribbean");
    expect(ctx).toContain("Wonder of the Seas");
    expect(ctx).toContain("7 nights");
    expect(ctx).toContain("USD 2450.00");
    expect(ctx).toContain("Do NOT promise prices");
  });

  it("returns null when booking belongs to a different tenant (cross-tenant guard)", async () => {
    const db = makeDb({
      // Note: the row only exists under tenant t1, but we're asking for tenant t2.
      "bookings:b1:t1": { row: { id: "b1", tenant_id: "t1" } },
    });
    const ctx = await resolveCustomerContext({ ref: { type: "booking", id: "b1" }, tenant_id: "t2", db });
    expect(ctx).toBeNull();
  });

  it("returns null on DB error rather than throwing (best-effort enrichment)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = makeDb({
      "bookings:b1:t1": { row: null, error: { message: "boom" } },
    });
    const ctx = await resolveCustomerContext({ ref: { type: "booking", id: "b1" }, tenant_id: "t1", db });
    expect(ctx).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("handles quote context with expiry + status", async () => {
    const db = makeDb({
      "quotes:q1:t1": {
        row: {
          id: "q1",
          tenant_id: "t1",
          status: "sent",
          expires_at: "2026-06-15",
          cruise_line: "Holland America",
          ship_name: "Eurodam",
          sailing_date: "2026-09-01",
          duration_nights: 10,
          total_price_cents: 312500,
          currency: "USD",
        },
      },
    });
    const ctx = await resolveCustomerContext({ ref: { type: "quote", id: "q1" }, tenant_id: "t1", db });
    expect(ctx).toContain("Eurodam");
    expect(ctx).toContain("USD 3125.00");
    expect(ctx).toContain("Quote expires: 2026-06-15");
    expect(ctx).toContain("Quote status: sent");
  });

  it("merges itinerary + booking lookups for trip_itinerary", async () => {
    const db = makeDb({
      "trip_itineraries:i1:t1": {
        row: { id: "i1", tenant_id: "t1", booking_id: "b1", agent_notes: "Sea-day brunch reserved." },
      },
      "bookings:b1:t1": {
        row: {
          cruise_line: "Celebrity",
          ship_name: "Edge",
          sailing_date: "2026-10-04",
          duration_nights: 11,
          departure_port: "Fort Lauderdale",
        },
      },
    });
    const ctx = await resolveCustomerContext({ ref: { type: "trip_itinerary", id: "i1" }, tenant_id: "t1", db });
    expect(ctx).toContain("Celebrity");
    expect(ctx).toContain("Edge");
    expect(ctx).toContain("Sea-day brunch reserved.");
    expect(ctx).toContain("The trip is already booked");
  });

  it("renders dashes when optional booking fields are null", async () => {
    const db = makeDb({
      "bookings:b1:t1": {
        row: {
          id: "b1",
          tenant_id: "t1",
          cruise_line: null,
          ship_name: null,
          sailing_date: null,
          duration_nights: null,
          cabin_category: null,
          departure_port: null,
          total_amount_cents: null,
          currency: null,
          status: null,
        },
      },
    });
    const ctx = await resolveCustomerContext({ ref: { type: "booking", id: "b1" }, tenant_id: "t1", db });
    expect(ctx).toContain("Cruise line: —");
    expect(ctx).toContain("Total: —");
  });
});
