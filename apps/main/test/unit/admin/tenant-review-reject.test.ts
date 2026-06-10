// #403 / §15.14.2 — onboarding review-reject must run termination side-effects.
//
// A rejected applicant goes straight to status='terminated' (it was never
// 'suspended'), so it bypasses the suspended→terminated finalizer entirely.
// The route therefore emits tenant.terminated DIRECTLY so the §15.14.2 cleanup
// (domain unbind, host-credential deletion, RAG chunk marking) still fires.
//
// These tests are the regression guard for that wiring: if a future refactor
// moves the emit into finalizeTermination without re-adding it to the reject
// path, the reject branch goes silent and the cleanup never runs — and the
// "approve does not emit terminated" case stops the emit from leaking branches.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_event: { name: string; data?: unknown }) => undefined),
  cancel: vi.fn(async () => ({})),
  subUpdate: vi.fn(async () => ({})),
  update: vi.fn((_payload: Record<string, unknown>) => ({ eq: async () => ({ error: null }) })),
  sendNotification: vi.fn(async (_input: Record<string, unknown>) => ({ status: "sent" })),
  tenantRow: { id: "t-1", legal_name: "Acme Travel LLC", slug: "acme", stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1", review_decision: null } as Record<string, unknown> | null,
  usersRows: [{ email: "owner@acme.test" }] as Array<{ email: string }>,
  fetchErr: null as { message: string } | null,
}));

vi.mock("@/lib/auth/assert-platform-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-platform-admin")>(
    "@/lib/auth/assert-platform-admin",
  );
  return {
    ...actual,
    assertPlatformAdmin: vi.fn(async (req: Request) => {
      const adminUserId = req.headers.get("x-admin-user-id");
      if (!adminUserId) {
        throw new actual.PlatformAdminError(401, "missing_bearer", "Missing Authorization: Bearer header.");
      }
      return { admin_user_id: adminUserId, role: "test", via: "session" as const };
    }),
  };
});

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (_opts, fn: (db: unknown, rec: () => void) => Promise<unknown>) => {
    const db = {
      from: (table: string) => {
        if (table === "users") {
          // db.from("users").select("email").eq(...).eq(...) — awaited list query.
          return {
            select: () => ({
              eq: () => ({ eq: async () => ({ data: mocks.usersRows, error: null }) }),
            }),
          };
        }
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: mocks.tenantRow, error: mocks.fetchErr }) }) }),
          update: mocks.update,
        };
      },
    };
    return fn(db, () => {});
  }),
}));

vi.mock("@/lib/email/notifications", () => ({
  sendTenantNotification: mocks.sendNotification,
}));

vi.mock("stripe", () => ({
  default: class StripeMock {
    subscriptions = { cancel: mocks.cancel, update: mocks.subUpdate };
  },
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: mocks.send },
}));

vi.mock("@/lib/onboarding/state-machine", () => ({
  revertTo: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.PLATFORM_PRIMARY_DOMAIN = "platform.test";
  mocks.tenantRow = { id: "t-1", legal_name: "Acme Travel LLC", slug: "acme", stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1", review_decision: null };
  mocks.usersRows = [{ email: "owner@acme.test" }];
  mocks.fetchErr = null;
  mocks.sendNotification.mockResolvedValue({ status: "sent" });
});

async function postReview(body: unknown, headers: Record<string, string> = { "x-admin-user-id": "admin-1" }): Promise<Response> {
  const { POST } = await import("@/app/api/admin/tenants/[id]/review/route");
  return POST(
    new Request("http://test/api/admin/tenants/t-1/review", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "t-1" }) },
  );
}

describe("POST /api/admin/tenants/[id]/review — reject side-effects (#403)", () => {
  it("finalizes status + emits tenant.terminated + cancels Stripe on reject", async () => {
    const res = await postReview({ action: "reject", reason: "spam application" });
    expect(res.status).toBe(200);

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const payload = mocks.update.mock.calls[0]![0];
    expect(payload.status).toBe("terminated");
    expect(payload.termination_kind).toBe("involuntary_other");
    expect(payload.terminated_at).toBeTruthy();

    expect(mocks.cancel).toHaveBeenCalledWith("sub_1", { prorate: false });
    expect(mocks.send).toHaveBeenCalledWith({
      name: "tenant.terminated",
      data: { tenant_id: "t-1", kind: "involuntary_other" },
    });
  });

  it("does NOT emit tenant.terminated on approve (no branch leak)", async () => {
    const res = await postReview({ action: "approve" });
    expect(res.status).toBe(200);

    const names = mocks.send.mock.calls.map((c) => c[0].name);
    expect(names).toContain("tenant.activated");
    expect(names).not.toContain("tenant.terminated");
  });
});

// #960 — the tenant admin was left in limbo after submitting: nothing told
// them the decision. These tests pin the contract that every decision
// (approve / reject) emails the tenant's active users, and that a broken
// email pipeline can never block the decision itself.
describe("POST /api/admin/tenants/[id]/review — decision notifications (#960)", () => {
  it("approve emails active tenant users with a sign-in link to their subdomain", async () => {
    const res = await postReview({ action: "approve" });
    expect(res.status).toBe(200);

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const input = mocks.sendNotification.mock.calls[0]![0];
    expect(input.to).toBe("owner@acme.test");
    expect(input.template_id).toBe("tenant_review_approved");
    expect(input.html).toContain("https://acme.platform.test/");
    expect(input.html).toContain("Acme Travel LLC");
  });

  it("reject emails the reason, BEFORE tenant.terminated deactivates the recipients", async () => {
    const res = await postReview({ action: "reject", reason: "duplicate <application>" });
    expect(res.status).toBe(200);

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const input = mocks.sendNotification.mock.calls[0]![0];
    expect(input.template_id).toBe("tenant_review_rejected");
    // Reason is rendered HTML-escaped.
    expect(input.html).toContain("duplicate &lt;application&gt;");

    // Ordering: the recipients query reads users with status='active'; the
    // tenant.terminated handler deactivates those rows, so the email must be
    // dispatched before the event is emitted.
    const terminatedCall = mocks.send.mock.calls.findIndex((c) => c[0].name === "tenant.terminated");
    expect(terminatedCall).toBeGreaterThanOrEqual(0);
    expect(mocks.sendNotification.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.send.mock.invocationCallOrder[terminatedCall]!,
    );
  });

  it("a failing email pipeline does not block the decision (best-effort)", async () => {
    mocks.sendNotification.mockRejectedValue(new Error("resend down"));
    const res = await postReview({ action: "approve" });
    expect(res.status).toBe(200);

    const names = mocks.send.mock.calls.map((c) => c[0].name);
    expect(names).toContain("tenant.activated");
  });
});
