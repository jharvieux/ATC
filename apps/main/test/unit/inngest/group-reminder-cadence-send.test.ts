// #1102 — group-reminder-cadence routes sends through the shared sendEmail()
// helper so suppression + §16.4 from-address + email_log all apply.
//
// Intent under test:
//   - A due reminder is sent via sendEmail (category=group_invitation) and
//     last_email_sent_at is stamped so the cadence interval advances.
//   - A suppressed recipient is skipped: sendEmail is still consulted, but
//     last_email_sent_at is NOT stamped (so a later run re-evaluates once the
//     suppression clears) and the run counts it as skipped.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: () => Promise<unknown>) => handler,
  },
}));

const sendEmailMock = vi.fn();
vi.mock("@/lib/email/send", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  TENANT_BRANDING_COLUMNS:
    "tenant_id, logo_url, primary_color, secondary_color, accent_color, slogan, " +
    "email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, " +
    "email_from_name, email_from_domain, email_from_domain_verified_at",
}));

vi.mock("@/lib/email/template-resolve", () => ({
  resolveEmailContent: vi.fn(async () => ({ subject: "Trip reminder", overrideBodyText: null })),
  renderOverrideBodyInLayout: vi.fn(async () => "<html>override</html>"),
}));

vi.mock("react-dom/server", () => ({
  renderToStaticMarkup: vi.fn(() => "<html>reminder</html>"),
}));

vi.mock("@/emails/GroupReminder", () => ({ GroupReminder: vi.fn(() => null) }));

vi.mock("@/lib/email/unsubscribe-token", () => ({
  signUnsubscribeToken: vi.fn(() => "unsub-tok"),
}));

vi.mock("@/lib/groups/invitation-token", () => ({
  generateToken: vi.fn((id: string) => `${id}.sig`),
}));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>("@/lib/db/safe-mutation");
  return { ...actual, safeAwait: vi.fn(async (p: Promise<unknown>) => p) };
});

// One pending invitation due for a reminder (no prior send, sailing ~3 months
// out → 7-day interval, so it fires on the first run).
const FUTURE_SAILING = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

const invitationsPool: { id: string; invitee_email: string; invitee_name: string; last_email_sent_at: string | null; group_id: string }[] = [
  { id: "inv-1", invitee_email: "kim@example.com", invitee_name: "Kim", last_email_sent_at: null, group_id: "g-1" },
];
const groupsPool = [
  {
    id: "g-1",
    sailing_date: FUTURE_SAILING,
    cruise_line: "Carnival",
    ship_name: "Mardi Gras",
    coordinator_message: "See you aboard!",
    hero_image_url: null,
    tenant_id: "t-1",
    status: "active",
  },
];
const tenantsPool = [
  {
    id: "t-1",
    legal_name: "Acme Travel",
    mailing_address: "1 Main St",
  },
];
// #1190: email send config lives on tenant_branding, not tenants. Keying it
// here (with tenant_resend, distinct from the platform default) makes the
// sendEmail assertion below a real guard — a revert that reads tenant.* gets the
// platform default and fails.
const brandingPool = [
  {
    tenant_id: "t-1",
    logo_url: null,
    primary_color: null,
    secondary_color: null,
    accent_color: null,
    slogan: null,
    email_send_pattern: "tenant_resend",
    tenant_resend_api_key_encrypted: "enc-key",
    email_from_address: "concierge@acme.com",
    email_from_name: "Acme Concierge",
    email_from_domain: null,
    email_from_domain_verified_at: null,
  },
];

// Tracks invitations.update() invocations so a test can assert whether
// last_email_sent_at was stamped.
const invitationUpdateSpy = vi.fn();

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      const result =
        table === "invitations" ? { data: invitationsPool, error: null }
        : table === "groups" ? { data: groupsPool, error: null }
        : table === "tenants" ? { data: tenantsPool, error: null }
        : table === "email_log" ? { data: [], error: null } // 3-per-24h count = 0 → not rate-limited
        : table === "tenant_branding" ? { data: brandingPool, error: null }
        : { data: [], error: null };

      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq() { return builder; },
        is() { return builder; },
        gte() { return builder; },
        in() { return builder; },
        limit() { return builder; },
        update() { if (table === "invitations") invitationUpdateSpy(); return builder; },
        then(resolve: (v: typeof result) => unknown) { return Promise.resolve(resolve(result)); },
      };
      return builder;
    },
  }),
}));

import { groupReminderCadence } from "@/inngest/group-reminder-cadence";

const run = groupReminderCadence as unknown as () => Promise<{ sent: number; skipped: number }>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
});

afterEach(() => {
  invitationsPool[0]!.last_email_sent_at = null;
});

describe("group-reminder-cadence — send path (#1102)", () => {
  it("sends a due reminder through sendEmail and stamps last_email_sent_at", async () => {
    sendEmailMock.mockResolvedValue({ status: "sent", resend_message_id: "m-1" });

    const result = await run();

    expect(sendEmailMock).toHaveBeenCalledOnce();
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "kim@example.com",
        template_id: "group_reminder",
        category: "group_invitation",
        related_group_id: "g-1",
        // #1190: email config must come from tenant_branding (tenant_resend),
        // not the tenants row.
        tenant: expect.objectContaining({
          id: "t-1",
          email_send_pattern: "tenant_resend",
          email_from_address: "concierge@acme.com",
        }),
      }),
    );
    expect(result.sent).toBe(1);
    expect(invitationUpdateSpy).toHaveBeenCalledOnce();
  });

  it("skips a suppressed recipient without stamping last_email_sent_at", async () => {
    sendEmailMock.mockResolvedValue({ status: "suppressed", reason: "unsubscribe_all" });

    const result = await run();

    // sendEmail was still consulted (suppression is decided inside it), but the
    // reminder was not delivered — so we must not advance the cadence clock.
    expect(sendEmailMock).toHaveBeenCalledOnce();
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(invitationUpdateSpy).not.toHaveBeenCalled();
  });

  // #1584 — send-invitation-email.ts now stamps last_email_sent_at on the
  // initial send (previously it never did, so this cadence job treated a
  // brand-new invitee as "never emailed" and sent a near-duplicate
  // GroupReminder the very next 08:00 UTC run). Proves the initial send
  // counts as the first reminder for cadence purposes: with
  // last_email_sent_at set to "now" and a 7-day interval (90-day-out
  // sailing), the very next run must not re-select this invitation.
  it("does not re-send: an invite emailed earlier today is not selected by the next cadence run", async () => {
    invitationsPool[0]!.last_email_sent_at = new Date().toISOString();

    const result = await run();

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(invitationUpdateSpy).not.toHaveBeenCalled();
  });
});
