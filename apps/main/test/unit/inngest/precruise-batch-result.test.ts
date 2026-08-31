// #1676 — precruiseSendFromBatchResult (the ai.batch_request.completed
// consumer for the §27.12 "batched" T-90/T-30/T-7 path) got the identical
// #1582 fix as the direct path (precruiseGenerateAndSend, pinned by
// precruise-duplicate-race.test.ts): check the insert error, short-circuit
// on 23505 instead of discarding it and sending anyway. Only the direct
// path had a regression test before this. Mirrors precruise-duplicate-race
// so a future refactor that touches only this twin still fails a test if
// it reintroduces the double-send / silent-loss bug.

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
}));

// #1953 — the content insert/update now purges the companion page's cache tag.
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
              maybeSingle: async () => ({ data: null, error: null }), // not yet sent
            };
            return chain;
          },
          insert(payload: Record<string, unknown>) {
            mocks.insertPayloads.push(payload);
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

import { precruiseSendFromBatchResult } from "@/inngest/precruise-generate-and-send";

type BatchResultEvent = {
  event: {
    data: {
      request_id: string;
      tenant_id: string;
      result_text: string;
      caller_metadata: {
        booking_id: string;
        tenant_id: string;
        phase: string;
        email_ctx_id: string | null;
        companion_page_url: string;
      } | null;
    };
  };
};

function runHandler(event: BatchResultEvent): Promise<void> {
  return (precruiseSendFromBatchResult as unknown as (args: BatchResultEvent) => Promise<void>)(event);
}

function makeEvent(): BatchResultEvent {
  return {
    event: {
      data: {
        request_id: "req-1",
        tenant_id: "t1",
        result_text: JSON.stringify({ summary: "Enjoy your cruise!" }),
        caller_metadata: {
          booking_id: "b1",
          tenant_id: "t1",
          phase: "t_90",
          email_ctx_id: null,
          companion_page_url: "https://example.com/companion/abc",
        },
      },
    },
  };
}

beforeEach(() => {
  mocks.insertError = null;
  mocks.insertPayloads = [];
  mocks.sendEmailCalls = 0;
  mocks.revalidateCalls = [];
});

describe("precruiseSendFromBatchResult — #1582/#1676 duplicate insert race (batched-path twin)", () => {
  it("skips the send when the insert hits a 23505 unique violation", async () => {
    mocks.insertError = { code: "23505", message: "duplicate key value violates unique constraint" };
    await runHandler(makeEvent());
    expect(mocks.sendEmailCalls).toBe(0);
    // #1953 — the race branch wrote nothing, so it must not purge the
    // companion cache either (the winning run owns that).
    expect(mocks.revalidateCalls).toEqual([]);
  });

  it("sends when the insert succeeds (no race)", async () => {
    mocks.insertError = null;
    await runHandler(makeEvent());
    expect(mocks.sendEmailCalls).toBe(1);
    expect(mocks.insertPayloads[0]).toMatchObject({
      booking_id: "b1",
      contact_id: "contact-1",
    });
    // #1953 — content landed, so the companion page's (booking_id, phase)
    // cache entry must be purged or a placeholder-phase render stays pinned.
    expect(mocks.revalidateCalls).toEqual([["b1", "t_90"]]);
  });

  it("throws (not swallows) on a non-23505 insert error — the batch consumer must fail loud for Inngest retry, same as the direct path", async () => {
    mocks.insertError = { code: "42501", message: "permission denied" };
    await expect(runHandler(makeEvent())).rejects.toThrow();
    expect(mocks.sendEmailCalls).toBe(0);
  });
});
