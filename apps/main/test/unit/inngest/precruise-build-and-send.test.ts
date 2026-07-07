// #1582 — buildAndSend's transient-failure and duplicate-insert-race
// handling.
//
// The bug: a "failed" sendEmail result (Resend 5xx, timeout, misconfigured
// tenant key) was only logged, never thrown. The pre_cruise_email_content
// row already existed with sent_at null, and the scheduler deduped on row
// *existence* rather than sent_at, so the booking was silently skipped on
// every future scheduler run — the customer never got the email and no
// alert fired. Separately, a concurrent duplicate event could race past the
// discarded insert error on a 23505 unique violation and send twice.
//
// These tests pin: (1) "failed" throws so Inngest retries the run instead
// of swallowing it, (2) "sent" does not throw and persists sent_at, and
// (3) "suppressed"/"rate_limited" are terminal policy outcomes that must
// NOT throw (they are not transient errors — retrying won't help).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEmailResult: { status: "sent" as string, reason: null as string | null },
  updateCalls: [] as Array<{ table: string; payload: unknown }>,
}));

vi.mock("@/lib/sailings/sailing-itinerary", () => ({
  getSailingItinerary: async () => null,
}));

vi.mock("@/lib/email/template-resolve", () => ({
  resolveEmailContent: async () => ({ subject: "Test Subject", overrideBodyText: "Hello there" }),
  renderOverrideBodyInLayout: async () => "<html>mock</html>",
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async () => mocks.sendEmailResult,
}));

import { buildAndSend } from "@/inngest/precruise-generate-and-send";

function makeSvc() {
  return {
    from(table: string) {
      return {
        update(payload: unknown) {
          mocks.updateCalls.push({ table, payload });
          return { eq: async () => ({ data: null, error: null }) };
        },
      };
    },
  } as unknown as Parameters<typeof buildAndSend>[0]["svc"];
}

const EMAIL_CTX = {
  booking: { id: "booking-1" },
  toEmail: "traveler@example.com",
  tenant: { id: "tenant-1", legal_name: "Test Agency" },
  branding: {},
  customerName: "Jordan",
  shipName: "Test Ship",
  cruiseLine: "Test Cruise Line",
  sailingDate: "2026-09-01",
  ports: [],
  companionPageUrl: "https://example.com/companion/token",
  unsubscribeUrl: "https://example.com/unsub",
  layoutProps: {
    branding: { logo_url: null, primary_color: null, secondary_color: null, accent_color: null, slogan: null },
    tenant_legal_name: "Test Agency",
    tenant_business_address: null,
    unsubscribe_url: "https://example.com/unsub",
  },
} as unknown as Parameters<typeof buildAndSend>[0]["emailCtx"];

beforeEach(() => {
  mocks.sendEmailResult = { status: "sent", reason: null };
  mocks.updateCalls = [];
});

describe("buildAndSend — #1582 transient-failure retry semantics", () => {
  it("throws when sendEmail returns status:\"failed\" so Inngest retries", async () => {
    mocks.sendEmailResult = { status: "failed", reason: "resend_500" };
    await expect(
      buildAndSend({
        svc: makeSvc(),
        phase: "t_90",
        emailCtx: EMAIL_CTX,
        generatedContent: {},
        contentId: "content-1",
      }),
    ).rejects.toThrow(/send failed/);
    // A failed send must never mark sent_at — the row stays retryable.
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it("does not throw and persists sent_at when sendEmail succeeds", async () => {
    mocks.sendEmailResult = { status: "sent", reason: null };
    await expect(
      buildAndSend({
        svc: makeSvc(),
        phase: "t_90",
        emailCtx: EMAIL_CTX,
        generatedContent: {},
        contentId: "content-1",
      }),
    ).resolves.toBeUndefined();
    expect(mocks.updateCalls).toHaveLength(1);
    expect(mocks.updateCalls[0]?.table).toBe("pre_cruise_email_content");
    expect(mocks.updateCalls[0]?.payload).toHaveProperty("sent_at");
  });

  it.each(["suppressed", "rate_limited"])(
    "does not throw on terminal policy outcome status:\"%s\"",
    async (status) => {
      mocks.sendEmailResult = { status, reason: "policy" };
      await expect(
        buildAndSend({
          svc: makeSvc(),
          phase: "t_90",
          emailCtx: EMAIL_CTX,
          generatedContent: {},
          contentId: "content-1",
        }),
      ).resolves.toBeUndefined();
      // Not sent — sent_at must not be written either.
      expect(mocks.updateCalls).toHaveLength(0);
    },
  );
});
