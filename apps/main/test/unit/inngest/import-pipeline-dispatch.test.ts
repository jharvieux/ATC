// §import — import-pipeline dispatch + retention math (P3 for #1217).
//
// File was 0% (210 NoCoverage) in the 2026-06-17 Stryker sweep. These three
// pure cores route every import through the right extractor/validator and set
// the row's purge clock — a mis-wired case or a dropped default branch is a
// silent data-handling bug, so they're pinned directly.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/import/extractors/lead-notification", () => ({
  extractLeadNotification: () => ({ extracted: "LEAD", per_field_confidence: {}, overall_confidence: 1 }),
}));
vi.mock("@/lib/import/extractors/booking-confirmation", () => ({
  extractBookingConfirmation: () => ({ extracted: "BOOKING", per_field_confidence: {}, overall_confidence: 1 }),
}));
vi.mock("@/lib/import/extractors/commission-statement", () => ({
  extractCommissionStatement: () => ({ extracted: "COMMISSION", per_field_confidence: {}, overall_confidence: 1 }),
}));
vi.mock("@/lib/import/extractors/intake-form", () => ({
  extractIntakeForm: () => ({ extracted: "INTAKE", per_field_confidence: {}, overall_confidence: 1 }),
}));

import { runExtractor, buildValidationInput, hoursFromNow } from "@/inngest/import-pipeline";

const ARGS = { tenant_id: "t1", text: "body" };

afterEach(() => {
  vi.useRealTimers();
});

describe("runExtractor — dispatch table", () => {
  it.each([
    ["lead_notification", "LEAD"],
    ["booking_confirmation", "BOOKING"],
    ["commission_statement", "COMMISSION"],
    ["intake_form", "INTAKE"],
  ])("routes %s to its extractor", async (type, sentinel) => {
    const r = await runExtractor(type, ARGS);
    expect(r.extracted).toBe(sentinel);
    expect(r.error).toBeUndefined();
  });

  // Default branch must be reachable and self-describing — an unknown type is
  // a soft error, not a thrown exception, so the queue row can be parked.
  it("returns a typed error (no throw) for an unknown type", async () => {
    const r = await runExtractor("mystery_doc", ARGS);
    expect(r.error).toBe("no_extractor_for_type:mystery_doc");
    expect(r.extracted).toBeNull();
    expect(r.overall_confidence).toBe(0);
  });
});

describe("buildValidationInput", () => {
  it.each(["lead_notification", "booking_confirmation", "commission_statement", "intake_form"])(
    "passes %s straight through with type/tenant/fields",
    (type) => {
      const fields = { a: 1 };
      expect(buildValidationInput(type, "tenant-9", fields)).toEqual({ type, tenant_id: "tenant-9", fields });
    },
  );

  it("throws for an unknown validation type rather than silently passing it on", () => {
    expect(() => buildValidationInput("mystery_doc", "tenant-9", {})).toThrow("unknown_validation_type:mystery_doc");
  });
});

describe("hoursFromNow — retention clock", () => {
  it("returns an ISO timestamp exactly N hours ahead of now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T00:00:00.000Z"));
    expect(hoursFromNow(24)).toBe("2026-06-20T00:00:00.000Z"); // accepted/auto_accepted
    expect(hoursFromNow(7 * 24)).toBe("2026-06-26T00:00:00.000Z"); // parse_failed
    expect(hoursFromNow(30 * 24)).toBe("2026-07-19T00:00:00.000Z"); // virus_detected
  });

  it("treats 0 hours as 'now'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T12:34:56.000Z"));
    expect(hoursFromNow(0)).toBe("2026-06-19T12:34:56.000Z");
  });
});
