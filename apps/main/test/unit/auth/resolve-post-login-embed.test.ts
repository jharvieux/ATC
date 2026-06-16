// Regression guard for #1134 — the login-500 (ERROR 101242302) embed ambiguity.
//
// WHY: reverse FKs from tenants→users (review_decided_by_user_id,
// termination_initiated_by_user_id) made the bare `tenants(...)` embed off
// `users` ambiguous, so PostgREST returned HTTP 300 → supabase-js error →
// uncaught throw → login 500. The fix pins the embed to
// `tenants!users_tenant_id_fkey(...)`. These tests assert the FK hint is
// present so a future edit reverting to the bare form fails CI instead of
// re-breaking login in prod (tsc can't see inside the embed string).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const selectCalls: { users: string[]; platform_admins: string[] } = {
    users: [],
    platform_admins: [],
  };
  const makeBuilder = (table: string, result: { data: unknown; error: unknown }) => {
    const b: Record<string, unknown> = {
      select: (s: string) => {
        if (table === "users" || table === "platform_admins") selectCalls[table].push(s);
        return b;
      },
      eq: () => b,
      maybeSingle: async () => result,
      then: (resolve: (v: unknown) => void) => resolve(result),
    };
    return b;
  };
  return { selectCalls, makeBuilder };
});

vi.mock("@/lib/auth/ssr-client", () => ({
  createRequestScopedClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) =>
      h.makeBuilder(
        table,
        table === "users"
          ? {
              data: [
                {
                  role: "tenant_owner",
                  tenant_id: "t1",
                  status: "active",
                  tenants: { onboarding_stage: "complete", status: "active" },
                },
              ],
              error: null,
            }
          : { data: null, error: null },
      ),
  }),
}));

describe("resolve-post-login users→tenants embed (#1134)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.selectCalls.users = [];
    h.selectCalls.platform_admins = [];
  });

  it("resolvePostLoginDestination pins the embed to users_tenant_id_fkey, never bare tenants(", async () => {
    const { resolvePostLoginDestination } = await import("@/lib/auth/resolve-post-login");
    await resolvePostLoginDestination(new Request("https://lisa-travel.example.com/"));
    const sel = h.selectCalls.users.find((s) => s.includes("tenants"));
    expect(sel).toBeDefined();
    expect(sel).toContain("tenants!users_tenant_id_fkey(");
    // The ambiguous form that caused the 300 must not reappear.
    expect(sel).not.toContain("tenants(");
  });

  it("getTenantRole pins the embed to users_tenant_id_fkey, never bare tenants(", async () => {
    const { getTenantRole } = await import("@/lib/auth/resolve-post-login");
    await getTenantRole("u1", "t1");
    const sel = h.selectCalls.users.find((s) => s.includes("tenants"));
    expect(sel).toBeDefined();
    expect(sel).toContain("tenants!users_tenant_id_fkey(");
    expect(sel).not.toContain("tenants(");
  });
});
