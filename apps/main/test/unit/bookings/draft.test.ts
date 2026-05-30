// §7.6 / §20.2 — POST /api/bookings/draft (#448).
//
// Contracts pinned here:
//   1. Status is forced to "draft" — caller can't request a different
//      status. The /submit and PATCH routes drive transitions.
//   2. tenant_id comes from ctx, NEVER the body — two-layer isolation
//      depends on this. A malicious body that tries to set tenant_id is
//      ignored (zod .strict rejects unknown keys).
//   3. primary_contact_id ownership: passing a contact_id that belongs
//      to another tenant returns 422 contact_not_found (the contacts
//      SELECT through tenantClient returns null on RLS-hidden rows;
//      same shape as a truly missing id so we don't leak cross-tenant
//      existence).
//   4. Mutation fail-loud: safeAwait wraps the insert so a DB error
//      surfaces, not a silent 201 with a nonsense id.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  contactMaybeSingle: vi.fn(),
  insertSingle: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
      "@/lib/auth/assert-permission",
    );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "contacts") {
        // tenantClient proxy auto-injects .eq("tenant_id", ...) on
        // select(), but vi.mock replaces the whole tenantClient — the
        // mock only needs to model what the *route* calls directly:
        // .select(...).eq("id", ...).maybeSingle().
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.contactMaybeSingle }),
          }),
        };
      }
      // bookings
      return {
        insert: () => ({
          select: () => ({ single: mocks.insertSingle }),
        }),
      };
    },
  }),
}));

import { POST } from "@/app/api/bookings/draft/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const CONTACT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
    user: {
      id: "u1",
      auth_user_id: "auth-1",
      tenant_id: TENANT_ID,
      status: "active",
      role: "agent",
    },
  });
  mocks.insertSingle.mockResolvedValue({ data: { id: "booking-1" }, error: null });
});

function postReq(body: unknown): Request {
  return new Request("https://tenant.example.com/api/bookings/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/bookings/draft", () => {
  it("creates a draft with no body (blank draft, contact bound later)", async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("booking-1");
    // contacts lookup is skipped when no primary_contact_id was sent
    expect(mocks.contactMaybeSingle).not.toHaveBeenCalled();
  });

  it("rejects an unknown body field via zod .strict() (no caller-controlled status / tenant_id)", async () => {
    const res = await POST(postReq({ status: "submitted", tenant_id: "evil" }));
    expect(res.status).toBe(400);
    expect(mocks.insertSingle).not.toHaveBeenCalled();
  });

  it("rejects a primary_contact_id that isn't a uuid (zod string().uuid())", async () => {
    const res = await POST(postReq({ primary_contact_id: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("when primary_contact_id is provided AND belongs to this tenant, the draft binds it", async () => {
    mocks.contactMaybeSingle.mockResolvedValue({
      data: { id: CONTACT_ID },
      error: null,
    });
    const res = await POST(postReq({ primary_contact_id: CONTACT_ID }));
    expect(res.status).toBe(201);
    expect(mocks.contactMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it("returns 422 when primary_contact_id is not found in this tenant (RLS hides cross-tenant rows)", async () => {
    mocks.contactMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(postReq({ primary_contact_id: CONTACT_ID }));
    expect(res.status).toBe(422);
    expect(mocks.insertSingle).not.toHaveBeenCalled();
  });

  it("returns 500 when the contacts lookup itself errors (fail-loud, no silent 201)", async () => {
    mocks.contactMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "rls failure" },
    });
    const res = await POST(postReq({ primary_contact_id: CONTACT_ID }));
    expect(res.status).toBe(500);
    expect(mocks.insertSingle).not.toHaveBeenCalled();
  });

  it("safeAwait surfaces a DB error from the insert as a 500 via respondToAuthError", async () => {
    mocks.insertSingle.mockResolvedValue({
      data: null,
      error: { message: "duplicate key", code: "23505" },
    });
    const res = await POST(postReq({}));
    expect(res.status).toBe(500);
  });

  it("delegates auth errors to respondToAuthError (401 for invalid session)", async () => {
    mocks.assertPermission.mockRejectedValue(
      new Error("assertPermission: invalid or expired access token."),
    );
    const res = await POST(postReq({}));
    expect(res.status).toBe(401);
  });

  it("delegates AuthForbidden to respondToAuthError as 403 (RBAC)", async () => {
    const { AuthForbidden } = await import("@/lib/auth/assert-permission");
    mocks.assertPermission.mockRejectedValue(
      new AuthForbidden("bookings", "create", "viewer"),
    );
    const res = await POST(postReq({}));
    expect(res.status).toBe(403);
  });
});
