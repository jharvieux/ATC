// §23 — sendEmail happy path + suppression + rate limit tests.
//
// We test the deterministic paths: suppression blocks, rate limit blocks,
// missing key fails. The actual Resend fetch call is intercepted via the
// vi.stubGlobal fetch mock so no real HTTP happens.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { sendEmail, type SendEmailInput } from "@/lib/email/send";
import type { SupabaseClient } from "@supabase/supabase-js";

const testHtml = "<p>Test email body</p>";

type DbChain = Record<string, unknown>;

function makeDb({
  suppressions = [] as unknown[],
  logCount = 0,
  insertId = "log-1",
  logInsertError = null as { message: string } | null,
}: {
  suppressions?: unknown[];
  logCount?: number;
  insertId?: string;
  logInsertError?: { message: string } | null;
} = {}): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === "email_suppressions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: () => ({
                  or: vi.fn().mockResolvedValue({ data: suppressions, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "email_log") {
        // rate-limit query
        const countChain: DbChain = {
          select: () => countChain,
          eq: () => countChain,
          gte: () => countChain,
          not: vi.fn().mockResolvedValue({ data: Array(logCount).fill({ id: "x" }), error: null }),
          insert: () => ({
            select: () => ({
              single: vi.fn().mockResolvedValue(
                logInsertError ? { data: null, error: logInsertError } : { data: { id: insertId }, error: null },
              ),
            }),
          }),
        };
        return countChain as unknown as ReturnType<SupabaseClient["from"]>;
      }
      return {} as ReturnType<SupabaseClient["from"]>;
    },
  } as unknown as SupabaseClient;
}

const baseTenant: SendEmailInput["tenant"] = {
  id: "tenant-1",
  legal_name: "Test Agency",
  mailing_address: "123 Main St, Miami FL",
  email_send_pattern: "platform_resend",
  email_from_address: "noreply@test.com",
  email_from_name: "Test Agency",
};

describe("sendEmail — §23", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-msg-123" }),
      text: async () => "",
    }));
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    vi.unstubAllGlobals();
  });

  it("sends email and returns sent status on happy path", async () => {
    const db = makeDb();
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test Subject",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
    });
    expect(result.status).toBe("sent");
    expect(result.resend_message_id).toBe("resend-msg-123");
  });

  it("falls back to legal_name when email_from_name is an empty string (Resend 422 regression)", async () => {
    // tenant_branding stores "" (not NULL) for an unset from-name. Nullish
    // coalescing let "" through, yielding a " <addr>" from header that Resend
    // rejects with 422 "Invalid `from` field" — a silent fail-soft delivery
    // failure. Empty/whitespace must fall through to legal_name.
    const db = makeDb();
    const result = await sendEmail({
      db,
      tenant: { ...baseTenant, email_from_name: "", legal_name: "Lisa Travel LLC", email_from_address: "noreply@test.com" },
      to: "customer@example.com",
      subject: "Test",
      template_id: "t",
      category: "transactional",
      html: testHtml,
    });
    expect(result.status).toBe("sent");
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const body = JSON.parse((calls[0]?.[1]?.body as string) ?? "{}") as { from: string };
    expect(body.from).toBe("Lisa Travel LLC <noreply@test.com>");
  });

  it("returns suppressed when email_suppressions match", async () => {
    const db = makeDb({ suppressions: [{ reason: "hard_bounce" }] });
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "bounced@example.com",
      subject: "Test",
      template_id: "t",
      category: "transactional",
      html: testHtml,
    });
    expect(result.status).toBe("suppressed");
    expect(result.reason).toBe("hard_bounce");
  });

  it("returns rate_limited for marketing email at limit (4 sent)", async () => {
    const db = makeDb({ suppressions: [], logCount: 4 });
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Marketing email",
      template_id: "promo",
      category: "marketing",
      html: testHtml,
    });
    expect(result.status).toBe("rate_limited");
    expect(result.reason).toBe("marketing_monthly_limit_reached");
  });

  it("still returns sent when the email_log insert errors (#400 — log failure is non-fatal)", async () => {
    // The email was already handed to the vendor; a failed audit-log insert
    // must NOT flip the result to "failed". Pre-fix the error was discarded;
    // post-fix it is warned-and-swallowed, so the send still reports sent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeDb({ logInsertError: { message: "email_log insert boom" } });
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test Subject",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
    });
    expect(result.status).toBe("sent");
    expect(result.email_log_id).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("email_log insert failed"));
    warn.mockRestore();
  });

  it("returns failed when RESEND_API_KEY is not set", async () => {
    delete process.env.RESEND_API_KEY;
    const db = makeDb();
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test",
      template_id: "t",
      category: "transactional",
      html: testHtml,
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/platform_resend_key_not_set/);
  });
});
