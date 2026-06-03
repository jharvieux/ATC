// §24.6 — POST /api/chat/conversations/[id]/persona (#589).
//
// Contracts pinned here:
//   1. The DB personas table is the SINGLE source of truth for switchable
//      slugs. There is no hardcoded KNOWN_SLUGS allowlist to drift from the
//      seed (#589 root cause). A slug the DB doesn't return is a 400
//      (unknown_persona_slug) — NOT a 500 seed-invariant.
//   2. Regression guard for the boundary the dropped allowlist used to
//      enforce: the lookup MUST scope to kind='travel_concierge' AND
//      is_active=true, so the platform help assistant (kind='platform_help')
//      and any deactivated persona stay non-switchable. If a future edit
//      drops either .eq(), help_ai becomes switchable — this test fails.
//   3. Empty/missing slug short-circuits to 400 WITHOUT touching the DB.
//   4. Mutations fail loud: a personas-lookup error, a messages.insert
//      error (safeAwait), or a conversations.update error each surface as
//      5xx, never a silent 200.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  personaMaybeSingle: vi.fn(),
  personaEqCalls: [] as Array<[string, unknown]>,
  messagesInsert: vi.fn(),
  conversationsUpdate: vi.fn(),
  conversationsUpdateEq: vi.fn(),
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
      if (table === "personas") {
        // Each .eq is captured so a test can assert the kind/is_active scope.
        const builder = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            mocks.personaEqCalls.push([col, val]);
            return builder;
          },
          maybeSingle: mocks.personaMaybeSingle,
        };
        return builder;
      }
      if (table === "messages") {
        // Awaited by safeAwait — resolve to a { data, error } shape.
        return { insert: mocks.messagesInsert };
      }
      // conversations: .update(payload).eq("id", ...) resolves to { error }.
      // update() is captured so a test can assert the active_persona_id payload.
      return { update: mocks.conversationsUpdate };
    },
  }),
}));

import { POST } from "@/app/api/chat/conversations/[id]/persona/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const CONV_ID = "99999999-8888-7777-6666-555555555555";
const PERSONA_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const params = { params: Promise.resolve({ id: CONV_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.personaEqCalls.length = 0;
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
  mocks.personaMaybeSingle.mockResolvedValue({
    data: { id: PERSONA_ID },
    error: null,
  });
  mocks.messagesInsert.mockResolvedValue({ data: null, error: null });
  mocks.conversationsUpdate.mockReturnValue({ eq: mocks.conversationsUpdateEq });
  mocks.conversationsUpdateEq.mockResolvedValue({ error: null });
});

function postReq(body: unknown): Request {
  return new Request(
    `https://tenant.example.com/api/chat/conversations/${CONV_ID}/persona`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/chat/conversations/[id]/persona", () => {
  it("switches to a travel persona the DB returns: 200 + records the switch", async () => {
    const res = await POST(postReq({ persona_slug: "marcus-cole" }), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; active_persona_slug: string };
    expect(body).toEqual({ ok: true, active_persona_slug: "marcus-cole" });
    // System transcript line written AND the resolved persona id persisted —
    // assert the payload, not just that update was called, so a dropped or
    // hardcoded active_persona_id can't pass silently.
    expect(mocks.messagesInsert).toHaveBeenCalledTimes(1);
    expect(mocks.conversationsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ active_persona_id: PERSONA_ID }),
    );
    expect(mocks.conversationsUpdateEq).toHaveBeenCalledWith("id", CONV_ID);
  });

  it("scopes the lookup to kind='travel_concierge' AND is_active=true (help_ai stays unswitchable, #589)", async () => {
    await POST(postReq({ persona_slug: "marcus-cole" }), params);
    // The dropped KNOWN_SLUGS allowlist used to keep platform_help /
    // deactivated personas off the switch list. These two filters are what
    // now enforce that boundary — losing either re-opens the #589 hazard.
    expect(mocks.personaEqCalls).toContainEqual(["slug", "marcus-cole"]);
    expect(mocks.personaEqCalls).toContainEqual(["kind", "travel_concierge"]);
    expect(mocks.personaEqCalls).toContainEqual(["is_active", true]);
  });

  it("returns 400 unknown_persona_slug when the DB has no matching row (DB is source of truth, NOT a 500)", async () => {
    mocks.personaMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(postReq({ persona_slug: "help-ai" }), params);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_persona_slug");
    // No switch recorded for a non-switchable slug.
    expect(mocks.messagesInsert).not.toHaveBeenCalled();
    expect(mocks.conversationsUpdateEq).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty slug WITHOUT querying the DB", async () => {
    const res = await POST(postReq({ persona_slug: "" }), params);
    expect(res.status).toBe(400);
    expect(mocks.personaMaybeSingle).not.toHaveBeenCalled();
  });

  it("returns 400 when persona_slug is absent entirely", async () => {
    const res = await POST(postReq({}), params);
    expect(res.status).toBe(400);
    expect(mocks.personaMaybeSingle).not.toHaveBeenCalled();
  });

  it("returns 500 when the personas lookup itself errors (fail-loud)", async () => {
    mocks.personaMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "rls failure" },
    });
    const res = await POST(postReq({ persona_slug: "marcus-cole" }), params);
    expect(res.status).toBe(500);
    expect(mocks.conversationsUpdateEq).not.toHaveBeenCalled();
  });

  it("surfaces a messages.insert failure as 5xx via safeAwait (no silent 200)", async () => {
    mocks.messagesInsert.mockResolvedValue({
      data: null,
      error: { message: "insert failed" },
    });
    const res = await POST(postReq({ persona_slug: "marcus-cole" }), params);
    expect(res.status).toBe(500);
  });

  it("returns 500 when the conversations.update errors (fail-loud)", async () => {
    mocks.conversationsUpdateEq.mockResolvedValue({
      error: { message: "update failed" },
    });
    const res = await POST(postReq({ persona_slug: "marcus-cole" }), params);
    expect(res.status).toBe(500);
  });

  it("delegates auth errors to respondToAuthError (401 for invalid session)", async () => {
    mocks.assertPermission.mockRejectedValue(
      new Error("assertPermission: invalid or expired access token."),
    );
    const res = await POST(postReq({ persona_slug: "marcus-cole" }), params);
    expect(res.status).toBe(401);
  });

  it("delegates AuthForbidden to respondToAuthError as 403 (RBAC)", async () => {
    const { AuthForbidden } = await import("@/lib/auth/assert-permission");
    mocks.assertPermission.mockRejectedValue(
      new AuthForbidden("Switch persona", "post", "viewer"),
    );
    const res = await POST(postReq({ persona_slug: "marcus-cole" }), params);
    expect(res.status).toBe(403);
  });
});
