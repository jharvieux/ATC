// #1953 — a data-cache hit on /supervisor must NOT skip the platform-admin
// gate. The page was restructured so the six service-role reads live inside
// an unstable_cache unit while assertPlatformAdminAreaPage runs per-request
// in the page body, BEFORE the cached read. WHY this matters: if the auth
// check ever moves inside the cached unit (or the page itself becomes
// statically cacheable around it), a cache hit would serve the cross-tenant
// dashboard to an unauthenticated caller — the exact access-control bypass
// #1953 blocked caching on. These tests simulate a warm cache (the loader
// resolves without touching the DB) and prove the gate still decides.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  assertCalls: 0,
  assertShouldThrow: false,
  cachedUnitInvocations: 0,
}));

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  assertPlatformAdminAreaPage: vi.fn(async () => {
    mocks.assertCalls++;
    if (mocks.assertShouldThrow) {
      // Mirrors notFound()'s internal throw — the page never continues.
      throw new Error("NEXT_NOT_FOUND");
    }
    return { admin_user_id: "admin-1", role: "superadmin", via: "session" };
  }),
  assertPlatformRolePage: vi.fn(),
}));

// Simulated WARM cache: unstable_cache returns a wrapper that serves a
// canned dashboard payload without ever invoking the underlying loader —
// i.e. every request is a cache hit and the DB is never touched.
vi.mock("next/cache", () => ({
  unstable_cache: () => async () => {
    mocks.cachedUnitInvocations++;
    return {
      escalations: [],
      flaggedMessages: [],
      personaMetrics: [],
      killSwitch: { global_paused: false, global_paused_at: null, global_paused_reason: null },
      regenExhausted: 0,
      drift: { current_7d: 0, prior_7d: 0, delta_pct: null },
    };
  },
  revalidateTag: vi.fn(),
}));

// The DB client must be unreachable on a cache hit — any call here means
// the cached unit leaked, voiding the simulation.
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: vi.fn(() => {
    throw new Error("DB touched despite simulated cache hit");
  }),
}));

import SupervisorDashboardPage from "../../../src/app/(admin)/supervisor/page";

beforeEach(() => {
  mocks.assertCalls = 0;
  mocks.assertShouldThrow = false;
  mocks.cachedUnitInvocations = 0;
});

describe("/supervisor — cache hit still enforces platform-admin (#1953)", () => {
  it("non-admin is rejected before any cached data is read", async () => {
    mocks.assertShouldThrow = true;
    await expect(SupervisorDashboardPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.assertCalls).toBe(1);
    // Fail-closed ordering: the rejection happened without the cached
    // payload ever being served.
    expect(mocks.cachedUnitInvocations).toBe(0);
  });

  it("admin renders entirely from the cached payload — auth ran, DB untouched", async () => {
    const html = renderToStaticMarkup(await SupervisorDashboardPage());
    expect(mocks.assertCalls).toBe(1);
    expect(mocks.cachedUnitInvocations).toBe(1);
    expect(html).toContain("AI Supervisor Dashboard");
  });

  it("auth runs per-request even when every request is a cache hit", async () => {
    await SupervisorDashboardPage();
    await SupervisorDashboardPage();
    expect(mocks.assertCalls).toBe(2);
  });
});
