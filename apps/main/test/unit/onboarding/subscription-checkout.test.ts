// §15.8 — POST /api/onboarding/subscription/checkout
//
// Tests verify WHY behavior matters:
// - tier_definitions.code is type-prefixed (byo_agency); priceIdFor needs bare tier (agency).
//   Wrong code→tier mapping silently charges the wrong price or throws.
// - tier_id not found in tier_definitions → 500 (tenant state corrupted, fail-closed).
// - DB error fetching tenant → 500 (fail-closed, no silent no-op).
// - success_url must use the tenant request origin (subdomain/custom domain),
//   NOT a platform-level origin — onboarding APIs resolve tenant_id from the
//   request Host, and the platform domain resolves to the "platform" sentinel
//   which throws ("Failed to load page" — issue #1132).

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above const declarations — use vi.hoisted() for shared mock refs.
const mockSessionCreate = vi.hoisted(() =>
  vi.fn(async () => ({ url: "https://checkout.stripe.com/test" })),
);

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: { tenant_id: "t1" },
    user: { id: "user-1" },
  })),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn((err: unknown) =>
    Response.json({ error: String(err) }, { status: 401 }),
  ),
}));

vi.mock("stripe", () => ({
  default: vi.fn(function StripeConstructor() {
    return { checkout: { sessions: { create: mockSessionCreate } } };
  }),
}));

vi.mock("@/lib/stripe/price-ids", () => ({
  priceIdFor: vi.fn(() => "price_test_123"),
}));

type TenantRow = {
  id: string;
  tenant_type: string;
  tier_id: string;
  seat_count: number;
  billing_period: string;
  stripe_customer_id: string | null;
} | null;

type TierRow = { code: string } | null;

let tenantData: TenantRow = null;
let tenantError: { message: string } | null = null;
let tierData: TierRow = null;
let tierError: { message: string } | null = null;

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          table === "tenants"
            ? { single: () => Promise.resolve({ data: tenantData, error: tenantError }) }
            : { maybeSingle: () => Promise.resolve({ data: tierData, error: tierError }) },
      }),
    }),
  }),
}));

// Default request comes from a tenant subdomain — the redirect origin is
// derived from this host, so assertions below pin it to this value.
const TENANT_HOST = "https://lisa-travel.ai-travelconcierge.com";

function postRequest(origin = TENANT_HOST) {
  return new Request(`${origin}/api/onboarding/subscription/checkout`, { method: "POST" });
}

describe("POST /api/onboarding/subscription/checkout §15.8", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantData = null;
    tenantError = null;
    tierData = null;
    tierError = null;
    process.env.STRIPE_SECRET_KEY = "sk_test_key";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  it("returns 500 on tenant DB error — fail-closed", async () => {
    tenantError = { message: "connection timeout" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(500);
  });

  it("returns 500 on tier_definitions DB error — fail-closed", async () => {
    tenantData = { id: "t1", tenant_type: "byo_host", tier_id: "tier-1", seat_count: 1, billing_period: "monthly", stripe_customer_id: null };
    tierError = { message: "db_timeout" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; ref?: string };
    expect(body.error).toBe("db_error");
    expect(body.ref).toBeTruthy();
  });

  it("returns 500 when tier_definition not found — corrupted tenant state", async () => {
    tenantData = { id: "t1", tenant_type: "byo_host", tier_id: "missing-id", seat_count: 1, billing_period: "monthly", stripe_customer_id: null };
    tierData = null;
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tier_definition_missing");
  });

  it("returns 500 for unrecognized tier code — fail-closed on unexpected DB value", async () => {
    tenantData = { id: "t1", tenant_type: "byo_host", tier_id: "tier-x", seat_count: 1, billing_period: "monthly", stripe_customer_id: null };
    tierData = { code: "unknown_code" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unrecognized_tier_code");
  });

  it("maps byo_host + byo_agency code → agency tier for priceIdFor", async () => {
    tenantData = { id: "t1", tenant_type: "byo_host", tier_id: "tier-1", seat_count: 1, billing_period: "annual", stripe_customer_id: null };
    tierData = { code: "byo_agency" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    const { priceIdFor } = await import("@/lib/stripe/price-ids");
    await POST(postRequest());
    expect(vi.mocked(priceIdFor)).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_type: "byo_host", tier: "agency", billing_period: "annual" }),
    );
  });

  it("maps sub_host + sub_pro code → pro tier for priceIdFor", async () => {
    tenantData = { id: "t1", tenant_type: "sub_host", tier_id: "tier-2", seat_count: 1, billing_period: "monthly", stripe_customer_id: null };
    tierData = { code: "sub_pro" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    const { priceIdFor } = await import("@/lib/stripe/price-ids");
    await POST(postRequest());
    expect(vi.mocked(priceIdFor)).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_type: "sub_host", tier: "pro" }),
    );
  });

  it("adds additional_seats line item for agency tier with seat_count > 1", async () => {
    tenantData = { id: "t1", tenant_type: "byo_host", tier_id: "tier-3", seat_count: 4, billing_period: "monthly", stripe_customer_id: null };
    tierData = { code: "byo_agency" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    const { priceIdFor } = await import("@/lib/stripe/price-ids");
    await POST(postRequest());
    const calls = vi.mocked(priceIdFor).mock.calls;
    expect(calls.some(([q]) => q.line_item === "additional_seats")).toBe(true);
    const seatsCall = calls.find(([q]) => q.line_item === "additional_seats");
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: expect.arrayContaining([
          expect.objectContaining({ quantity: 3 }),
        ]),
      }),
    );
    expect(seatsCall).toBeDefined();
  });

  it("success_url uses the tenant request origin, never a platform origin", async () => {
    // NEXT_PUBLIC_APP_URL is set (to a different host) in beforeEach. The
    // redirect must STILL track the request host — a regression that reverts
    // to platformBaseUrl()/NEXT_PUBLIC_APP_URL would land the user on the
    // platform domain ("platform" sentinel → throw). See issue #1132.
    tenantData = { id: "t1", tenant_type: "sub_host", tier_id: "tier-4", seat_count: 1, billing_period: "monthly", stripe_customer_id: null };
    tierData = { code: "sub_starter" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    await POST(postRequest());
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: "https://lisa-travel.ai-travelconcierge.com/onboarding/connect",
        cancel_url: "https://lisa-travel.ai-travelconcierge.com/onboarding/subscription",
      }),
    );
  });

  it("success_url tracks a custom-domain host", async () => {
    tenantData = { id: "t1", tenant_type: "sub_host", tier_id: "tier-4b", seat_count: 1, billing_period: "monthly", stripe_customer_id: null };
    tierData = { code: "sub_starter" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    await POST(postRequest("https://book.lisatravel.com"));
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: "https://book.lisatravel.com/onboarding/connect",
      }),
    );
  });

  it("BYO host success_url goes to branding, never the payouts page", async () => {
    // Payouts (connect_setup) are sub-host-only. Routing a BYO host to
    // /onboarding/connect stranded them on Set Up Payouts because advanceByo
    // only rescues the connect_setup stage, which BYO hosts skip.
    tenantData = { id: "t1", tenant_type: "byo_host", tier_id: "tier-7", seat_count: 1, billing_period: "monthly", stripe_customer_id: null };
    tierData = { code: "byo_research" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    await POST(postRequest());
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: "https://lisa-travel.ai-travelconcierge.com/onboarding/branding",
      }),
    );
  });

  it("returns 200 with Stripe checkout URL on success", async () => {
    tenantData = { id: "t1", tenant_type: "sub_host", tier_id: "tier-5", seat_count: 1, billing_period: "monthly", stripe_customer_id: null };
    tierData = { code: "sub_starter" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string };
    expect(body.url).toBe("https://checkout.stripe.com/test");
  });

  it("trial_end is within Stripe's 730-day cap — never sends far-future epoch", async () => {
    tenantData = { id: "t1", tenant_type: "sub_host", tier_id: "tier-6", seat_count: 1, billing_period: "monthly", stripe_customer_id: null };
    tierData = { code: "sub_starter" };
    const { POST } = await import("@/app/api/onboarding/subscription/checkout/route");
    const before = Math.floor(Date.now() / 1000);
    await POST(postRequest());
    const after = Math.floor(Date.now() / 1000);
    // mock.calls typed as [][] (no-param fn); cast to actual runtime shape.
    const call = (mockSessionCreate.mock.calls as unknown as [[{ subscription_data: { trial_end: number } }]])[0][0];
    const trialEnd = call.subscription_data.trial_end;
    const maxAllowed = after + 730 * 24 * 60 * 60;
    const minExpected = before + 728 * 24 * 60 * 60;
    expect(trialEnd).toBeGreaterThanOrEqual(minExpected);
    expect(trialEnd).toBeLessThanOrEqual(maxAllowed);
  });
});
