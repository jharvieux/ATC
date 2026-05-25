// BP28 — POST /api/admin/abuse/overrides input validation.
//
// We mock withPlatformAdminAudit so the handler runs without touching a real
// database. The intent is to lock in the validation contract (rejects bad
// shapes; accepts the canonical shape) — not to test Supabase plumbing.

import { describe, it, expect, vi, beforeEach } from "vitest";

// §26 admin gate — mock the session gate so the validation tests can focus
// on the input-shape contract rather than auth plumbing. Tests pass a
// header to opt into "admin present" mode; an empty header object gets 401.
vi.mock("@/lib/auth/assert-platform-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-platform-admin")>(
    "@/lib/auth/assert-platform-admin",
  );
  return {
    ...actual,
    assertPlatformAdmin: vi.fn(async (req: Request) => {
      // Honor the legacy x-admin-user-id header for the validation tests.
      const adminUserId = req.headers.get("x-admin-user-id");
      if (!adminUserId) {
        throw new actual.PlatformAdminError(401, "missing_bearer", "Missing Authorization: Bearer header.");
      }
      return { admin_user_id: adminUserId, role: "test", via: "session" as const };
    }),
  };
});

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (_opts, fn: (db: unknown, rec: () => void) => Promise<unknown>) => {
    const db = {
      from: () => ({
        insert: () => ({
          select: () => ({ single: async () => ({ data: { id: "ovr-1" }, error: null }) }),
        }),
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }),
    };
    return fn(db, () => {});
  }),
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

async function postOverride(body: unknown, headers: Record<string, string> = { "x-admin-user-id": "admin-1" }): Promise<Response> {
  const { POST } = await import("@/app/api/admin/abuse/overrides/route");
  return POST(new Request("http://test/api/admin/abuse/overrides", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

describe("POST /api/admin/abuse/overrides — validation", () => {
  it("401 when x-admin-user-id missing", async () => {
    const res = await postOverride({}, {});
    expect(res.status).toBe(401);
  });

  it("400 on missing dimension", async () => {
    const res = await postOverride({ tenant_id: "t", tier_override: "hard", threshold_value: 100, reason: "valid reason" });
    expect(res.status).toBe(400);
  });

  it("400 on invalid dimension", async () => {
    const res = await postOverride({ tenant_id: "t", dimension: "fake", tier_override: "hard", threshold_value: 100, reason: "valid reason" });
    expect(res.status).toBe(400);
  });

  it("400 on invalid tier_override", async () => {
    const res = await postOverride({ tenant_id: "t", dimension: "ai_cost", tier_override: "ultra", threshold_value: 100, reason: "valid reason" });
    expect(res.status).toBe(400);
  });

  it("400 on negative threshold_value", async () => {
    const res = await postOverride({ tenant_id: "t", dimension: "ai_cost", tier_override: "hard", threshold_value: -1, reason: "valid reason" });
    expect(res.status).toBe(400);
  });

  it("400 on reason shorter than 5 chars", async () => {
    const res = await postOverride({ tenant_id: "t", dimension: "ai_cost", tier_override: "hard", threshold_value: 100, reason: "no" });
    expect(res.status).toBe(400);
  });

  it("200 on canonical payload", async () => {
    const res = await postOverride({ tenant_id: "t-1", dimension: "ai_cost", tier_override: "hard", threshold_value: 12345, reason: "ops override after Stripe issue" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.override.id).toBe("ovr-1");
  });
});
