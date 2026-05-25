// BP34 §34.3.4 — validation layer tests.

import { describe, expect, it } from "vitest";
import { validate } from "@/lib/import/validation";

// Minimal fake supabase: only validate() touches db.from('bookings').
function fakeDb(dupResult: { data: { id: string }[] | null; error: { message: string } | null }) {
  return {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => Promise.resolve(dupResult),
          }),
        }),
      }),
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("validate lead_notification", () => {
  it("flags missing required fields", async () => {
    const flags = await validate(
      {
        type: "lead_notification",
        tenant_id: "t1",
        fields: {
          contact_name: null,
          contact_email: null,
          contact_phone: null,
          interest_summary: null,
          destination: null,
          travel_window: null,
          party_size: null,
        },
      },
      fakeDb({ data: [], error: null }),
    );
    const reasons = flags.map((f) => f.reason).join("|");
    expect(reasons).toContain("contact_name");
    expect(reasons).toContain("contact_email nor contact_phone");
  });

  it("accepts well-formed lead", async () => {
    const flags = await validate(
      {
        type: "lead_notification",
        tenant_id: "t1",
        fields: {
          contact_name: "Jane Doe",
          contact_email: "jane@example.com",
          contact_phone: null,
          interest_summary: "wants Alaska cruise summer",
          destination: "Alaska",
          travel_window: "summer 2026",
          party_size: 2,
        },
      },
      fakeDb({ data: [], error: null }),
    );
    expect(flags).toHaveLength(0);
  });

  it("flags implausible email and party_size", async () => {
    const flags = await validate(
      {
        type: "lead_notification",
        tenant_id: "t1",
        fields: {
          contact_name: "X",
          contact_email: "not-an-email",
          contact_phone: null,
          interest_summary: null,
          destination: null,
          travel_window: null,
          party_size: 99,
        },
      },
      fakeDb({ data: [], error: null }),
    );
    const reasons = flags.map((f) => f.reason).join("|");
    expect(reasons).toContain("not-an-email");
    expect(reasons).toContain("party_size 99");
  });
});

describe("validate booking_confirmation", () => {
  const baseFields = {
    cruise_line: "Royal Caribbean",
    ship_name: "Symphony of the Seas",
    sailing_date: "2030-06-15",
    departure_port: "Miami",
    duration_nights: 7,
    provider_booking_ref: "RC-12345",
    passenger_last_names: ["Doe"],
    total_amount_cents: 250000,
    currency: "USD",
    cabin_category: "Balcony",
    commission_rate: 0.12,
    commission_amount_cents: 30000,
  };

  it("accepts a clean booking with no duplicate", async () => {
    const flags = await validate(
      { type: "booking_confirmation", tenant_id: "t1", fields: baseFields },
      fakeDb({ data: [], error: null }),
    );
    expect(flags).toHaveLength(0);
  });

  it("flags duplicate provider_booking_ref", async () => {
    const flags = await validate(
      { type: "booking_confirmation", tenant_id: "t1", fields: baseFields },
      fakeDb({ data: [{ id: "existing-booking-id" }], error: null }),
    );
    expect(flags.some((f) => f.flag === "duplicate_provider_booking_ref")).toBe(true);
  });

  it("flags past sailing_date", async () => {
    const flags = await validate(
      {
        type: "booking_confirmation",
        tenant_id: "t1",
        fields: { ...baseFields, sailing_date: "2020-01-01" },
      },
      fakeDb({ data: [], error: null }),
    );
    expect(flags.some((f) => f.reason.includes("in the past"))).toBe(true);
  });

  it("flags commission_rate above 0.5", async () => {
    const flags = await validate(
      {
        type: "booking_confirmation",
        tenant_id: "t1",
        fields: { ...baseFields, commission_rate: 0.85 },
      },
      fakeDb({ data: [], error: null }),
    );
    expect(flags.some((f) => f.reason.includes("commission_rate"))).toBe(true);
  });

  it("flags currency absent when total present", async () => {
    const flags = await validate(
      {
        type: "booking_confirmation",
        tenant_id: "t1",
        fields: { ...baseFields, currency: null },
      },
      fakeDb({ data: [], error: null }),
    );
    expect(flags.some((f) => f.reason.includes("currency absent"))).toBe(true);
  });
});

describe("validate commission_statement", () => {
  it("always emits requires_human_review flag", async () => {
    const flags = await validate(
      {
        type: "commission_statement",
        tenant_id: "t1",
        fields: {
          statement_period_start: "2026-04-01",
          statement_period_end: "2026-04-30",
          line_items: [
            {
              provider_booking_ref: "RC-1",
              cruise_line: "RC",
              ship_name: "Symphony",
              sailing_date: "2026-03-01",
              passenger_last_name: "Doe",
              commissionable_fare_cents: 100000,
              commission_rate: 0.12,
              commission_amount_cents: 12000,
            },
          ],
        },
      },
      fakeDb({ data: [], error: null }),
    );
    expect(flags.some((f) => f.flag === "requires_human_review")).toBe(true);
  });

  it("flags empty line_items + inverted period", async () => {
    const flags = await validate(
      {
        type: "commission_statement",
        tenant_id: "t1",
        fields: {
          statement_period_start: "2026-05-01",
          statement_period_end: "2026-04-01",
          line_items: [],
        },
      },
      fakeDb({ data: [], error: null }),
    );
    const reasons = flags.map((f) => f.reason).join("|");
    expect(reasons).toContain("no line_items");
    expect(reasons).toContain("after statement_period_end");
  });
});

describe("validate intake_form", () => {
  it("flags zero preferences", async () => {
    const flags = await validate(
      {
        type: "intake_form",
        tenant_id: "t1",
        fields: {
          contact_name: "Jane",
          contact_email: "jane@example.com",
          contact_phone: null,
          preferences: {},
        },
      },
      fakeDb({ data: [], error: null }),
    );
    expect(flags.some((f) => f.reason.includes("zero preferences"))).toBe(true);
  });
});
