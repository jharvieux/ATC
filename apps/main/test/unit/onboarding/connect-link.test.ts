// §15.9 — POST /api/onboarding/connect/link
//
// WHY: the Connect account-link refresh_url/return_url must point at the
// tenant's own host (subdomain/custom domain), not a platform origin. A
// redirect to the platform domain resolves to the "platform" sentinel and the
// returning page throws ("Failed to load page" — issue #1132).
//
// Two branches matter: an existing Connect account (skip create) and a
// first-time account (create + persist via safeAwait). Both must build the
// redirect from the request origin, and the create branch must surface a
// DB-write failure (D-094).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  accountLinksCreate: vi.fn(async () => ({ url: "https://connect.stripe.com/setup/acct_1" })),
  accountsCreate: vi.fn(async () => ({ id: "acct_new" })),
  safeAwait: vi.fn(async () => undefined),
  state: { connectAccountId: "acct_1" as string | null },
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({ ctx: { tenant_id: "t1" } })),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn((err: unknown) => Response.json({ error: String(err) }, { status: 401 })),
}));

vi.mock("stripe", () => ({
  default: vi.fn(function StripeConstructor() {
    return {
      accountLinks: { create: h.accountLinksCreate },
      accounts: { create: h.accountsCreate },
    };
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { stripe_connect_account_id: h.state.connectAccountId },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({ from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
}));

vi.mock("@/lib/db/safe-mutation", () => ({ safeAwait: h.safeAwait }));

function postRequest(origin: string) {
  return new Request(`${origin}/api/onboarding/connect/link`, { method: "POST" });
}

describe("POST /api/onboarding/connect/link §15.9", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.connectAccountId = "acct_1";
    process.env.STRIPE_SECRET_KEY = "sk_test_key";
  });

  it("refresh_url/return_url use the tenant request origin (subdomain)", async () => {
    const { POST } = await import("@/app/api/onboarding/connect/link/route");
    await POST(postRequest("https://lisa-travel.ai-travelconcierge.com"));
    expect(h.accountsCreate).not.toHaveBeenCalled();
    expect(h.safeAwait).not.toHaveBeenCalled();
    expect(h.accountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        refresh_url: "https://lisa-travel.ai-travelconcierge.com/onboarding/connect",
        return_url: "https://lisa-travel.ai-travelconcierge.com/onboarding/branding",
      }),
    );
  });

  it("tracks a custom-domain host", async () => {
    const { POST } = await import("@/app/api/onboarding/connect/link/route");
    await POST(postRequest("https://book.lisatravel.com"));
    expect(h.accountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: "https://book.lisatravel.com/onboarding/branding",
      }),
    );
  });

  it("first-time account: creates Connect account, persists via safeAwait, still redirects to tenant origin", async () => {
    h.state.connectAccountId = null;
    const { POST } = await import("@/app/api/onboarding/connect/link/route");
    await POST(postRequest("https://book.lisatravel.com"));
    expect(h.accountsCreate).toHaveBeenCalledOnce();
    // DB write of the new account id must go through safeAwait (D-094) — a
    // silent failure here would strand the tenant without a Connect account.
    expect(h.safeAwait).toHaveBeenCalledOnce();
    expect(h.accountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "acct_new",
        return_url: "https://book.lisatravel.com/onboarding/branding",
      }),
    );
  });
});
