// BP40 §40.3 / §40.9 — line-item validation tests.

import { describe, expect, it } from "vitest";
import { computeExpectedCommissionCents, validateLineItem } from "@/lib/line-items/validate";

describe("validateLineItem", () => {
  it("rejects start > end on dates", () => {
    const r = validateLineItem({
      item_type: "hotel",
      start_date: "2026-05-10",
      end_date: "2026-05-08",
      item_details: { hotel_name: "x" },
    });
    expect(r.ok).toBe(false);
  });

  it("excursion requires same start/end day", () => {
    const r = validateLineItem({
      item_type: "excursion",
      start_date: "2026-05-10",
      end_date: "2026-05-11",
      item_details: null,
    });
    expect(r.ok).toBe(false);
  });

  it("flight requires depart_airport + arrive_airport", () => {
    const r = validateLineItem({
      item_type: "flight",
      start_date: null,
      end_date: null,
      item_details: { depart_airport: "LAX" }, // missing arrive
    });
    expect(r.ok).toBe(false);
  });

  it("hotel requires hotel_name + at-least-1-night between dates", () => {
    const r = validateLineItem({
      item_type: "hotel",
      start_date: "2026-05-10",
      end_date: "2026-05-10", // 0 nights
      item_details: { hotel_name: "Hyatt" },
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a clean flight", () => {
    const r = validateLineItem({
      item_type: "flight",
      start_date: "2026-03-14",
      end_date: "2026-03-14",
      item_details: { depart_airport: "LAX", arrive_airport: "FLL" },
    });
    expect(r.ok).toBe(true);
  });

  it("transfer + other + insurance pass with minimal data", () => {
    for (const t of ["transfer", "insurance", "other"] as const) {
      const r = validateLineItem({
        item_type: t,
        start_date: null,
        end_date: null,
        item_details: null,
      });
      expect(r.ok).toBe(true);
    }
  });

  // #2034 — per-type item_details allowlist. WHY it matters: item_details is
  // accepted as free-form JSON at the API boundary, so without an allowlist
  // passenger names / DOB / policy numbers could be smuggled into the blob and
  // evade the CCPA data map. Each test would pass if the allowlist were dropped
  // to a no-op, so they pin the actual gate.
  it("accepts spec-defined keys for each previously-unvalidated type", () => {
    const cases: Array<{ item_type: "transfer" | "excursion" | "insurance"; item_details: Record<string, unknown>; start_date: string | null; end_date: string | null }> = [
      { item_type: "transfer", start_date: null, end_date: null, item_details: { transfer_type: "private_car", pickup_location: "MIA", dropoff_location: "Port", pickup_datetime: "2026-03-14T11:00:00-04:00" } },
      { item_type: "excursion", start_date: "2026-03-14", end_date: "2026-03-14", item_details: { excursion_name: "Tulum", departure_time: "08:30", is_cruise_line_excursion: false } },
      { item_type: "insurance", start_date: null, end_date: null, item_details: { policy_provider: "Allianz", policy_number: "TR12345678", claims_url: "https://x/claims" } },
    ];
    for (const c of cases) {
      const r = validateLineItem(c);
      expect(r.ok, `${c.item_type} with spec keys should pass`).toBe(true);
    }
  });

  it("rejects a PII key that is not on the type's allowlist", () => {
    for (const item_type of ["transfer", "excursion", "insurance"] as const) {
      const r = validateLineItem({
        item_type,
        start_date: "2026-03-14",
        end_date: "2026-03-14",
        item_details: { passenger_name: "Jane Doe", passenger_dob: "1980-01-01" },
      });
      expect(r.ok, `${item_type} with PII keys must be rejected`).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toMatch(/unpermitted keys/);
    }
  });

  it("'other' accepts only its §40.3.6 keys (free_form_label / notes / url), rejects the rest", () => {
    expect(validateLineItem({ item_type: "other", start_date: null, end_date: null, item_details: { free_form_label: "Port parking", notes: "Reserved online", url: "https://x" } }).ok).toBe(true);
    expect(validateLineItem({ item_type: "other", start_date: null, end_date: null, item_details: {} }).ok).toBe(true);
    // An undocumented key is still rejected (not a free-for-all catch-all).
    expect(validateLineItem({ item_type: "other", start_date: null, end_date: null, item_details: { passenger_name: "Jane" } }).ok).toBe(false);
  });

  // #2031/#2034 spec-completeness: the allowlist must carry the FULL §40.3 key
  // set per type, not a narrower subset — a narrower list would 400 legitimate
  // payloads the API itself produced. These pin the full shapes from the spec.
  it("accepts a full §40.3.1 flight payload (every spec key)", () => {
    const r = validateLineItem({
      item_type: "flight",
      start_date: "2026-03-14",
      end_date: "2026-03-14",
      item_details: {
        airline_code: "UA",
        flight_number: "UA1234",
        depart_airport: "LAX",
        arrive_airport: "FLL",
        depart_datetime: "2026-03-14T08:00:00-07:00",
        arrive_datetime: "2026-03-14T16:30:00-04:00",
        cabin_class: "economy",
        passenger_count: 2,
        seat_assignments: ["12A", "12B"],
        loyalty_program_used: null,
        is_round_trip: false,
        return_depart_airport: null,
        return_arrive_airport: null,
        return_depart_datetime: null,
        return_arrive_datetime: null,
      },
    });
    expect(r.ok).toBe(true);
  });

  it("re-validates a stored full-shape blob on PATCH without an allowlist regression", () => {
    // A PATCH re-runs validateLineItem against the FULL stored item_details.
    // Every key accepted on create (the complete §40.3.2 hotel shape here) must
    // still pass, or an unrelated field edit would 400 on data we ourselves wrote.
    const storedHotel = {
      hotel_name: "Hyatt Regency Miami",
      address: "400 SE 2nd Ave, Miami, FL 33131",
      check_in_date: "2026-03-13",
      check_out_date: "2026-03-14",
      room_type: "King City View",
      guest_count: 2,
      nights: 1,
      loyalty_program_used: "World of Hyatt",
      purpose: "pre_cruise",
    };
    const r = validateLineItem({
      item_type: "hotel",
      start_date: "2026-03-13",
      end_date: "2026-03-14",
      item_details: storedHotel,
    });
    expect(r.ok).toBe(true);
  });

  it("still 400s an undocumented key even alongside a full spec payload", () => {
    const r = validateLineItem({
      item_type: "insurance",
      start_date: null,
      end_date: null,
      item_details: {
        policy_provider: "Allianz",
        policy_number: "TR12345678",
        coverage_type: "trip_cancellation_and_medical",
        coverage_amount_cents: 5000000,
        covered_persons_count: 2,
        claims_url: "https://x/claims",
        claims_phone: "+1-800-555-0100",
        passenger_passport: "X123", // undocumented → rejected
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/unpermitted keys/);
  });

  it("flight/hotel keep required-field checks AND reject unknown keys", () => {
    // Required check preserved: valid keys still pass.
    expect(validateLineItem({ item_type: "flight", start_date: null, end_date: null, item_details: { depart_airport: "LAX", arrive_airport: "FLL" } }).ok).toBe(true);
    // Unknown key rejected even when required fields are present.
    const r = validateLineItem({ item_type: "flight", start_date: null, end_date: null, item_details: { depart_airport: "LAX", arrive_airport: "FLL", passenger_passport: "X123" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/unpermitted keys/);
  });
});

describe("computeExpectedCommissionCents", () => {
  it("returns null when not commissionable", () => {
    expect(
      computeExpectedCommissionCents({ commissionable: false, customer_cost_cents: 100000, commission_rate: 0.1 }),
    ).toBeNull();
  });

  it("returns null when commission_rate is null", () => {
    expect(
      computeExpectedCommissionCents({ commissionable: true, customer_cost_cents: 100000, commission_rate: null }),
    ).toBeNull();
  });

  it("computes integer cents (half-away-from-zero rounding)", () => {
    expect(
      computeExpectedCommissionCents({ commissionable: true, customer_cost_cents: 123456, commission_rate: 0.075 }),
    ).toBe(Math.round(123456 * 0.075));
  });
});
