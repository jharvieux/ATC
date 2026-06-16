// §15.15 — POST /api/tenant/billing (change_tier, update_seats, switch_billing_period)
//
// Tests verify WHY behavior matters:
// - Tenant DB error → 500 (fail-closed; can't trust any subsequent DB or Stripe op without tenant state).
// - pending_review / suspended → 403 (billing changes blocked until admin approval / reactivation).
// - unknown_action → 422 (fail on unexpected input; prevents silent no-op).
// - change_tier: invalid_tier_for_tenant_type → 422 (unmapped code would corrupt billing).
// - change_tier: tier_definitions error/missing → 500 (fail-closed; incomplete platform state must not proceed).
// - switch_billing_period: same period → 200 no-op (idempotent; prevents unnecessary Stripe calls).
// - switch_billing_period: annual→monthly deferred to renewal (§15.15; immediate downgrade is not supported).
// - switch_billing_period: monthly→annual resolves tier from DB via CODE_TO_TIER, not from request body.
// - switch_billing_period: unrecognized_tier_code → 500 (corrupted tier_definitions row must not proceed).
// - inngest.send fired on successful tier/seat changes (downstream pipeline must be notified).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStripeSubscriptionsUpdate = vi.hoisted(() => vi.fn(async () => ({ id: "sub_1" })));
const mockStripeSubscriptionsRetrieve = vi.hoisted(() =>
  vi.fn(async () => ({ current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30 })),
);
const mockInngestSend = vi.hoisted(() => vi.fn(async () => {}));
const mockSafeAwait = vi.hoisted(() => vi.fn(async () => {}));
const mockPriceIdFor = vi.hoisted(() => vi.fn(() => "price_test_123"));

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
    return {
      subscriptions: {
        update: mockStripeSubscriptionsUpdate,
        retrieve: mockStripeSubscriptionsRetrieve,
      },
    };
  }),
}));

vi.mock("@/lib/stripe/price-ids", () => ({
  priceIdFor: mockPriceIdFor,
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: mockInngestSend },
}));

vi.mock("@/lib/vendor-health/gate", () => ({
  withVendorHealthGate: vi.fn((_vendor: string, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: mockSafeAwait,
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({}), // passed to safeAwait (mocked)
      }),
    }),
  }),
}));

type TenantRow = {
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  tier_id: string;
  seat_count: number;
  billing_period: string;
  status: string;
  tenant_type: string;
} | null;

type TierDefIdRow = { id: string } | null;
type TierDefCodeRow = { code: string } | null;

let tenantData: TenantRow = null;
let tenantError: { message: string } | null = null;
let tierDefIdData: TierDefIdRow = null;    // for change_tier: select("id").eq("code", ...)
let tierDefIdError: { message: string } | null = null;
let tierDefCodeData: TierDefCodeRow = null; // for switch_billing_period: select("code").eq("id", ...)
let tierDefCodeError: { message: string } | null = null;

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: () =>
          table === "tenants"
            ? { single: () => Promise.resolve({ data: tenantData, error: tenantError }) }
            : cols === "id"
              ? { maybeSingle: () => Promise.resolve({ data: tierDefIdData, error: tierDefIdError }) }
              : { maybeSingle: () => Promise.resolve({ data: tierDefCodeData, error: tierDefCodeError }) },
      }),
    }),
  }),
}));

const activeTenant = (): TenantRow => ({
  stripe_subscription_id: null,
  stripe_customer_id: "cus_test_1",
  tier_id: "tier-1",
  seat_count: 1,
  billing_period: "monthly",
  status: "active",
  tenant_type: "byo_host",
});

function postRequest(body: object) {
  return new Request("http://test/api/tenant/billing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function badJsonRequest() {
  return new Request("http://test/api/tenant/billing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-json{{{",
  });
}

describe("POST /api/tenant/billing §15.15", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantData = null;
    tenantError = null;
    tierDefIdData = null;
    tierDefIdError = null;
    tierDefCodeData = null;
    tierDefCodeError = null;
    process.env.STRIPE_SECRET_KEY = "sk_test_key";
  });

  // ── Common guards ───────────────────────────────────────────────────────────

  it("returns 400 on invalid JSON — validates before any DB call", async () => {
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(badJsonRequest());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("returns 500 on tenant DB error — fail-closed; can't operate without tenant state", async () => {
    tenantError = { message: "connection_timeout" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "change_tier", tier: "pro" }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("connection_timeout");
  });

  it("returns 403 for pending_review status — billing changes blocked pending admin approval", async () => {
    tenantData = { ...activeTenant()!, status: "pending_review" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "change_tier", tier: "pro" }));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("billing_read_only_in_current_status");
  });

  it("returns 403 for suspended status — billing changes blocked until reactivation", async () => {
    tenantData = { ...activeTenant()!, status: "suspended" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "change_tier", tier: "pro" }));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("billing_read_only_in_current_status");
  });

  it("returns 422 for unknown action — fail on unexpected input, no silent no-op", async () => {
    tenantData = activeTenant();
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "delete_account" }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unknown_action");
  });

  // ── change_tier ─────────────────────────────────────────────────────────────

  it("change_tier: returns 422 when tier is missing", async () => {
    tenantData = activeTenant();
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "change_tier" }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tier required");
  });

  it("change_tier: returns 422 for invalid_tier_for_tenant_type — unmapped code corrupts billing", async () => {
    tenantData = { ...activeTenant()!, tenant_type: "unknown_type" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "change_tier", tier: "pro" }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_tier_for_tenant_type");
  });

  it("change_tier: returns 500 on tier_definitions DB error — fail-closed", async () => {
    tenantData = activeTenant();
    tierDefIdError = { message: "tier_db_timeout" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "change_tier", tier: "pro" }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tier_db_timeout");
  });

  it("change_tier: returns 500 when tier_definition missing — corrupted platform state", async () => {
    tenantData = activeTenant();
    tierDefIdData = null;
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "change_tier", tier: "pro" }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tier_definition_missing");
  });

  it("change_tier: inngest.send fires with change:tier on success — downstream must be notified", async () => {
    tenantData = activeTenant();
    tierDefIdData = { id: "tier-new" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "change_tier", tier: "pro" }));
    expect(res.status).toBe(200);
    expect(mockSafeAwait).toHaveBeenCalled();
    expect(vi.mocked(mockInngestSend)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tenant.subscription_changed",
        data: expect.objectContaining({ change: "tier", new_tier: "pro" }),
      }),
    );
  });

  // ── update_seats ────────────────────────────────────────────────────────────

  it("update_seats: returns 422 when seat_count is missing", async () => {
    tenantData = activeTenant();
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "update_seats" }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("seat_count required");
  });

  it("update_seats: inngest.send fires with change:seats on success", async () => {
    tenantData = activeTenant();
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "update_seats", seat_count: 3 }));
    expect(res.status).toBe(200);
    expect(mockSafeAwait).toHaveBeenCalled();
    expect(vi.mocked(mockInngestSend)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tenant.subscription_changed",
        data: expect.objectContaining({ change: "seats", new_seat_count: 3 }),
      }),
    );
  });

  it("update_seats: calls stripe.subscriptions.update with seat price + quantity:n-1 when subscription active (#1122)", async () => {
    // activeTenant() has stripe_subscription_id: null so the Stripe guard skips.
    // This case exercises the live-subscription path that a regression in the
    // seat-price calculation would break — wrong price ID or wrong quantity offset
    // would silently mis-bill the tenant.
    tenantData = { ...activeTenant()!, stripe_subscription_id: "sub_test_1" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "update_seats", seat_count: 4 }));
    expect(res.status).toBe(200);
    expect(vi.mocked(mockStripeSubscriptionsUpdate)).toHaveBeenCalledWith(
      "sub_test_1",
      expect.objectContaining({
        items: [expect.objectContaining({ price: "price_test_123", quantity: 3 })],
      }),
    );
    expect(vi.mocked(mockInngestSend)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ change: "seats", new_seat_count: 4 }),
      }),
    );
  });

  // ── switch_billing_period ───────────────────────────────────────────────────

  it("switch_billing_period: returns 422 when billing_period is missing", async () => {
    tenantData = activeTenant();
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "switch_billing_period" }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("billing_period required");
  });

  it("switch_billing_period: returns 200 no-op when already on requested period — idempotent", async () => {
    tenantData = { ...activeTenant()!, billing_period: "monthly" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "switch_billing_period", billing_period: "monthly" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(mockStripeSubscriptionsUpdate)).not.toHaveBeenCalled();
    const body = await res.json() as { ok: boolean; billing_period: string };
    expect(body.ok).toBe(true);
    expect(body.billing_period).toBe("monthly");
  });

  it("switch_billing_period: annual→monthly deferred to renewal — immediate downgrade not supported", async () => {
    tenantData = { ...activeTenant()!, billing_period: "annual", stripe_subscription_id: "sub_1" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "switch_billing_period", billing_period: "monthly" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; deferred: boolean; effective_at: string };
    expect(body.deferred).toBe(true);
    expect(body.effective_at).toBeTruthy();
    // Stripe subscriptions.update must NOT be called (no immediate change).
    expect(mockStripeSubscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("switch_billing_period: annual→monthly Stripe unavailable — defers with null effective_at rather than blocking", async () => {
    tenantData = { ...activeTenant()!, billing_period: "annual", stripe_subscription_id: "sub_1" };
    mockStripeSubscriptionsRetrieve.mockRejectedValueOnce(new Error("stripe_unavailable"));
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "switch_billing_period", billing_period: "monthly" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; deferred: boolean; effective_at: null };
    expect(body.deferred).toBe(true);
    // effective_at is null when Stripe is unreachable; the DB records null rather than a wrong date.
    expect(body.effective_at).toBeNull();
  });

  it("switch_billing_period: monthly→annual tier_definitions DB error → 500", async () => {
    tenantData = { ...activeTenant()!, billing_period: "monthly" };
    tierDefCodeError = { message: "tier_code_timeout" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "switch_billing_period", billing_period: "annual" }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tier_code_timeout");
  });

  it("switch_billing_period: monthly→annual tier_definition missing → 500", async () => {
    tenantData = { ...activeTenant()!, billing_period: "monthly" };
    tierDefCodeData = null;
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "switch_billing_period", billing_period: "annual" }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tier_definition_missing");
  });

  it("switch_billing_period: unrecognized_tier_code → 500 — corrupted tier_definitions row must not proceed", async () => {
    tenantData = { ...activeTenant()!, billing_period: "monthly" };
    tierDefCodeData = { code: "totally_unknown_code" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    const res = await POST(postRequest({ action: "switch_billing_period", billing_period: "annual" }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unrecognized_tier_code");
  });

  it("switch_billing_period: monthly→annual calls priceIdFor with annual period and updates Stripe", async () => {
    tenantData = { ...activeTenant()!, billing_period: "monthly", stripe_subscription_id: "sub_1" };
    tierDefCodeData = { code: "byo_agency" };
    const { POST } = await import("@/app/api/tenant/billing/route");
    await POST(postRequest({ action: "switch_billing_period", billing_period: "annual" }));
    expect(vi.mocked(mockPriceIdFor)).toHaveBeenCalledWith(
      expect.objectContaining({ billing_period: "annual" }),
    );
    expect(vi.mocked(mockStripeSubscriptionsUpdate)).toHaveBeenCalled();
    expect(mockSafeAwait).toHaveBeenCalled();
  });
});
