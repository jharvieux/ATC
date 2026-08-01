import { describe, it, expect, vi } from "vitest";
import { isCrossOriginRedirect } from "@/lib/http/redirect-guard";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (config: unknown, handler: unknown) => ({ config, handler }),
  },
}));
vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => ({
    from: () => ({
      select: () => Promise.resolve({ data: [], error: null }),
    }),
  }),
}));

// WHY: the reconcile fetches main's admin API with a Bearer token. If
// MAIN_APP_URL points at a host that redirects (apex→www, or the Vercel
// protection wall), following the redirect strips the bearer and yields a
// silent anonymous 200. The function uses redirect: "manual" and must treat
// any redirect as a hard failure so the misconfig is loud, not silent (#1273).
// A test that can't fail when that guard is removed would be worthless, so we
// pin both the redirect shapes Node can produce and the must-not-trip cases.
describe("isCrossOriginRedirect", () => {
  it("treats an undici opaqueredirect (status 0) as a redirect", () => {
    expect(isCrossOriginRedirect({ type: "opaqueredirect", status: 0 })).toBe(true);
  });

  it("treats raw 3xx statuses as a redirect", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(isCrossOriginRedirect({ type: "default", status })).toBe(true);
    }
  });

  it("does NOT trip on a successful 200", () => {
    expect(isCrossOriginRedirect({ type: "default", status: 200 })).toBe(false);
  });

  it("does NOT trip on 4xx/5xx — those are handled by the !res.ok branch", () => {
    // 403 (protection wall returning forbidden) and 401 (key mismatch) must
    // fall through to the explicit `returned ${status}` error, not the
    // redirect error — keeping the two failure modes diagnosable apart.
    for (const status of [400, 401, 403, 404, 500, 502]) {
      expect(isCrossOriginRedirect({ type: "default", status })).toBe(false);
    }
  });
});

describe("#2002 rotation — tenant-registry-reconcile signer", () => {
  it("presents MAIN_APP_ADMIN_API_KEY_CURRENT in the Bearer header when both it and the legacy var are set", async () => {
    process.env.MAIN_APP_URL = "https://main.example.com";
    process.env.MAIN_APP_ADMIN_API_KEY = "legacy-admin-key";
    process.env.MAIN_APP_ADMIN_API_KEY_CURRENT = "rotated-admin-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      type: "default",
      json: async () => ({ tenants: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { tenantRegistryReconcile } = await import("@/inngest/tenant-registry-reconcile");
      const fn = tenantRegistryReconcile as unknown as { handler: () => Promise<unknown> };
      await fn.handler();

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer rotated-admin-key",
      );
    } finally {
      vi.unstubAllGlobals();
      delete process.env.MAIN_APP_URL;
      delete process.env.MAIN_APP_ADMIN_API_KEY;
      delete process.env.MAIN_APP_ADMIN_API_KEY_CURRENT;
    }
  });
});
