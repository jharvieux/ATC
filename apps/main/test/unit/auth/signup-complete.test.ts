// §7.1 / §17.3 — signup/complete tenant provisioning (#441).
//
// Contracts pinned here:
//   1. Platform domain guard: non-platform x-resolved-tenant-id → 403.
//   2. Session guard: missing/invalid session → 401.
//   3. Required fields: each absent field → 400 with specific error code.
//   4. tenant_type restricted to byo_host | sub_host; anything else → 400.
//   5. Idempotency guard: user with an existing users row → 409 already_provisioned.
//   6. Idempotency guard fail-closed: DB error on the guard query → 500, not silent pass.
//   7. Slug conflict: 23505 from tenants.insert → 409 slug_taken.
//   8. Partial-state: users.insert failure after tenant committed → 500 + orphan logged.
//   9. Happy path: 201 with correct body, attribution cookie cleared, publishTenantEvent
//      called with tenant.created, bindContactOnIdentification called with utm_parsed when
//      pending cookie present and agent_set when absent.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_ID   = "ffffffff-0000-1111-2222-333333333333";
const AUTH_ID   = "auth-user-uuid-1234";
const EMAIL     = "operator@example.com";

const mocks = vi.hoisted(() => ({
  getUser:                      vi.fn(),
  usersIdempotencyQuery:        vi.fn(),
  tenantsInsertSingle:          vi.fn(),
  usersInsertSingle:            vi.fn(),
  publishTenantEvent:           vi.fn(),
  bindContactOnIdentification:  vi.fn(),
  progressTo:                   vi.fn(),
}));

vi.mock("@/lib/auth/ssr-client", () => ({
  createRequestScopedClient: () => ({
    auth: { getUser: mocks.getUser },
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({ maybeSingle: mocks.usersIdempotencyQuery }),
            }),
          }),
          insert: () => ({
            select: () => ({ single: mocks.usersInsertSingle }),
          }),
        };
      }
      if (table === "tenants") {
        return {
          insert: () => ({
            select: () => ({ single: mocks.tenantsInsertSingle }),
          }),
        };
      }
      return {};
    },
  }),
}));

vi.mock("@/lib/rag-sync/publish-tenant-event", () => ({
  publishTenantEvent: mocks.publishTenantEvent,
}));

vi.mock("@/lib/attribution/bind-contact-on-identification", () => ({
  bindContactOnIdentification: mocks.bindContactOnIdentification,
}));

vi.mock("@/lib/onboarding/state-machine", () => ({
  progressTo: mocks.progressTo,
}));

import { POST } from "@/app/api/auth/signup/complete/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function platformReq(body: unknown, extra: Record<string, string> = {}) {
  return new NextRequest("http://platform.example.com/api/auth/signup/complete", {
    method: "POST",
    headers: {
      "x-resolved-tenant-id": "platform",
      "content-type": "application/json",
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  display_name:  "Acme Travel",
  legal_name:    "Acme Travel LLC",
  slug:          "acme-travel",
  tenant_type:   "byo_host",
  support_email: "support@acmetravel.com",
  timezone:      "America/New_York",
  mailing_address: { line1: "123 Main St", city: "Miami", state: "FL", zip: "33101", country: "US" },
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated user with email, no existing users row
  mocks.getUser.mockResolvedValue({ data: { user: { id: AUTH_ID, email: EMAIL } }, error: null });
  mocks.usersIdempotencyQuery.mockResolvedValue({ data: null, error: null });
  mocks.tenantsInsertSingle.mockResolvedValue({ data: { id: TENANT_ID }, error: null });
  mocks.usersInsertSingle.mockResolvedValue({ data: { id: USER_ID }, error: null });
  mocks.publishTenantEvent.mockResolvedValue(undefined);
  mocks.bindContactOnIdentification.mockResolvedValue({ ok: true, contact_id: "c1", was_new_contact: true });
  mocks.progressTo.mockResolvedValue(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/auth/signup/complete", () => {
  describe("platform domain guard", () => {
    it("returns 403 when x-resolved-tenant-id is a UUID (tenant subdomain)", async () => {
      const req = new NextRequest("http://example.com/api/auth/signup/complete", {
        method: "POST",
        headers: {
          "x-resolved-tenant-id": "11111111-2222-3333-4444-555555555555",
          "content-type": "application/json",
        },
        body: JSON.stringify(VALID_BODY),
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    });

    it("returns 403 when x-resolved-tenant-id header is absent", async () => {
      const req = new NextRequest("http://example.com/api/auth/signup/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
    });
  });

  describe("session guard", () => {
    it("returns 401 when session is missing", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error("no session") });
      const res = await POST(platformReq(VALID_BODY));
      expect(res.status).toBe(401);
    });

    it("returns 400 when auth user has no email", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: { id: AUTH_ID, email: null } }, error: null });
      const res = await POST(platformReq(VALID_BODY));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "email_required" });
    });
  });

  describe("body validation", () => {
    it.each([
      [{ ...VALID_BODY, display_name: undefined },                          "display_name_required"],
      [{ ...VALID_BODY, legal_name: undefined },                            "legal_name_required"],
      [{ ...VALID_BODY, slug: undefined },                                  "slug_required"],
      [{ ...VALID_BODY, support_email: undefined },                         "support_email_required"],
      [{ ...VALID_BODY, timezone: undefined },                              "timezone_required"],
      [{ ...VALID_BODY, mailing_address: undefined },                       "mailing_address_required"],
      [{ ...VALID_BODY, mailing_address: { city: "Miami", state: "FL", zip: "33101" } }, "mailing_address_required"],
      [{ ...VALID_BODY, tenant_type: "platform" },                          "tenant_type_invalid"],
      [{ ...VALID_BODY, tenant_type: "bad_type" },                          "tenant_type_invalid"],
    ])("returns 400 with %s error for body %j", async (body, expectedError) => {
      const res = await POST(platformReq(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expectedError });
    });
  });

  describe("idempotency guard", () => {
    it("returns 409 already_provisioned when user already has a users row", async () => {
      mocks.usersIdempotencyQuery.mockResolvedValue({ data: { tenant_id: TENANT_ID }, error: null });
      const res = await POST(platformReq(VALID_BODY));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "already_provisioned" });
    });

    it("returns 500 (fail-closed) when the idempotency guard DB query errors", async () => {
      mocks.usersIdempotencyQuery.mockResolvedValue({ data: null, error: { message: "DB unavailable", code: "PGRST_0001" } });
      const res = await POST(platformReq(VALID_BODY));
      // Guard must not silently pass on DB error — fail-closed means 500, not 201
      expect(res.status).toBe(500);
    });
  });

  describe("slug conflict", () => {
    it("returns 409 slug_taken on tenants 23505 unique violation", async () => {
      mocks.tenantsInsertSingle.mockResolvedValue({
        data: null,
        error: { message: "duplicate key", code: "23505", hint: null, details: null, name: "PostgrestError" },
      });
      const res = await POST(platformReq(VALID_BODY));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "slug_taken" });
    });
  });

  describe("partial-state failure", () => {
    it("returns 500 and does not publish event when users.insert fails after tenant committed", async () => {
      mocks.usersInsertSingle.mockResolvedValue({
        data: null,
        error: { message: "constraint violation", code: "23502", hint: null, details: null, name: "PostgrestError" },
      });
      const res = await POST(platformReq(VALID_BODY));
      expect(res.status).toBe(500);
      expect(mocks.publishTenantEvent).not.toHaveBeenCalled();
    });
  });

  describe("happy path", () => {
    it("returns 201 with tenant_id, slug, status, onboarding_stage=legal", async () => {
      const res = await POST(platformReq(VALID_BODY));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        tenant_id:        TENANT_ID,
        slug:             "acme-travel",
        status:           "onboarding",
        onboarding_stage: "legal",
      });
    });

    it("advances stage through profile then legal", async () => {
      await POST(platformReq(VALID_BODY));
      expect(mocks.progressTo).toHaveBeenNthCalledWith(1, TENANT_ID, "profile");
      expect(mocks.progressTo).toHaveBeenNthCalledWith(2, TENANT_ID, "legal");
    });

    it("normalises slug to lowercase", async () => {
      const res = await POST(platformReq({ ...VALID_BODY, slug: "Acme-Travel" }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.slug).toBe("acme-travel");
    });

    it("clears the attribution pending cookie on success", async () => {
      const res = await POST(platformReq(VALID_BODY));
      const setCookie = res.headers.get("set-cookie") ?? "";
      // clearPendingAttributionCookie uses cookies.delete() which sets Expires to epoch
      expect(setCookie).toContain("atc_attribution_pending=");
      expect(setCookie.toLowerCase()).toMatch(/expires=thu, 01 jan 1970|max-age=0/);
    });

    it("calls publishTenantEvent with tenant.created payload", async () => {
      await POST(platformReq(VALID_BODY));
      expect(mocks.publishTenantEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type:      "tenant.created",
          tenant_id:       TENANT_ID,
          source_revision: 0,
          payload: expect.objectContaining({
            status:       "onboarding",
            tenant_type:  "byo_host",
            display_name: "Acme Travel",
          }),
        }),
      );
    });

    it("calls bindContactOnIdentification with utm_parsed when pending attribution cookie is present", async () => {
      const pendingCookie = encodeURIComponent(JSON.stringify({
        utm_source: "google", utm_medium: "cpc", utm_campaign: "travel-agents",
        utm_content: null, utm_term: null, referrer_url: null,
        landing_path: "/", channel: "paid_search", manual_label: null,
        manual_category: null, captured_at: "2026-05-31T10:00:00.000Z",
      }));
      const req = platformReq(VALID_BODY, { cookie: `atc_attribution_pending=${pendingCookie}` });
      await POST(req);
      expect(mocks.bindContactOnIdentification).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id:     TENANT_ID,
          user_id:       USER_ID,
          source_origin: "utm_parsed",
          pending_payload: expect.objectContaining({ utm_source: "google" }),
        }),
      );
    });

    it("calls bindContactOnIdentification with agent_set when no pending attribution cookie", async () => {
      await POST(platformReq(VALID_BODY));
      expect(mocks.bindContactOnIdentification).toHaveBeenCalledWith(
        expect.objectContaining({
          source_origin:   "agent_set",
          pending_payload: null,
        }),
      );
    });

    it("accepts sub_host tenant_type", async () => {
      const res = await POST(platformReq({ ...VALID_BODY, tenant_type: "sub_host" }));
      expect(res.status).toBe(201);
    });
  });

  describe("attribution binding failure", () => {
    it("returns 201 and logs a warning when bindContactOnIdentification fails", async () => {
      mocks.bindContactOnIdentification.mockResolvedValue({ ok: false, error: "crm_unavailable" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(platformReq(VALID_BODY));
      expect(res.status).toBe(201);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[signup/complete] attribution binding failed:"),
        "crm_unavailable",
      );
      warnSpy.mockRestore();
    });
  });
});
