// #781 — PATCH route FK behavior: explicit intent test.
//
// When a user PATCHes cruise_line or ship_name to a value that the canonical
// matcher does NOT recognise, the FK (cruise_line_id / cruise_ship_id) MUST
// be set to null IN THE DB WRITE. This prevents a stale FK pointing to the
// wrong entity when the free-text field changes. The backfill job handles the
// inverse case (never overwrite an existing FK) — the PATCH route is
// semantically different because the user is explicitly changing the
// free-text value.
//
// These tests invoke the real bookings PATCH handler and assert on the
// payload passed to db.update() — deleting the `r.matched ? r.id : null`
// assignment in the route fails every test here.
//
// Contrast: the backfill filters rows where EITHER FK is null and only writes
// FK keys when the entity matched (see backfill-cruise-fk.test.ts). The
// quote-options PATCH applies the same clear-on-unmatched rule via extraFks.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  tenantClient: vi.fn(),
  safeAwait: vi.fn(),
  resolveCanonical: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: mocks.assertPermission,
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: mocks.tenantClient,
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: () => Response.json({ error: "auth" }, { status: 401 }),
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: mocks.safeAwait,
  safeAwaitRowCount: vi.fn(),
}));

vi.mock("@/lib/canonical/resolve-canonical", () => ({
  resolveCanonical: mocks.resolveCanonical,
}));

import { PATCH } from "@/app/api/bookings/[id]/route";

// Fake tenant db: select-chain resolves the current row (draft = editable);
// update() captures the patch payload the route writes.
const updateSpy = vi.fn();
function makeDb() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: "b-1", status: "draft" }, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        updateSpy(patch);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  };
}

function patchReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/bookings/b-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: "b-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: "t-1" } });
  mocks.tenantClient.mockReturnValue(makeDb());
  mocks.safeAwait.mockImplementation(async (q: unknown) => q);
});

describe("bookings PATCH — unmatched free-text clears FK in the DB write", () => {
  it("unmatched line → update payload carries cruise_line_id: null", async () => {
    mocks.resolveCanonical.mockResolvedValueOnce({ matched: false });
    const res = await PATCH(patchReq({ cruise_line: "Some Unknown Cruise Line" }), { params });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cruise_line: "Some Unknown Cruise Line", cruise_line_id: null }),
    );
  });

  it("matched line → update payload carries the canonical id", async () => {
    mocks.resolveCanonical.mockResolvedValueOnce({ matched: true, id: "line-uuid-1" });
    const res = await PATCH(patchReq({ cruise_line: "Royal Caribbean" }), { params });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cruise_line_id: "line-uuid-1" }),
    );
    expect(mocks.resolveCanonical).toHaveBeenCalledWith("Royal Caribbean", "line", expect.anything());
  });

  it("unmatched ship → update payload carries cruise_ship_id: null", async () => {
    mocks.resolveCanonical.mockResolvedValueOnce({ matched: false });
    const res = await PATCH(patchReq({ ship_name: "SS Nessie" }), { params });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ship_name: "SS Nessie", cruise_ship_id: null }),
    );
  });

  it("matched ship → update payload carries the canonical id", async () => {
    mocks.resolveCanonical.mockResolvedValueOnce({ matched: true, id: "ship-uuid-2" });
    const res = await PATCH(patchReq({ ship_name: "Harmony of the Seas" }), { params });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cruise_ship_id: "ship-uuid-2" }),
    );
    expect(mocks.resolveCanonical).toHaveBeenCalledWith("Harmony of the Seas", "ship", expect.anything());
  });

  it("patch without cruise_line/ship_name never calls the matcher", async () => {
    const res = await PATCH(patchReq({ cabin_category: "Balcony" }), { params });
    expect(res.status).toBe(200);
    expect(mocks.resolveCanonical).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ cruise_line_id: expect.anything() }),
    );
  });
});
