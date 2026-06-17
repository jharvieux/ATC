// Regression test for #1183: PATCH /api/tenant/personas/[slug] was returning
// 404 on every call because it selected the nonexistent tenants.tier column.
// Fix: select tier_id, resolve to tier_definitions.code via a second query.
// This test confirms the route returns 200 for a valid agency-tier tenant
// and that the tier-code is correctly resolved and passed to upsertPersonaOverride.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  tierCode: "byo_agency" as string,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: { tenant_id: "tenant-1", source: { kind: "http_request", user_id: "auth-1" } },
  })),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn((err: unknown) => {
    return Response.json({ error: String(err) }, { status: 403 });
  }),
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: "tenant-1", tier_id: "tier-uuid-1", background_ai_enabled: true },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "tier_definitions") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { code: h.tierCode },
                error: null,
              }),
            }),
          }),
        };
      }
      // tenant_persona_overrides upsert path
      return {
        upsert: () => ({
          select: () => ({
            single: async () => ({ data: { id: "override-id-1" }, error: null }),
          }),
        }),
      };
    },
  }),
}));

vi.mock("@/lib/personas/screen-addendum", () => ({
  screenPersonaAddendum: vi.fn().mockResolvedValue({ approved: true }),
}));

vi.mock("@/lib/api/db-error-response", () => ({
  dbErrorResponse: vi.fn((err: unknown) => Response.json({ error: String(err) }, { status: 500 })),
}));

import { PATCH } from "@/app/api/tenant/personas/[slug]/route";

const makeReq = (slug: string, body: unknown) =>
  new Request(`http://localhost/api/tenant/personas/${slug}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const makeProps = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("PATCH /api/tenant/personas/[slug] — #1183 regression", () => {
  beforeEach(() => {
    h.tierCode = "byo_agency";
  });

  it("returns 200 and resolves tier_id to tier code correctly", async () => {
    const res = await PATCH(makeReq("marcus-cole", { display_name_override: "Marcus Jr." }), makeProps("marcus-cole"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 404 for unknown persona slug", async () => {
    const res = await PATCH(makeReq("unknown-slug", { display_name_override: "X" }), makeProps("unknown-slug"));
    expect(res.status).toBe(404);
  });

  it("returns 422 when byo_research tier tries to set display_name_override", async () => {
    h.tierCode = "byo_research";
    const res = await PATCH(makeReq("marcus-cole", { display_name_override: "Bobby" }), makeProps("marcus-cole"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/byo_research/);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/api/tenant/personas/marcus-cole", {
      method: "PATCH",
      body: "not-json",
    });
    const res = await PATCH(req, makeProps("marcus-cole"));
    expect(res.status).toBe(400);
  });
});
