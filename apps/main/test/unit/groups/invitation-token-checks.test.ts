// §19.x — Shared checks 1-4 of the invite-token contract, factored out for
// the anonymous-invitee forum routes. This pins the same error shapes as
// the five-check GET /api/groups/invite/[token] route (test/unit/api/
// groups-invite-token-route.test.ts) minus check 5 (first-use email
// binding), which doesn't apply to the session-less forum flow.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  parseAndVerifyHmac: vi.fn(),
  invitationLookup: vi.fn(),
  groupLookup: vi.fn(),
  invitationsUpdate: vi.fn(),
}));

vi.mock("@/lib/groups/invitation-token", () => ({
  parseAndVerifyHmac: mocks.parseAndVerifyHmac,
  generateToken: (id: string) => `tok-${id}`,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "invitations") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: mocks.invitationLookup }) }),
          update: () => ({ eq: () => mocks.invitationsUpdate() }),
        };
      }
      if (table === "groups") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: mocks.groupLookup }) }),
        };
      }
      throw new Error(`unmocked table: ${table}`);
    },
  }),
}));

const INVITATION_BASE = {
  id: "inv-1",
  group_id: "grp-1",
  rsvp_state: "interested",
  visibility_choice: "no_opinion" as const,
  token_revoked_at: null,
  token_revoked_reason: null,
};

const GROUP_BASE = {
  id: "grp-1",
  status: "active",
  sailed_at: null,
  sailing_date: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  visibility_default: "visible" as const,
  tenant_id: "tenant-1",
};

beforeEach(() => vi.clearAllMocks());

describe("validateInviteTokenChecks1to4", () => {
  it("400s invalid_token on a bad HMAC before touching the DB", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "", ok: false });

    const { validateInviteTokenChecks1to4 } = await import("@/lib/groups/invitation-token-checks");
    const result = await validateInviteTokenChecks1to4("garbage");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
    expect(mocks.invitationLookup).not.toHaveBeenCalled();
  });

  it("400s invalid_token when the invitation id doesn't exist", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
    mocks.invitationLookup.mockResolvedValue({ data: null, error: null });

    const { validateInviteTokenChecks1to4 } = await import("@/lib/groups/invitation-token-checks");
    const result = await validateInviteTokenChecks1to4("tok-inv-1.sig");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toMatchObject({ error: "invalid_token" });
    }
  });

  it("410s token_revoked with the stored reason", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
    mocks.invitationLookup.mockResolvedValue({
      data: { ...INVITATION_BASE, token_revoked_at: "2026-01-01T00:00:00Z", token_revoked_reason: "coordinator_revoked" },
      error: null,
    });

    const { validateInviteTokenChecks1to4 } = await import("@/lib/groups/invitation-token-checks");
    const result = await validateInviteTokenChecks1to4("tok-inv-1.sig");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(410);
      expect(await result.response.json()).toMatchObject({ error: "token_revoked", reason: "coordinator_revoked" });
    }
  });

  it("410s expired_natural once sailing_date + 30 days has passed, and revokes the token", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
    mocks.invitationLookup.mockResolvedValue({ data: INVITATION_BASE, error: null });
    mocks.groupLookup.mockResolvedValue({ data: { ...GROUP_BASE, sailing_date: "2020-01-01" }, error: null });
    mocks.invitationsUpdate.mockResolvedValue({ data: null, error: null });

    const { validateInviteTokenChecks1to4 } = await import("@/lib/groups/invitation-token-checks");
    const result = await validateInviteTokenChecks1to4("tok-inv-1.sig");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(410);
      expect(await result.response.json()).toMatchObject({ error: "token_revoked", reason: "expired_natural" });
    }
    expect(mocks.invitationsUpdate).toHaveBeenCalledOnce();
  });

  it("404s not_found when the invitation's group row is missing", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
    mocks.invitationLookup.mockResolvedValue({ data: INVITATION_BASE, error: null });
    mocks.groupLookup.mockResolvedValue({ data: null, error: null });

    const { validateInviteTokenChecks1to4 } = await import("@/lib/groups/invitation-token-checks");
    const result = await validateInviteTokenChecks1to4("tok-inv-1.sig");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  it("resolves invitation + group on the happy path", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
    mocks.invitationLookup.mockResolvedValue({ data: INVITATION_BASE, error: null });
    mocks.groupLookup.mockResolvedValue({ data: GROUP_BASE, error: null });

    const { validateInviteTokenChecks1to4 } = await import("@/lib/groups/invitation-token-checks");
    const result = await validateInviteTokenChecks1to4("tok-inv-1.sig");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invitation.id).toBe("inv-1");
      expect(result.group.id).toBe("grp-1");
      expect(result.group.tenant_id).toBe("tenant-1");
    }
  });
});
