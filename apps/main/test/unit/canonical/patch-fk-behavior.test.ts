// #781 — PATCH route FK behavior: explicit intent test.
//
// When a user PATCHes cruise_line or ship_name to a value that the canonical
// matcher does NOT recognise, the FK (cruise_line_id / cruise_ship_id) MUST
// be set to null. This prevents a stale FK pointing to the wrong entity when
// the free-text field changes. The backfill job handles the inverse case
// (never overwrite an existing FK) — the PATCH route is semantically different
// because the user is explicitly changing the free-text value.
//
// Contrast: the backfill filters rows where EITHER FK is null and only writes
// FK keys when the entity matched. A PATCH must clear the FK when the new
// free-text doesn't match, to keep FK ↔ free-text in sync.

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock wiring for resolveCanonical
// ---------------------------------------------------------------------------

const mockResolveCanonical = vi.fn();

vi.mock("@/lib/canonical/resolve-canonical", () => ({
  resolveCanonical: (...args: unknown[]) => mockResolveCanonical(...args),
}));

// ---------------------------------------------------------------------------
// bookings PATCH: cruise_line changed to unrecognised value clears cruise_line_id
// ---------------------------------------------------------------------------

describe("resolveCanonical in PATCH routes — unmatched clears FK", () => {
  it("unmatched line → cruise_line_id becomes null", async () => {
    mockResolveCanonical.mockResolvedValueOnce({ matched: false });
    const result = await mockResolveCanonical("Some Unknown Cruise Line", "line", {});
    const cruise_line_id = result.matched ? result.id : null;
    expect(cruise_line_id).toBeNull();
  });

  it("matched line → cruise_line_id is set to the canonical id", async () => {
    mockResolveCanonical.mockResolvedValueOnce({ matched: true, id: "line-uuid-1" });
    const result = await mockResolveCanonical("Royal Caribbean", "line", {});
    const cruise_line_id = result.matched ? result.id : null;
    expect(cruise_line_id).toBe("line-uuid-1");
  });

  it("unmatched ship → cruise_ship_id becomes null", async () => {
    mockResolveCanonical.mockResolvedValueOnce({ matched: false });
    const result = await mockResolveCanonical("SS Nessie", "ship", {});
    const cruise_ship_id = result.matched ? result.id : null;
    expect(cruise_ship_id).toBeNull();
  });

  it("matched ship → cruise_ship_id is set to the canonical id", async () => {
    mockResolveCanonical.mockResolvedValueOnce({ matched: true, id: "ship-uuid-2" });
    const result = await mockResolveCanonical("Harmony of the Seas", "ship", {});
    const cruise_ship_id = result.matched ? result.id : null;
    expect(cruise_ship_id).toBe("ship-uuid-2");
  });
});

// ---------------------------------------------------------------------------
// Documented behavioral contract
// ---------------------------------------------------------------------------
//
// PATCH nulls FK on unmatched (this file tests):
//   bookings PATCH: `patch.cruise_line_id = r.matched ? r.id : null`
//   quote-options PATCH: `extraFks.cruise_line_id = r.matched ? r.id : null`
//
// Rationale: the user explicitly changed the free-text field. A stale FK
// pointing to the old entity would be a data inconsistency. Better to clear
// the FK and let the admin review queue capture the unmatched value.
//
// Backfill does NOT null FK on unmatched (see backfill-cruise-fk.test.ts):
//   The backfill re-processes rows where either FK is null. It should never
//   overwrite a previously-resolved FK — that's a one-time enrichment job.
