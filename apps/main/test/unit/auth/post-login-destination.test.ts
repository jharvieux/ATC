// Tests for the post-login routing dispatcher. Each case encodes the WHY
// behind the destination — these are intent tests, not coverage. If the
// product changes its mind about where a given user type should land, the
// test that breaks tells the editor which decision they're walking back.

import { describe, it, expect } from "vitest";
import { postLoginDestination } from "@/lib/auth/post-login-destination";
import {
  pickHighestRankActiveMembership,
  normalizeTenant,
  isRouteableTenant,
  type MembershipRow,
} from "@/lib/auth/resolve-post-login";

describe("postLoginDestination", () => {
  it("sends platform admins to /admin (admin work is why they log in, even if they're also a tenant member)", () => {
    // The discriminated union doesn't even allow passing a role here —
    // that's the type-level guarantee that role doesn't influence the
    // admin destination. Previously this was a runtime concern documented
    // in a comment; now it's a compile-time invariant.
    expect(postLoginDestination({ isPlatformAdmin: true })).toBe("/admin");
  });

  it("sends an onboarding-incomplete tenant_owner to the matching stage URL (not the tenant home)", () => {
    // Was the original blank-page symptom: a half-onboarded tenant landed on
    // `/` with nothing to do. The dispatcher must route them back to the
    // pending stage so the funnel resumes.
    expect(
      postLoginDestination({
        isPlatformAdmin: false,
        role: "tenant_owner",
        tenantOnboardingStage: "tax_form",
      }),
    ).toBe("/onboarding/tax-form");
  });

  it("kebab-cases snake_case stage names when mapping to URLs", () => {
    // The stage enum is snake_case (matches SQL); the Next.js routes are
    // kebab-case. The mapping must translate — otherwise we redirect to a
    // 404 like /onboarding/state_of_operation.
    expect(
      postLoginDestination({
        isPlatformAdmin: false,
        role: "agent",
        tenantOnboardingStage: "state_of_operation",
      }),
    ).toBe("/onboarding/state-of-operation");
  });

  it("sends a fully-onboarded tenant_owner to the tenant CRM home", () => {
    expect(
      postLoginDestination({
        isPlatformAdmin: false,
        role: "tenant_owner",
        tenantOnboardingStage: "complete",
      }),
    ).toBe("/crm/contacts");
  });

  it("sends a fully-onboarded agent to the same tenant CRM home (agents work in the same surface as owners)", () => {
    expect(
      postLoginDestination({
        isPlatformAdmin: false,
        role: "agent",
        tenantOnboardingStage: "complete",
      }),
    ).toBe("/crm/contacts");
  });

  it("sends viewers to /chat (end customers don't have an onboarding state)", () => {
    expect(
      postLoginDestination({
        isPlatformAdmin: false,
        role: "viewer",
      }),
    ).toBe("/chat");
  });

  it("treats a null onboarding_stage on a viewer the same as no stage (viewers aren't onboarded)", () => {
    // The customer flow upserts the user with no onboarding_stage on the
    // tenants row; that null must NOT route them to an onboarding URL.
    expect(
      postLoginDestination({
        isPlatformAdmin: false,
        role: "viewer",
        tenantOnboardingStage: null,
      }),
    ).toBe("/chat");
  });

  it("treats a `signup` stage (just-created, no work done yet) as a route to /onboarding/profile", () => {
    // `signup` is the initial stage right after sign-up; the next concrete
    // page is /onboarding/profile, so that's where the dispatcher sends them.
    expect(
      postLoginDestination({
        isPlatformAdmin: false,
        role: "tenant_owner",
        tenantOnboardingStage: "signup",
      }),
    ).toBe("/onboarding/profile");
  });
});

describe("pickHighestRankActiveMembership", () => {
  const row = (role: string): MembershipRow => ({
    role,
    tenant_id: `tenant-${role}`,
    tenants: { onboarding_stage: "complete", status: "active" },
  });

  it("picks tenant_owner over agent over viewer when multiple memberships exist", () => {
    // Reason this matters: a platform admin who's also embedded as a viewer
    // on a tenant shouldn't be dispatched as a viewer. Highest privilege wins.
    const picked = pickHighestRankActiveMembership([
      row("viewer"),
      row("tenant_owner"),
      row("agent"),
    ]);
    expect(picked?.role).toBe("tenant_owner");
  });

  it("returns null when every row has an unknown role (future SQL enum value the app hasn't caught up to)", () => {
    // Without the filter guard the naive reducer would keep the first row
    // silently — wrong pick, no error in logs. The fallback is what the
    // resolver uses to send the user to /chat instead of crashing.
    const picked = pickHighestRankActiveMembership([
      row("unknown_role_added_later"),
      row("another_unknown_role"),
    ]);
    expect(picked).toBeNull();
  });

  it("returns null on empty input (user has no active memberships)", () => {
    expect(pickHighestRankActiveMembership([])).toBeNull();
  });

  it("filters unknown rows out but still picks the highest of the known ones", () => {
    // Mixed case — confirms the filter is per-row, not all-or-nothing.
    const picked = pickHighestRankActiveMembership([
      row("future_admin_role"),
      row("agent"),
      row("viewer"),
    ]);
    expect(picked?.role).toBe("agent");
  });
});

describe("normalizeTenant", () => {
  // The bug this protects against (#665): PostgREST returns embedded
  // foreign-table joins as EITHER a single object OR an array, even for
  // 1:1 relationships. The dispatcher's pre-fix typing assumed the
  // object shape only — array-shape responses silently routed
  // onboarding-incomplete tenants to /crm/contacts instead of the
  // pending onboarding stage. fetch-tenant-branding.ts hit the same
  // thing and handles both.

  it("returns the inner object when supabase returns the embedded shape", () => {
    expect(normalizeTenant({ onboarding_stage: "tax_form", status: "active" })).toEqual({
      onboarding_stage: "tax_form",
      status: "active",
    });
  });

  it("picks the first element when supabase returns the embedded shape as a one-element array (the #665 bug)", () => {
    expect(normalizeTenant([{ onboarding_stage: "tax_form", status: "active" }])).toEqual({
      onboarding_stage: "tax_form",
      status: "active",
    });
  });

  it("returns null for null (no membership row joined)", () => {
    expect(normalizeTenant(null)).toBeNull();
  });

  it("returns null for an empty array (FK present but the join filtered out)", () => {
    expect(normalizeTenant([])).toBeNull();
  });
});

describe("isRouteableTenant", () => {
  // The bug this guards (#666): a still-active user under a suspended /
  // terminated tenant was being routed to /crm and then 403'd by
  // assertPermission. Onboarding-in-flight (`onboarding`, `pending_review`)
  // tenants MUST stay routeable — the dispatcher's whole job is to send
  // them to the right onboarding stage.

  it("returns true for `active` tenants (fully live)", () => {
    expect(isRouteableTenant({ onboarding_stage: "complete", status: "active" })).toBe(true);
  });

  it("returns true for `onboarding` tenants (mid-funnel, dispatcher should still route them to /onboarding/{stage})", () => {
    // Critical regression case: the original fix used `=== \"active\"`
    // which would have broken every new tenant signing up mid-onboarding.
    expect(isRouteableTenant({ onboarding_stage: "tax_form", status: "onboarding" })).toBe(true);
  });

  it("returns true for `pending_review` tenants (awaiting platform-admin approval but still in the funnel)", () => {
    expect(isRouteableTenant({ onboarding_stage: "review_submitted", status: "pending_review" })).toBe(true);
  });

  it("returns false for `suspended` tenants (member shouldn't be sent to /crm where assertPermission will 403)", () => {
    expect(isRouteableTenant({ onboarding_stage: "complete", status: "suspended" })).toBe(false);
  });

  it("returns false for `terminated` tenants (tenant has been deleted)", () => {
    expect(isRouteableTenant({ onboarding_stage: "complete", status: "terminated" })).toBe(false);
  });

  it("returns false for null (no tenant joined)", () => {
    expect(isRouteableTenant(null)).toBe(false);
  });
});
