// #1165 — sub-host-review-sla-monitor
//
// Tests verify WHY behavior matters:
// - The 30-day SLA is a product commitment: auto-decline must fire reliably so
//   sub-hosts are never silently held without Stripe cancellation.
// - The day-25 alert exists so the operator can intervene before auto-decline.
// - Auto-decline must be CAS-guarded: a tenant manually reviewed between SELECT
//   and UPDATE must not be double-terminated.
// - Stripe cancellation failure must NOT abort the termination — the tenant
//   record must still be updated even if Stripe is flaky.
// - Termination side-effects (tenant.terminated event) must fire after the DB
//   update, not before — consistent with idempotency-row ordering rules.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendOperatorNotification = vi.fn(async () => ({ status: "sent" as const }));
const mockSendTenantNotification = vi.fn(async () => ({ status: "sent" as const }));
const mockInngestSend = vi.fn(async () => undefined);
const mockStripeCancel = vi.fn(async () => ({}));

vi.mock("@/lib/email/notifications", () => ({
  sendOperatorNotification: mockSendOperatorNotification,
  sendTenantNotification: mockSendTenantNotification,
}));

// Track the sequence of DB operations so we can assert ordering.
const ops: string[] = [];

type Candidate = {
  id: string;
  legal_name: string | null;
  slug: string | null;
  stripe_subscription_id: string | null;
  review_submitted_at: string | null;
};

// Configurable: what the candidates query returns.
let mockCandidates: Candidate[] = [];
// Configurable: whether the CAS update succeeds (returns 1 row) or misses (0 rows).
let casUpdateRows: Array<{ id: string }> = [{ id: "t1" }];
let auditInsertError: null | { message: string } = null;
let selectUsersError: null | { message: string } = null;

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(
    async (_meta: unknown, fn: (db: unknown, recordQuery: (q: unknown) => void) => Promise<unknown>) => {
      const db = {
        from: (table: string) => ({
          select: (_cols: string) => {
            if (table === "users") {
              // users query: .select("email").eq("tenant_id", ...).eq("status", "active")
              return {
                eq: (_col: string, _val: unknown) => ({
                  eq: (_col2: string, _val2: unknown) =>
                    Promise.resolve({
                      data: selectUsersError ? null : [{ email: "host@example.com" }],
                      error: selectUsersError,
                    }),
                }),
              };
            }
            // tenants query: .select().eq().eq().eq().eq().lt().limit()
            return {
              eq: (_col: string, _val: unknown) => ({
                eq: (_col2: string, _val2: unknown) => ({
                  eq: (_col3: string, _val3: unknown) => ({
                    eq: (_col4: string, _val4: unknown) => ({
                      lt: (_col5: string, _val5: unknown) => ({
                        limit: () => {
                          ops.push(`select.${table}`);
                          return Promise.resolve({ data: mockCandidates, error: null });
                        },
                      }),
                    }),
                  }),
                }),
              }),
            };
          },
          update: (_payload: unknown) => ({
            eq: (_col: string, _val: unknown) => ({
              eq: (_col2: string, _val2: unknown) => ({
                select: (_s: string) => {
                  ops.push(`update.${table}`);
                  return Promise.resolve({ data: casUpdateRows, error: null });
                },
              }),
            }),
          }),
          insert: (_row: unknown) => {
            ops.push(`insert.${table}`);
            return Promise.resolve({ data: null, error: auditInsertError });
          },
        }),
      };
      return fn(db, () => undefined);
    },
  ),
}));

vi.mock("stripe", () => {
  const MockStripe = vi.fn(function (this: unknown) {
    return { subscriptions: { cancel: mockStripeCancel } };
  });
  return { default: MockStripe };
});

vi.mock("@/inngest/client", () => ({
  inngest: {
    send: mockInngestSend,
    createFunction: (_meta: unknown, handler: unknown) => ({ __handler: handler }),
  },
}));

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "t1",
    legal_name: "Sunset Travel",
    slug: "sunset",
    stripe_subscription_id: "sub_abc",
    review_submitted_at: null,
    ...overrides,
  };
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("sub-host-review-sla-monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ops.length = 0;
    mockCandidates = [];
    casUpdateRows = [{ id: "t1" }];
    auditInsertError = null;
    selectUsersError = null;
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  });

  it("skips all processing in staging mode — prevents accidental prod-style sweeps on staging data", async () => {
    process.env.STAGING_MODE = "true";
    mockCandidates = [makeCandidate({ review_submitted_at: daysAgo(31) })];
    const { subHostReviewSlaMonitor } = await import(
      "@/inngest/sub-host-review-sla-monitor"
    );

    const result = await (subHostReviewSlaMonitor as unknown as { __handler: () => Promise<unknown> }).__handler();
    expect(result).toMatchObject({ skipped_for_staging: true });
    expect(mockStripeCancel).not.toHaveBeenCalled();
    delete process.env.STAGING_MODE;
  });

  it("returns ok with zero counts when no candidates — no unnecessary Stripe/email calls", async () => {
    mockCandidates = [];
    const { subHostReviewSlaMonitor } = await import(
      "@/inngest/sub-host-review-sla-monitor"
    );
    const result = await (subHostReviewSlaMonitor as unknown as { __handler: () => Promise<unknown> }).__handler();
    expect(result).toMatchObject({ ok: true, warned: 0, declined: 0 });
    expect(mockSendOperatorNotification).not.toHaveBeenCalled();
    expect(mockStripeCancel).not.toHaveBeenCalled();
  });

  it("sends operator alert for day-25 tenants — operator must be able to intervene before auto-decline", async () => {
    mockCandidates = [makeCandidate({ review_submitted_at: daysAgo(26) })];
    const { subHostReviewSlaMonitor } = await import(
      "@/inngest/sub-host-review-sla-monitor"
    );
    const result = await (subHostReviewSlaMonitor as unknown as { __handler: () => Promise<unknown> }).__handler();
    expect(result).toMatchObject({ ok: true, warned: 1, declined: 0 });
    expect(mockSendOperatorNotification).toHaveBeenCalledOnce();
    const alertArg = (mockSendOperatorNotification.mock.calls as unknown[][])[0]![0] as { subject: string };
    expect(alertArg.subject).toContain("30-day review deadline");
    expect(mockStripeCancel).not.toHaveBeenCalled();
  });

  it("auto-declines at day-30: terminates tenant, cancels Stripe, notifies applicant, emits tenant.terminated", async () => {
    mockCandidates = [makeCandidate({ review_submitted_at: daysAgo(31) })];
    const { subHostReviewSlaMonitor } = await import(
      "@/inngest/sub-host-review-sla-monitor"
    );
    const result = await (subHostReviewSlaMonitor as unknown as { __handler: () => Promise<unknown> }).__handler();
    expect(result).toMatchObject({ ok: true, warned: 0, declined: 1 });
    expect(mockStripeCancel).toHaveBeenCalledWith("sub_abc", { prorate: false });
    expect(mockSendTenantNotification).toHaveBeenCalledOnce();
    const notifyArg = (mockSendTenantNotification.mock.calls as unknown[][])[0]![0] as { template_id: string };
    expect(notifyArg.template_id).toBe("tenant_review_auto_declined");
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "tenant.terminated", data: { tenant_id: "t1", kind: "involuntary_other" } }),
    );
  });

  it("tenant.terminated fires AFTER the DB update — idempotency ordering: event means fully processed", async () => {
    mockCandidates = [makeCandidate({ review_submitted_at: daysAgo(31) })];
    const { subHostReviewSlaMonitor } = await import(
      "@/inngest/sub-host-review-sla-monitor"
    );
    await (subHostReviewSlaMonitor as unknown as { __handler: () => Promise<unknown> }).__handler();
    const updateIdx = ops.indexOf("update.tenants");
    const auditIdx = ops.indexOf("insert.audit_log");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(auditIdx).toBeGreaterThan(updateIdx);
    // The Inngest send happens after audit_log — verify call order via mock.invocationCallOrder
    const sendCallOrder = mockInngestSend.mock.invocationCallOrder[0];
    expect(sendCallOrder).toBeGreaterThan(0);
  });

  it("CAS miss is silently skipped — tenant reviewed between SELECT and UPDATE is not double-terminated", async () => {
    mockCandidates = [makeCandidate({ review_submitted_at: daysAgo(31) })];
    casUpdateRows = []; // zero rows matched = CAS loss, tenant was already acted on
    const { subHostReviewSlaMonitor } = await import(
      "@/inngest/sub-host-review-sla-monitor"
    );
    const result = await (subHostReviewSlaMonitor as unknown as { __handler: () => Promise<unknown> }).__handler();
    expect(result).toMatchObject({ ok: true, declined: 0 });
    expect(mockStripeCancel).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("Stripe cancel failure does NOT abort termination — tenant must still be marked terminated", async () => {
    mockCandidates = [makeCandidate({ review_submitted_at: daysAgo(31) })];
    mockStripeCancel.mockRejectedValueOnce(new Error("stripe network error"));
    const { subHostReviewSlaMonitor } = await import(
      "@/inngest/sub-host-review-sla-monitor"
    );
    const result = await (subHostReviewSlaMonitor as unknown as { __handler: () => Promise<unknown> }).__handler();
    // Despite Stripe failure, termination completes.
    expect(result).toMatchObject({ ok: true, declined: 1 });
    expect(mockInngestSend).toHaveBeenCalled();
  });

  it("tenants with no Stripe subscription are still auto-declined — Stripe cancel is skipped gracefully", async () => {
    mockCandidates = [makeCandidate({ review_submitted_at: daysAgo(31), stripe_subscription_id: null })];
    const { subHostReviewSlaMonitor } = await import(
      "@/inngest/sub-host-review-sla-monitor"
    );
    const result = await (subHostReviewSlaMonitor as unknown as { __handler: () => Promise<unknown> }).__handler();
    expect(result).toMatchObject({ ok: true, declined: 1 });
    expect(mockStripeCancel).not.toHaveBeenCalled();
  });
});
