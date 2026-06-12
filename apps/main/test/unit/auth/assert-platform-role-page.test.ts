// #1002 — Unit tests for assertPlatformRolePage (page-level role gate).
//
// Uses the service-bearer path for getCachedAdminContext so tests don't need
// an auth/DB round-trip. Verifies the two gate behaviours: allowed role
// returns context; disallowed role calls notFound().

import { describe, it, expect, vi, beforeEach } from "vitest";

// notFound() throws in Next.js (NEXT_NOT_FOUND). Simulate that so tests can
// catch the thrown value and confirm the gate fired.
const mockNotFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

// getCachedAdminContext reads next/headers to forward Authorization + cookie.
// Provide a service-bearer so the test doesn't need a live auth/DB round-trip.
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ authorization: "Bearer service-secret-key" })),
}));

// Required by the module's imports even though the bearer path doesn't call them.
vi.mock("@/lib/auth/ssr-client", () => ({
  createRequestScopedClient: () => ({ auth: { getUser: vi.fn() } }),
}));
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: vi.fn() }),
}));

import { assertPlatformRolePage } from "@/lib/auth/assert-platform-admin";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    MAIN_APP_ADMIN_API_KEY: "service-secret-key",
  };
});

describe("assertPlatformRolePage — role gate", () => {
  it("returns context when caller's role is in allowedRoles", async () => {
    // The service bearer resolves to role "service".
    const ctx = await assertPlatformRolePage(["superadmin", "service"]);
    expect(ctx.role).toBe("service");
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("calls notFound() when caller's role is NOT in allowedRoles", async () => {
    // "service" role is not in this list — gate must fire.
    await expect(assertPlatformRolePage(["superadmin", "reviewer"])).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});
