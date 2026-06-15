// §15.8 — POST /api/onboarding/tier
//
// Tests verify WHY behavior matters:
// - Tier and billing_period are validated before any DB call; bad values must never reach the DB.
// - Tenant fetch failure → 500 (fail-closed; unknown tenant state must not proceed).
// - Unrecognized tenant_type → 422 (TIER_CODE has no entry; inserting an unmapped code corrupts billing).
// - tier_definition DB error → 500 (fail-closed; incomplete tier lookup must not proceed).
// - tier_definition missing → 500 (corrupted platform data; no mapping to store).
// - safeAwaitRowCount throw propagates to respondToAuthError (zero-row update must surface).
// - progressTo called after successful update (state machine must advance; checkout stage gated on it).
// - agency tier: seat_count clamped to max(1, provided) (subscription with 0 seats is invalid).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSafeAwaitRowCount = vi.hoisted(() => vi.fn(async () => {}));
const mockProgressTo = vi.hoisted(() => vi.fn(async () => {}));
const mockTenantUpdate = vi.hoisted(() =>
  vi.fn(() => ({
    eq: vi.fn(() => ({ select: vi.fn(() => ({})) })),
  })),
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

vi.mock("@/lib/onboarding/state-machine", () => ({
  progressTo: mockProgressTo,
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwaitRowCount: mockSafeAwaitRowCount,
}));

type TenantRow = { tenant_type: string } | null;
type TierRow = { id: string } | null;

let tenantData: TenantRow = null;
let tenantError: { message: string } | null = null;
let tierData: TierRow = null;
let tierError: { message: string } | null = null;

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: tenantData, error: tenantError }),
            }),
          }),
          update: mockTenantUpdate,
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: tierData, error: tierError }),
          }),
        }),
      };
    },
  }),
}));

function postRequest(body: object = { tier: "starter", billing_period: "monthly", seat_count: 1 }) {
  return new Request("http://test/api/onboarding/tier", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/onboarding/tier §15.8", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantData = null;
    tenantError = null;
    tierData = null;
    tierError = null;
    mockSafeAwaitRowCount.mockImplementation(async () => {});
  });

  it("returns 400 on invalid JSON — validates before any DB call", async () => {
    const { POST } = await import("@/app/api/onboarding/tier/route");
    const res = await POST(new Request("http://test/api/onboarding/tier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("returns 422 for unrecognized tier value — bad tier must never reach the DB", async () => {
    const { POST } = await import("@/app/api/onboarding/tier/route");
    const res = await POST(postRequest({ tier: "enterprise", billing_period: "monthly", seat_count: 1 }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_tier");
  });

  it("returns 422 for unrecognized billing_period — bad period must never reach the DB", async () => {
    const { POST } = await import("@/app/api/onboarding/tier/route");
    const res = await POST(postRequest({ tier: "starter", billing_period: "quarterly", seat_count: 1 }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_billing_period");
  });

  it("returns 500 on tenant DB error — fail-closed; unknown tenant state must not proceed", async () => {
    tenantError = { message: "connection_timeout" };
    const { POST } = await import("@/app/api/onboarding/tier/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("connection_timeout");
  });

  it("returns 422 for unrecognized tenant_type — inserting unmapped tier code corrupts billing", async () => {
    tenantData = { tenant_type: "unknown_type" };
    const { POST } = await import("@/app/api/onboarding/tier/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_tier_for_tenant_type");
  });

  it("returns 500 on tier_definitions DB error — fail-closed; incomplete lookup must not proceed", async () => {
    tenantData = { tenant_type: "byo_host" };
    tierError = { message: "db_timeout" };
    const { POST } = await import("@/app/api/onboarding/tier/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("db_timeout");
  });

  it("returns 500 when tier_definition not found — corrupted platform data; no tier_id to store", async () => {
    tenantData = { tenant_type: "sub_host" };
    tierData = null;
    const { POST } = await import("@/app/api/onboarding/tier/route");
    const res = await POST(postRequest({ tier: "pro", billing_period: "monthly", seat_count: 1 }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tier_definition_missing");
  });

  it("safeAwaitRowCount throw propagates — zero-row update must surface, not be swallowed", async () => {
    tenantData = { tenant_type: "byo_host" };
    tierData = { id: "tier-1" };
    mockSafeAwaitRowCount.mockRejectedValueOnce(new Error("row_count_mismatch"));
    const { POST } = await import("@/app/api/onboarding/tier/route");
    const res = await POST(postRequest());
    expect(res.status).not.toBe(200);
    expect(vi.mocked(mockProgressTo)).not.toHaveBeenCalled();
  });

  it("progressTo called with tenant_id + 'subscription' — state machine must advance after update", async () => {
    tenantData = { tenant_type: "sub_host" };
    tierData = { id: "tier-2" };
    const { POST } = await import("@/app/api/onboarding/tier/route");
    await POST(postRequest({ tier: "starter", billing_period: "annual", seat_count: 1 }));
    expect(vi.mocked(mockSafeAwaitRowCount)).toHaveBeenCalledTimes(1);
    // mock.calls typed as [][] (no-param fn); cast to access the expectedRowCount arg.
    expect((mockSafeAwaitRowCount.mock.calls as unknown as [[unknown, unknown, number]])[0][2]).toBe(1);
    expect(vi.mocked(mockProgressTo)).toHaveBeenCalledWith("t1", "subscription");
  });

  it("returns 200 with ok + next_stage on success", async () => {
    tenantData = { tenant_type: "byo_host" };
    tierData = { id: "tier-3" };
    const { POST } = await import("@/app/api/onboarding/tier/route");
    const res = await POST(postRequest({ tier: "pro", billing_period: "annual", seat_count: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; next_stage: string };
    expect(body.ok).toBe(true);
    expect(body.next_stage).toBe("subscription");
  });

  it("agency seat_count clamped to 1 minimum — subscription with 0 seats is invalid", async () => {
    tenantData = { tenant_type: "byo_host" };
    tierData = { id: "tier-4" };
    const { POST } = await import("@/app/api/onboarding/tier/route");
    const res = await POST(postRequest({ tier: "agency", billing_period: "monthly", seat_count: 0 }));
    expect(res.status).toBe(200);
    // update must store 1, not 0 — a zero-seat subscription is invalid.
    // mock.calls typed as [][] (unknown param fn); cast to actual runtime shape.
    const updateArg = (mockTenantUpdate.mock.calls as unknown as [[{ seat_count: number }]])[0][0];
    expect(updateArg.seat_count).toBe(1);
  });

  it("non-agency tier always stores seat_count: 1 regardless of input", async () => {
    tenantData = { tenant_type: "sub_host" };
    tierData = { id: "tier-5" };
    const { POST } = await import("@/app/api/onboarding/tier/route");
    await POST(postRequest({ tier: "starter", billing_period: "monthly", seat_count: 5 }));
    const updateArg = (mockTenantUpdate.mock.calls as unknown as [[{ seat_count: number }]])[0][0];
    expect(updateArg.seat_count).toBe(1);
  });
});
