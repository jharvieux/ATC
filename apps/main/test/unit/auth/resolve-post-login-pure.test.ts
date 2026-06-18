// Unit tests for the pure functions in apps/main/src/lib/auth/resolve-post-login.ts
//
// Covers: normalizeTenant, isRouteableTenant, pickHighestRankActiveMembership
// These are the 40%-coverage survivors from Stryker — the role-rank comparator
// and the tenant-status filter are the enforcement boundaries for post-login routing.
//
// Separate from resolve-post-login-embed.test.ts (which covers the FK embed guard).

import { describe, expect, it } from "vitest";
import {
  normalizeTenant,
  isRouteableTenant,
  pickHighestRankActiveMembership,
  type MembershipRow,
} from "@/lib/auth/resolve-post-login";

// ── normalizeTenant ────────────────────────────────────────────────────────

describe("normalizeTenant", () => {
  it("returns null when input is null", () => {
    expect(normalizeTenant(null)).toBeNull();
  });

  it("returns the object itself when input is a plain object (1:1 FK)", () => {
    const t = { onboarding_stage: "complete" as const, status: "active" };
    expect(normalizeTenant(t)).toBe(t);
  });

  it("returns the first element when input is a non-empty array (array embed shape)", () => {
    const t = { onboarding_stage: "complete" as const, status: "active" };
    expect(normalizeTenant([t])).toBe(t);
  });

  it("returns null when input is an empty array", () => {
    expect(normalizeTenant([])).toBeNull();
  });
});

// ── isRouteableTenant ──────────────────────────────────────────────────────

describe("isRouteableTenant", () => {
  function tenant(status: string) {
    return { onboarding_stage: null, status };
  }

  it("returns false for null (missing tenant embed)", () => {
    expect(isRouteableTenant(null)).toBe(false);
  });

  it("returns true for 'active' — the standard active state", () => {
    expect(isRouteableTenant(tenant("active"))).toBe(true);
  });

  it("returns true for 'onboarding' — mid-funnel state must route normally", () => {
    expect(isRouteableTenant(tenant("onboarding"))).toBe(true);
  });

  it("returns true for 'pending_review' — awaiting platform approval must route normally", () => {
    expect(isRouteableTenant(tenant("pending_review"))).toBe(true);
  });

  it("returns false for 'suspended' — suspended tenant must not route to /crm", () => {
    // A user under a suspended tenant would be 403'd by assertPermission if routed
    // to /crm. isRouteableTenant filters these out so the user falls back to /chat.
    expect(isRouteableTenant(tenant("suspended"))).toBe(false);
  });

  it("returns false for 'terminated' — terminated tenant must not route to /crm", () => {
    expect(isRouteableTenant(tenant("terminated"))).toBe(false);
  });

  it("returns false for an unknown status string (fail-closed for future DB enum additions)", () => {
    expect(isRouteableTenant(tenant("unknown_future_status"))).toBe(false);
  });
});

// ── pickHighestRankActiveMembership ────────────────────────────────────────

function row(role: string, tenantId = "t1"): MembershipRow {
  return { role, tenant_id: tenantId, tenants: { onboarding_stage: null, status: "active" } };
}

describe("pickHighestRankActiveMembership", () => {
  it("returns null for an empty array", () => {
    expect(pickHighestRankActiveMembership([])).toBeNull();
  });

  it("returns null when all rows have unknown roles (future enum value)", () => {
    // Unknown roles are silently dropped so a new DB enum value doesn't
    // accidentally elevate a user — fail-closed default to no selection.
    expect(pickHighestRankActiveMembership([row("platform_admin"), row("superuser")])).toBeNull();
  });

  it("picks tenant_owner over agent and viewer", () => {
    const result = pickHighestRankActiveMembership([row("viewer"), row("agent"), row("tenant_owner")]);
    expect(result!.role).toBe("tenant_owner");
  });

  it("picks agent over viewer", () => {
    const result = pickHighestRankActiveMembership([row("viewer"), row("agent")]);
    expect(result!.role).toBe("agent");
  });

  it("returns the single known row when there is only one", () => {
    const result = pickHighestRankActiveMembership([row("viewer")]);
    expect(result!.role).toBe("viewer");
  });

  it("drops rows with unknown roles, picks highest from remaining known ones", () => {
    const result = pickHighestRankActiveMembership([
      row("agent"),
      row("unknown_future_role"),
      row("viewer"),
    ]);
    expect(result!.role).toBe("agent");
  });

  it("preserves tenant_id of the winning row", () => {
    // The dispatcher uses the picked row's tenant_id for routing.
    const result = pickHighestRankActiveMembership([row("viewer", "t-viewer"), row("tenant_owner", "t-owner")]);
    expect(result!.tenant_id).toBe("t-owner");
  });

  it("returns first tenant_owner when multiple tenant_owner rows exist (tie)", () => {
    // The reduce keeps the first equal-rank row, so order matters.
    const result = pickHighestRankActiveMembership([row("tenant_owner", "t-first"), row("tenant_owner", "t-second")]);
    expect(result!.tenant_id).toBe("t-first");
  });
});
