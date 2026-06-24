// #970 — POST /api/groups/[id]/invitations — invite action.
//
// Intent under test:
//   1. invite action with valid email → inserts invitation row via safeAwait
//      and returns 200 with invitation_id.
//   2. invite action with invalid email → 400 (validation gate before any DB write).
//   3. invite action with invalid visibility_choice → 400.
//   4. Email send failure is silenced — the invitation_id is still returned.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  safeAwait: vi.fn(),
  groupSingle: vi.fn(),
  assertGroupNotSailed: vi.fn(),
  // Invitation email helper — dynamic import, mocked at module level.
  invitationSingle: vi.fn(),
  tenantSingle: vi.fn(),
  brandingMaybeSingle: vi.fn(),
  allInvitations: vi.fn(),
  resolveEmailContent: vi.fn(),
  renderOverrideBodyInLayout: vi.fn(),
  signUnsubscribeToken: vi.fn(),
  generateToken: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>("@/lib/auth/assert-permission");
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/groups/sailed-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/groups/sailed-gate")>("@/lib/groups/sailed-gate");
  return { ...actual, assertGroupNotSailed: mocks.assertGroupNotSailed };
});

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>("@/lib/db/safe-mutation");
  return { ...actual, safeAwait: mocks.safeAwait };
});

vi.mock("@/lib/groups/invitation-token", () => ({
  generateToken: mocks.generateToken,
}));

vi.mock("@/lib/email/template-resolve", () => ({
  resolveEmailContent: mocks.resolveEmailContent,
  renderOverrideBodyInLayout: mocks.renderOverrideBodyInLayout,
}));

vi.mock("@/lib/email/unsubscribe-token", () => ({
  signUnsubscribeToken: mocks.signUnsubscribeToken,
}));

vi.mock("react-dom/server", () => ({
  renderToStaticMarkup: () => "<p>group invitation html</p>",
}));

vi.mock("@/emails/GroupInvitation", () => ({
  GroupInvitation: () => null,
}));

// Service-role client: each table returns the appropriate mock.
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "groups") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ single: mocks.groupSingle }),
            }),
          }),
        };
      }
      if (table === "invitations") {
        return {
          select: () => ({
            eq: () => ({
              single: mocks.invitationSingle,
              is: () => ({ then: (r: (v: unknown) => unknown) => mocks.allInvitations().then(r) }),
            }),
          }),
          insert: () => ({
            select: () => ({
              then: (r: (v: unknown) => unknown) =>
                // safeAwait intercepts this — return the raw builder thenable
                ({ then: r }),
            }),
          }),
        };
      }
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({ single: mocks.tenantSingle }),
          }),
        };
      }
      // tenant_branding
      return {
        select: () => ({
          eq: () => ({ maybeSingle: mocks.brandingMaybeSingle }),
        }),
      };
    },
  }),
}));

global.fetch = mocks.fetch as unknown as typeof fetch;

import { POST } from "@/app/api/groups/[id]/invitations/route";

const TENANT_ID = "t-1";
const GROUP_ID = "g-1";
const PARAMS = { params: Promise.resolve({ id: GROUP_ID }) };

function postReq(body: unknown): Request {
  return new Request(`https://example.com/api/groups/${GROUP_ID}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID },
    user: { id: "coord-1" },
  });
  mocks.assertGroupNotSailed.mockResolvedValue(undefined);
  mocks.groupSingle.mockResolvedValue({
    data: {
      id: GROUP_ID,
      coordinator_user_id: "coord-1",
      tenant_id: TENANT_ID,
      cruise_line: "Carnival",
      ship_name: "Mardi Gras",
      sailing_date: "2026-11-03",
      departure_port: "Miami, FL",
      coordinator_message: null,
      hero_image_url: null,
    },
    error: null,
  });
  // safeAwait resolves to a non-empty array (row inserted)
  mocks.safeAwait.mockResolvedValue([{ id: "inv-new" }]);
  // Email helper dependencies — provide enough data for a successful send
  mocks.invitationSingle.mockResolvedValue({
    data: { id: "inv-new", invitee_email: "guest@example.com", invitee_name: "Sam" },
    error: null,
  });
  mocks.tenantSingle.mockResolvedValue({
    data: { id: TENANT_ID, legal_name: "Acme Travel", mailing_address: "1 Main St" },
    error: null,
  });
  mocks.brandingMaybeSingle.mockResolvedValue({
    data: { logo_url: null, primary_color: null, secondary_color: null, accent_color: null, slogan: null },
    error: null,
  });
  mocks.allInvitations.mockResolvedValue({ data: [], error: null });
  mocks.resolveEmailContent.mockResolvedValue({ subject: "You're invited!", overrideBodyText: null });
  mocks.signUnsubscribeToken.mockReturnValue("unsub-tok");
  mocks.generateToken.mockReturnValue("tok-abc");
  mocks.fetch.mockResolvedValue({ ok: true });
});

describe("POST /api/groups/[id]/invitations — invite action (#970)", () => {
  it("valid invite → calls safeAwait for insert, returns ok + invitation_id", async () => {
    const res = await POST(postReq({ action: "invite", invitee_email: "Guest@Example.com" }), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; invitation_id: string };
    expect(body.ok).toBe(true);
    expect(typeof body.invitation_id).toBe("string");
    // safeAwait must have been called with the insert query
    expect(mocks.safeAwait).toHaveBeenCalledOnce();
    // Email is normalized to lowercase
    const safeCall = mocks.safeAwait.mock.calls[0]!;
    expect(safeCall[1]).toBe("invitations.insert");
  });

  it("invalid email → 400, no DB write", async () => {
    const res = await POST(postReq({ action: "invite", invitee_email: "not-an-email" }), PARAMS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invitee_email");
    expect(mocks.safeAwait).not.toHaveBeenCalled();
  });

  // #84: the email regex is the ReDoS guard. A >254-char address matches the
  // format but must be rejected by the length cap before the regex runs, so a
  // crafted long string can't drive polynomial backtracking or reach the DB.
  it("oversized email (>254 chars) → 400, no DB write", async () => {
    const huge = `${"a".repeat(250)}@e.com`; // 256 chars, valid format
    const res = await POST(postReq({ action: "invite", invitee_email: huge }), PARAMS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invitee_email");
    expect(mocks.safeAwait).not.toHaveBeenCalled();
  });

  it("invalid visibility_choice → 400, no DB write", async () => {
    const res = await POST(
      postReq({ action: "invite", invitee_email: "guest@example.com", visibility_choice: "reveal_all" }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("visibility_choice");
    expect(mocks.safeAwait).not.toHaveBeenCalled();
  });

  it("email send failure is silenced — invitation_id still returned", async () => {
    mocks.resolveEmailContent.mockRejectedValue(new Error("template read failed"));

    const res = await POST(postReq({ action: "invite", invitee_email: "guest@example.com" }), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; invitation_id: string };
    expect(body.ok).toBe(true);
    expect(typeof body.invitation_id).toBe("string");
  });
});
