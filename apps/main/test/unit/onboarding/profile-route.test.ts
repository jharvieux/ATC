// §15.3 — GET + POST /api/onboarding/profile unit tests.
//
// Contracts pinned here:
//   1. GET happy path: returns 200 with tenant profile fields.
//   2. GET DB error: returns 500, not a silent empty response.
//   3. POST happy path: returns { ok: true, next_stage: "legal" }.
//   4. POST stage_advance_failed: progressTo throws after update committed → 500,
//      client gets a distinct retriable error code (not a generic internal_error).
//   5. POST slug_taken: slug uniqueness check → 409.
//   6. POST missing required fields → 422.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  tenantSelectSingle: vi.fn(),
  tenantUpdate: vi.fn(),
  slugCheckMaybeSingle: vi.fn(),
  progressTo: vi.fn(),
  publishShadow: vi.fn(async () => undefined),
}));

vi.mock("@/lib/rag-sync/publish-tenant-shadow-event", () => ({
  publishTenantShadowEvent: mocks.publishShadow,
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single: mocks.tenantSelectSingle }),
      }),
      update: () => ({
        eq: () => ({ error: null, ...mocks.tenantUpdate() }),
      }),
    }),
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          neq: () => ({ maybeSingle: mocks.slugCheckMaybeSingle }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/onboarding/state-machine", () => ({
  progressTo: mocks.progressTo,
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: (err: unknown) =>
    Response.json({ error: "unauthorized" }, { status: 401 }),
}));

import { GET, POST } from "@/app/api/onboarding/profile/route";

const CTX = { tenant_id: TENANT_ID, user_id: "u1", role: "tenant_owner" };

const VALID_BODY = {
  legal_name:    "Acme Travel LLC",
  display_name:  "Acme Travel",
  slug:          "acme-travel",
  support_email: "support@acmetravel.com",
  timezone:      "America/New_York",
  mailing_address: { line1: "123 Main St", city: "Miami", state: "FL", zip: "33101", country: "US" },
};

function makeReq(body?: unknown): Request {
  return new Request("http://example.com/api/onboarding/profile", {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({ ctx: CTX });
  mocks.tenantSelectSingle.mockResolvedValue({
    data: { legal_name: "Acme", display_name: "Acme Travel", slug: "acme", mailing_address: null, support_email: "s@acme.com", support_phone: null, timezone: "UTC" },
    error: null,
  });
  mocks.tenantUpdate.mockReturnValue({ error: null });
  mocks.slugCheckMaybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.progressTo.mockResolvedValue(undefined);
});

describe("GET /api/onboarding/profile", () => {
  it("returns 200 with profile data on happy path", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ slug: "acme", support_email: "s@acme.com" });
  });

  it("returns 500 when DB query errors", async () => {
    mocks.tenantSelectSingle.mockResolvedValue({ data: null, error: { message: "db error" } });
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });
});

describe("POST /api/onboarding/profile", () => {
  it("returns 200 with ok and next_stage=legal on happy path", async () => {
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, next_stage: "legal" });
    // display_name change is mirrored to RAG's shadow registry.
    expect(mocks.publishShadow).toHaveBeenCalledWith(expect.anything(), TENANT_ID, "tenant.metadata_updated");
  });

  it("advances stage through profile then legal", async () => {
    await POST(makeReq(VALID_BODY));
    expect(mocks.progressTo).toHaveBeenNthCalledWith(1, TENANT_ID, "profile");
    expect(mocks.progressTo).toHaveBeenNthCalledWith(2, TENANT_ID, "legal");
  });

  it("returns 500 stage_advance_failed when progressTo throws after update committed", async () => {
    mocks.progressTo.mockRejectedValueOnce(new Error("StaleStageError"));
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "stage_advance_failed" });
  });

  it("returns 409 slug_taken when slug uniqueness check finds a conflict", async () => {
    mocks.slugCheckMaybeSingle.mockResolvedValue({ data: { id: "other-tenant" }, error: null });
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "slug_taken" });
  });

  it("returns 422 when required fields are missing", async () => {
    const res = await POST(makeReq({ ...VALID_BODY, legal_name: undefined }));
    expect(res.status).toBe(422);
  });
});
