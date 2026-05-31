// §21.10.1 / §23.10.1 — Quote estimate expiry sweep.
//
// Tests verify WHY the behavior matters:
//   - Contacts without an email are silently skipped so the cron doesn't fail
//     mid-batch. Operators need accurate emailed counts to trust the pipeline.
//   - Quotes with a valid contact email get an email through sendEmail with the
//     correct category and template_id so rate-limit + audit-log work correctly.
//   - DB errors on the initial query abort immediately rather than updating
//     status first, which would leave quotes in expired-but-never-emailed limbo.
//   - sendEmail returning 'failed' does not increment the emailed count but the
//     quote is still expired — the expiry is non-retryable on next run.

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

async function runSweep(): Promise<unknown> {
  vi.resetModules();
  const { quoteEstimateExpirySweep } = await import(
    "@/inngest/quote-estimate-expiry-sweep"
  );
  const fn = (quoteEstimateExpirySweep as unknown) as { __handler: () => Promise<unknown> };
  return fn.__handler();
}

describe("quoteEstimateExpirySweep — §21.10.1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("sends emails for expired quotes with valid contact emails", async () => {
    mockSendEmail.mockResolvedValue({ status: "sent" });

    const expiredRows = [
      { id: "q1", tenant_id: "t1", contact_id: "c1", user_id: null, customer_access_token: "tok-abc", cruise_line: "NCL", ship_name: "Bliss" },
    ];

    let callIdx = 0;
    mockFrom.mockImplementation((table: string) => {
      callIdx++;
      // 1st call: quotes select
      if (table === "quotes" && callIdx === 1) {
        return makeSelectChain(expiredRows);
      }
      // 2nd call: quotes update
      if (table === "quotes" && callIdx === 2) {
        return { update: () => ({ in: () => Promise.resolve({ error: null }) }) };
      }
      if (table === "contacts") {
        return makeSelectChain([{ id: "c1", first_name: "Jane", last_name: "Doe", email: "jane@example.com" }]);
      }
      if (table === "tenants") {
        return makeSelectChain([{ id: "t1", legal_name: "Test Agency", mailing_address: null, email_send_pattern: "platform_resend", tenant_resend_api_key_encrypted: null, email_from_address: null, email_from_name: null }]);
      }
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 1, emailed: 1 });
    expect(mockSendEmail).toHaveBeenCalledOnce();

    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.to).toBe("jane@example.com");
    expect(call.category).toBe("transactional");
    expect(call.template_id).toBe("quote_estimate_expired");
  });

  it("skips quotes where contact has no email and returns correct counts", async () => {
    const expiredRows = [
      { id: "q2", tenant_id: "t1", contact_id: "c2", user_id: null, customer_access_token: null, cruise_line: null, ship_name: null },
    ];

    let callIdx = 0;
    mockFrom.mockImplementation((table: string) => {
      callIdx++;
      if (table === "quotes" && callIdx === 1) return makeSelectChain(expiredRows);
      if (table === "quotes" && callIdx === 2) return { update: () => ({ in: () => Promise.resolve({ error: null }) }) };
      if (table === "contacts") return makeSelectChain([{ id: "c2", first_name: null, last_name: null, email: null }]);
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 1, emailed: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("skips quotes where contact_id is null", async () => {
    const expiredRows = [
      { id: "q3", tenant_id: "t1", contact_id: null, user_id: null, customer_access_token: null, cruise_line: null, ship_name: null },
    ];

    let callIdx = 0;
    mockFrom.mockImplementation((table: string) => {
      callIdx++;
      if (table === "quotes" && callIdx === 1) return makeSelectChain(expiredRows);
      if (table === "quotes" && callIdx === 2) return { update: () => ({ in: () => Promise.resolve({ error: null }) }) };
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 1, emailed: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sendEmail returning 'failed' does not increment emailed count — quote is still expired", async () => {
    mockSendEmail.mockResolvedValue({ status: "failed", reason: "resend_500" });

    const expiredRows = [
      { id: "q4", tenant_id: "t1", contact_id: "c1", user_id: null, customer_access_token: "tok", cruise_line: null, ship_name: null },
    ];

    let callIdx = 0;
    mockFrom.mockImplementation((table: string) => {
      callIdx++;
      if (table === "quotes" && callIdx === 1) return makeSelectChain(expiredRows);
      if (table === "quotes" && callIdx === 2) return { update: () => ({ in: () => Promise.resolve({ error: null }) }) };
      if (table === "contacts") return makeSelectChain([{ id: "c1", first_name: "Jane", last_name: "Doe", email: "jane@example.com" }]);
      if (table === "tenants") return makeSelectChain([{ id: "t1", legal_name: "Agency", mailing_address: null, email_send_pattern: "platform_resend", tenant_resend_api_key_encrypted: null, email_from_address: null, email_from_name: null }]);
      return makeSelectChain([]);
    });

    const result = await runSweep();
    // expired=1 (status update applied) but emailed=0 (send failed)
    expect(result).toEqual({ expired: 1, emailed: 0 });
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("returns early with error when initial quotes query fails — no status update", async () => {
    mockFrom.mockImplementation(() =>
      makeSelectChain(null, { message: "connection reset" }),
    );

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0, error: "connection reset" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns { expired: 0, emailed: 0 } when no stale quotes exist", async () => {
    let callIdx = 0;
    mockFrom.mockImplementation((table: string) => {
      callIdx++;
      if (table === "quotes" && callIdx === 1) return makeSelectChain([]);
      return makeSelectChain([]);
    });

    const result = await runSweep();
    expect(result).toEqual({ expired: 0, emailed: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
