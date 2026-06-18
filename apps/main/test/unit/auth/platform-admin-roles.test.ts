// Unit tests for apps/main/src/lib/auth/platform-admin-roles.ts
//
// Pure-function tests — no mocks required. Pins:
//   - isPlatformAdminRole type guard boundary
//   - ADMIN_AREA_GRANTS separation invariants (the role-separation matrix
//     is the security boundary for admin area routing)

import { describe, expect, it } from "vitest";
import {
  isPlatformAdminRole,
  PLATFORM_ADMIN_ROLES,
  ADMIN_AREA_GRANTS,
} from "@/lib/auth/platform-admin-roles";

describe("isPlatformAdminRole", () => {
  it("returns true for each valid role", () => {
    for (const role of PLATFORM_ADMIN_ROLES) {
      expect(isPlatformAdminRole(role)).toBe(true);
    }
  });

  it("returns false for unknown string", () => {
    expect(isPlatformAdminRole("tenant_owner")).toBe(false);
    expect(isPlatformAdminRole("admin")).toBe(false);
    expect(isPlatformAdminRole("")).toBe(false);
  });

  it("returns false for a string that is a substring of a valid role", () => {
    // 'super' is not 'superadmin'
    expect(isPlatformAdminRole("super")).toBe(false);
  });
});

describe("ADMIN_AREA_GRANTS — superadmin is present in every area", () => {
  it("superadmin appears in all areas (no area is superadmin-locked out)", () => {
    for (const [area, grants] of Object.entries(ADMIN_AREA_GRANTS)) {
      expect((grants as readonly string[]).includes("superadmin")).toBe(true);
    }
  });
});

describe("ADMIN_AREA_GRANTS — reviewer access boundaries", () => {
  const REVIEWER_DENIED = ["abuse", "tenants", "personas", "persona_safety", "ai_pricing", "reconciliation", "resource_util", "admins", "legal_docs", "pause_ai", "ai_kill_switch", "integrations"] as const;
  const REVIEWER_GRANTED = ["rag", "chunks", "retrieval_weights", "travel_news", "cruise_catalog", "denylist", "email_samples"] as const;

  for (const area of REVIEWER_DENIED) {
    it(`reviewer cannot access '${area}'`, () => {
      expect((ADMIN_AREA_GRANTS[area] as readonly string[]).includes("reviewer")).toBe(false);
    });
  }

  for (const area of REVIEWER_GRANTED) {
    it(`reviewer can access '${area}'`, () => {
      expect((ADMIN_AREA_GRANTS[area] as readonly string[]).includes("reviewer")).toBe(true);
    });
  }
});

describe("ADMIN_AREA_GRANTS — finance access boundaries", () => {
  it("finance can access ai_pricing, reconciliation, resource_util", () => {
    for (const area of ["ai_pricing", "reconciliation", "resource_util"] as const) {
      expect((ADMIN_AREA_GRANTS[area] as readonly string[]).includes("finance")).toBe(true);
    }
  });

  it("finance cannot access reviewer areas (rag, chunks, cruise_catalog)", () => {
    for (const area of ["rag", "chunks", "cruise_catalog"] as const) {
      expect((ADMIN_AREA_GRANTS[area] as readonly string[]).includes("finance")).toBe(false);
    }
  });

  it("finance cannot access support areas (help, vendor_status)", () => {
    for (const area of ["help", "vendor_status"] as const) {
      expect((ADMIN_AREA_GRANTS[area] as readonly string[]).includes("finance")).toBe(false);
    }
  });

  it("finance cannot access superadmin-only areas", () => {
    for (const area of ["abuse", "tenants", "personas", "persona_safety", "admins"] as const) {
      expect((ADMIN_AREA_GRANTS[area] as readonly string[]).includes("finance")).toBe(false);
    }
  });
});

describe("ADMIN_AREA_GRANTS — support access boundaries", () => {
  it("support can access help, vendor_status, email_samples", () => {
    for (const area of ["help", "vendor_status", "email_samples"] as const) {
      expect((ADMIN_AREA_GRANTS[area] as readonly string[]).includes("support")).toBe(true);
    }
  });

  it("support cannot access finance areas", () => {
    for (const area of ["ai_pricing", "reconciliation", "resource_util"] as const) {
      expect((ADMIN_AREA_GRANTS[area] as readonly string[]).includes("support")).toBe(false);
    }
  });

  it("support cannot access reviewer-only areas (rag, chunks)", () => {
    for (const area of ["rag", "chunks"] as const) {
      expect((ADMIN_AREA_GRANTS[area] as readonly string[]).includes("support")).toBe(false);
    }
  });
});

describe("ADMIN_AREA_GRANTS — supervisor area grants all roles", () => {
  it("all 4 platform admin roles can access supervisor", () => {
    const grants = ADMIN_AREA_GRANTS["supervisor"] as readonly string[];
    for (const role of PLATFORM_ADMIN_ROLES) {
      expect(grants.includes(role)).toBe(true);
    }
  });
});
