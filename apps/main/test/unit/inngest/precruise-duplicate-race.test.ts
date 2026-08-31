// #1582 — duplicate-event race must send exactly once.
//
// The bug: the content-row insert's error was discarded (`const { data:
// inserted } = await ...insert(...)`), so a 23505 unique-constraint
// violation from a concurrent duplicate `precruise/email.due` event was
// silently ignored and the code proceeded to send anyway — a double send.
// This pins that the insert error is now checked and a 23505 short-circuits
// before sendEmail is ever reached.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: unknown) => handler,
  },
}));

const mocks = vi.hoisted(() => ({
  insertError: null as { code: string; message: string } | null,
  insertPayloads: [] as Array<Record<string, unknown>>,
  sendEmailCalls: 0,
  revalidateCalls: [] as Array<[string, string]>,
  existingContent: null as {
    id: string;
    sent_at: null;
    generated_content: Record<string, unknown>;
    content_context_fingerprint: string | null;
  } | null,
  updatePayloads: [] as Array<Record<string, unknown>>,
}));

// #1953 — the content insert now purges the companion page's cache tag.
vi.mock("@/lib/precruise/companion-content", () => ({
  revalidateCompanionContent: (booking_id: string, phase: string) => {
    mocks.revalidateCalls.push([booking_id, phase]);
  },
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  assertTenantStillPayingById: async () => ({ ok: true }),
}));

vi.mock("@/lib/ai/call-wrapper", () => ({
  instrumentedClaudeCall: async () => ({ text: "unused" }),
}));

vi.mock("@/lib/email/unsubscribe-token", () => ({
  signCompanionToken: () => "companion-token",
  signUnsubscribeToken: () => "unsub-token",
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async () => {
    mocks.sendEmailCalls++;
    return { status: "sent", email_log_id: "log-1" };
  },
  TENANT_BRANDING_COLUMNS:
    "tenant_id, logo_url, primary_color, secondary_color, accent_color, slogan, " +
    "email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, " +
    "email_from_name, email_from_domain, email_from_domain_verified_at",
}));

vi.mock("@/lib/email/template-resolve", () => ({
  resolveEmailContent: async () => ({ subject: "Subject", overrideBodyText: "Body" }),
  renderOverrideBodyInLayout: async () => "<html>mock</html>",
}));

vi.mock("@/lib/sailings/sailing-itinerary", () => ({
  getSailingItinerary: async () => null,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "pre_cruise_email_content") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              maybeSingle: async () => ({ data: mocks.existingContent, error: null }),
            };
            return chain;
          },
          insert(payload: Record<string, unknown>) {
            mocks.insertPayloads.push(payload);
            return {
              select: () => ({
                single: async () => ({ data: { id: "content-1" }, error: mocks.insertError }),
              }),
            };
          },
          update(payload: Record<string, unknown>) {
            mocks.updatePayloads.push(payload);
            const chain = {
              eq: () => chain,
              is: () => chain,
              or: () => chain,
              select: async () => ({
                data: "send_claimed_at" in payload
                  ? payload.send_claimed_at
                    ? [{ send_claimed_at: payload.send_claimed_at }]
                    : [{ id: "content-1" }]
                  : [{ id: "content-1" }],
                error: null,
              }),
            };
            return chain;
          },
        };
      }
      if (table === "bookings") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              maybeSingle: async () => ({
                data: {
                  id: "b1",
                  tenant_id: "t1",
                  status: "confirmed",
                  group_booking_id: "g1",
                  user_id: "u1",
                  primary_contact_id: "contact-1",
                  groups: {
                    cruise_line: "Norwegian",
                    ship_name: "Bliss",
                    sailing_date: "2026-09-01",
                    departure_port: "Miami, FL",
                  },
                },
                error: null,
              }),
            };
            return chain;
          },
        };
      }
      if (table === "contacts") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              maybeSingle: async () => ({ data: { first_name: "Jordan", email: "jordan@example.com" }, error: null }),
            };
            return chain;
          },
        };
      }
      if (table === "tenants") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              maybeSingle: async () => ({ data: { id: "t1", legal_name: "Anchor & Compass" }, error: null }),
            };
            return chain;
          },
        };
      }
      // tenant_branding
      return {
        select() {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({ data: {}, error: null }),
          };
          return chain;
        },
      };
    },
  }),
}));

import { precruiseGenerateAndSend } from "@/inngest/precruise-generate-and-send";

beforeEach(() => {
  mocks.insertError = null;
  mocks.insertPayloads = [];
  mocks.sendEmailCalls = 0;
  mocks.revalidateCalls = [];
  mocks.existingContent = null;
  mocks.updatePayloads = [];
});

describe("precruiseGenerateAndSend — #1582 duplicate insert race", () => {
  it("skips the send when the insert hits a 23505 unique violation", async () => {
    mocks.insertError = { code: "23505", message: "duplicate key value violates unique constraint" };
    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90" } },
    });
    expect(mocks.sendEmailCalls).toBe(0);
  });

  it("sends when the insert succeeds (no race)", async () => {
    mocks.insertError = null;
    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90" } },
    });
    expect(mocks.sendEmailCalls).toBe(1);
    expect(mocks.insertPayloads[0]).toMatchObject({
      booking_id: "b1",
      contact_id: "contact-1",
    });
    // #1953 — the successful content insert must purge the companion
    // page's (booking_id, phase) cache entry, or a pre-insert "no content"
    // render stays pinned for the customer.
    expect(mocks.revalidateCalls).toEqual([["b1", "t_90"]]);
  });

  it("makes the T-30 specialty experiences section reachable in direct sends", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    try {
      await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
        event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_30", via: "direct" } },
      });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mocks.insertPayloads[0]?.generated_content).toMatchObject({
      specialty_experiences: ["unused"],
    });
  });

  it("regenerates unsent cached content when the booking/contact context fingerprint is stale", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      generated_content: { documentation_reminder: "old copy" },
      content_context_fingerprint: "stale",
    };

    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90", via: "direct" } },
    });

    expect(mocks.insertPayloads).toHaveLength(0);
    const regeneration = mocks.updatePayloads.find((payload) => "generated_content" in payload);
    expect(regeneration).toMatchObject({
      contact_id: "contact-1",
      content_context_fingerprint: expect.not.stringMatching(/^stale$/),
      generated_content: expect.objectContaining({
        documentation_reminder: expect.not.stringMatching(/^old copy$/),
      }),
    });
    expect(mocks.sendEmailCalls).toBe(1);
  });

  it("does not retarget a scheduled manual send after the reviewed contact changes", async () => {
    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: {
        data: {
          booking_id: "b1",
          tenant_id: "t1",
          phase: "t_30",
          via: "direct",
          expected_contact_id: "contact-2",
          expected_contact_email: "jordan@example.com",
        },
      },
    });

    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.sendEmailCalls).toBe(0);
  });

  it("throws (not swallows) on a non-23505 insert error", async () => {
    mocks.insertError = { code: "42501", message: "permission denied" };
    await expect(
      (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
        event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90" } },
      }),
    ).rejects.toThrow();
    expect(mocks.sendEmailCalls).toBe(0);
  });
});
