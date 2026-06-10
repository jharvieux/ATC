// §21.10.1 / §23.10.1 — Quote estimate expiry sweep.
//
// Tests verify WHY the behavior matters:
//   - Contacts without an email are silently skipped so the cron doesn't fail
//     mid-batch. Operators need accurate emailed counts to trust the pipeline.
//   - Quotes with a valid contact email get an email through sendEmail with the
//     correct category and template_id so rate-limit + audit-log work correctly.
//   - Each quote is marked expired AFTER its email sends — a DB error on the
//     status update leaves the quote re-processable on the next run (no stranding).
//   - sendEmail returning 'failed' does not expire or count the quote.
//   - Batch-fetch errors (contacts, tenants, branding) abort before the loop
//     so no emails are sent and no quotes are marked expired.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendEmail = vi.fn();
vi.mock("@/lib/email/send", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/email/unsubscribe-token", () => ({
  signUnsubscribeToken: () => "signed-token",
}));
vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_: unknown, handler: unknown) => ({ __handler: handler }),
  },
}));
vi.mock("react-dom/server", () => ({
  renderToStaticMarkup: () => "<html>mocked</html>",
}));

const mockFrom = vi.fn();
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: mockFrom }),
}));

// Minimal chainable mock — returns the provided data as the terminal resolution.
function makeSelectChain(data: unknown, error: null | { message: string } = null) {
  const resolve = () => Promise.resolve({ data, error });
  const deepChain = (): unknown =>
    new Proxy({}, {
      get: (_target, prop) => {
        if (prop === "then") return resolve().then.bind(resolve());
        return (..._args: unknown[]) => deepChain();
      },
    });
  return deepChain();
}

// Per-quote update chain: .update().eq("id").eq("status").select("id")
function makeUpdateChain(result: { data: { id: string }[] | null; error: null | { message: string } }) {
  return {
    update: () => ({
      eq: () => ({
        eq: () => ({
          select: () => Promise.resolve(result),
        }),
      }),
    }),
  };
}

async function runSweep(): Promise<unknown> {
  vi.resetModules();
  const { quoteEstimateExpirySweep } = await import(
    "@/inngest/quote-estimate-expiry-sweep"
  );
  const fn = (quoteEstimateExpirySweep as unknown) as { __handler: () => Promise<unknown> };
  return fn.__handler();
}

const TENANT = { id: "t1", legal_name: "Test Agency", mailing_address: null, email_send_pattern: "platform_resend", tenant_resend_api_key_encrypted: null, email_from_address: null, email_from_name: null };
const CONTACT = { id: "c1", first_name: "Jane", last_name: "Doe", email: "jane@example.com" };
// §38 — the quotes container no longer carries trip columns; cruise_line/
// ship_name now come from the representative quote_options row.
const QUOTE_ROW = { id: "q1", tenant_id: "t1", contact_id: "c1", user_id: null, customer_access_token: "tok-abc" };
const OPTION_ROW = { quote_id: "q1", option_index: 1, customer_selected: false, cruise_line: "NCL", ship_name: "Bliss" };

function setupHappyPathMocks(overrides: { updateResult?: { data: { id: string }[] | null; error: null | { message: string } } } = {}) {
  const updateResult = overrides.updateResult ?? { data: [{ id: QUOTE_ROW.id }], error: null };
  let quotesCallCount = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === "quotes") {
      quotesCallCount++;
      if (quotesCallCount === 1) return makeSelectChain([QUOTE_ROW]);
      return makeUpdateChain(updateResult);
    }
    if (table === "contacts") return makeSelectChain([CONTACT]);
    if (table === "tenants") return makeSelectChain([TENANT]);
    if (table === "quote_options") return makeSelectChain([OPTION_ROW]);
    return makeSelectChain([]);
  });
}

describe("quoteEstimateExpirySweep — §21.10.1 / §23.10.1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("sends emails for expired quotes with valid contact emails", async () => {
    mockSendEmail.mockResolvedValue({ status: "sent" });
    setupHappyPathMocks();

    const result = await runSweep();
    expect(result).toEqual({ expired: 1, emailed: 1 });
    expect(mockSendEmail).toHaveBeenCalledOnce();

    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.to).toBe("jane@example.com");
    expect(call.category).toBe("transactional");
    expect(call.template_id).toBe("quote_estimate_expired");
    // §38 — subject label is built from the representative quote_options row,
    // not the (now-dropped) quotes.cruise_line/ship_name columns.
    expect(call.subject).toContain("NCL — Bliss");
  });

  it("§38 — falls back to the generic subject when the quote has no options", async () => {
    mockSendEmail.mockResolvedValue({ status: "sent" });
    let quotesCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "quotes") {
        quotesCallCount++;
        if (quotesCallCount === 1) return makeSelectChain([QUOTE_ROW]);
        return makeUpdateChain({ data: [{ id: QUOTE_ROW.id }], error: null });
      }
      if (table === "contacts") return makeSelectChain([CONTACT]);
      if (table === "tenants") return makeSelectChain([TENANT]);
      // quote_options returns [] → no representative option → generic subject.
      return makeSelectChain([]);
    });

    await runSweep();
    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    // #963 — the default subject now comes from the template registry; with
    // no representative option, {{cruise_label}} falls back to "your cruise".
    expect(call.subject).toBe("Your estimate for your cruise has expired — request fresh pricing");
  });

  it("skips quotes where contact has no email — not expired, not emailed", async () => {
    let quotesCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "quotes") {
        quotesCallCount++;
        if (quotesCallCount === 1) {
          return makeSelectChain([{ ...QUOTE_ROW, id: "q2", contact_id: "c2", customer_access_token: null }]);
        }
      }
      if (table === "contacts") return makeSelectChain([{ id: "c2", first_name: null, last_name: null, email: null }]);
      if (table === "tenants") return makeSelectChain([TENANT]);
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("skips quotes where contact_id is null — not expired, not emailed", async () => {
    let quotesCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "quotes") {
        quotesCallCount++;
        if (quotesCallCount === 1) {
          return makeSelectChain([{ ...QUOTE_ROW, id: "q3", contact_id: null }]);
        }
      }
      if (table === "tenants") return makeSelectChain([TENANT]);
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sendEmail returning 'failed' does not expire or count the quote", async () => {
    mockSendEmail.mockResolvedValue({ status: "failed", reason: "resend_500" });
    let quotesCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "quotes") {
        quotesCallCount++;
        if (quotesCallCount === 1) return makeSelectChain([QUOTE_ROW]);
      }
      if (table === "contacts") return makeSelectChain([CONTACT]);
      if (table === "tenants") return makeSelectChain([TENANT]);
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0 });
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("returns early with error when initial quotes query fails — no emails sent", async () => {
    mockFrom.mockImplementation(() =>
      makeSelectChain(null, { message: "connection reset" }),
    );

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0, error: "connection reset" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns { expired: 0, emailed: 0 } when no stale quotes exist", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "quotes") return makeSelectChain([]);
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("contactsErr aborts before loop — expired: 0, emailed: 0", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "quotes") return makeSelectChain([QUOTE_ROW]);
      if (table === "contacts") return makeSelectChain(null, { message: "contacts unavailable" });
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0, error: "contacts unavailable" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("tenantsErr aborts before loop — expired: 0, emailed: 0", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "quotes") return makeSelectChain([QUOTE_ROW]);
      if (table === "contacts") return makeSelectChain([CONTACT]);
      if (table === "tenants") return makeSelectChain(null, { message: "tenants unavailable" });
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0, error: "tenants unavailable" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("brandingsErr aborts before loop — expired: 0, emailed: 0", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "quotes") return makeSelectChain([QUOTE_ROW]);
      if (table === "contacts") return makeSelectChain([CONTACT]);
      if (table === "tenants") return makeSelectChain([TENANT]);
      if (table === "tenant_branding") return makeSelectChain(null, { message: "branding unavailable" });
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0, error: "branding unavailable" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("updateErr after successful email — emailed increments, expired does not", async () => {
    mockSendEmail.mockResolvedValue({ status: "sent" });
    setupHappyPathMocks({ updateResult: { data: null, error: { message: "update failed" } } });

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 1 });
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("zero-row CAS update (concurrent expiry) — emailed increments but expired does not", async () => {
    mockSendEmail.mockResolvedValue({ status: "sent" });
    setupHappyPathMocks({ updateResult: { data: [], error: null } });

    const result = await runSweep();
    // emailed++ because the email was dispatched; expired stays 0 because another
    // process already marked this quote expired between our select and update.
    expect(result).toEqual({ expired: 0, emailed: 1 });
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("sendEmail returning 'rate_limited' does not expire the quote — re-processable on next cron", async () => {
    mockSendEmail.mockResolvedValue({ status: "rate_limited" });
    let quotesCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "quotes") {
        quotesCallCount++;
        if (quotesCallCount === 1) return makeSelectChain([QUOTE_ROW]);
      }
      if (table === "contacts") return makeSelectChain([CONTACT]);
      if (table === "tenants") return makeSelectChain([TENANT]);
      return makeSelectChain([]);
    });

    const result = await runSweep();
    // rate_limited means the send was skipped; quote stays sent for next run.
    expect(result).toEqual({ expired: 0, emailed: 0 });
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("sendEmail returning 'suppressed' does not expire or email the quote", async () => {
    mockSendEmail.mockResolvedValue({ status: "suppressed" });
    let quotesCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "quotes") {
        quotesCallCount++;
        if (quotesCallCount === 1) return makeSelectChain([QUOTE_ROW]);
      }
      if (table === "contacts") return makeSelectChain([CONTACT]);
      if (table === "tenants") return makeSelectChain([TENANT]);
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0 });
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });
});
