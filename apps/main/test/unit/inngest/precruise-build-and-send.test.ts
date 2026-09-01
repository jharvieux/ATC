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
import { createHash } from "node:crypto";

const CONTENT_CONTEXT_HASH = createHash("sha256")
  .update(JSON.stringify({
    contact_id: "contact-1",
    recipient_email: "traveler@example.com",
    customer_name: "Jordan",
    cruise_line: "Test Cruise Line",
    ship_name: "Test Ship",
    sailing_date: "2026-09-01",
    departure_port: null,
    ports: [],
  }))
  .digest("hex");

const mocks = vi.hoisted(() => ({
  sendEmailResult: { status: "sent" as string, reason: null as string | null },
  sendEmailArgs: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<{ table: string; payload: unknown }>,
  bookingStatus: "confirmed",
  bookingContactId: "contact-1",
  contactEmail: "traveler@example.com",
  sailingDate: "2026-09-01",
  claimed: false,
  afterClaim: null as (() => void) | null,
  beforeDispatchMutation: null as (() => void) | null,
  operations: [] as string[],
  tenantPaying: true,
  providerCalls: 0,
  providerFirstAttemptAt: null as string | null,
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  assertTenantStillPayingById: async () => ({
    ok: mocks.tenantPaying,
    ...(mocks.tenantPaying ? {} : { reason: "past_grace", days_since_non_paying: 31 }),
  }),
}));

vi.mock("@/lib/sailings/sailing-itinerary", () => ({
  getSailingItinerary: async () => null,
}));

vi.mock("@/lib/email/template-resolve", () => ({
  resolveEmailContent: async () => ({ subject: "Test Subject", overrideBodyText: "Hello there" }),
  renderOverrideBodyInLayout: async () => "<html>mock</html>",
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (args: Record<string, unknown>) => {
    mocks.operations.push("sendEmail");
    mocks.sendEmailArgs.push(args);
    mocks.beforeDispatchMutation?.();
    const beforeDispatch = args.beforeDispatch as (() => Promise<boolean | { allowed: boolean; reason?: string }>) | undefined;
    if (beforeDispatch) {
      const verdict = await beforeDispatch();
      if (!(typeof verdict === "boolean" ? verdict : verdict.allowed)) {
        return { status: "cancelled", reason: typeof verdict === "boolean" ? null : verdict.reason ?? null };
      }
    }
    mocks.providerCalls++;
    return mocks.sendEmailResult;
  },
  TENANT_BRANDING_COLUMNS:
    "tenant_id, logo_url, primary_color, secondary_color, accent_color, slogan, " +
    "email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, " +
    "email_from_name, email_from_domain, email_from_domain_verified_at",
}));

import { buildAndSend } from "@/inngest/precruise-generate-and-send";

function makeSvc() {
  return {
    from(table: string) {
      if (table === "bookings") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              maybeSingle: async () => ({
                data: {
                  status: mocks.bookingStatus,
                  primary_contact_id: mocks.bookingContactId,
                  cruise_line: "Test Cruise Line",
                  ship_name: "Test Ship",
                  sailing_date: mocks.sailingDate,
                  departure_port: null,
                  groups: null,
                  contacts: {
                    tenant_id: "tenant-1",
                    first_name: "Jordan",
                    email: mocks.contactEmail,
                  },
                },
                error: null,
              }),
            };
            mocks.operations.push("final-read");
            return chain;
          },
        };
      }
      return {
        update(payload: Record<string, unknown>) {
          mocks.updateCalls.push({ table, payload });
          const chain = {
            eq: () => chain,
            is: () => chain,
            or: () => chain,
            select: async () => {
              if (payload.send_claimed_at) {
                if (mocks.claimed) return { data: [], error: null };
                mocks.claimed = true;
                mocks.operations.push("claim");
                mocks.afterClaim?.();
                return {
                  data: [{
                    send_claimed_at: payload.send_claimed_at,
                    provider_first_attempt_at: mocks.providerFirstAttemptAt,
                    content_context_hash: CONTENT_CONTEXT_HASH,
                    generated_content: {},
                  }],
                  error: null,
                };
              }
              if (payload.provider_first_attempt_at) {
                mocks.operations.push("provider-attempt");
                return { data: [{ id: "content-1" }], error: null };
              }
              mocks.claimed = false;
              mocks.operations.push("release-or-finalize");
              return { data: [{ id: "content-1" }], error: null };
            },
          };
          return chain;
        },
      };
    },
  } as unknown as Parameters<typeof buildAndSend>[0]["svc"];
}

const EMAIL_CTX = {
  booking: { id: "booking-1", primary_contact_id: "contact-1" },
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
  mocks.sendEmailArgs = [];
  mocks.updateCalls = [];
  mocks.bookingStatus = "confirmed";
  mocks.bookingContactId = "contact-1";
  mocks.contactEmail = "traveler@example.com";
  mocks.sailingDate = "2026-09-01";
  mocks.claimed = false;
  mocks.afterClaim = null;
  mocks.beforeDispatchMutation = null;
  mocks.operations = [];
  mocks.tenantPaying = true;
  mocks.providerCalls = 0;
  mocks.providerFirstAttemptAt = null;
});

describe("buildAndSend — #1582 transient-failure retry semantics", () => {
  it("throws when sendEmail returns status:\"failed\" so Inngest retries", async () => {
    mocks.sendEmailResult = { status: "failed", reason: "resend_500" };
    await expect(
      buildAndSend({
        svc: makeSvc(),
        phase: "t_90",
        emailCtx: EMAIL_CTX,
        contentId: "content-1",
      }),
    ).rejects.toThrow(/send failed/);
    // A failed send must never mark sent_at — the row stays retryable.
    expect(mocks.updateCalls.filter((call) => "sent_at" in (call.payload as object))).toHaveLength(0);
  });

  it("does not throw and persists sent_at when sendEmail succeeds", async () => {
    mocks.sendEmailResult = { status: "sent", reason: null };
    await expect(
      buildAndSend({
        svc: makeSvc(),
        phase: "t_90",
        emailCtx: EMAIL_CTX,
        contentId: "content-1",
      }),
    ).resolves.toBeUndefined();
    const sentUpdate = mocks.updateCalls.find((call) => "sent_at" in (call.payload as object));
    expect(sentUpdate?.table).toBe("pre_cruise_email_content");
    expect(sentUpdate?.payload).toHaveProperty("sent_at");
    expect(mocks.sendEmailArgs[0]).toMatchObject({
      contact_id: "contact-1",
      related_booking_id: "booking-1",
      idempotencyKey: "pre_cruise:booking-1:t_90",
    });
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
          contentId: "content-1",
        }),
      ).resolves.toBeUndefined();
      // Not sent — sent_at must not be written either.
      expect(mocks.updateCalls.filter((call) => "sent_at" in (call.payload as object))).toHaveLength(0);
    },
  );

  it("rechecks cancellation immediately before dispatch", async () => {
    mocks.bookingStatus = "cancelled";

    await buildAndSend({
      svc: makeSvc(),
      phase: "t_7",
      emailCtx: EMAIL_CTX,
      contentId: "content-1",
    });

    expect(mocks.sendEmailArgs).toHaveLength(0);
  });

  it("releases the claim when the tenant becomes ineligible before dispatch", async () => {
    mocks.tenantPaying = false;

    await buildAndSend({
      svc: makeSvc(),
      phase: "t_7",
      emailCtx: EMAIL_CTX,
      contentId: "content-1",
    });

    expect(mocks.sendEmailArgs).toHaveLength(0);
    expect(mocks.operations).toEqual(["claim", "release-or-finalize"]);
  });

  it("claims first, then catches a booking/contact mutation in the one final read", async () => {
    mocks.afterClaim = () => {
      mocks.bookingContactId = "contact-2";
      mocks.contactEmail = "new-recipient@example.com";
    };

    await buildAndSend({
      svc: makeSvc(),
      phase: "t_7",
      emailCtx: EMAIL_CTX,
      contentId: "content-1",
    });

    expect(mocks.sendEmailArgs).toHaveLength(0);
    expect(mocks.operations).toEqual(["claim", "final-read", "release-or-finalize"]);
  });

  it("rechecks the primary contact address immediately before dispatch", async () => {
    mocks.contactEmail = "new-recipient@example.com";

    await buildAndSend({
      svc: makeSvc(),
      phase: "t_7",
      emailCtx: EMAIL_CTX,
      contentId: "content-1",
    });

    expect(mocks.sendEmailArgs).toHaveLength(0);
  });

  it("does not send rendered content after material trip details change", async () => {
    mocks.sailingDate = "2026-09-08";

    await buildAndSend({
      svc: makeSvc(),
      phase: "t_30",
      emailCtx: EMAIL_CTX,
      contentId: "content-1",
    });

    expect(mocks.sendEmailArgs).toHaveLength(0);
  });

  it("allows only one concurrent consumer to invoke sendEmail for an existing row", async () => {
    const svc = makeSvc();

    await Promise.all([
      buildAndSend({ svc, phase: "t_30", emailCtx: EMAIL_CTX, contentId: "content-1" }),
      buildAndSend({ svc, phase: "t_30", emailCtx: EMAIL_CTX, contentId: "content-1" }),
    ]);

    expect(mocks.sendEmailArgs).toHaveLength(1);
  });

  it.each([
    ["booking cancellation", () => { mocks.bookingStatus = "cancelled"; }],
    ["recipient mutation", () => {
      mocks.bookingContactId = "contact-2";
      mocks.contactEmail = "new-recipient@example.com";
    }],
    ["payment ineligibility", () => { mocks.tenantPaying = false; }],
  ])("blocks provider fetch when %s happens after rendering", async (_label, mutate) => {
    mocks.beforeDispatchMutation = mutate;

    await buildAndSend({
      svc: makeSvc(),
      phase: "t_7",
      emailCtx: EMAIL_CTX,
      contentId: "content-1",
    });

    expect(mocks.sendEmailArgs).toHaveLength(1);
    expect(mocks.providerCalls).toBe(0);
    expect(mocks.updateCalls.filter((call) => "sent_at" in (call.payload as object))).toHaveLength(0);
    expect(mocks.operations.at(-1)).toBe("release-or-finalize");
  });

  it("never re-enters the provider after the 23-hour replay cutoff", async () => {
    mocks.providerFirstAttemptAt = new Date(Date.now() - 23 * 60 * 60_000).toISOString();

    await buildAndSend({
      svc: makeSvc(),
      phase: "t_7",
      emailCtx: EMAIL_CTX,
      contentId: "content-1",
    });

    expect(mocks.sendEmailArgs).toHaveLength(0);
    expect(mocks.providerCalls).toBe(0);
    expect(mocks.operations).toEqual(["claim", "release-or-finalize"]);
  });
});
