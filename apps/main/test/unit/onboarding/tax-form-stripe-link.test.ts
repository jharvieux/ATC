// §15.6 — POST /api/onboarding/tax-form/stripe-link
//
// WHY: the tax-form account-link refresh_url/return_url must point at the
// tenant's own host, not a platform origin (issue #1132). Tenant already has a
// Connect account here, so the accounts.create + DB-write branch is skipped and
// the test isolates the redirect-origin behavior.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAccountLinksCreate = vi.hoisted(() =>
  vi.fn(async () => ({ url: "https://connect.stripe.com/setup/acct_1" })),
);

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({ ctx: { tenant_id: "t1" } })),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn((err: unknown) => Response.json({ error: String(err) }, { status: 401 })),
}));

vi.mock("stripe", () => ({
  default: vi.fn(function StripeConstructor() {
    return {
      accountLinks: { create: mockAccountLinksCreate },
      accounts: { create: vi.fn(async () => ({ id: "acct_new" })) },
    };
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { stripe_connect_account_id: "acct_1", support_email: null, display_name: null },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/db/tenant-client", () => ({ tenantClient: () => ({ from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }) }));
vi.mock("@/lib/db/safe-mutation", () => ({ safeAwait: vi.fn(async () => undefined) }));

function postRequest(origin: string) {
  return new Request(`${origin}/api/onboarding/tax-form/stripe-link`, { method: "POST" });
}

describe("POST /api/onboarding/tax-form/stripe-link §15.6", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_key";
  });

  it("refresh_url/return_url use the tenant request origin (subdomain)", async () => {
    const { POST } = await import("@/app/api/onboarding/tax-form/stripe-link/route");
    await POST(postRequest("https://lisa-travel.ai-travelconcierge.com"));
    expect(mockAccountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        refresh_url: "https://lisa-travel.ai-travelconcierge.com/onboarding/tax-form",
        return_url: "https://lisa-travel.ai-travelconcierge.com/onboarding/tax-form",
      }),
    );
  });
});
