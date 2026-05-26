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

// -- Boundary coverage targeting Stryker-found survivors -------------------

describe("validate lead_notification — party_size boundaries", () => {
  function leadWithSize(party_size: number | null) {
    return {
      type: "lead_notification" as const,
      tenant_id: "t1",
      fields: {
        contact_name: "Jane",
        contact_email: "jane@example.com",
        contact_phone: null,
        interest_summary: "x",
        destination: "y",
        travel_window: "z",
        party_size,
      },
    };
  }
  it("accepts party_size=1 (boundary)", async () => {
    const flags = await validate(leadWithSize(1), fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("party_size"))).toBeUndefined();
  });
  it("accepts party_size=50 (boundary)", async () => {
    const flags = await validate(leadWithSize(50), fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("party_size"))).toBeUndefined();
  });
  it("flags party_size=0 (below boundary)", async () => {
    const flags = await validate(leadWithSize(0), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("party_size 0"))).toBe(true);
  });
  it("flags party_size=51 (above boundary)", async () => {
    const flags = await validate(leadWithSize(51), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("party_size 51"))).toBe(true);
  });
  it("does NOT flag party_size=null (skips the check entirely)", async () => {
    const flags = await validate(leadWithSize(null), fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("party_size"))).toBeUndefined();
  });
});

describe("validate lead_notification — email plausibility", () => {
  function leadWithEmail(email: string | null) {
    return {
      type: "lead_notification" as const,
      tenant_id: "t1",
      fields: {
        contact_name: "Jane",
        contact_email: email,
        contact_phone: "555-0100",
        interest_summary: "x",
        destination: "y",
        travel_window: "z",
        party_size: 2,
      },
    };
  }
  it("flags 'not an email'", async () => {
    const flags = await validate(leadWithEmail("not an email"), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("does not look like a valid address"))).toBe(true);
  });
  it("flags 'missing-at-symbol.com'", async () => {
    const flags = await validate(leadWithEmail("missing-at-symbol.com"), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.flag === "implausible_value")).toBe(true);
  });
  it("flags 'missing-tld@nope'", async () => {
    const flags = await validate(leadWithEmail("missing-tld@nope"), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.flag === "implausible_value")).toBe(true);
  });
  it("accepts valid email", async () => {
    const flags = await validate(leadWithEmail("jane.doe+tag@example.co.uk"), fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.flag === "implausible_value")).toBeUndefined();
  });
});

describe("validate booking_confirmation — boundaries", () => {
  function bookingWith(overrides: Record<string, unknown>) {
    return {
      type: "booking_confirmation" as const,
      tenant_id: "t1",
      fields: {
        cruise_line: "Royal",
        ship_name: "Wonder",
        sailing_date: "2026-12-01",
        departure_port: "Miami",
        duration_nights: 7,
        provider_booking_ref: "REF-1",
        total_amount_cents: 100000,
        currency: "USD",
        commission_rate: 0.12,
        passenger_first_name: "J",
        passenger_last_name: "D",
        ...overrides,
      },
    };
  }

  it("flags sailing_date >24h in the past", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const flags = await validate(bookingWith({ sailing_date: twoDaysAgo }), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("is in the past"))).toBe(true);
  });
  it("does NOT flag sailing_date 23h ago (within the 24h grace)", async () => {
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    const flags = await validate(bookingWith({ sailing_date: twentyThreeHoursAgo }), fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("is in the past"))).toBeUndefined();
  });

  it("flags total_amount_cents=0", async () => {
    const flags = await validate(bookingWith({ total_amount_cents: 0 }), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("must be positive"))).toBe(true);
  });
  it("flags negative total_amount_cents", async () => {
    const flags = await validate(bookingWith({ total_amount_cents: -100 }), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("must be positive"))).toBe(true);
  });
  it("accepts total_amount_cents=1 (boundary)", async () => {
    const flags = await validate(bookingWith({ total_amount_cents: 1 }), fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("total_amount_cents"))).toBeUndefined();
  });

  it("flags currency missing when amount present", async () => {
    const flags = await validate(bookingWith({ currency: null }), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("currency absent"))).toBe(true);
  });
  it("does NOT flag currency missing when amount is also null", async () => {
    const flags = await validate(
      bookingWith({ currency: null, total_amount_cents: null }),
      fakeDb({ data: [], error: null }),
    );
    expect(flags.find((f) => f.reason.includes("currency absent"))).toBeUndefined();
  });

  it("flags commission_rate=-0.01 (below 0)", async () => {
    const flags = await validate(bookingWith({ commission_rate: -0.01 }), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("commission_rate"))).toBe(true);
  });
  it("flags commission_rate=0.51 (above 0.5)", async () => {
    const flags = await validate(bookingWith({ commission_rate: 0.51 }), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("commission_rate"))).toBe(true);
  });
  it("accepts commission_rate=0 (boundary)", async () => {
    const flags = await validate(bookingWith({ commission_rate: 0 }), fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("commission_rate"))).toBeUndefined();
  });
  it("accepts commission_rate=0.5 (boundary)", async () => {
    const flags = await validate(bookingWith({ commission_rate: 0.5 }), fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("commission_rate"))).toBeUndefined();
  });

  it("flags duration_nights=0 (below 1)", async () => {
    const flags = await validate(bookingWith({ duration_nights: 0 }), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("duration_nights"))).toBe(true);
  });
  it("flags duration_nights=366 (above 365)", async () => {
    const flags = await validate(bookingWith({ duration_nights: 366 }), fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("duration_nights"))).toBe(true);
  });
  it("accepts duration_nights=1 (boundary)", async () => {
    const flags = await validate(bookingWith({ duration_nights: 1 }), fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("duration_nights"))).toBeUndefined();
  });
  it("accepts duration_nights=365 (boundary)", async () => {
    const flags = await validate(bookingWith({ duration_nights: 365 }), fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("duration_nights"))).toBeUndefined();
  });
});

describe("validate booking_confirmation — duplicate detection", () => {
  function bookingMin(ref: string | null) {
    return {
      type: "booking_confirmation" as const,
      tenant_id: "t1",
      fields: {
        cruise_line: "Royal", ship_name: "Wonder", sailing_date: "2026-12-01",
        departure_port: "Miami", duration_nights: 7, provider_booking_ref: ref,
        total_amount_cents: 100000, currency: "USD", commission_rate: 0.12,
        passenger_first_name: "J", passenger_last_name: "D",
      },
    };
  }
  it("flags duplicate when bookings query returns a row", async () => {
    const flags = await validate(
      bookingMin("REF-DUP"),
      fakeDb({ data: [{ id: "existing-booking-1" }], error: null }),
    );
    expect(flags.some((f) => f.flag === "duplicate_provider_booking_ref")).toBe(true);
  });
  it("does NOT flag duplicate when bookings returns empty", async () => {
    const flags = await validate(
      bookingMin("REF-NEW"),
      fakeDb({ data: [], error: null }),
    );
    expect(flags.find((f) => f.flag === "duplicate_provider_booking_ref")).toBeUndefined();
  });
  it("flags duplicate_check_failed on DB error", async () => {
    const flags = await validate(
      bookingMin("REF-1"),
      fakeDb({ data: null, error: { message: "rls denied" } }),
    );
    expect(flags.some((f) => f.flag === "duplicate_check_failed")).toBe(true);
  });
  it("does NOT query bookings when provider_booking_ref is null (also triggers missing_required)", async () => {
    const flags = await validate(
      bookingMin(null),
      fakeDb({ data: [], error: null }),
    );
    expect(flags.find((f) => f.flag === "duplicate_provider_booking_ref")).toBeUndefined();
    expect(flags.some((f) => f.reason === "provider_booking_ref absent")).toBe(true);
  });
});

describe("validate commission_statement — line item completeness", () => {
  it("flags line_items missing provider_booking_ref", async () => {
    const flags = await validate(
      {
        type: "commission_statement",
        tenant_id: "t1",
        fields: {
          statement_period_start: "2026-04-01",
          statement_period_end: "2026-05-01",
          line_items: [
            { provider_booking_ref: null, passenger_first_name: "J", passenger_last_name: "D",
              commissionable_fare_cents: 100000, commission_rate: 0.12, commission_amount_cents: 12000 },
          ],
        },
      },
      fakeDb({ data: [], error: null }),
    );
    expect(flags.some((f) => f.flag === "line_items_incomplete")).toBe(true);
  });
  it("flags line_items missing commission_amount_cents", async () => {
    const flags = await validate(
      {
        type: "commission_statement",
        tenant_id: "t1",
        fields: {
          statement_period_start: "2026-04-01",
          statement_period_end: "2026-05-01",
          line_items: [
            { provider_booking_ref: "REF-1", passenger_first_name: "J", passenger_last_name: "D",
              commissionable_fare_cents: 100000, commission_rate: 0.12, commission_amount_cents: null },
          ],
        },
      },
      fakeDb({ data: [], error: null }),
    );
    expect(flags.some((f) => f.flag === "line_items_incomplete")).toBe(true);
  });
});

describe("validate booking_confirmation — exact-boundary dates", () => {
  it("flags sailing_date at exactly 24h + 1s ago", async () => {
    const just_over = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000).toISOString();
    const flags = await validate({
      type: "booking_confirmation",
      tenant_id: "t1",
      fields: {
        cruise_line: "Royal", ship_name: "Wonder", sailing_date: just_over,
        departure_port: "Miami", duration_nights: 7, provider_booking_ref: "REF-1",
        total_amount_cents: 100000, currency: "USD", commission_rate: 0.12,
        passenger_first_name: "J", passenger_last_name: "D",
      },
    }, fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("is in the past"))).toBe(true);
  });
  it("does NOT flag sailing_date at exactly 24h ago - 1s (just inside grace)", async () => {
    const just_under = new Date(Date.now() - 24 * 60 * 60 * 1000 + 1000).toISOString();
    const flags = await validate({
      type: "booking_confirmation",
      tenant_id: "t1",
      fields: {
        cruise_line: "Royal", ship_name: "Wonder", sailing_date: just_under,
        departure_port: "Miami", duration_nights: 7, provider_booking_ref: "REF-1",
        total_amount_cents: 100000, currency: "USD", commission_rate: 0.12,
        passenger_first_name: "J", passenger_last_name: "D",
      },
    }, fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("is in the past"))).toBeUndefined();
  });
});

describe("validate commission_statement — period date boundary", () => {
  it("flags statement_period_start === statement_period_end (single-day = suspicious)", async () => {
    // Open question whether equal dates should flag — the spec says "start
    // after end". Current implementation uses strict `>`, so equal dates DO NOT
    // flag. Locks that semantic: equal-date statements pass plausibility.
    const flags = await validate({
      type: "commission_statement",
      tenant_id: "t1",
      fields: {
        statement_period_start: "2026-05-01",
        statement_period_end: "2026-05-01",
        line_items: [{
          provider_booking_ref: "REF-1", passenger_first_name: "J", passenger_last_name: "D",
          commissionable_fare_cents: 100000, commission_rate: 0.12, commission_amount_cents: 12000,
        }],
      },
    }, fakeDb({ data: [], error: null }));
    expect(flags.find((f) => f.reason.includes("after statement_period_end"))).toBeUndefined();
  });
  it("flags statement_period_start one day after end (clear violation)", async () => {
    const flags = await validate({
      type: "commission_statement",
      tenant_id: "t1",
      fields: {
        statement_period_start: "2026-05-02",
        statement_period_end: "2026-05-01",
        line_items: [{
          provider_booking_ref: "REF-1", passenger_first_name: "J", passenger_last_name: "D",
          commissionable_fare_cents: 100000, commission_rate: 0.12, commission_amount_cents: 12000,
        }],
      },
    }, fakeDb({ data: [], error: null }));
    expect(flags.some((f) => f.reason.includes("after statement_period_end"))).toBe(true);
  });
});
