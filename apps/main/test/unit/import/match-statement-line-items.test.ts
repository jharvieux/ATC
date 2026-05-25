// BP34 §34.5.4 / §14.8 — Statement line-item matching tests.

import { describe, expect, it } from "vitest";
import { matchStatementLineItems } from "@/lib/import/match-statement-line-items";

function fakeSvc(rows: Array<{
  id: string;
  booking_id: string;
  provider_booking_ref: string | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  passenger_last_name: string | null;
}>) {
  // Mock the join shape returned by Supabase.
  const joined = rows.map((r) => ({
    id: r.id,
    booking_id: r.booking_id,
    bookings: {
      provider_booking_ref: r.provider_booking_ref,
      cruise_line: r.cruise_line,
      ship_name: r.ship_name,
      sailing_date: r.sailing_date,
      contacts: { last_name: r.passenger_last_name },
    },
  }));
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({ lte: () => Promise.resolve({ data: joined, error: null }) }),
          lte: () => Promise.resolve({ data: joined, error: null }),
          then: undefined, // ensures the call chain works without await chain magic
        }),
        // direct then() handler so awaiting query without gte/lte still works
        then: (resolve: (v: { data: typeof joined; error: null }) => void) =>
          resolve({ data: joined, error: null }),
      }),
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("matchStatementLineItems", () => {
  it("matches exact provider_booking_ref", async () => {
    const report = await matchStatementLineItems({
      tenant_id: "t1",
      statement: {
        statement_period_start: "2026-04-01",
        statement_period_end: "2026-04-30",
        line_items: [
          {
            provider_booking_ref: "RC-9001",
            cruise_line: "Royal Caribbean",
            ship_name: "Symphony of the Seas",
            sailing_date: "2026-06-15",
            passenger_last_name: "Doe",
            commissionable_fare_cents: 100000,
            commission_rate: 0.12,
            commission_amount_cents: 12000,
          },
        ],
      },
      svc: fakeSvc([
        {
          id: "c1",
          booking_id: "b1",
          provider_booking_ref: "RC-9001",
          cruise_line: "Royal Caribbean",
          ship_name: "Symphony of the Seas",
          sailing_date: "2026-06-15",
          passenger_last_name: "Doe",
        },
      ]),
    });

    expect(report.exact_ref_matches).toBe(1);
    expect(report.items[0]?.kind).toBe("exact_ref");
  });

  it("falls back to fuzzy match when ref is absent", async () => {
    const report = await matchStatementLineItems({
      tenant_id: "t1",
      statement: {
        statement_period_start: "2026-04-01",
        statement_period_end: "2026-04-30",
        line_items: [
          {
            provider_booking_ref: null,
            cruise_line: "Royal Caribbean",
            ship_name: "Symphony of the Seas",
            sailing_date: "2026-06-15",
            passenger_last_name: "Doe",
            commissionable_fare_cents: 100000,
            commission_rate: 0.12,
            commission_amount_cents: 12000,
          },
        ],
      },
      svc: fakeSvc([
        {
          id: "c1",
          booking_id: "b1",
          provider_booking_ref: "RC-9001", // doesn't match (line has null)
          cruise_line: "Royal Caribbean",
          ship_name: "Symphony of the Seas",
          sailing_date: "2026-06-15",
          passenger_last_name: "Doe",
        },
      ]),
    });

    expect(report.fuzzy_matches).toBe(1);
    const item = report.items[0];
    expect(item?.kind).toBe("fuzzy");
    if (item?.kind === "fuzzy") {
      expect(item.candidates[0]?.confidence).toBeGreaterThanOrEqual(0.85);
    }
  });

  it("marks orphan when no candidates score high enough", async () => {
    const report = await matchStatementLineItems({
      tenant_id: "t1",
      statement: {
        statement_period_start: "2026-04-01",
        statement_period_end: "2026-04-30",
        line_items: [
          {
            provider_booking_ref: null,
            cruise_line: "Carnival",
            ship_name: "Mardi Gras",
            sailing_date: "2026-08-01",
            passenger_last_name: "Smith",
            commissionable_fare_cents: 50000,
            commission_rate: 0.1,
            commission_amount_cents: 5000,
          },
        ],
      },
      svc: fakeSvc([
        {
          id: "c1",
          booking_id: "b1",
          provider_booking_ref: "RC-9001",
          cruise_line: "Royal Caribbean", // different line
          ship_name: "Symphony of the Seas",
          sailing_date: "2026-06-15", // different date
          passenger_last_name: "Doe", // different name
        },
      ]),
    });

    expect(report.orphans).toBe(1);
    expect(report.items[0]?.kind).toBe("orphan");
  });

  it("counts mix correctly across multiple lines", async () => {
    const report = await matchStatementLineItems({
      tenant_id: "t1",
      statement: {
        statement_period_start: "2026-04-01",
        statement_period_end: "2026-04-30",
        line_items: [
          {
            provider_booking_ref: "RC-9001",
            cruise_line: "Royal Caribbean",
            ship_name: "Symphony of the Seas",
            sailing_date: "2026-06-15",
            passenger_last_name: "Doe",
            commissionable_fare_cents: 100000,
            commission_rate: 0.12,
            commission_amount_cents: 12000,
          },
          {
            provider_booking_ref: null,
            cruise_line: "Norwegian",
            ship_name: "Bliss",
            sailing_date: "2026-07-01",
            passenger_last_name: "Ng",
            commissionable_fare_cents: 80000,
            commission_rate: 0.1,
            commission_amount_cents: 8000,
          },
        ],
      },
      svc: fakeSvc([
        {
          id: "c1",
          booking_id: "b1",
          provider_booking_ref: "RC-9001",
          cruise_line: "Royal Caribbean",
          ship_name: "Symphony of the Seas",
          sailing_date: "2026-06-15",
          passenger_last_name: "Doe",
        },
        {
          id: "c2",
          booking_id: "b2",
          provider_booking_ref: "NCL-555",
          cruise_line: "Carnival",
          ship_name: "Mardi Gras",
          sailing_date: "2026-09-01",
          passenger_last_name: "Smith",
        },
      ]),
    });

    expect(report.exact_ref_matches).toBe(1);
    expect(report.orphans).toBe(1);
  });
});
