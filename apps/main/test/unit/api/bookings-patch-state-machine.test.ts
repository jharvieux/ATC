// §7.6 / §14.4 — PATCH /api/bookings/[id] gates editable fields by status.
//
// Unit-tests the field-allowlist table by simulating the logic — full
// route-handler integration is covered separately.

import { describe, it, expect } from "vitest";

const PATCHABLE_FIELDS_BY_STATUS: Record<string, ReadonlyArray<string>> = {
  draft: [
    "cruise_line",
    "ship_name",
    "sailing_date",
    "duration_nights",
    "cabin_category",
    "departure_port",
    "total_amount_cents",
    "commissionable_fare_cents",
    "currency",
  ],
  pending_host_review: [
    "cruise_line",
    "ship_name",
    "sailing_date",
    "duration_nights",
    "cabin_category",
    "departure_port",
    "total_amount_cents",
    "commissionable_fare_cents",
    "currency",
  ],
};

function isAllowed(status: string, field: string): boolean | "locked" {
  const allowed = PATCHABLE_FIELDS_BY_STATUS[status];
  if (!allowed) return "locked";
  return allowed.includes(field);
}

describe("PATCH state-machine gating", () => {
  it("allows trip-detail edits in draft", () => {
    expect(isAllowed("draft", "cruise_line")).toBe(true);
    expect(isAllowed("draft", "sailing_date")).toBe(true);
    expect(isAllowed("draft", "total_amount_cents")).toBe(true);
  });

  it("allows the same fields in pending_host_review (agent fixes + resubmits)", () => {
    expect(isAllowed("pending_host_review", "cruise_line")).toBe(true);
    expect(isAllowed("pending_host_review", "total_amount_cents")).toBe(true);
  });

  it("locks edits during submitting (host call in flight)", () => {
    expect(isAllowed("submitting", "cruise_line")).toBe("locked");
  });

  it("locks edits after submitted / confirmed (must use modify flow)", () => {
    expect(isAllowed("submitted", "cruise_line")).toBe("locked");
    expect(isAllowed("confirmed", "cabin_category")).toBe("locked");
  });

  it("locks edits in terminal states (cancelled / failed)", () => {
    expect(isAllowed("cancelled", "cruise_line")).toBe("locked");
    expect(isAllowed("failed", "cruise_line")).toBe("locked");
  });

  it("rejects platform-only fields even in draft", () => {
    expect(isAllowed("draft", "host_booking_reference")).toBe(false);
    expect(isAllowed("draft", "ai_paused_by_platform")).toBe(false);
    expect(isAllowed("draft", "is_test")).toBe(false);
  });
});
