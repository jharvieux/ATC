// #1565 — PATCH /api/admin/cruise-catalog/ships/[id] gained the RAG-populated
// stat fields (guest_capacity, decks, built_year, signature_feature) so staff
// have a curation path for columns with no automated ingestion.
//
// Intent under test:
//   1. A valid stat edit reaches the DB as the exact update payload and echoes
//      the updated row back.
//   2. Out-of-range / wrong-type stats are rejected at the boundary (400) and
//      NEVER reach the DB — a bad built_year must not silently coerce.
//   3. An empty signature_feature clears the column (null), not "".
//   4. A too-long signature_feature is rejected before the DB.
//   5. An unknown ship id (zero rows) surfaces as 404, not a 200 with null.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  lastUpdate: null as Record<string, unknown> | null,
  // Rows the .select() after the update resolves to.
  returnRows: [] as unknown[],
}));

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  assertPlatformAdminArea: async () => ({ admin_user_id: "admin-user-1" }),
  PlatformAdminError: class extends Error {},
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: async (
    _opts: unknown,
    fn: (db: unknown, recordQuery: (q: unknown) => void) => Promise<unknown>,
  ) => {
    const db = {
      from: (_table: string) => ({
        update: (payload: Record<string, unknown>) => {
          h.lastUpdate = payload;
          return {
            eq: (_col: string, _id: string) => ({
              select: async (_cols: string) => ({ data: h.returnRows, error: null }),
            }),
          };
        },
      }),
    };
    return fn(db, () => {});
  },
}));

import { PATCH } from "@/app/api/admin/cruise-catalog/ships/[id]/route";

function req(body: unknown): Request {
  return new Request("https://app.example.com/api/admin/cruise-catalog/ships/s-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", Authorization: "Bearer admin" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: "s-1" });

beforeEach(() => {
  h.lastUpdate = null;
  h.returnRows = [{ id: "s-1", canonical_name: "Icon of the Seas", signature_feature: "Category Six waterpark" }];
});

describe("PATCH /api/admin/cruise-catalog/ships/[id] — stat curation (#1565)", () => {
  it("writes valid stat fields and echoes the updated row", async () => {
    const res = await PATCH(
      req({ guest_capacity: 5610, decks: 20, built_year: 2024, signature_feature: "Category Six waterpark" }),
      { params },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ship: { signature_feature: string } };
    expect(body.ship.signature_feature).toBe("Category Six waterpark");

    // The exact payload reached the DB — no dropped or coerced fields.
    expect(h.lastUpdate).toMatchObject({
      guest_capacity: 5610,
      decks: 20,
      built_year: 2024,
      signature_feature: "Category Six waterpark",
    });
  });

  it.each([
    ["guest_capacity", { guest_capacity: 0 }, "invalid_guest_capacity"],
    ["guest_capacity non-integer", { guest_capacity: 12.5 }, "invalid_guest_capacity"],
    ["decks over cap", { decks: 500 }, "invalid_decks"],
    ["built_year too old", { built_year: 1800 }, "invalid_built_year"],
    ["built_year as string", { built_year: "2020" }, "invalid_built_year"],
  ])("rejects %s at the boundary without touching the DB", async (_label, patch, expectedError) => {
    const res = await PATCH(req(patch), { params });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(expectedError);
    // A rejected edit must never have reached the DB.
    expect(h.lastUpdate).toBeNull();
  });

  it("clears signature_feature to null when set to an empty string", async () => {
    const res = await PATCH(req({ signature_feature: "   " }), { params });
    expect(res.status).toBe(200);
    expect(h.lastUpdate).toMatchObject({ signature_feature: null });
  });

  it("stores an explicit null to clear guest_capacity", async () => {
    const res = await PATCH(req({ guest_capacity: null }), { params });
    expect(res.status).toBe(200);
    expect(h.lastUpdate).toMatchObject({ guest_capacity: null });
  });

  it("rejects a signature_feature longer than the column limit", async () => {
    const res = await PATCH(req({ signature_feature: "x".repeat(200) }), { params });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_signature_feature");
    expect(h.lastUpdate).toBeNull();
  });

  it("returns 404 when the ship id matches no row", async () => {
    h.returnRows = [];
    const res = await PATCH(req({ signature_feature: "Something" }), { params });
    expect(res.status).toBe(404);
  });

  it("rejects an edit with no editable fields", async () => {
    const res = await PATCH(req({}), { params });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_fields_to_update");
    expect(h.lastUpdate).toBeNull();
  });
});
