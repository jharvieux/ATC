// §15.10 — POST /api/onboarding/branding-skip
//
// Tests verify WHY behavior matters:
// - BYO hosts are NOT reviewed: completing onboarding activates them
//   immediately (status=active, stage=complete). They must NEVER be parked in
//   review_submitted / pending_review — that's the whole point of the change.
// - Sub-hosts still advance to review_submitted to await platform approval.
// - A DB error on the tenant_type fetch must 500 (fail-closed, don't guess).
// - The BYO activation is CAS-guarded on the current stage: a zero-row result
//   (concurrent writer / double-click on an already-moved tenant) must throw,
//   not silently succeed.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: { tenant_id: "t1" },
    user: { id: "user-1", auth_user_id: "auth-1" },
  })),
}));

vi.mock("@/lib/auth/respond", () => ({
  // Mirror the real fall-through: an unknown thrown error (e.g. the CAS
  // row-count mismatch) becomes a 500. Auth errors aren't exercised here.
  respondToAuthError: vi.fn(() =>
    Response.json({ error: "internal_error" }, { status: 500 }),
  ),
}));

vi.mock("@/lib/onboarding/state-machine", () => ({
  progressTo: vi.fn(async () => undefined),
}));

type TenantRow = { tenant_type: string; onboarding_stage: string } | null;
let tenantData: TenantRow = null;
let tenantError: { message: string } | null = null;

// Rows returned by the CAS update's `.select("id")`. Default: one row updated
// (the happy path). Set to [] to simulate a zero-row CAS miss.
let updateRows: Array<{ id: string }> = [{ id: "t1" }];
let updateError: { message: string } | null = null;

// Captures the payload passed to .update() so tests can assert the exact
// terminal state written (status + onboarding_stage).
let lastUpdatePayload: Record<string, unknown> | null = null;

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: tenantData, error: tenantError }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        lastUpdatePayload = payload;
        return {
          eq: () => ({
            eq: () => ({
              select: () =>
                Promise.resolve({ data: updateRows, error: updateError }),
            }),
          }),
        };
      },
    }),
  }),
}));

function postRequest() {
  return new Request("http://test/api/onboarding/branding-skip", { method: "POST" });
}

describe("POST /api/onboarding/branding-skip §15.10", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantData = null;
    tenantError = null;
    updateRows = [{ id: "t1" }];
    updateError = null;
    lastUpdatePayload = null;
  });

  it("returns 500 on DB error fetching tenant_type — fail-closed, don't guess the path", async () => {
    tenantError = { message: "connection timeout" };
    const { POST } = await import("@/app/api/onboarding/branding-skip/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; ref?: string };
    expect(body.error).toBe("db_error");
    expect(body.ref).toBeTruthy();
  });

  it("activates a BYO host immediately (status=active, stage=complete) — never parked for review", async () => {
    tenantData = { tenant_type: "byo_host", onboarding_stage: "branding" };
    const { POST } = await import("@/app/api/onboarding/branding-skip/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; next_stage: string };
    expect(body.next_stage).toBe("complete");

    // The intent assertion: a byo_host completing onboarding must land in the
    // terminal active state, NOT review_submitted / pending_review. If a future
    // edit re-routes BYO back through review, these break.
    expect(lastUpdatePayload).toMatchObject({
      status: "active",
      onboarding_stage: "complete",
    });
    expect(lastUpdatePayload?.status).not.toBe("pending_review");
    expect(lastUpdatePayload?.onboarding_stage).not.toBe("review_submitted");
    expect(lastUpdatePayload?.activated_at).toBeTruthy();

    // BYO must NOT go through the generic progressTo("review_submitted") path.
    const { progressTo } = await import("@/lib/onboarding/state-machine");
    expect(vi.mocked(progressTo)).not.toHaveBeenCalled();
  });

  it("throws (500) when the BYO activation CAS matches zero rows — no silent no-op", async () => {
    tenantData = { tenant_type: "byo_host", onboarding_stage: "branding" };
    updateRows = []; // concurrent writer already advanced the stage
    const { POST } = await import("@/app/api/onboarding/branding-skip/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(500);
  });

  it("advances a sub-host to review_submitted — they still await platform approval", async () => {
    tenantData = { tenant_type: "sub_host", onboarding_stage: "branding" };
    const { POST } = await import("@/app/api/onboarding/branding-skip/route");
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; next_stage: string };
    expect(body.next_stage).toBe("review_submitted");

    const { progressTo } = await import("@/lib/onboarding/state-machine");
    expect(vi.mocked(progressTo)).toHaveBeenCalledWith("t1", "review_submitted");
    // Sub-hosts must NOT be activated directly.
    expect(lastUpdatePayload).toBeNull();
  });
});
