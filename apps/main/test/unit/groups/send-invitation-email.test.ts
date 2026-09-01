// #1584 / #1716 — sendGroupInvitationEmail and the last_email_sent_at cadence stamp.
//
// #1584: the initial send must count as the first reminder, else
// group-reminder-cadence.ts (which treats a null last_email_sent_at as "never
// emailed" and skips its interval check) sends a near-duplicate GroupReminder to
// every brand-new invitee the very next 08:00 UTC run.
//
// #1716: the stamp is now written as a claim BEFORE the send (D-091 #21) so a
// crash between a delivered send and the stamp can't re-open the
// one-duplicate-reminder window. The claim is reverted to null when the send
// does NOT go out (suppressed / rate-limited / failed / pre-send throw), so a
// send that never happened doesn't suppress a legitimate reminder.
//
// #1707: a failure BEFORE sendEmail must leave a queryable email_log record
// (status 'rejected') instead of only a console.error, without breaking the
// fail-silent contract.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  safeAwait: vi.fn(),
  invitationSingle: vi.fn(),
  tenantSingle: vi.fn(),
  brandingMaybeSingle: vi.fn(),
  allInvitations: vi.fn(),
  updateEq: vi.fn(),
  updateFilterEq: vi.fn(),
  claimResult: vi.fn(),
  revertResult: vi.fn(),
  emailLogInsert: vi.fn(),
  resolveEmailContent: vi.fn(),
  renderOverrideBodyInLayout: vi.fn(),
  signUnsubscribeToken: vi.fn(),
  generateToken: vi.fn(),
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: mocks.sendEmail }));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>("@/lib/db/safe-mutation");
  return { ...actual, safeAwait: mocks.safeAwait };
});

vi.mock("@/lib/email/template-resolve", () => ({
  resolveEmailContent: mocks.resolveEmailContent,
  renderOverrideBodyInLayout: mocks.renderOverrideBodyInLayout,
}));

vi.mock("@/lib/email/unsubscribe-token", () => ({
  signUnsubscribeToken: mocks.signUnsubscribeToken,
}));

vi.mock("@/lib/groups/invitation-token", () => ({
  generateToken: mocks.generateToken,
}));

vi.mock("react-dom/server", () => ({
  renderToStaticMarkup: () => "<p>group invitation html</p>",
}));

vi.mock("@/emails/GroupInvitation", () => ({
  GroupInvitation: () => null,
}));

function buildSvc(targetId = "inv-1") {
  return {
    from: (table: string) => {
      if (table === "invitations") {
        return {
          select: () => ({
            eq: () => ({
              single: mocks.invitationSingle,
              is: () => ({ then: (r: (v: unknown) => unknown) => mocks.allInvitations().then(r) }),
            }),
          }),
          update: (payload: unknown) => {
            mocks.updateEq(payload);
            // Both the claim CAS and the revert filter by .eq("id", ...) FIRST
            // (#1654 — a dropped id filter mass-stamps every unstamped invitation
            // across all tenants). The update-return exposes ONLY `.eq`, so a claim
            // chain that skips the id filter (`.update(...).is(...)`) throws here and
            // fails the test; and the claim resolves rows only when the id filter
            // equals the invitation under test.
            return {
              eq: (col: string, id: string) => {
                mocks.updateFilterEq(col, id);
                const scoped = col === "id" && id === targetId;
                return {
                  // revert path: .update({ last_email_sent_at: null }).eq("id", id)
                  then: (r: (v: unknown) => unknown) => Promise.resolve(mocks.revertResult()).then(r),
                  // claim CAS path: .eq("id", id).is("last_email_sent_at", null).select("id")
                  is: () => ({
                    select: () =>
                      Promise.resolve(scoped ? mocks.claimResult() : { data: [], error: null }),
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ single: mocks.tenantSingle }) }) };
      }
      if (table === "email_log") {
        return { insert: (row: unknown) => Promise.resolve(mocks.emailLogInsert(row)) };
      }
      // tenant_branding
      return { select: () => ({ eq: () => ({ maybeSingle: mocks.brandingMaybeSingle }) }) };
    },
  };
}

import { sendGroupInvitationEmail } from "@/lib/groups/send-invitation-email";

const GROUP = {
  id: "g-1",
  cruise_line: "Carnival",
  ship_name: "Mardi Gras",
  sailing_date: "2026-11-03",
  departure_port: "Miami, FL",
  coordinator_message: null,
  hero_image_url: null,
};

function lastUpdatePayload(): Record<string, unknown> | undefined {
  const calls = mocks.updateEq.mock.calls;
  const last = calls[calls.length - 1];
  return last ? (last[0] as Record<string, unknown>) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invitationSingle.mockResolvedValue({
    data: { id: "inv-1", invitee_email: "guest@example.com", invitee_name: "Sam" },
    error: null,
  });
  mocks.tenantSingle.mockResolvedValue({
    data: { id: "t-1", legal_name: "Acme Travel", mailing_address: "1 Main St" },
    error: null,
  });
  mocks.brandingMaybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.allInvitations.mockResolvedValue({ data: [], error: null });
  mocks.resolveEmailContent.mockResolvedValue({ subject: "You're invited!", overrideBodyText: null });
  mocks.signUnsubscribeToken.mockResolvedValue("unsub-tok");
  mocks.generateToken.mockResolvedValue("tok-abc");
  mocks.emailLogInsert.mockReturnValue({ data: null, error: null });
  // Default: claim wins (one row stamped), revert succeeds.
  mocks.claimResult.mockReturnValue({ data: [{ id: "inv-1" }], error: null });
  mocks.revertResult.mockReturnValue({ data: null, error: null });
  // Real safeAwait unwraps { data } — mirror that so the claim CAS row array
  // flows back to the caller (the mock query resolves { data, error }).
  mocks.safeAwait.mockImplementation(async (p: Promise<{ data: unknown } | null>) => {
    const r = await p;
    return r?.data ?? null;
  });
});

describe("sendGroupInvitationEmail — claim-before-send stamping (#1584 / #1716)", () => {
  it("stamps last_email_sent_at and leaves it set on a successful send", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "sent", resend_message_id: "m-1" });

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    // Claim written before the send (a real timestamp), and never reverted.
    expect(mocks.updateEq).toHaveBeenCalledWith(
      expect.objectContaining({ last_email_sent_at: expect.any(String) }),
    );
    expect(lastUpdatePayload()).toEqual({ last_email_sent_at: expect.any(String) });
    expect(mocks.updateEq).not.toHaveBeenCalledWith(
      expect.objectContaining({ last_email_sent_at: null }),
    );
  });

  it("reverts the claim to null when the send is suppressed — cadence must retry", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "suppressed", reason: "unsubscribe_all" });

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    // Net effect must be null: a send that never went out cannot suppress the
    // invitee's next legitimate reminder.
    expect(lastUpdatePayload()).toEqual({ last_email_sent_at: null });
  });

  it("reverts the claim to null when the send fails", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "failed", reason: "resend_5xx" });

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    expect(lastUpdatePayload()).toEqual({ last_email_sent_at: null });
  });

  it("scopes the claim CAS to exactly the target invitation id (no unrelated mass-stamp) (#1654)", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "sent", resend_message_id: "m-1" });

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    // The claim UPDATE must be filtered by the exact invitation id. Dropping this
    // .eq("id", ...) stamps last_email_sent_at on every unstamped invitation row
    // across all tenants on every send (#1654).
    expect(mocks.updateFilterEq).toHaveBeenCalledWith("id", "inv-1");
    // A send WAS attempted — the claim resolved a row because it was scoped to inv-1.
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("treats the claim as lost when it is NOT scoped to the target invitation — send is skipped", async () => {
    // The mock resolves a claimed row only when .eq("id", ...) matches the target.
    // Point the svc at a different id: the source's .eq("id","inv-1") then matches
    // no row, proving the CAS is genuinely id-scoped (a dropped/wrong filter would
    // otherwise let the send proceed against the wrong rows).
    mocks.sendEmail.mockResolvedValue({ status: "sent", resend_message_id: "m-1" });

    await sendGroupInvitationEmail({
      svc: buildSvc("some-other-invitation") as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("skips the send when the claim is lost (zero rows) — a concurrent send/cadence already stamped", async () => {
    // CAS guard matched no row: last_email_sent_at was already non-null.
    mocks.claimResult.mockReturnValue({ data: [], error: null });

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    // No send — we must not duplicate the winner's email...
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // ...and we must NOT revert the stamp that the winner legitimately set.
    expect(mocks.updateEq).not.toHaveBeenCalledWith(
      expect.objectContaining({ last_email_sent_at: null }),
    );
  });
});

describe("sendGroupInvitationEmail — pre-send failure observability (#1707)", () => {
  it("writes a best-effort email_log row when a pre-send step throws", async () => {
    // Template resolution runs after the invitee read but before sendEmail —
    // exactly the fail-silent window #1707 is about.
    mocks.resolveEmailContent.mockRejectedValue(new Error("template boom"));

    await expect(
      sendGroupInvitationEmail({
        svc: buildSvc() as never,
        invitationId: "inv-1",
        group: GROUP,
        tenantId: "t-1",
      }),
    ).resolves.toBeUndefined(); // still fail-silent — never throws to the caller

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.emailLogInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t-1",
        to_email: "guest@example.com",
        template_id: "group_invitation",
        email_category: "group_invitation",
        status: "rejected",
        related_group_id: "g-1",
        bounce_reason: "template boom",
      }),
    );
  });

  it("still logs (with a placeholder recipient) when the invitee read itself fails", async () => {
    mocks.invitationSingle.mockRejectedValue(new Error("invitations read boom"));

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    expect(mocks.emailLogInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rejected",
        to_email: "unknown:invitation:inv-1",
        bounce_reason: "invitations read boom",
      }),
    );
  });

  it("reverts the claim AND logs when the send itself throws after the claim", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("send transport boom"));

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    // Claim was taken then reverted (last write null) so the cadence retries...
    expect(lastUpdatePayload()).toEqual({ last_email_sent_at: null });
    // ...and the failure is operator-visible.
    expect(mocks.emailLogInsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected", bounce_reason: "send transport boom" }),
    );
  });

  it("writes an email_log row when the claim revert itself fails — a stuck stamp must be operator-visible", async () => {
    // Send doesn't go out (failed), so revertClaim runs; the revert UPDATE errors,
    // leaving last_email_sent_at stuck non-null — that would silently suppress the
    // next cadence reminder, so it must surface as a queryable rejected row.
    mocks.sendEmail.mockResolvedValue({ status: "failed", reason: "resend_5xx" });
    mocks.revertResult.mockReturnValue({ data: null, error: { message: "revert db down" } });

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    expect(mocks.emailLogInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rejected",
        related_group_id: "g-1",
        bounce_reason: expect.stringContaining("revert"),
      }),
    );
  });
});
