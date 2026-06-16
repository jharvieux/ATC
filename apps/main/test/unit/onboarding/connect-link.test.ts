// §15.9 — POST /api/onboarding/connect/link
//
// WHY: the Connect account-link refresh_url/return_url must point at the
// tenant's own host (subdomain/custom domain), not a platform origin. A
// redirect to the platform domain resolves to the "platform" sentinel and the
// returning page throws ("Failed to load page" — issue #1132).

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
    return { accountLinks: { create: mockAccountLinksCreate } };
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { stripe_connect_account_id: "acct_1" }, error: null }),
        }),
      }),
    }),
  }),
}));

function postRequest(origin: string) {
  return new Request(`${origin}/api/onboarding/connect/link`, { method: "POST" });
}

describe("POST /api/onboarding/connect/link §15.9", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_key";
  });

  it("refresh_url/return_url use the tenant request origin (subdomain)", async () => {
    const { POST } = await import("@/app/api/onboarding/connect/link/route");
    await POST(postRequest("https://lisa-travel.ai-travelconcierge.com"));
    expect(mockAccountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        refresh_url: "https://lisa-travel.ai-travelconcierge.com/onboarding/connect",
        return_url: "https://lisa-travel.ai-travelconcierge.com/onboarding/branding",
      }),
    );
  });

  it("tracks a custom-domain host", async () => {
    const { POST } = await import("@/app/api/onboarding/connect/link/route");
    await POST(postRequest("https://book.lisatravel.com"));
    expect(mockAccountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: "https://book.lisatravel.com/onboarding/branding",
      }),
    );
  });
});
