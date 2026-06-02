// #556 — route-level proof that a thrown auth failure reaches
// respondToAuthError and maps to the correct status, instead of escaping as a
// generic 500 (or leaking a raw error message).
//
// The mapper (respond.ts) is unit-tested on its own, and the static guard
// (scripts/check-auth-error-adoption.mjs) proves the import + call are present
// in every route. Neither proves the catch is actually *reached* at runtime.
// These fire a thrown error through two representative adopters of the #556
// sweep — `tasks` GET (a handler that had no try/catch and was wrapped) and
// `subcontractors` GET (a handler whose existing outer catch was rewired) — so
// the live status code is asserted for both transform shapes.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
      "@/lib/auth/assert-permission",
    );
  return { ...actual, assertPermission: mocks.assertPermission };
});

import { GET as tasksGet } from "@/app/api/tasks/route";
import { GET as subcontractorsGet } from "@/app/api/subcontractors/route";
import { AuthForbidden } from "@/lib/auth/assert-permission";

beforeEach(() => {
  vi.clearAllMocks();
});

function get(path: string): Request {
  return new Request(`https://tenant.example.com${path}`);
}

describe("#556 — assertPermission failures map through respondToAuthError", () => {
  it("tasks GET (wrapped from a no-try handler): AuthForbidden → 403, not 500", async () => {
    mocks.assertPermission.mockRejectedValue(new AuthForbidden("tasks", "list", "viewer"));
    const res = await tasksGet(get("/api/tasks"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  });

  it("tasks GET: invalid session → 401 unauthorized (flat code, no leaked message)", async () => {
    mocks.assertPermission.mockRejectedValue(
      new Error("assertPermission: invalid or expired access token."),
    );
    const res = await tasksGet(get("/api/tasks"));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
  });

  it("subcontractors GET (existing catch rewired): AuthForbidden → 403", async () => {
    mocks.assertPermission.mockRejectedValue(new AuthForbidden("subcontractors", "read", "viewer"));
    const res = await subcontractorsGet(get("/api/subcontractors"));
    expect(res.status).toBe(403);
  });

  it("subcontractors GET: invalid session → 401", async () => {
    mocks.assertPermission.mockRejectedValue(
      new Error("assertPermission: invalid or expired access token."),
    );
    const res = await subcontractorsGet(get("/api/subcontractors"));
    expect(res.status).toBe(401);
  });
});
