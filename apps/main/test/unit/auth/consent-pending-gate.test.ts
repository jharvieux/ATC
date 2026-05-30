// §17.4 — assertPermission consent-pending gate tests.
//
// Spec contract (Build Prompt part-4 §17.4): "the global middleware redirects
// ANY authenticated request other than /consent, /logout, /legal/* to
// /consent if pending rows exist". The session lives in HttpOnly cookies but
// the consent check needs the authenticated user id (only available after
// getUser), so the gate enforces in assertPermission. These tests verify:
//   1. respondToAuthError maps ConsentPendingError to a 403 with the
//      structured `consent_pending` body.
//   2. assertPermission throws ConsentPendingError when getConsentPending
//      returns one or more rows.
//   3. assertPermission proceeds normally when getConsentPending returns
//      an empty array.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ConsentPendingError,
  AuthForbidden,
} from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

const mocks = vi.hoisted(() => ({
  getConsentPending: vi.fn(),
  tenantContextFromRequest: vi.fn(),
  getUser: vi.fn(),
  usersMaybeSingle: vi.fn(),
}));

vi.mock("@/lib/consent/pending", () => ({
  getConsentPending: mocks.getConsentPending,
}));

vi.mock("@/lib/db/factories", () => ({
  tenantContextFromRequest: mocks.tenantContextFromRequest,
}));

vi.mock("@/lib/auth/ssr-client", () => ({
  createRequestScopedClient: () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: mocks.usersMaybeSingle }),
        }),
      }),
    }),
  }),
}));

describe("respondToAuthError — ConsentPendingError mapping", () => {
  it("returns 403 with structured consent_pending body", async () => {
    const err = new ConsentPendingError("/dashboard", [
      { document_type: "tou", document_id_pending: "doc-1", flagged_at: "2026-05-01T00:00:00Z" },
    ]);
    const res = respondToAuthError(err);
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      return_to: string;
      pending: Array<{ document_type: string }>;
    };
    expect(body.error).toBe("consent_pending");
    expect(body.return_to).toBe("/dashboard");
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]?.document_type).toBe("tou");
  });

  it("does NOT misclassify other auth errors as consent_pending", async () => {
    const res = respondToAuthError(new AuthForbidden("contacts", "delete", "viewer"));
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
    expect(res.status).toBe(403);
  });
});

describe("assertPermission — consent gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenantContextFromRequest.mockResolvedValue({
      tenant_id: "t-1",
      source: { kind: "http_request", user_id: "auth-1" },
    });
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "auth-1" } },
      error: null,
    });
    mocks.usersMaybeSingle.mockResolvedValue({
      data: {
        id: "user-1",
        auth_user_id: "auth-1",
        tenant_id: "t-1",
        status: "active",
        role: "tenant_owner",
      },
      error: null,
    });
  });

  function makeReq(): Request {
    return new Request("https://atc.example/api/contacts", {
      headers: { "x-resolved-tenant-id": "t-1" },
    });
  }

  it("throws ConsentPendingError when pending rows exist", async () => {
    mocks.getConsentPending.mockResolvedValue([
      { document_type: "privacy_policy", document_id_pending: "doc-9", flagged_at: "2026-05-01T00:00:00Z" },
    ]);
    const { assertPermission } = await import("@/lib/auth/assert-permission");
    await expect(
      assertPermission(makeReq(), { resource: "contacts", action: "list" }),
    ).rejects.toBeInstanceOf(ConsentPendingError);
  });

  it("includes the request pathname in return_to", async () => {
    mocks.getConsentPending.mockResolvedValue([
      { document_type: "tou", document_id_pending: "doc-3", flagged_at: "2026-05-01T00:00:00Z" },
    ]);
    const { assertPermission } = await import("@/lib/auth/assert-permission");
    try {
      await assertPermission(makeReq(), { resource: "contacts", action: "list" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConsentPendingError);
      expect((e as ConsentPendingError).return_to).toBe("/api/contacts");
      expect((e as ConsentPendingError).pending).toHaveLength(1);
    }
  });

  it("proceeds normally when no pending rows exist", async () => {
    mocks.getConsentPending.mockResolvedValue([]);
    const { assertPermission } = await import("@/lib/auth/assert-permission");
    const result = await assertPermission(makeReq(), {
      resource: "contacts",
      action: "list",
    });
    expect(result.user.id).toBe("user-1");
    expect(result.user.role).toBe("tenant_owner");
  });
});
