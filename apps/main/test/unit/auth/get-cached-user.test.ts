// Tests for the request-scoped getUser cache (#667). The error-collapse
// invariant matters because the prior in-line implementation in
// getSiteHeaderProps would 500 the landing for anonymous visitors when
// it threw on `AuthSessionMissingError` (#657 hotfix). Same pattern is
// required here.

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — declare mocks inside the factory and pull them
// out via vi.hoisted so the factories can close over them.
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  headersGet: vi.fn(() => null),
}));

// React.cache is an RSC runtime feature unavailable in vitest's node env;
// substitute a pass-through (no memoization) so the function under test
// can at least be called. The cache-scoping invariant requires a render-
// tree integration test to verify, which is out of scope for this unit.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    cache: <T extends (...a: unknown[]) => unknown>(fn: T): T => fn,
  };
});

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve({ get: mocks.headersGet }),
}));

vi.mock("@/lib/auth/ssr-client", () => ({
  createRequestScopedClient: () => ({ auth: { getUser: mocks.getUser } }),
}));

import { getCachedUser } from "@/lib/auth/get-cached-user";

describe("getCachedUser", () => {
  beforeEach(() => {
    mocks.getUser.mockReset();
    mocks.headersGet.mockReset();
    mocks.headersGet.mockReturnValue(null);
  });

  it("returns isAuthenticated=true when getUser resolves with a user", async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });
    const result = await getCachedUser();
    expect(result.isAuthenticated).toBe(true);
  });

  it("returns isAuthenticated=false when getUser resolves with an error (the AuthSessionMissingError case that #657 was about)", async () => {
    // This is the regression #657 hotfixed: the prior version threw on
    // any non-null error, including the routine "Auth session missing!"
    // that Supabase returns for anonymous visitors — 500ing the landing.
    mocks.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { name: "AuthSessionMissingError", message: "Auth session missing!" },
    });
    const result = await getCachedUser();
    expect(result.isAuthenticated).toBe(false);
  });

  it("returns isAuthenticated=false when getUser resolves with no user and no error (no session, no failure)", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const result = await getCachedUser();
    expect(result.isAuthenticated).toBe(false);
  });

  it("returns isAuthenticated=false when getUser data is missing entirely (network/Supabase oddity)", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: null, error: null });
    const result = await getCachedUser();
    expect(result.isAuthenticated).toBe(false);
  });
});
