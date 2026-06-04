// Tests for fetchPersonaCustomerBio. The branches matter for the
// /agents/[slug] route's contract — if the DB returns null (persona
// missing, inactive, or bio not yet authored), the page must fall back
// to the in-code catalog bio so the page still renders. If the DB
// errors, that's a real 500 and we must throw rather than silently
// degrade.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMaybeSingle = vi.fn();
const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: mockFrom }),
}));

import { fetchPersonaCustomerBio } from "@/lib/agents/fetch-customer-bio";

describe("fetchPersonaCustomerBio", () => {
  beforeEach(() => {
    mockMaybeSingle.mockReset();
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockEq.mockClear();
  });

  it("returns the bio text when the persona is active and has a customer_bio", async () => {
    // The happy path the route depends on.
    mockMaybeSingle.mockResolvedValueOnce({
      data: { customer_bio: "Marcus has spent fifteen years...", is_active: true },
      error: null,
    });
    const result = await fetchPersonaCustomerBio("marcus-cole");
    expect(result).toBe("Marcus has spent fifteen years...");
  });

  it("returns null when the persona row doesn't exist (catalog fallback intent)", async () => {
    // Why: /agents/[slug] must still render the in-code catalog bio
    // when a slug hasn't been seeded into the DB yet. The function's
    // null return is the signal that triggers that fallback.
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await fetchPersonaCustomerBio("not-in-db-yet");
    expect(result).toBeNull();
  });

  it("returns null when the persona is inactive (don't surface deactivated agents)", async () => {
    // An admin can deactivate a persona via is_active=false. Falling
    // through to catalog would still show the page — but the catalog
    // is the right source of truth for "soft-removed" personas (catalog
    // entry can be removed too) and the read still terminates cleanly.
    mockMaybeSingle.mockResolvedValueOnce({
      data: { customer_bio: "old text", is_active: false },
      error: null,
    });
    const result = await fetchPersonaCustomerBio("deactivated-slug");
    expect(result).toBeNull();
  });

  it("returns null when customer_bio is whitespace-only (admin started editing then cleared)", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { customer_bio: "   \n  ", is_active: true },
      error: null,
    });
    const result = await fetchPersonaCustomerBio("marcus-cole");
    expect(result).toBeNull();
  });

  it("throws on DB error rather than silently falling back (fail-loud contract)", async () => {
    // Why: a legit DB outage should 500 the route, not silently render
    // the catalog bio while production data is unavailable. The catch-
    // and-fallback pattern would mask incidents — the audit explicitly
    // ruled out that posture.
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "connection refused" },
    });
    await expect(fetchPersonaCustomerBio("marcus-cole")).rejects.toThrow(
      /fetchPersonaCustomerBio: connection refused/,
    );
  });
});
