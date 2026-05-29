// §7.6 / §14.4 — PATCH /api/bookings/[id] gates editable fields by status.
//
// Imports the real gating helpers used by the PATCH route so a change to the
// per-status allowlist fails this suite (D-091 / #384 — no in-test
// reimplementation).

import { describe, it, expect } from "vitest";
import {
  PATCHABLE_FIELDS_BY_STATUS,
  isStatusPatchable,
  isFieldPatchable,
} from "@/lib/bookings/patchable-fields";

describe("PATCH state-machine gating (§7.6 / §14.4)", () => {
  it("allows trip-detail edits in draft", () => {
    expect(isFieldPatchable("draft", "cruise_line")).toBe(true);
    expect(isFieldPatchable("draft", "sailing_date")).toBe(true);
    expect(isFieldPatchable("draft", "total_amount_cents")).toBe(true);
  });

  it("allows the same fields in pending_host_review (agent fixes + resubmits)", () => {
    expect(isFieldPatchable("pending_host_review", "cruise_line")).toBe(true);
    expect(isFieldPatchable("pending_host_review", "total_amount_cents")).toBe(true);
  });

  it("draft and pending_host_review expose the identical field set", () => {
    expect([...PATCHABLE_FIELDS_BY_STATUS.pending_host_review!].sort()).toEqual(
      [...PATCHABLE_FIELDS_BY_STATUS.draft!].sort(),
    );
  });

  it("locks edits during submitting (host call in flight)", () => {
    expect(isStatusPatchable("submitting")).toBe(false);
    expect(isFieldPatchable("submitting", "cruise_line")).toBe(false);
  });

  it("locks edits after submitted / confirmed (must use modify flow)", () => {
    expect(isStatusPatchable("submitted")).toBe(false);
    expect(isStatusPatchable("confirmed")).toBe(false);
  });

  it("locks edits in terminal states (cancelled / failed)", () => {
    expect(isStatusPatchable("cancelled")).toBe(false);
    expect(isStatusPatchable("failed")).toBe(false);
  });

  it("rejects platform-only fields even in an editable status", () => {
    expect(isFieldPatchable("draft", "host_booking_reference")).toBe(false);
    expect(isFieldPatchable("draft", "ai_paused_by_platform")).toBe(false);
    expect(isFieldPatchable("draft", "is_test")).toBe(false);
    expect(isFieldPatchable("draft", "status")).toBe(false);
  });
});
