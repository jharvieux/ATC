// §3.1 / §15 — POST /api/onboarding/byo/advance
//
// Tests verify WHY behavior matters:
// - BYO hosts must be advanced past inapplicable sub-host-only stages.
// - Non-BYO tenants must NOT be advanced (page renders normally for sub-hosts).
// - Stages not in the skip map must 409 (route doesn't handle all stages).
// - DB error on tenant fetch must 500 (fail-closed, don't silently skip).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: { tenant_id: "t1" },
    user: { id: "user-1", auth_user_id: "auth-1" },
  })),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn((err: unknown) =>
    Response.json({ error: String(err) }, { status: 401 }),
  ),
}));

vi.mock("@/lib/onboarding/state-machine", () => ({
  progressTo: vi.fn(async () => undefined),
}));

type TenantRow = { tenant_type: string; onboarding_stage: string } | null;
let tenantData: TenantRow = null;
let tenantError: { message: string } | null = null;

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: tenantData, error: tenantError }),
        }),
      }),
    }),
  }),
}));

function postRequest(path: string) {
  return new Request(`http://test${path}`, { method: "POST" });
}

describe("POST /api/onboarding/byo/advance §3.1 / §15", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantData = null;
    tenantError = null;
  });

  it("returns 500 on DB error — fail-closed, BYO tenant must not be silently routed", async () => {
    tenantError = { message: "connection timeout" };
    const { POST } = await import("@/app/api/onboarding/byo/advance/route");
    const res = await POST(postRequest("/api/onboarding/byo/advance"));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("connection timeout");
  });

  it("returns 409 for non-BYO tenant — sub-host page renders normally, no redirect", async () => {
    tenantData = { tenant_type: "sub_host", onboarding_stage: "ica" };
    const { POST } = await import("@/app/api/onboarding/byo/advance/route");
    const res = await POST(postRequest("/api/onboarding/byo/advance"));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_byo_host");
  });

  it("returns 409 for BYO tenant on stage not in skip map — guard does not fire at this stage", async () => {
    tenantData = { tenant_type: "byo_host", onboarding_stage: "branding" };
    const { POST } = await import("@/app/api/onboarding/byo/advance/route");
    const res = await POST(postRequest("/api/onboarding/byo/advance"));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("stage_not_skippable");
  });

  it("advances BYO tenant at 'ica' → state_of_operation and returns redirect URL", async () => {
    tenantData = { tenant_type: "byo_host", onboarding_stage: "ica" };
    const { POST } = await import("@/app/api/onboarding/byo/advance/route");
    const res = await POST(postRequest("/api/onboarding/byo/advance"));
    expect(res.status).toBe(200);
    const body = await res.json() as { redirect_to: string };
    expect(body.redirect_to).toBe("/onboarding/state-of-operation");
    const { progressTo } = await import("@/lib/onboarding/state-machine");
    expect(vi.mocked(progressTo)).toHaveBeenCalledWith("t1", "state_of_operation");
  });

  it("advances BYO tenant at 'tax_form' → state_of_operation (tax form is sub-host-only)", async () => {
    tenantData = { tenant_type: "byo_host", onboarding_stage: "tax_form" };
    const { POST } = await import("@/app/api/onboarding/byo/advance/route");
    const res = await POST(postRequest("/api/onboarding/byo/advance"));
    expect(res.status).toBe(200);
    const body = await res.json() as { redirect_to: string };
    expect(body.redirect_to).toBe("/onboarding/state-of-operation");
    const { progressTo } = await import("@/lib/onboarding/state-machine");
    expect(vi.mocked(progressTo)).toHaveBeenCalledWith("t1", "state_of_operation");
  });

  it("advances BYO tenant at 'connect_setup' → branding (Connect payout is sub-host-only)", async () => {
    tenantData = { tenant_type: "byo_host", onboarding_stage: "connect_setup" };
    const { POST } = await import("@/app/api/onboarding/byo/advance/route");
    const res = await POST(postRequest("/api/onboarding/byo/advance"));
    expect(res.status).toBe(200);
    const body = await res.json() as { redirect_to: string };
    expect(body.redirect_to).toBe("/onboarding/branding");
    const { progressTo } = await import("@/lib/onboarding/state-machine");
    expect(vi.mocked(progressTo)).toHaveBeenCalledWith("t1", "branding");
  });
});
