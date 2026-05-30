// §7.1 — /api/auth/me + /api/auth/signout (#445).
//
// Contracts pinned here:
//   1. /me returns the caller's identity + role + display fields. When
//      consent is pending it does NOT 403 (which would hide the pending
//      list from the very endpoint clients use to discover it); it
//      returns 200 with consent_pending + return_to.
//   2. /signout has no auth check — it must clear cookies whether or not
//      the request carries a valid session, idempotently. supabase.auth
//      .signOut() emits the cookie-clear via setAll, and applyAuthCookies
//      flushes them onto the 204 response.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  usersMaybeSingle: vi.fn(),
  signOut: vi.fn(),
  applyAuthCookiesSpy: vi.fn(<T>(res: T): T => res),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
      "@/lib/auth/assert-permission",
    );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/auth/ssr-client", () => ({
  createRequestScopedClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: mocks.usersMaybeSingle }),
        }),
      }),
    }),
  }),
  createRouteHandlerClient: () => ({
    supabase: { auth: { signOut: mocks.signOut } },
    applyAuthCookies: mocks.applyAuthCookiesSpy,
  }),
}));

import { GET as ME_GET } from "@/app/api/auth/me/route";
import { POST as SIGNOUT_POST } from "@/app/api/auth/signout/route";
import { ConsentPendingError } from "@/lib/auth/assert-permission";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyAuthCookiesSpy.mockImplementation(<T>(res: T): T => res);
  mocks.signOut.mockResolvedValue({ error: null });
});

function meReq(): Request {
  return new Request("https://tenant.example.com/api/auth/me", {
    headers: { "x-resolved-tenant-id": TENANT_ID },
  });
}

function signoutReq(): NextRequest {
  return new NextRequest("https://tenant.example.com/api/auth/signout", {
    method: "POST",
    headers: { "x-resolved-tenant-id": TENANT_ID },
  });
}

describe("GET /api/auth/me", () => {
  it("returns the caller's identity, role, and display fields on the happy path", async () => {
    mocks.assertPermission.mockResolvedValue({
      ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "auth-1" } },
      user: {
        id: "user-row-1",
        auth_user_id: "auth-1",
        tenant_id: TENANT_ID,
        status: "active",
        role: "tenant_owner",
      },
    });
    mocks.usersMaybeSingle.mockResolvedValue({
      data: { email: "alice@example.com", first_name: "Alice", last_name: "A." },
      error: null,
    });

    const res = await ME_GET(meReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      user_id: "user-row-1",
      auth_user_id: "auth-1",
      tenant_id: TENANT_ID,
      role: "tenant_owner",
      email: "alice@example.com",
      first_name: "Alice",
      last_name: "A.",
      consent_pending: [],
    });
  });

  it("returns 200 with consent_pending + return_to when assertPermission throws ConsentPendingError (don't 403 the discovery endpoint)", async () => {
    const pending = [
      { document_type: "tou", document_id_pending: "doc-9", flagged_at: "2026-05-30T00:00:00Z" },
    ];
    mocks.assertPermission.mockRejectedValue(
      new ConsentPendingError("/api/auth/me", pending),
    );

    const res = await ME_GET(meReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.consent_pending).toEqual(pending);
    expect(body.return_to).toBe("/api/auth/me");
    expect(body.user_id).toBeNull();
  });

  it("falls back to nulls when the users-row lookup returns no row (defensive)", async () => {
    mocks.assertPermission.mockResolvedValue({
      ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "auth-2" } },
      user: {
        id: "user-row-2",
        auth_user_id: "auth-2",
        tenant_id: TENANT_ID,
        status: "active",
        role: "agent",
      },
    });
    mocks.usersMaybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await ME_GET(meReq());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.email).toBeNull();
    expect(body.first_name).toBeNull();
    expect(body.last_name).toBeNull();
    expect(body.role).toBe("agent");
  });

  it("delegates non-consent auth errors to respondToAuthError (no rebuilt error path)", async () => {
    mocks.assertPermission.mockRejectedValue(
      new Error("assertPermission: invalid or expired access token."),
    );
    const res = await ME_GET(meReq());
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/signout", () => {
  it("calls supabase.auth.signOut and flushes cookie-clear through applyAuthCookies", async () => {
    const res = await SIGNOUT_POST(signoutReq());
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.applyAuthCookiesSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(204);
  });

  it("is idempotent — even with no session, it still returns 204 (no 401)", async () => {
    // Simulate the @supabase/ssr signOut on a no-session request: it
    // resolves without error and sets no cookies. The route must not 401.
    mocks.signOut.mockResolvedValue({ error: { message: "no session" } });
    const res = await SIGNOUT_POST(signoutReq());
    expect(res.status).toBe(204);
  });
});
