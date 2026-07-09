// #1584 — sendGroupInvitationEmail must stamp invitations.last_email_sent_at
// on a successful initial send. Before this fix it never did, so
// group-reminder-cadence.ts (which treats a null last_email_sent_at as
// "never emailed" and skips its interval check) sent a near-duplicate
// GroupReminder to every brand-new invitee the very next 08:00 UTC run,
// regardless of how far out the sailing was.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  safeAwait: vi.fn(),
  invitationSingle: vi.fn(),
  tenantSingle: vi.fn(),
  brandingMaybeSingle: vi.fn(),
  allInvitations: vi.fn(),
  updateEq: vi.fn(),
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

function buildSvc() {
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
            return { eq: () => Promise.resolve({ data: null, error: null }) };
          },
        };
      }
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ single: mocks.tenantSingle }) }) };
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
  mocks.safeAwait.mockImplementation(async (p: Promise<unknown>) => {
    await p;
    return null;
  });
});

describe("sendGroupInvitationEmail — last_email_sent_at stamping (#1584)", () => {
  it("stamps last_email_sent_at on a successful send — counts as the first reminder for cadence purposes", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "sent", resend_message_id: "m-1" });

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    expect(mocks.updateEq).toHaveBeenCalledWith(
      expect.objectContaining({ last_email_sent_at: expect.any(String) }),
    );
  });

  it("does not stamp when the send is suppressed", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "suppressed", reason: "unsubscribe_all" });

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    expect(mocks.updateEq).not.toHaveBeenCalled();
  });

  it("does not stamp when the send fails", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "failed", reason: "resend_5xx" });

    await sendGroupInvitationEmail({
      svc: buildSvc() as never,
      invitationId: "inv-1",
      group: GROUP,
      tenantId: "t-1",
    });

    expect(mocks.updateEq).not.toHaveBeenCalled();
  });
});
