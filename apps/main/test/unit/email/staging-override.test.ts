// §25.10 — Outbound isolation: when STAGING_MODE=true and TEST_OVERRIDE_EMAIL
// is set, sendEmail() must redirect every outbound to the override address
// and prefix the subject with [STAGING → original-recipient@...] so the
// test recipient can see who would have been hit in prod.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendEmail, type SendEmailInput } from "@/lib/email/send";
import type { SupabaseClient } from "@supabase/supabase-js";

function makeDb(): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    in: () => chain,
    or: () => chain,
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    not: vi.fn().mockResolvedValue({ data: [], error: null }),
    insert: () => ({
      select: () => ({
        single: vi.fn().mockResolvedValue({ data: { id: "log-1" }, error: null }),
      }),
    }),
  };
  return {
    from: () => chain,
  } as unknown as SupabaseClient;
}

const baseTenant: SendEmailInput["tenant"] = {
  id: "tenant-1",
  legal_name: "Test Agency",
  mailing_address: "123 Main St",
  email_send_pattern: "platform_resend",
  email_from_address: "noreply@test.com",
  email_from_name: "Test Agency",
};

describe("§25.10 staging outbound override", () => {
  let savedStaging: string | undefined;
  let savedOverride: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    savedStaging = process.env.STAGING_MODE;
    savedOverride = process.env.TEST_OVERRIDE_EMAIL;
    process.env.RESEND_API_KEY = "re_test_key";
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-1" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    if (savedStaging !== undefined) process.env.STAGING_MODE = savedStaging;
    else delete process.env.STAGING_MODE;
    if (savedOverride !== undefined) process.env.TEST_OVERRIDE_EMAIL = savedOverride;
    else delete process.env.TEST_OVERRIDE_EMAIL;
    delete process.env.RESEND_API_KEY;
    vi.unstubAllGlobals();
  });

  it("redirects to TEST_OVERRIDE_EMAIL and prefixes subject when STAGING_MODE=true", async () => {
    process.env.STAGING_MODE = "true";
    process.env.TEST_OVERRIDE_EMAIL = "qa@example.com";

    await sendEmail({
      db: makeDb(),
      tenant: baseTenant,
      to: "real-customer@example.com",
      subject: "Important",
      template_id: "t",
      category: "transactional",
      html: "<p>body</p>",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      to: string;
      subject: string;
    };
    expect(body.to).toBe("qa@example.com");
    expect(body.subject).toBe("[STAGING → real-customer@example.com] Important");
  });

  it("does NOT redirect when STAGING_MODE is not set", async () => {
    delete process.env.STAGING_MODE;
    process.env.TEST_OVERRIDE_EMAIL = "qa@example.com";

    await sendEmail({
      db: makeDb(),
      tenant: baseTenant,
      to: "real-customer@example.com",
      subject: "Important",
      template_id: "t",
      category: "transactional",
      html: "<p>body</p>",
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      to: string;
      subject: string;
    };
    expect(body.to).toBe("real-customer@example.com");
    expect(body.subject).toBe("Important");
  });

  it("does NOT redirect when STAGING_MODE=true but TEST_OVERRIDE_EMAIL is unset", async () => {
    process.env.STAGING_MODE = "true";
    delete process.env.TEST_OVERRIDE_EMAIL;

    await sendEmail({
      db: makeDb(),
      tenant: baseTenant,
      to: "real-customer@example.com",
      subject: "Important",
      template_id: "t",
      category: "transactional",
      html: "<p>body</p>",
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      to: string;
      subject: string;
    };
    expect(body.to).toBe("real-customer@example.com");
    expect(body.subject).toBe("Important");
  });
});
