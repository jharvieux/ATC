// Tests for the post-login routing dispatcher. Each case encodes the WHY
// behind the destination — these are intent tests, not coverage. If the
// product changes its mind about where a given user type should land, the
// test that breaks tells the editor which decision they're walking back.

import { describe, it, expect } from "vitest";
import { postLoginDestination } from "@/lib/auth/post-login-destination";

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
