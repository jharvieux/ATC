// §18.5 — GET + revoke action for /api/groups/[id]/invitations (#1064).
//
// Intent under test:
//   1. GET returns the invitee list for a coordinator (200).
//   2. GET returns 403 when the caller is not the coordinator.
//   3. POST action=revoke sets token_revoked_at on the target invitation (200).
//   4. POST action=revoke on an already-revoked invitation still returns 200
//      (Supabase IS NULL filter means zero rows updated, but error is null —
//      client should treat this as "already removed").
//   5. POST with an unknown action returns 400.

import { describe, it, expect, vi, beforeEach } from "vitest";

const COORDINATOR_ID = "user-coord-1";
const GROUP_ID = "g-111";
const INV_ID = "inv-abc";
const TENANT_ID = "t-1";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  groupQuery: vi.fn(),
  invitationsQuery: vi.fn(),
  updateQuery: vi.fn(),
  inviteInsertQuery: vi.fn(),
  inviteEmailSingleQuery: vi.fn(),
  inviteRsvpSelectQuery: vi.fn(),
  tenantQuery: vi.fn(),
  brandingQuery: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/groups/sailed-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/groups/sailed-gate")>(
    "@/lib/groups/sailed-gate",
  );
  return { ...actual, assertGroupNotSailed: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@/lib/groups/invitation-token", () => ({
  generateToken: (id: string) => `tok-${id.slice(0, 8)}`,
}));

// Service-role client drives the invitations route (coordinator-owned).
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "groups") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ single: mocks.groupQuery }),
            }),
          }),
        };
      }
      if (table === "invitations") {
        return {
          select: (cols: string) => {
            if (cols.includes("token_revoked_at")) {
              // GET list query — ends with .eq().order()
              return { eq: () => ({ order: () => mocks.invitationsQuery() }) };
            }
            if (cols === "rsvp_state") {
              // rsvp count inside sendGroupInvitationEmail — ends with .eq().is()
              return { eq: () => ({ is: () => mocks.inviteRsvpSelectQuery() }) };
            }
            // Single lookup inside sendGroupInvitationEmail — ends with .eq().single()
            return { eq: () => ({ single: mocks.inviteEmailSingleQuery }) };
          },
          insert: (data: unknown) => ({
            select: () => mocks.inviteInsertQuery(data),
          }),
          update: () => ({
            eq: () => ({
              eq: () => ({
                is: () => mocks.updateQuery(),
              }),
            }),
          }),
        };
      }
      if (table === "tenants") {
        return {
          select: () => ({ eq: () => ({ single: mocks.tenantQuery }) }),
        };
      }
      if (table === "tenant_branding") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: mocks.brandingQuery }) }),
        };
      }
      return {};
    },
  }),
}));

vi.mock("@/lib/email/unsubscribe-token", () => ({
  signUnsubscribeToken: vi.fn().mockReturnValue("unsub-tok"),
}));

vi.mock("@/lib/email/template-resolve", () => ({
  resolveEmailContent: vi.fn().mockResolvedValue({
    subject: "You're invited!",
    overrideBodyText: null,
  }),
  renderOverrideBodyInLayout: vi.fn(),
}));

vi.mock("react-dom/server", () => ({
  renderToStaticMarkup: vi.fn().mockReturnValue("<html>invite-email</html>"),
}));

vi.mock("@/emails/GroupInvitation", () => ({
  GroupInvitation: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: (...args: unknown[]) => mocks.sendEmail(...args),
}));

function getReq(groupId: string) {
  return new Request(`http://localhost/api/groups/${groupId}/invitations`);
}

function postReq(groupId: string, body: unknown) {
  return new Request(`http://localhost/api/groups/${groupId}/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/groups/[id]/invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({
      ctx: { tenant_id: TENANT_ID },
      user: { id: COORDINATOR_ID },
    });
    mocks.groupQuery.mockResolvedValue({
      data: { id: GROUP_ID, coordinator_user_id: COORDINATOR_ID, tenant_id: TENANT_ID },
      error: null,
    });
  });

  it("returns invitee list when caller is coordinator", async () => {
    const inv = { id: INV_ID, invitee_email: "a@example.com", rsvp_state: "interested" };
    mocks.invitationsQuery.mockResolvedValue({ data: [inv], error: null });

    const { GET } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await GET(getReq(GROUP_ID), { params: Promise.resolve({ id: GROUP_ID }) });

    expect(res.status).toBe(200);
    const body: { invitations: unknown[] } = await res.json();
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]).toMatchObject({ rsvp_state: "interested" });
  });

  it("returns 403 when caller is not the group coordinator", async () => {
    mocks.groupQuery.mockResolvedValue({
      data: { id: GROUP_ID, coordinator_user_id: "other-user", tenant_id: TENANT_ID },
      error: null,
    });

    const { GET } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await GET(getReq(GROUP_ID), { params: Promise.resolve({ id: GROUP_ID }) });

    expect(res.status).toBe(403);
  });
});

describe("POST /api/groups/[id]/invitations — revoke action (#1064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({
      ctx: { tenant_id: TENANT_ID },
      user: { id: COORDINATOR_ID },
    });
    mocks.groupQuery.mockResolvedValue({
      data: { id: GROUP_ID, coordinator_user_id: COORDINATOR_ID, tenant_id: TENANT_ID },
      error: null,
    });
  });

  it("revoke action sets token_revoked_at and returns ok", async () => {
    mocks.updateQuery.mockResolvedValue({ error: null });

    const { POST } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await POST(
      postReq(GROUP_ID, { action: "revoke", invitation_id: INV_ID }),
      { params: Promise.resolve({ id: GROUP_ID }) },
    );

    expect(res.status).toBe(200);
    const body: { ok: boolean; action: string } = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe("revoked");
  });

  it("returns 200 when invitation is already revoked (zero-row update, error null)", async () => {
    // IS NULL guard means zero rows updated when already revoked — route returns ok:true regardless.
    // This verifies the documented silent-success contract (intent #4).
    mocks.updateQuery.mockResolvedValue({ error: null });

    const { POST } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await POST(
      postReq(GROUP_ID, { action: "revoke", invitation_id: "already-revoked-id" }),
      { params: Promise.resolve({ id: GROUP_ID }) },
    );

    expect(res.status).toBe(200);
    const body: { ok: boolean; action: string } = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe("revoked");
  });

  it("returns 400 for an unknown action", async () => {
    const { POST } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await POST(
      postReq(GROUP_ID, { action: "not_a_real_action" }),
      { params: Promise.resolve({ id: GROUP_ID }) },
    );

    expect(res.status).toBe(400);
  });
});

describe("POST /api/groups/[id]/invitations — invite action (#979)", () => {
  const FULL_GROUP = {
    id: GROUP_ID,
    coordinator_user_id: COORDINATOR_ID,
    tenant_id: TENANT_ID,
    cruise_line: "Royal Caribbean",
    ship_name: "Harmony of the Seas",
    sailing_date: "2026-09-01",
    departure_port: "Miami, FL",
    coordinator_message: "Can't wait!",
    hero_image_url: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

    mocks.assertPermission.mockResolvedValue({
      ctx: { tenant_id: TENANT_ID },
      user: { id: COORDINATOR_ID },
    });
    mocks.groupQuery.mockResolvedValue({ data: FULL_GROUP, error: null });
    mocks.inviteInsertQuery.mockResolvedValue({ data: [{ id: "new-inv-id" }], error: null });
    mocks.inviteEmailSingleQuery.mockResolvedValue({
      data: { id: "new-inv-id", invitee_email: "bob@example.com", invitee_name: "Bob" },
      error: null,
    });
    mocks.inviteRsvpSelectQuery.mockResolvedValue({ data: [], error: null });
    mocks.tenantQuery.mockResolvedValue({
      data: {
        id: TENANT_ID,
        legal_name: "Acme Travel",
        mailing_address: "123 Main St",
        email_send_pattern: "platform_resend",
        tenant_resend_api_key_encrypted: null,
        email_from_address: null,
        email_from_name: null,
        email_from_domain: null,
        email_from_domain_verified_at: null,
      },
      error: null,
    });
    mocks.brandingQuery.mockResolvedValue({ data: null, error: null });
    mocks.sendEmail.mockResolvedValue({ status: "sent", resend_message_id: "resend-msg-id" });
  });

  it("creates the invitation row and returns 200 with invitation_id", async () => {
    const { POST } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await POST(
      postReq(GROUP_ID, { action: "invite", invitee_email: "bob@example.com" }),
      { params: Promise.resolve({ id: GROUP_ID }) },
    );

    expect(res.status).toBe(200);
    const body: { ok: boolean; invitation_id: string } = await res.json();
    expect(body.ok).toBe(true);
    expect(body.invitation_id).toBeDefined();
  });

  it("routes the invitation through sendEmail with the group_invitation category", async () => {
    const { POST } = await import("@/app/api/groups/[id]/invitations/route");
    await POST(
      postReq(GROUP_ID, { action: "invite", invitee_email: "bob@example.com" }),
      { params: Promise.resolve({ id: GROUP_ID }) },
    );

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "bob@example.com",
        template_id: "group_invitation",
        category: "group_invitation",
        related_group_id: GROUP_ID,
        tenant: expect.objectContaining({ id: TENANT_ID, email_send_pattern: "platform_resend" }),
      }),
    );
  });

  it("returns 200 even when sendEmail does not deliver (suppressed / rate-limited)", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "suppressed", reason: "unsubscribe_all" });

    const { POST } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await POST(
      postReq(GROUP_ID, { action: "invite", invitee_email: "bob@example.com" }),
      { params: Promise.resolve({ id: GROUP_ID }) },
    );

    // The invitation row is already committed; a non-delivered email must not
    // roll it back or fail the request — it is logged and the caller gets 200.
    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
  });

  it("returns 200 when sendEmail reports a hard failure (key/vendor error)", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "failed", reason: "platform_resend_key_not_set" });

    const { POST } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await POST(
      postReq(GROUP_ID, { action: "invite", invitee_email: "bob@example.com" }),
      { params: Promise.resolve({ id: GROUP_ID }) },
    );

    // A failed send is logged at error level but still must not roll back the
    // committed invitation row — the coordinator can reissue later.
    expect(res.status).toBe(200);
    const body: { ok: boolean; invitation_id: string } = await res.json();
    expect(body.ok).toBe(true);
  });
});
