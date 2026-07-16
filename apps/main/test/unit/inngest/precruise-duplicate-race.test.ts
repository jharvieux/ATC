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
  sendEmailCalls: 0,
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
              maybeSingle: async () => ({ data: null, error: null }), // not yet sent
            };
            return chain;
          },
          insert() {
            return {
              select: () => ({
                single: async () => ({ data: null, error: mocks.insertError }),
              }),
            };
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
  mocks.sendEmailCalls = 0;
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
